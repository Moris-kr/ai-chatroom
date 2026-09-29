// Headless camera for the building world: opens public/world.html
// in screenshot mode in a headless Chrome on the local listener, waits for the page's
// window.__shotReady, and saves a PNG. Driven over the DevTools protocol with Node's own
// WebSocket, so no extra packages.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killTree, onPath, spawnOpts } from './agents.mjs';

// Any Chromium-based browser works. CHROME_PATH wins; then the usual install places.
const CANDIDATES = [
  process.env.CHROME_PATH,
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const LINUX_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];

export function findBrowser() {
  return CANDIDATES.find((f) => f && fs.existsSync(f)) || LINUX_NAMES.map(onPath).find(Boolean) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One browser at a time: they share a profile folder, and a second Chrome on a profile
// that is still shutting down just hands off to it and exits.
let queue = Promise.resolve();

// opts: {night, view: 'iso'|'top', tx, tz, dist, angle, elev,   (orbit camera)
//        cx, cy, cz + lx, ly, lz | yaw, pitch | qx, qy, qz, qw,  (free camera, block coords)
//        fov, cut (hide blocks above this y), width, height, timeoutMs}
// Returns a PNG Buffer.
export function shootWorld(home, port, opts = {}) {
  const run = queue.then(() => shootOnce(home, port, opts));
  queue = run.catch(() => {});
  return run;
}

async function shootOnce(home, port, opts) {
  const bin = findBrowser();
  if (!bin) throw new Error('크롬이나 엣지를 못 찾았어');
  const profile = path.join(home, 'data', 'shot-browser');
  fs.mkdirSync(profile, { recursive: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const width = opts.width || 1280, height = opts.height || 720;
  const child = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, '--hide-scrollbars', '--mute-audio', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    'about:blank',
  ], { ...spawnOpts, stdio: 'ignore' });
  const deadline = Date.now() + (opts.timeoutMs || 45000);
  let ws;
  try {
    let devPort = null;
    while (!devPort) {
      if (Date.now() > deadline) throw new Error('브라우저가 안 떠');
      try { devPort = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim(); } catch { await sleep(150); }
    }
    let pageWs = null;
    while (!pageWs) {
      if (Date.now() > deadline) throw new Error('브라우저 페이지를 못 찾았어');
      try {
        const list = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
        pageWs = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl || null;
      } catch { /* not up yet */ }
      if (!pageWs) await sleep(150);
    }
    ws = new WebSocket(pageWs);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools 연결 실패')); });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });

    const q = new URLSearchParams({ shot: '1', night: opts.night ? '1' : '0', view: opts.view === 'top' ? 'top' : 'iso' });
    for (const k of ['tx', 'tz', 'dist', 'angle', 'elev', 'cx', 'cy', 'cz', 'lx', 'ly', 'lz', 'yaw', 'pitch', 'qx', 'qy', 'qz', 'qw', 'fov', 'cut']) {
      if (Number.isFinite(opts[k])) q.set(k, String(opts[k]));
    }
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/world.html?${q}` });
    for (;;) {
      if (Date.now() > deadline) throw new Error('월드 화면이 준비가 안 돼');
      const r = await send('Runtime.evaluate', { expression: 'window.__shotReady === true', returnByValue: true });
      if (r.result?.value === true) break;
      await sleep(250);
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(shot.data, 'base64');
  } finally {
    try { ws?.close(); } catch { /* closed */ }
    const gone = new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 8000); } });
    killTree(child.pid);
    await gone;
    await sleep(300); // let the profile lock go
  }
}
