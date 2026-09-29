// CLI adapters: one headless call per turn for each AI, plus image generation for the
// members whose CLI has an image tool. Everything goes through the user's logged-in
// CLIs (claude, codex, grok, agy); no API keys are used.
//
// Safety: chat calls run with every tool disabled or denied. Image calls allow only
// the image tool (Grok) or run sandboxed (Codex workspace sandbox, agy --sandbox).
// Grok ignores `--tools ""`, so its chat calls remove every tool it lets us remove
// and run in dontAsk mode, which cancels any call to the few tools that remain.

import { spawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const HOME = os.homedir();

const GROK_TOOLS = ['run_terminal_command', 'read_file', 'search_replace', 'list_dir', 'grep', 'kill_command_or_subagent',
  'todo_write', 'get_command_or_subagent_output', 'spawn_subagent', 'scheduler_create', 'scheduler_delete', 'scheduler_list',
  'monitor', 'search_tool', 'use_tool', 'workflow', 'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'send_feedback',
  'image_gen', 'image_edit', 'image_to_video', 'reference_to_video', 'write', 'web_fetch'].join(',');

const WIN = process.platform === 'win32';
const exe = (name) => (WIN ? `${name}.exe` : name);

export function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const f = dir && path.join(dir, name);
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

// <root>/<any>/<rest...>: newest match (for versioned install folders).
function newestUnder(root, ...rest) {
  if (!root || !fs.existsSync(root)) return null;
  const hits = fs.readdirSync(root).map((d) => path.join(root, d, ...rest)).filter((f) => fs.existsSync(f));
  return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

// Finds the four CLIs. `overrides` is config.json "bins" ({claude, codex, grok, agy}: full
// paths) and wins over everything. Otherwise PATH, then the usual install folders.
// On Windows npm installs `.cmd` shims, which cannot be spawned without a shell, so the real
// executables inside the npm packages are looked up instead.
export function resolveBins(overrides = {}) {
  const npmRoot = WIN ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm', 'node_modules') : null;
  const first = (...c) => c.find((f) => f && fs.existsSync(f)) || null;
  return {
    claude: overrides.claude || newestClaude([
      onPath(exe('claude')),
      path.join(HOME, '.local', 'bin', exe('claude')),
      npmRoot && path.join(npmRoot, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    ]),
    codex: overrides.codex || first(
      onPath(exe('codex')),
      // official standalone installer
      WIN ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
        : path.join(HOME, '.local', 'bin', 'codex'),
      WIN && newestUnder(path.join(HOME, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin'), 'codex.exe'), // Codex desktop app
      npmRoot && newestUnder(path.join(npmRoot, '@openai', 'codex', 'vendor'), 'codex', 'codex.exe'),
    ),
    grok: overrides.grok || first(onPath(exe('grok')), path.join(HOME, '.grok', 'bin', exe('grok'))),
    agy: overrides.agy || first(
      onPath(exe('agy')),
      WIN ? path.join(HOME, 'AppData', 'Local', 'agy', 'bin', 'agy.exe') : path.join(HOME, '.local', 'bin', 'agy'),
    ),
  };
}

// Several Claude Code installs can coexist (native installer in ~/.local/bin, npm global);
// newer models need a newer CLI, so use whichever reports the highest version.
function newestClaude(cands) {
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
    return 0;
  };
  let best = null, bestVer = null;
  for (const f of new Set(cands.filter((c) => c && fs.existsSync(c)))) {
    let ver;
    try {
      const out = execFileSync(f, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      ver = (out.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
    } catch { continue; }
    if (!bestVer || cmp(ver, bestVer) > 0) { best = f; bestVer = ver; }
  }
  return best;
}

// Children are spawned in their own process group on macOS/Linux (see spawnOpts), so the
// whole tree can be killed there too.
export function killTree(pid) {
  if (!pid) return;
  if (WIN) { execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {}); return; }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}
export const spawnOpts = { windowsHide: true, detached: !WIN };

// Track children so the server can kill them on shutdown.
export const running = new Set();

export function run(cmd, args, { input, cwd, timeoutMs = 150000, env } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = [], err = [];
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, ...spawnOpts, env: env ? { ...process.env, ...env } : process.env });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e), ms: 0 });
      return;
    }
    running.add(child);
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => err.push(Buffer.from(String(e))));
    child.on('close', (code) => {
      clearTimeout(timer);
      running.delete(child);
      resolve({
        code: timedOut ? -2 : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ms: Date.now() - t0,
        timedOut,
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export function killAll() {
  for (const c of running) killTree(c.pid);
}

const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// `claude -p` with images: one stream-json user message (image blocks + the text), still
// with every tool off. Returns {r, text} like a plain call.
async function claudeWithImages(bin, args, text, images, { cwd, timeoutMs }) {
  const content = images.map((f) => ({
    type: 'image',
    source: { type: 'base64', media_type: IMAGE_MIME[path.extname(f).toLowerCase()] || 'image/png', data: fs.readFileSync(f).toString('base64') },
  }));
  content.push({ type: 'text', text });
  const input = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  const r = await run(bin, [...args, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { input, cwd, timeoutMs });
  let out = '';
  for (const line of r.stdout.split('\n')) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'result') {
      out = j.is_error ? '' : String(j.result ?? '');
      if (j.is_error) r.stderr += `\nresult error: ${String(j.result ?? j.subtype).slice(0, 300)}`;
    }
  }
  return { r, text: out };
}

// ---------------------------------------------------------------------------
// Chat turn. Returns {ok, text, ms, detail}.

export class Adapters {
  constructor(root, cfg) {
    this.root = root;
    this.cfg = cfg;
    this.bins = resolveBins(cfg.bins || {});
    this.sessions = {}; // gemini conversation rotation
  }

  cwd(id, sub = 'chat') {
    const d = path.join(this.root, 'data', 'cwd', id, sub);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  available() {
    const b = this.bins;
    return {
      claude: !!b.claude && fs.existsSync(b.claude),
      gpt: !!b.codex && fs.existsSync(b.codex),
      grok: fs.existsSync(b.grok),
      gemini: fs.existsSync(b.agy),
    };
  }

  // Longest prompt a backend accepts (agy takes the prompt as a command-line argument).
  maxPromptChars(id) { return id === 'gemini' ? 26000 : 120000; }

  // Who can look at photos. Claude (stream-json image blocks) and Codex (--image) get them
  // with the turn, tools still off. agy's stream input is text only, but in headless mode
  // it may read files in its cwd (and temp), so a Gemini photo turn runs in a folder that
  // holds only the photo copies. Grok can't: ACP says image:false, and its read_file tool
  // reads the whole disk whatever --allow says (its sandbox profiles are Linux/macOS only),
  // so by default Grok gets the text description (describeImage).
  // agents.grok.seePhotos: true lets Grok look through read_file on photo turns instead. Its
  // read_file can read ANY file on the computer (path rules are ignored on Windows), so only
  // turn it on if you accept that; see the grok case in chat().
  canSee(id) {
    if (id === 'grok') return this.cfg.agents.grok?.seePhotos === true;
    return id === 'claude' || id === 'gpt' || id === 'gemini';
  }

  // agy always lets the model read the temp folder, so point TEMP/TMP at an empty room-only
  // folder for every agy call; the user's real %TEMP% stays out of reach.
  agyEnv() {
    const tmp = path.join(this.root, 'data', 'tmp', 'agy');
    fs.mkdirSync(tmp, { recursive: true });
    return { TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  }

  // opts.boost: this turn runs on the member's boost settings (진심모드): agents.<id>.boost
  // overrides model and/or effort. Missing boost settings fall back to the defaults.
  // opts.images: absolute paths of photos to attach (only for members that canSee).
  async chat(id, brief, turn, opts = {}) {
    const images = this.canSee(id) ? (opts.images || []).filter((f) => fs.existsSync(f)) : [];
    // Web search (config webSearch): each CLI's own search tool, nothing that opens pages
    // locally. agy's search_web runs in headless mode regardless (its read_url is denied).
    const search = !!this.cfg.webSearch;
    const base = this.cfg.agents[id];
    const a = opts.boost && (base.boost?.model || base.boost?.effort) ? { ...base, ...base.boost } : base;
    // 진심모드 turns think for a long time (a rulebook plus a worked example took >150s).
    const timeoutMs = ((opts.boost && this.cfg.boost?.timeoutSec) || this.cfg.turnTimeoutSec || 150) * 1000;
    const cwd = this.cwd(id);
    let r, text;
    switch (id) {
      case 'claude': {
        const sysFile = path.join(cwd, 'system.md');
        fs.writeFileSync(sysFile, brief);
        // Web search on: the WebSearch tool only (no WebFetch, so no arbitrary URLs).
        const tools = search ? ['--tools', 'WebSearch', '--allowedTools', 'WebSearch'] : ['--tools', ''];
        const args = ['-p', '--model', a.model, ...tools, '--strict-mcp-config', '--no-session-persistence',
          '--setting-sources', '', '--system-prompt-file', sysFile];
        if (a.effort) args.push('--effort', a.effort);
        if (images.length) {
          ({ r, text } = await claudeWithImages(this.bins.claude, args, turn, images, { cwd, timeoutMs }));
        } else {
          r = await run(this.bins.claude, args, { input: turn, cwd, timeoutMs });
          text = r.stdout;
        }
        break;
      }
      case 'gpt': {
        const outFile = path.join(cwd, `reply-${crypto.randomUUID()}.txt`);
        const args = ['exec', '-m', a.model, '-c', `model_reasoning_effort="${a.effort || 'low'}"`,
          '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '-s', 'read-only',
          '--disable', 'shell_tool', '--disable', 'computer_use', '--disable', 'browser_use', '--disable', 'apps',
          // "indexed" searches OpenAI's index instead of fetching pages live.
          '-c', `web_search="${search ? 'indexed' : 'disabled'}"`,
          '-c', 'windows.sandbox="unelevated"', ...images.map((f) => `--image=${f}`), '--color', 'never', '-o', outFile, '-'];
        r = await run(this.bins.codex, args, { input: `${brief}\n\n=====\n\n${turn}`, cwd, timeoutMs });
        try { text = fs.readFileSync(outFile, 'utf8'); fs.rmSync(outFile); } catch { text = ''; }
        break;
      }
      case 'grok': {
        // Photo turns: read_file on (only way Grok's CLI can look at a picture), run in a
        // folder holding only the photo copies, and web search off for that turn so file
        // reading and the network are never open together. Other turns: no file tools.
        let viewDir = null;
        let prompt = `${brief}\n\n=====\n\n${turn}`;
        if (images.length) {
          viewDir = path.join(this.root, 'data', 'view', 'grok', crypto.randomUUID());
          fs.mkdirSync(viewDir, { recursive: true });
          const names = images.map((f, i) => {
            const n = `photo${i + 1}${path.extname(f).toLowerCase()}`;
            fs.copyFileSync(f, path.join(viewDir, n));
            return path.join(viewDir, n);
          });
          prompt += `\n\n[사진 파일] 붙인 사진은 ${names.join(', ')}에 있어(순서대로). read_file로 이 파일들만 열어서 직접 봐. 다른 파일은 열지 마.`;
        }
        const pf = path.join(cwd, 'prompt.txt');
        fs.writeFileSync(pf, prompt);
        const disallowed = viewDir ? GROK_TOOLS.split(',').filter((t) => t !== 'read_file').join(',') : GROK_TOOLS;
        const args = ['--prompt-file', pf, '-m', a.model, '--effort', a.effort || 'low',
          ...(viewDir ? ['--tools', 'read_file'] : []),
          '--disallowed-tools', disallowed, '--permission-mode', 'dontAsk',
          '--output-format', 'plain', '--no-subagents', ...(search && !viewDir ? [] : ['--disable-web-search']), '--cwd', viewDir || cwd];
        // Search runs on xAI's side (its "open_page" can't be split off); the local
        // web_fetch tool stays off either way.
        try {
          r = await run(this.bins.grok, args, { cwd: viewDir || cwd, timeoutMs, env: { GROK_WEB_FETCH: 'false' } });
        } finally {
          if (viewDir) fs.rmSync(viewDir, { recursive: true, force: true });
        }
        text = r.stdout;
        break;
      }
      case 'gemini': {
        // Reuse one agy conversation for a few turns so the user's agy history does not
        // fill up with one conversation per chat turn. Boost turns use another model, so
        // they get a conversation of their own.
        // Photo turns also get a conversation of their own, started in a folder that holds
        // nothing but copies of the photos (agy may read its cwd), removed afterwards.
        let viewDir = null;
        let prompt = `${brief}\n\n=====\n\n${turn}`;
        if (images.length) {
          viewDir = path.join(this.root, 'data', 'view', 'gemini', crypto.randomUUID());
          fs.mkdirSync(viewDir, { recursive: true });
          const names = images.map((f, i) => {
            const n = `photo${i + 1}${path.extname(f).toLowerCase()}`;
            fs.copyFileSync(f, path.join(viewDir, n));
            return n;
          });
          prompt += `\n\n[사진 파일] 붙인 사진은 지금 작업 폴더에 ${names.join(', ')}로 있어(순서대로). 파일 보기 도구로 열어서 직접 봐. 다른 파일은 열지 마.`;
        }
        const s = opts.boost || viewDir ? { id: null, n: 0 } : (this.sessions.gemini ??= { id: null, n: 0 });
        if (s.id && s.n >= (a.rotate || 6)) { s.id = null; s.n = 0; }
        const args = ['--model', a.model, '--output-format', 'json', '--print-timeout', `${Math.round(timeoutMs / 1000)}s`];
        if (s.id) args.push('--conversation', s.id);
        args.push('-p', prompt);
        try {
          r = await run(this.bins.agy, args, { cwd: viewDir || cwd, timeoutMs: timeoutMs + 10000, env: this.agyEnv() });
        } finally {
          if (viewDir) fs.rmSync(viewDir, { recursive: true, force: true });
        }
        text = '';
        try {
          const j = JSON.parse(r.stdout);
          text = j.response || '';
          // agy tried a tool (headless mode denies it) and said nothing: treat as a pass, not a failure.
          if (!text.trim() && j.status === 'SUCCESS' && j.denied_actions?.length) {
            text = '{"action":"pass"}';
            r.stderr += `\nagy tool denied: ${j.denied_actions.map((d) => d.display_name || d.action).join(', ')}`;
          }
          if (j.conversation_id) { if (s.id !== j.conversation_id) { s.id = j.conversation_id; s.n = 0; } s.n++; }
          if (j.status && j.status !== 'SUCCESS') r.stderr += `\nstatus=${j.status}`;
        } catch { text = r.stdout; s.id = null; s.n = 0; }
        break;
      }
      default:
        throw new Error(`unknown agent ${id}`);
    }
    const ok = r.code === 0 && !!text?.trim();
    return { ok, text: text || '', ms: r.ms, detail: ok ? '' : `exit=${r.code}${r.timedOut ? ' (timeout)' : ''} ${r.stderr.slice(-600)}` };
  }

  // -------------------------------------------------------------------------
  // Photo description for the members that can't take images. One no-tools call per
  // upload (Claude's default chat model, Codex as the fallback). Returns {ok, text, detail}.
  async describeImage(file) {
    const ask = '이 사진을 직접 못 보는 채팅 멤버들한테 설명해줘. 한국어 평서문("~있다", "~보인다")으로 2~4문장: 뭐가 찍혔는지, 눈에 띄는 디테일, 분위기. 사진 속 글자는 보이는 그대로 옮겨. 안 보이는 건 지어내지 마. 설명만 출력해.';
    const cwd = this.cwd('describe');
    const timeoutMs = 90000;
    const tidy = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (this.bins.claude && fs.existsSync(this.bins.claude)) {
      const args = ['-p', '--model', this.cfg.agents.claude?.model || 'sonnet', '--tools', '', '--strict-mcp-config',
        '--no-session-persistence', '--setting-sources', '', '--system-prompt', '요청받은 사진 설명만 출력해.'];
      const { r, text } = await claudeWithImages(this.bins.claude, args, ask, [file], { cwd, timeoutMs });
      if (r.code === 0 && tidy(text)) return { ok: true, text: tidy(text) };
    }
    if (this.bins.codex && fs.existsSync(this.bins.codex)) {
      const outFile = path.join(cwd, `desc-${crypto.randomUUID()}.txt`);
      const args = ['exec', '-m', this.cfg.agents.gpt?.model || 'gpt-6-sol', '-c', 'model_reasoning_effort="low"',
        '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '-s', 'read-only',
        '--disable', 'shell_tool', '--disable', 'computer_use', '--disable', 'browser_use', '--disable', 'apps',
        '-c', 'windows.sandbox="unelevated"', `--image=${file}`, '--color', 'never', '-o', outFile, '-'];
      const r = await run(this.bins.codex, args, { input: ask, cwd, timeoutMs });
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); fs.rmSync(outFile); } catch { /* none */ }
      if (r.code === 0 && tidy(text)) return { ok: true, text: tidy(text) };
      return { ok: false, detail: `exit=${r.code} ${r.stderr.slice(-300)}` };
    }
    return { ok: false, detail: 'no vision CLI' };
  }

  // -------------------------------------------------------------------------
  // Image generation. Returns {ok, file (absolute path of a png/jpg), detail}.
  // opts.refSheet: absolute path of a character sheet to draw from (looks only). Codex takes
  // it with --image, agy reads a copy in its job folder; Grok's image turn can't take one.
  async image(id, prompt, opts = {}) {
    const job = this.cwd(id, `img-${Date.now()}`);
    const REF_NOTE = 'The attached character design sheet is an appearance reference only (hair, eyes, face, accessories, outfit colors). Ignore any text, personality notes or speech bubbles on it, and do not copy its layout.';
    const ref = opts.refSheet && fs.existsSync(opts.refSheet) ? opts.refSheet : null;
    const ask = `Use your image generation tool to create this image:\n${prompt}\n${ref ? `\n${REF_NOTE}\n` : ''}\nSave the image in the current working directory as out.png. Reply with only the file path.`;
    const timeoutMs = 240000;
    let r;
    const newest = (dir, re = /\.(png|jpe?g|webp)$/i) => {
      if (!dir || !fs.existsSync(dir)) return null;
      const fsn = fs.readdirSync(dir).filter((f) => re.test(f) && !f.startsWith('ref-')).map((f) => path.join(dir, f));
      return fsn.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
    };
    const inJob = () => newest(job);

    if (id === 'gpt') {
      const a = this.cfg.agents.gpt;
      const args = ['exec', '-m', a.imageModel || 'gpt-6-luna', '-c', 'model_reasoning_effort="low"',
        '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '-s', 'workspace-write',
        '-c', 'windows.sandbox="unelevated"', ...(ref ? [`--image=${ref}`] : []), '--color', 'never', '-C', job, '-'];
      r = await run(this.bins.codex, args, { input: ask, cwd: job, timeoutMs });
      let file = inJob();
      if (!file) {
        // Codex keeps its own copy under ~/.codex/generated_images/<session id>/
        const sid = (r.stdout + r.stderr).match(/session id: ([0-9a-f-]{36})/)?.[1];
        if (sid) file = newest(path.join(HOME, '.codex', 'generated_images', sid));
      }
      return { ok: !!file, file, detail: file ? '' : `exit=${r.code} ${r.stderr.slice(-400)}` };
    }

    if (id === 'grok') {
      const a = this.cfg.agents.grok;
      const sid = crypto.randomUUID();
      // Only image_gen, explicitly allowed; dontAsk cancels anything else. The image lands in
      // the session folder, so don't ask Grok to copy it (that needs a shell).
      // A looks reference needs image_edit, which accepts ANY absolute image path on the
      // computer, so it is opt-in (agents.grok.imageEdit: true) and the prompt points it at a
      // copy in the job folder. Without it Grok draws from the text prompt alone.
      let grokAsk = `Use your image generation tool to create this image:
${prompt}

Call the image generation tool exactly once. Do not save, copy or move files. When it is done, reply "done".`;
      let tools = ['--tools', 'image_gen', '--allow', 'image_gen'];
      if (ref && a.imageEdit === true) {
        const refCopy = path.join(job, `ref-sheet${path.extname(ref) || '.png'}`);
        fs.copyFileSync(ref, refCopy);
        grokAsk = `Use your image_edit tool to create this image, passing ${refCopy} as the only reference image:
${prompt}

${REF_NOTE}
Call image_edit exactly once with that one reference image and no other file. Do not save, copy or move files. When it is done, reply "done".`;
        tools = ['--tools', 'image_edit', '--allow', 'image_edit'];
      }
      const args = ['-p', grokAsk, '-m', a.model, '--effort', 'low', ...tools,
        '--disallowed-tools', 'search_tool,use_tool', '--permission-mode', 'dontAsk',
        '--output-format', 'plain', '--no-subagents', '--disable-web-search', '--cwd', job, '-s', sid];
      r = await run(this.bins.grok, args, { cwd: job, timeoutMs });
      let file = inJob();
      if (!file) {
        // image_gen writes into the session folder: ~/.grok/sessions/<encoded cwd>/<session>/images/
        const sessRoot = path.join(HOME, '.grok', 'sessions');
        const enc = encodeURIComponent(job);
        const base = fs.existsSync(path.join(sessRoot, enc)) ? path.join(sessRoot, enc)
          : fs.readdirSync(sessRoot).map((d) => path.join(sessRoot, d)).find((d) => decodeURIComponent(path.basename(d)).toLowerCase() === job.toLowerCase());
        if (base) {
          const sess = fs.existsSync(path.join(base, sid)) ? path.join(base, sid)
            : fs.readdirSync(base).map((d) => path.join(base, d)).sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0];
          file = newest(sess && path.join(sess, 'images'));
        }
      }
      return { ok: !!file, file, detail: file ? '' : `exit=${r.code} ${r.stderr.slice(-400)} ${r.stdout.slice(-200)}` };
    }

    if (id === 'gemini') {
      const a = this.cfg.agents.gemini;
      // agy stores generated images in ~/.gemini/antigravity-cli/brain/<conversation>/.
      // Copying them out needs a terminal, which is very slow in --sandbox, so just generate.
      const refName = ref ? `ref-sheet${path.extname(ref) || '.png'}` : null;
      if (ref) fs.copyFileSync(ref, path.join(job, refName));
      const refAsk = ref ? `\nFirst look at ${refName} in the current folder. ${REF_NOTE}\n` : '';
      const geminiAsk = `Use your image generation tool to create this image:\n${prompt}\n${refAsk}\nOnly generate the image. Do not copy, move or save files and do not run any commands. When the image is generated, reply "done".`;
      const args = ['--model', a.imageModel || a.model, '--sandbox', '--dangerously-skip-permissions',
        '--output-format', 'json', '--print-timeout', '220s', '-p', geminiAsk];
      r = await run(this.bins.agy, args, { cwd: job, timeoutMs, env: this.agyEnv() });
      let file = inJob();
      if (!file) {
        try {
          const cid = JSON.parse(r.stdout).conversation_id;
          if (cid) file = newest(path.join(HOME, '.gemini', 'antigravity-cli', 'brain', cid));
        } catch { /* no json */ }
      }
      return { ok: !!file, file, detail: file ? '' : `exit=${r.code} ${r.stderr.slice(-400)}` };
    }

    return { ok: false, detail: 'no image tool' };
  }
}
