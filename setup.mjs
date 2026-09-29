#!/usr/bin/env node
// Setup helper (run by setup.bat / setup.sh): finds the four member CLIs, offers to install
// the missing ones with each vendor's official installer and to log in, writes config.json,
// and can start the room. Nothing is installed or changed without asking first.
//
//   node setup.mjs           step by step, with questions
//   node setup.mjs --check   status only: no questions, no changes

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBins, run, Adapters } from './lib/agents.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const HOME = os.homedir();
const CHECK = process.argv.includes('--check');
const CONFIG = process.env.CHATROOM_CONFIG ? path.resolve(process.env.CHATROOM_CONFIG) : path.join(ROOT, 'config.json');
const EXAMPLE = path.join(ROOT, 'config.example.json');
const ORIG_PATH = process.env.PATH || '';

// Official install commands (Windows: PowerShell, macOS/Linux: sh). Sources:
// code.claude.com/docs/en/setup, github.com/openai/codex, docs.x.ai/build/overview,
// antigravity.google/docs/cli/install
const CLIS = [
  {
    id: 'claude', bin: 'claude', member: 'Claude', product: 'Claude Code',
    need: 'Claude Pro·Max·Team 등 유료 요금제 (무료 요금제는 안 됨)',
    win: 'irm https://claude.ai/install.ps1 | iex',
    unix: 'curl -fsSL https://claude.ai/install.sh | bash',
    login: ['auth', 'login'],
  },
  {
    id: 'gpt', bin: 'codex', member: 'ChatGPT', product: 'Codex CLI',
    need: 'ChatGPT 계정',
    win: 'irm https://chatgpt.com/codex/install.ps1 | iex',
    unix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    login: ['login'],
  },
  {
    id: 'grok', bin: 'grok', member: 'Grok', product: 'Grok Build CLI',
    need: 'SuperGrok 또는 X Premium+',
    win: 'irm https://x.ai/cli/install.ps1 | iex',
    unix: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    login: ['login'],
  },
  {
    id: 'gemini', bin: 'agy', member: 'Gemini', product: 'Antigravity CLI',
    need: 'Google 계정',
    win: 'irm https://antigravity.google/cli/install.ps1 | iex',
    unix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    login: [], // no login command: the first interactive run opens the browser
  },
];

// ---- output ----

const tty = process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = paint(32), red = paint(31), yellow = paint(33), dim = paint(2), bold = paint(1), cyan = paint(36);
const say = (s = '') => console.log(s);
const step = (s) => say(`\n${bold(cyan(`■ ${s}`))}`);

// ---- input ----
// A terminal gets a fresh readline per question, so nothing is left reading stdin while an
// installer or login runs in this window. Piped input (tests) is read once into a queue.

const piped = !process.stdin.isTTY;
const queue = [];
let waiting = null, eof = false, pipeRl = null;
if (piped && !CHECK) {
  pipeRl = readline.createInterface({ input: process.stdin, terminal: false });
  pipeRl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else queue.push(l); });
  pipeRl.on('close', () => { eof = true; if (waiting) { const w = waiting; waiting = null; w(''); } });
}

function readLine() {
  if (piped) {
    if (queue.length) return Promise.resolve(queue.shift());
    if (eof) return Promise.resolve('');
    return new Promise((res) => { waiting = res; });
  }
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    // res before close: close() emits 'close' synchronously, which would answer '' first.
    rl.once('line', (l) => { res(l); rl.close(); });
    rl.once('close', () => res('')); // EOF (Ctrl+Z / Ctrl+D)
  });
}

async function ask(q, def = '') {
  process.stdout.write(q);
  const a = (await readLine()).trim();
  if (piped) process.stdout.write(`${a}\n`);
  return a || def;
}

// Accepts y/yes/예/네/응, and ㅛ (y typed with the Korean keyboard on).
async function yes(q, def = false) {
  const a = (await ask(`${q} ${dim(def ? '[Y/n]' : '[y/N]')} `)).toLowerCase();
  if (!a) return def;
  return ['y', 'yes', 'ㅛ', '예', '네', '응', 'ㅇ'].includes(a);
}

// Runs a command in this window (installers, logins, the room itself). Ctrl+C goes to the
// child; this helper keeps running and continues afterwards.
function interactive(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const onInt = () => {};
    process.on('SIGINT', onInt);
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      process.off('SIGINT', onInt);
      resetTerminal();
      resolve(code);
    };
    let child;
    try { child = spawn(cmd, args, { stdio: 'inherit', ...opts }); } catch { finish(-1); return; }
    child.on('error', () => finish(-1));
    child.on('exit', (code) => finish(code ?? -1));
  });
}

// A login screen or installer can leave the terminal in raw mode (no echo, no line input),
// especially after Ctrl+C. Put it back before asking the next question.
function resetTerminal() {
  if (!process.stdin.isTTY) return;
  try {
    if (WIN) { process.stdin.setRawMode(true); process.stdin.setRawMode(false); }
    else spawnSync('stty', ['sane'], { stdio: 'inherit' });
  } catch { /* leave it */ }
}

function shellCommand(line) {
  return WIN
    ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', line]]
    : ['sh', ['-c', line]];
}

// ---- detection ----

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chatroom-setup-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* in use */ } });

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

function resolveWithPath(p) {
  const saved = process.env.PATH;
  process.env.PATH = p;
  try { return resolveBins(readConfig().bins || {}); } finally { process.env.PATH = saved; }
}

// After an installer ran, pick up the PATH it wrote (this process still has the old one).
function refreshPath() {
  let fresh = '';
  try {
    if (WIN) {
      fresh = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
    } else {
      const out = execFileSync(process.env.SHELL || '/bin/sh', ['-ilc', 'printf "\\n__PATH__%s\\n" "$PATH"'],
        { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
      fresh = (out.match(/__PATH__(.*)/) || [])[1] || '';
    }
  } catch { /* keep the current PATH */ }
  const cur = (process.env.PATH || '').split(path.delimiter);
  const extra = [path.join(HOME, '.local', 'bin'), ...(MAC ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])];
  const add = [...fresh.split(path.delimiter), ...extra].filter((d) => d && !cur.includes(d));
  process.env.PATH = [...cur, ...add].join(path.delimiter);
}

async function version(bin) {
  const r = await run(bin, ['--version'], { cwd: TMP, timeoutMs: 20000 });
  return ((r.stdout + r.stderr).match(/\d+\.\d+\.\d+[\w.-]*/) || [])[0] || null;
}

// true / false / null (could not tell). Reads login state only; no model calls.
async function loggedIn(c, bin) {
  try {
    if (c.id === 'claude') {
      const r = await run(bin, ['auth', 'status'], { cwd: TMP, timeoutMs: 20000 });
      const j = JSON.parse(r.stdout);
      return { ok: j.loggedIn === true, note: j.loggedIn ? j.subscriptionType || '' : '' };
    }
    if (c.id === 'gpt') {
      const r = await run(bin, ['login', 'status'], { cwd: TMP, timeoutMs: 20000 });
      const t = r.stdout + r.stderr;
      if (/not logged in/i.test(t)) return { ok: false };
      if (/logged in/i.test(t)) return { ok: true, note: (t.match(/using (ChatGPT)/i) || [])[1] || '' };
      return { ok: null };
    }
    if (c.id === 'grok') {
      const r = await run(bin, ['models'], { cwd: TMP, timeoutMs: 40000 });
      const t = r.stdout + r.stderr;
      if (/you are logged in/i.test(t)) return { ok: true };
      if (/not logged in|log ?in|sign ?in|unauthori[sz]ed/i.test(t)) return { ok: false };
      return { ok: null };
    }
    if (c.id === 'gemini') {
      const r = await run(bin, ['-p', '/usage', '--output-format', 'json'], { cwd: TMP, timeoutMs: 30000 });
      try {
        const j = JSON.parse(r.stdout);
        if (j.status === 'SUCCESS' && j.command?.data?.groups?.length) return { ok: true };
      } catch { /* not json */ }
      const t = r.stdout + r.stderr;
      // Google's side sometimes answers 503 or not at all; that says nothing about the login.
      if (r.timedOut) return { ok: null, note: '응답 없음, 잠시 후 다시' };
      if (/\b503\b|UNAVAILABLE/.test(t)) return { ok: null, note: 'Google 서버 일시 오류, 잠시 후 다시' };
      if (/auth|log ?in|sign ?in|credential/i.test(t)) return { ok: false };
      return { ok: null };
    }
  } catch { /* unreadable output */ }
  return { ok: null };
}

async function inspect(c, bins) {
  const bin = bins[c.bin];
  if (!bin || !fs.existsSync(bin)) return { c, bin: null };
  const [ver, login] = await Promise.all([version(bin), loggedIn(c, bin)]);
  return { c, bin, ver, login };
}

function loginText(s) {
  if (!s.bin) return red('설치 안 됨');
  if (s.login.ok === true) return green('로그인됨') + (s.login.note ? dim(` (${s.login.note})`) : '');
  if (s.login.ok === false) return yellow('로그인 필요');
  return yellow('로그인 확인 못 함') + (s.login.note ? dim(` (${s.login.note})`) : '');
}

function printTable(list) {
  for (const s of list) {
    const mark = !s.bin ? red('[--]') : s.login.ok === true ? green('[OK]') : yellow('[!!]');
    const where = s.bin ? `${s.c.bin} ${s.ver || '?'}` : s.c.bin;
    say(`  ${mark} ${s.c.member.padEnd(8)} ${dim(where.padEnd(22))} ${loginText(s)}`);
  }
}

// ---- config.json ----

function portState(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', (e) => res(e.code || 'ERROR'));
    srv.listen(port, '127.0.0.1', () => srv.close(() => res('free')));
  });
}

async function roomAt(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return Array.isArray(j.members);
  } catch { return false; }
}

async function freePortFrom(port) {
  for (let p = port; p < port + 200 && p <= 65535; p++) if (await portState(p) === 'free') return p;
  return null;
}

// Edits values in place so the file keeps its layout; falls back to rewriting it when the
// edit would not give exactly the intended result.
function patchJson(text, orig, updates) {
  const want = { ...orig, ...updates };
  let out = text;
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`("${k}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?|true|false|null|\\{[^{}]*\\})`);
    if (!re.test(out)) { out = null; break; }
    out = out.replace(re, (_, pre) => pre + JSON.stringify(v));
  }
  try { if (out && JSON.stringify(JSON.parse(out)) === JSON.stringify(want)) return out; } catch { /* fall back */ }
  return `${JSON.stringify(want, null, 2)}\n`;
}

async function configure(pins) {
  const exists = fs.existsSync(CONFIG);
  const text = fs.readFileSync(exists ? CONFIG : EXAMPLE, 'utf8');
  let cfg;
  try { cfg = JSON.parse(text); } catch (e) {
    say(red(`  config.json을 읽을 수 없어 (JSON 오류: ${e.message}). 고치거나 지운 뒤 다시 실행해 줘.`));
    return null;
  }
  const rel = path.relative(ROOT, CONFIG).startsWith('..') ? CONFIG : path.relative(ROOT, CONFIG);
  let userName = cfg.userName || '방장';
  let port = Number(cfg.port) || 8321;
  let edit = true;
  if (exists) {
    say(`  ${rel} 있음: 이름 ${bold(userName)}, 포트 ${bold(port)}`);
    const busy = (await portState(port)) !== 'free' && !(await roomAt(port));
    if (busy) say(yellow(`  포트 ${port}은(는) 지금 다른 프로그램이 쓰고 있어. 바꾸는 걸 추천해.`));
    edit = await yes('  이름이나 포트를 바꿀까?', busy);
    if (!edit && !Object.keys(pins).length) return cfg;
  } else {
    say(`  ${rel}을(를) 새로 만들게.`);
  }

  if (edit) {
    const n = await ask(`  멤버들이 부를 내 이름 ${dim(`[${userName}]`)}: `, userName);
    userName = n.slice(0, 20);
    for (let tries = 0; tries < 3; tries++) {
      const st = await portState(port);
      const mine = st !== 'free' && await roomAt(port);
      let suggest = port;
      if (st !== 'free' && !mine) {
        suggest = await freePortFrom(port + 1);
        say(yellow(`  포트 ${port}은(는) 못 써 (${st === 'EADDRINUSE' ? '다른 프로그램이 사용 중' : `${st}, Windows 예약 포트일 수 있음`}).`) + (suggest ? ` ${suggest}번을 추천해.` : ''));
      }
      const p = Number(await ask(`  포트 ${dim(`[${suggest}]`)}: `, String(suggest)));
      if (!Number.isInteger(p) || p < 1024 || p > 65535) { say(yellow('  1024~65535 사이 숫자로 적어 줘.')); continue; }
      port = p;
      if ((await portState(port)) === 'free' || await roomAt(port)) break;
    }
  }

  const updates = { userName, port };
  if (Object.keys(pins).length) updates.bins = { ...(cfg.bins || {}), ...pins };
  const out = patchJson(text, cfg, updates);
  fs.writeFileSync(CONFIG, out);
  say(green(`  저장했어: ${rel}`) + dim(` (이름 ${userName}, 포트 ${port})`));
  return JSON.parse(out);
}

// ---- test calls ----

function roomConfig() {
  const ex = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  const user = readConfig();
  const agents = {};
  for (const c of CLIS) agents[c.id] = { ...ex.agents[c.id], ...(user.agents?.[c.id] || {}) };
  return { ...ex, ...user, agents, webSearch: false, turnTimeoutSec: 120 };
}

async function testCalls(ready, bins) {
  const cfg = roomConfig();
  const ad = new Adapters(TMP, cfg);
  ad.bins = bins;
  say(dim('  멤버마다 "OK" 한마디만 받아 볼게 (각 10~60초).'));
  await Promise.all(ready.map(async (s) => {
    const id = s.c.id;
    const model = cfg.agents[id].model;
    let r;
    try { r = await ad.chat(id, 'This is a connection test. Reply with exactly: OK', 'ping'); } catch (e) { r = { ok: false, detail: String(e) }; }
    if (r.ok) {
      say(`  ${green('[OK]')} ${s.c.member.padEnd(8)} ${dim(`${model} · ${(r.ms / 1000).toFixed(1)}초`)}`);
      return;
    }
    const last = (r.detail || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
    say(`  ${red('[실패]')} ${s.c.member.padEnd(8)} ${dim(model)} ${last.slice(0, 160)}`);
    if (/model/i.test(r.detail || '')) say(dim(`         모델 이름이 이 계정에서 안 될 수 있어. config.json의 agents.${id}.model을 바꿔 봐.`));
  }));
}

// ---- Windows desktop shortcut ----

function makeShortcut(roomName) {
  const name = String(roomName || 'AI 단톡방').replace(/[<>:"/\\|?*]/g, '').trim() || 'AI 단톡방';
  const ps = [
    '$d = [Environment]::GetFolderPath("Desktop")',
    '$f = Join-Path $d ($env:SC_NAME + ".lnk")',
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($f)',
    '$s.TargetPath = $env:SC_TARGET',
    '$s.WorkingDirectory = $env:SC_DIR',
    '$s.IconLocation = $env:SC_ICON',
    '$s.WindowStyle = 7',
    '$s.Save()',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Write-Output $f',
  ].join('; ');
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...process.env, SC_NAME: name, SC_TARGET: path.join(ROOT, 'start.bat'), SC_DIR: ROOT, SC_ICON: path.join(ROOT, 'public', 'icon.ico') },
  }).trim();
}

// ---- main ----

async function main() {
  say(bold('AI 단톡방 설치 도우미'));
  say(dim(CHECK ? '상태만 확인해 (아무것도 바꾸지 않아).' : '설치나 변경은 전부 먼저 물어볼게. 그냥 Enter를 누르면 [대문자] 쪽으로 가.'));

  step('Node.js');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    say(red(`  Node.js ${process.versions.node}: 22 이상이 필요해. https://nodejs.org 에서 LTS를 설치해 줘.`));
    process.exitCode = 1;
    return;
  }
  say(`  ${green('[OK]')} ${process.versions.node}`);

  step('멤버 CLI');
  say(dim('  찾는 중... (로그인 확인에 몇 초 걸려)'));
  let bins = resolveBins(readConfig().bins || {});
  let list = await Promise.all(CLIS.map((c) => inspect(c, bins)));
  printTable(list);

  if (CHECK) {
    step('설정');
    const cfg = readConfig();
    const port = Number(cfg.port) || 8321;
    const st = await portState(port);
    const running = st !== 'free' && await roomAt(port);
    say(`  ${fs.existsSync(CONFIG) ? 'config.json 있음' : 'config.json 없음 (기본값으로 돌아)'} · 포트 ${port}: ${
      st === 'free' ? green('비어 있음') : running ? green('방이 켜져 있음') : yellow(`못 씀 (${st})`)}`);
    return;
  }

  const missing = list.filter((s) => !s.bin);
  if (missing.length) {
    step('없는 CLI 설치');
    say(dim('  각 회사 공식 설치 명령을 이 창에서 그대로 실행해. 없는 멤버는 방에서 오프라인으로 떠 (나중에 설치해도 돼).'));
    for (const s of missing) {
      const cmd = WIN ? s.c.win : s.c.unix;
      say(`\n  ${bold(s.c.member)} ← ${s.c.product}  ${dim(`필요: ${s.c.need}`)}`);
      say(`  ${dim(WIN ? 'PowerShell>' : '$')} ${cmd}`);
      if (!(await yes('  설치할까?'))) continue;
      const [exe, args] = shellCommand(cmd);
      const code = await interactive(exe, args, { cwd: HOME });
      refreshPath();
      bins = resolveBins(readConfig().bins || {});
      const idx = list.indexOf(s);
      list[idx] = await inspect(s.c, bins);
      if (list[idx].bin) say(green(`  설치됨: ${list[idx].bin}`));
      else say(yellow(`  아직 못 찾았어 (종료 코드 ${code}). 새 창에서 setup을 다시 실행하거나, config.json "bins"에 실행 파일 경로를 적어 줘.`));
    }
  }

  const needLogin = list.filter((s) => s.bin && s.login.ok !== true);
  if (needLogin.length) {
    step('로그인');
    for (const s of needLogin) {
      const how = s.c.login.length ? `${s.c.bin} ${s.c.login.join(' ')}` : s.c.bin;
      const why = s.login.ok === false ? '로그인이 필요해'
        : `로그인 상태를 확인 못 했어${s.login.note ? ` (${s.login.note})` : ''}. 로그인돼 있으면 건너뛰어도 돼`;
      say(`\n  ${bold(s.c.member)}: ${why}. ${dim(`필요: ${s.c.need}`)}`);
      if (!s.c.login.length) say(dim(`  ${s.c.bin}를 실행하면 브라우저가 열려. 로그인이 끝나면 Ctrl+C로 빠져나와.`));
      else say(dim('  브라우저가 열리면 거기서 로그인해 줘.'));
      if (!(await yes(`  지금 로그인할까? (${how})`, s.login.ok === false))) continue;
      await interactive(s.bin, s.c.login, { cwd: HOME });
      const idx = list.indexOf(s);
      list[idx] = { ...s, login: await loggedIn(s.c, s.bin) };
      say(`  → ${loginText(list[idx])}`);
    }
  }

  if (missing.length || needLogin.length) {
    step('지금 상태');
    printTable(list);
  }
  const ready = list.filter((s) => s.bin && s.login.ok !== false);
  if (!ready.length) say(yellow('  쓸 수 있는 멤버가 아직 없어. 방은 켜지지만 아무도 말하지 않아. 나중에 setup을 다시 실행해 줘.'));

  // A CLI found only thanks to the refreshed PATH may be invisible to the room's own process
  // (an old window's PATH), so pin those paths in config.json.
  const before = resolveWithPath(ORIG_PATH);
  const pins = {};
  for (const s of list) if (s.bin && !before[s.c.bin]) pins[s.c.bin] = s.bin;

  step('설정 (config.json)');
  const cfg = await configure(pins);
  const port = Number(cfg?.port) || 8321;

  if (ready.length) {
    step('테스트 대화 (선택)');
    say(dim('  모델 이름·로그인이 실제로 되는지 멤버마다 한 번 불러 봐. 사용량이 아주 조금 들어.'));
    if (await yes('  해 볼까?')) await testCalls(ready, bins);
  }

  let shortcut = false;
  if (WIN) {
    step('바탕화면 바로가기 (선택)');
    if (await yes(`  바탕화면에 '${cfg?.roomName || 'AI 단톡방'}' 바로가기를 만들까?`)) {
      try {
        say(green(`  만들었어: ${makeShortcut(cfg?.roomName)}`));
        shortcut = true;
      } catch (e) { say(yellow(`  못 만들었어: ${String(e.message || e).split('\n')[0]}`)); }
    }
  }

  step('다 됐어');
  say(`  다음부터 켜기: ${bold(WIN ? `start.bat 더블클릭${shortcut ? ' (또는 바탕화면 바로가기)' : ''}` : './start.sh')}`);
  say(`  브라우저: ${bold(`http://localhost:${port}`)} → 왼쪽 위 ${bold('방 켜기')}`);
  say(dim('  서버 창을 닫거나 Ctrl+C를 누르면 방이 꺼져. 상태만 다시 보려면: node setup.mjs --check'));

  const running = (await portState(port)) !== 'free' && await roomAt(port);
  if (running) {
    say(green('\n  방 서버가 이미 켜져 있어.'));
    if (await yes('  브라우저로 열까?', true)) openBrowser(`http://localhost:${port}`);
    return;
  }
  if (await yes('\n  지금 방을 열까?', true)) {
    if (pipeRl) pipeRl.close();
    say(dim('  (이 창이 서버야. 닫으면 방이 꺼져.)\n'));
    await interactive(process.execPath, [path.join(ROOT, 'server.mjs'), '--open'], { cwd: ROOT });
  }
}

function openBrowser(url) {
  const [cmd, args] = WIN ? ['explorer.exe', [url]] : MAC ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser */ }
}

main()
  .catch((e) => { console.error(red(`\n설치 도우미 오류: ${e.stack || e}`)); process.exitCode = 1; })
  .finally(() => { if (pipeRl) pipeRl.close(); });
