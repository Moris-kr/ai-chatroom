// External access: a second listener for the owner away from home (router port forward to
// this PC). Everything on it sits behind a password login; the dev bridge API (/api/dev/*)
// is never served there. The local listener (127.0.0.1) is left exactly as it was.
//
// Files (all under data/, which is never served):
//   external-auth.json      scrypt hash of the password
//   external-password.txt   the generated password, written once for the owner to read
//   external-sessions.json  sha256 of each session cookie -> expiry
//   tls/key.pem, cert.pem   self-signed certificate for https

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const COOKIE = 'room_sid';
const SESSION_DAYS = 30;
const IP_FAILS = 5;            // wrong passwords per address before it is locked out
const IP_LOCK_MS = 15 * 60000;
const GLOBAL_FAILS = 30;       // wrong passwords per hour from everyone before login closes
const GLOBAL_LOCK_MS = 60 * 60000;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readJson(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; }
}

// 20 characters from an alphabet without look-alikes, in groups of 5.
function newPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(20);
  const chars = [...bytes].map((b) => abc[b % abc.length]).join('');
  return chars.match(/.{5}/g).join('-');
}

function hashPassword(pw, salt = crypto.randomBytes(16)) {
  return { salt: salt.toString('base64'), hash: crypto.scryptSync(pw, salt, 64).toString('base64') };
}

// Replace the password (set-password.mjs). Old sessions end, the generated-password note goes.
export function setPassword(home, pw) {
  const dir = path.join(home, 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'external-auth.json'), JSON.stringify({ ...hashPassword(String(pw)), createdAt: new Date().toISOString() }, null, 2));
  fs.writeFileSync(path.join(dir, 'external-sessions.json'), '{}');
  fs.rmSync(path.join(dir, 'external-password.txt'), { force: true });
}

function findOpenssl() {
  const cands = [
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
    // Git's native build; its usr/bin one is an MSYS binary that rewrites "/CN=..." args.
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  ];
  return cands.find((f) => fs.existsSync(f)) || 'openssl';
}

export class ExternalGate {
  constructor(home, { log } = {}) {
    this.dir = path.join(home, 'data');
    this.authFile = path.join(this.dir, 'external-auth.json');
    this.pwFile = path.join(this.dir, 'external-password.txt');
    this.sessFile = path.join(this.dir, 'external-sessions.json');
    this.log = log || (() => {});
    this.fails = new Map(); // ip -> {n, until}
    this.globalFails = [];  // timestamps
    this.globalUntil = 0;
    this.auth = readJson(this.authFile, null);
    if (!this.auth?.hash) {
      const pw = newPassword();
      this.auth = { ...hashPassword(pw), createdAt: new Date().toISOString() };
      fs.writeFileSync(this.authFile, JSON.stringify(this.auth, null, 2));
      fs.writeFileSync(this.pwFile, `${pw}\n`);
      this.log('generated a new password (data/external-password.txt)');
    }
    this.sessions = readJson(this.sessFile, {});
    this.prune();
  }

  // Self-signed certificate for https, made once.
  tls() {
    const dir = path.join(this.dir, 'tls');
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    if (!fs.existsSync(key) || !fs.existsSync(cert)) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync(findOpenssl(), ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
        '-keyout', key, '-out', cert, '-subj', '/CN=ai-chatroom'], { stdio: 'ignore', windowsHide: true, timeout: 60000 });
      this.log('made a self-signed certificate (data/tls)');
    }
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  }

  prune() {
    const now = Date.now();
    let changed = false;
    for (const [k, v] of Object.entries(this.sessions)) if (!v || v.exp < now) { delete this.sessions[k]; changed = true; }
    if (changed) this.saveSessions();
  }
  saveSessions() { fs.writeFileSync(this.sessFile, JSON.stringify(this.sessions, null, 2)); }

  cookieOf(req) {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,})`));
    return m ? m[1] : null;
  }
  valid(req) {
    this.reloadAuth();
    const tok = this.cookieOf(req);
    const s = tok && this.sessions[sha(tok)];
    return !!s && s.exp > Date.now();
  }

  // Pick up a password changed by set-password.mjs without a restart; that also ends
  // every session.
  reloadAuth() {
    let mtime = 0;
    try { mtime = fs.statSync(this.authFile).mtimeMs; } catch { return; }
    if (this.authMtime && mtime !== this.authMtime) {
      const next = readJson(this.authFile, null);
      if (next?.hash) {
        this.auth = next;
        this.sessions = {};
        this.saveSessions();
        this.log('password changed; sessions cleared');
      }
    }
    this.authMtime = mtime;
  }

  checkPassword(pw) {
    this.reloadAuth();
    const want = Buffer.from(this.auth.hash, 'base64');
    const got = crypto.scryptSync(String(pw ?? ''), Buffer.from(this.auth.salt, 'base64'), want.length);
    return crypto.timingSafeEqual(want, got);
  }

  locked(ip, now) {
    if (now < this.globalUntil) return '로그인 시도가 너무 많아서 잠시 막혔어. 나중에 다시 해줘.';
    const f = this.fails.get(ip);
    if (f && now < f.until) return `비밀번호를 여러 번 틀려서 ${Math.ceil((f.until - now) / 60000)}분 동안 막혔어.`;
    return null;
  }
  noteFail(ip, now) {
    const f = this.fails.get(ip) || { n: 0, until: 0 };
    f.n++;
    if (f.n >= IP_FAILS) { f.until = now + IP_LOCK_MS; f.n = 0; }
    this.fails.set(ip, f);
    this.globalFails = this.globalFails.filter((t) => now - t < 3600000);
    this.globalFails.push(now);
    if (this.globalFails.length >= GLOBAL_FAILS) { this.globalUntil = now + GLOBAL_LOCK_MS; this.globalFails = []; }
  }

  // Handles /login and /logout, and turns away everything else without a session.
  // Returns true when it answered the request itself.
  async handle(req, res, p, { secure }) {
    const ip = req.socket.remoteAddress || '?';
    const now = Date.now();
    if (p === '/login' && req.method === 'POST') {
      const origin = req.headers.origin;
      const host = req.headers.host;
      // "null" comes from privacy settings and sandboxed pages, not from another site.
      if (origin && origin !== 'null' && origin !== `https://${host}` && origin !== `http://${host}`) {
        this.log(`login refused: origin ${origin} host ${host} from ${ip}`);
        return this.page(res, 403, '다른 사이트에서 온 요청이라 막았어.'), true;
      }
      const why = this.locked(ip, now);
      if (why) return this.page(res, 429, why), true;
      let body = '';
      try { body = await readSmall(req, 4096); } catch { return this.page(res, 400, '요청이 이상해.'), true; }
      const pw = new URLSearchParams(body).get('password');
      if (!this.checkPassword(pw)) {
        this.noteFail(ip, now);
        this.log(`login FAIL ${ip}`);
        await new Promise((r) => setTimeout(r, 800));
        return this.page(res, 401, '비밀번호가 틀렸어.'), true;
      }
      this.fails.delete(ip);
      const tok = crypto.randomBytes(32).toString('base64url');
      this.sessions[sha(tok)] = { exp: now + SESSION_DAYS * 86400000, at: new Date(now).toISOString(), ip };
      this.saveSessions();
      this.log(`login ok ${ip}`);
      res.writeHead(303, {
        Location: '/',
        'Set-Cookie': `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`,
        'Cache-Control': 'no-store',
      });
      res.end();
      return true;
    }
    if (p === '/login') return this.page(res, 200, ''), true;
    if (p === '/logout') {
      const tok = this.cookieOf(req);
      if (tok) { delete this.sessions[sha(tok)]; this.saveSessions(); }
      res.writeHead(303, { Location: '/login', 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}` });
      res.end();
      return true;
    }
    if (this.valid(req)) return false;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
      res.end();
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('{"error":"login required"}');
    }
    return true;
  }

  page(res, code, msg) {
    res.writeHead(code, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      // not no-referrer: with it browsers send "Origin: null" on the form post, and the
      // origin check below would turn the owner away
      'Referrer-Policy': 'same-origin',
    });
    res.end(LOGIN_HTML.replace('{{msg}}', msg ? `<p class="err">${msg}</p>` : ''));
  }
}

function readSmall(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const LOGIN_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI 단톡방 로그인</title>
<style>
:root { --bg: #e9ebf0; --panel: #fff; --line: #d6d9e1; --text: #1b1f2a; --muted: #646b7d; --accent: #1f9d74; --err: #c2413b; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #0c0e12; --panel: #151920; --line: #2f3643; --text: #e7e9ef; --muted: #a0a7b7; --accent: #1b8d69; --err: #f07a73; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif; }
form { width: min(360px, 100%); background: var(--panel); border: 1px solid var(--line); border-radius: 18px; padding: 24px; }
h1 { font-size: 19px; margin: 0 0 4px; }
.sub { color: var(--muted); font-size: 13.5px; margin: 0 0 18px; }
input { width: 100%; font: inherit; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); background: transparent; color: inherit; }
input:focus { outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); border-color: var(--accent); }
button { width: 100%; margin-top: 12px; padding: 10px; border: 0; border-radius: 12px; background: var(--accent); color: #fff; font: inherit; font-weight: 650; }
.err { color: var(--err); font-size: 13.5px; margin: 0 0 12px; }
</style></head>
<body><form method="post" action="/login">
<h1>AI 단톡방</h1>
<p class="sub">밖에서 들어오려면 비밀번호가 필요해.</p>
{{msg}}
<input type="password" name="password" autocomplete="current-password" placeholder="비밀번호" aria-label="비밀번호" autofocus required>
<button type="submit">들어가기</button>
</form></body></html>`;
