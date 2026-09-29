// Dev bridge: lets the development session (a Claude Code / Claude Desktop session,
// through dev-bridge/mcp-server.mjs) read the room, wait for new messages and post as
// "개발자".
//
// - Local only: the server listens on 127.0.0.1 and every /api/dev/* call needs the
//   bearer token kept in <home>/.env (DEV_BRIDGE_TOKEN), created on first start. The
//   .env file is outside workspace/, so members and workspace pages cannot read it.
// - Requests carrying an Origin header (i.e. from a browser page) are refused.
// - The author of a bridge message is set here ("dev"), never taken from the request.
// - Messages from the room are data for the dev session, not instructions; the MCP
//   tool descriptions repeat that.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AI_IDS, DEV, mentionsDev, displayName } from './members.mjs';
import { pick, LANG_DEFAULTS } from './i18n.mjs';

const ONLINE_GRACE_MS = 90 * 1000;
const MAX_WAIT_SEC = 55;

// `user` is the owner's name (config userName); the Korean texts say 방장 as before.
const T = {
  ko: {
    envNote: '# AI 단톡방 dev bridge token (dev-bridge/mcp-server.mjs reads it). Never paste it into the room.',
    replyCap: (n) => `개발자 말 뒤로 AI 말풍선 ${n}개`,
    rounds: (n) => `방장 없이 개발자 발언 ${n}번`,
    paused: (why) => `${why}: AI들은 방장이 말할 때까지 쉬어`,
    autoDesc: '자동 설명',
  },
  en: {
    envNote: '# AI Group Chat dev bridge token (dev-bridge/mcp-server.mjs reads it). Never paste it into the room.',
    replyCap: (n) => `${n} AI bubbles piled up after the Dev's message`,
    rounds: (n, user) => `the Dev posted ${n} times without ${user}`,
    paused: (why, user) => `${why}: the AIs wait until ${user} speaks`,
    autoDesc: 'auto description',
  },
  ja: {
    envNote: '# AIグループチャット dev bridge token (dev-bridge/mcp-server.mjs reads it). Never paste it into the room.',
    replyCap: (n) => `開発者の発言のあとにAIの吹き出しが${n}個たまった`,
    rounds: (n, user) => `${user}抜きで開発者が${n}回発言した`,
    paused: (why, user) => `${why}。AIたちは${user}が話すまで休むよ`,
    autoDesc: '自動説明',
  },
};
const tx = () => pick(T);

export function loadOrCreateToken(home) {
  const file = path.join(home, '.env');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const m = text.match(/^DEV_BRIDGE_TOKEN=(\S+)\s*$/m);
  if (m) return { token: m[1], file };
  const token = crypto.randomBytes(24).toString('hex');
  if (text && !text.endsWith('\n')) text += '\n';
  text += `${tx().envNote}\nDEV_BRIDGE_TOKEN=${token}\n`;
  fs.writeFileSync(file, text);
  return { token, file };
}

// Is the room stuck in a dev <-> AI back-and-forth that should wait for the user?
// `messages` are recent messages in order. Returns null or {why}.
// opts.userName: the owner's name for the English / Japanese reason text.
export function devChainState(messages, now, opts = {}) {
  const { replyCap = 6, roundsWithoutUser = 8, windowMs = 10 * 60000 } = opts;
  const user = opts.userName || pick(LANG_DEFAULTS).userName;
  let lastDev = -1, lastUser = -1;
  for (let i = messages.length - 1; i >= 0 && (lastDev < 0 || lastUser < 0); i--) {
    if (lastDev < 0 && messages[i].from === DEV.id) lastDev = i;
    if (lastUser < 0 && messages[i].from === 'user') lastUser = i;
  }
  if (lastDev < 0 || lastUser > lastDev) return null;
  if (now - messages[lastDev].ts > windowMs) return null;
  const aiAfter = messages.slice(lastDev + 1).filter((m) => AI_IDS.includes(m.from)).length;
  // replyCap 0 turns this half of the guard off.
  if (replyCap > 0 && aiAfter >= replyCap) return { why: tx().replyCap(aiAfter) };
  const devRounds = messages.slice(lastUser + 1).filter((m) => m.from === DEV.id).length;
  // roundsWithoutUser 0 turns this half off too; with both at 0 there is no pause.
  if (roundsWithoutUser > 0 && devRounds >= roundsWithoutUser) return { why: tx().rounds(devRounds, user) };
  return null;
}

export class DevBridge {
  // ctx: {store, cfg, post(msg), fileChanged(result), roomView(), onPresence(online)}
  constructor(home, ctx) {
    this.ctx = ctx;
    const { token, file } = loadOrCreateToken(home);
    this.token = token;
    this.tokenFile = file;
    this.lastCall = 0;
    this.waiters = new Set();
    // Pick up where the log left off: if the dev was in when the server went down, keep it
    // "in" for the grace period so a quick reconnect is silent and a no-show gets its 나감.
    // (Old logs have no `online` field: read the "joined" text, in any room language.)
    const last = [...ctx.store.messages].reverse().find((m) => m.kind === 'dev');
    this.online = last ? (last.online ?? /들어옴|joined|入ってきた/.test(last.text || '')) : false;
    if (this.online) this.lastCall = Date.now();
    this.timer = setInterval(() => this.checkPresence(), 3000);
    this.timer.unref?.();
  }

  authorized(req) {
    if (req.headers.origin) return false;
    const h = String(req.headers.authorization || '');
    const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7).trim() : '');
    const want = Buffer.from(this.token);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  isOnline() {
    return this.waiters.size > 0 || Date.now() - this.lastCall < ONLINE_GRACE_MS;
  }

  checkPresence() {
    const now = this.isOnline();
    if (now !== this.online) {
      this.online = now;
      this.ctx.onPresence(now);
    }
  }

  touch() {
    this.lastCall = Date.now();
    this.checkPresence();
  }

  view(m) {
    const out = { id: m.id, ts: m.ts, from: m.from, name: displayName(m.from, this.ctx.cfg.userName), text: m.text || '' };
    if (m.kind) out.kind = m.kind;
    if (m.replyTo) out.reply_to = m.replyTo;
    if (m.attach) out.attach = m.attach.desc ? `${m.attach.path} — ${tx().autoDesc}: ${m.attach.desc}` : m.attach.path;
    if (m.model) out.model = m.model;
    const reacts = Object.entries(m.reactions || {}).filter(([, l]) => l.length);
    if (reacts.length) out.reactions = Object.fromEntries(reacts.map(([e, l]) => [e, l.map((x) => displayName(x, this.ctx.cfg.userName))]));
    return out;
  }

  // Does message m wake a waiter?
  wakes(w, m) {
    if (m.id <= w.since || m.from === DEV.id) return false;
    if (!w.mentionOnly) return true;
    if (mentionsDev(m.text)) return true;
    return !!m.replyTo && this.ctx.store.byId.get(m.replyTo)?.from === DEV.id;
  }

  batch(since, limit = 50) {
    const msgs = this.ctx.store.after(since);
    return { messages: msgs.slice(-limit).map((m) => this.view(m)), last_id: this.ctx.store.lastId, skipped: Math.max(0, msgs.length - limit) };
  }

  // Called by the server for every new message.
  notify(m) {
    for (const w of [...this.waiters]) if (this.wakes(w, m)) w.finish(false);
  }

  leave() {
    for (const w of [...this.waiters]) w.finish(true);
    this.lastCall = 0;
    this.checkPresence();
  }

  close() {
    clearInterval(this.timer);
    for (const w of [...this.waiters]) w.finish(true);
  }

  // Handles /api/dev/*. helpers: {sendJson, readBody}. Returns true if handled.
  async handle(req, res, url, { sendJson, readBody }) {
    const p = url.pathname;
    if (!p.startsWith('/api/dev/')) return false;
    if (!this.authorized(req)) {
      sendJson(res, 401, { error: 'dev bridge token required' });
      return true;
    }
    const { store } = this.ctx;
    const q = url.searchParams;
    this.touch();

    if (req.method === 'GET' && p === '/api/dev/status') {
      sendJson(res, 200, { online: this.online, last_id: store.lastId, room: this.ctx.roomView(), you: DEV.name });
      return true;
    }
    if (req.method === 'GET' && p === '/api/dev/messages') {
      const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 40));
      const since = q.has('since') ? Number(q.get('since')) || 0 : Math.max(0, store.lastId - limit);
      sendJson(res, 200, this.batch(since, limit));
      return true;
    }
    if (req.method === 'GET' && p === '/api/dev/wait') {
      const since = Number(q.get('since')) || 0;
      const timeout = Math.min(MAX_WAIT_SEC, Math.max(1, Number(q.get('timeout')) || 30));
      const mentionOnly = /^(1|true|yes)$/i.test(q.get('mention_only') || '');
      const w = { since, mentionOnly };
      if (store.after(since).some((m) => this.wakes(w, m))) {
        sendJson(res, 200, { ...this.batch(since), timed_out: false });
        return true;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => w.finish(true), timeout * 1000);
        w.finish = (timedOut) => {
          if (!this.waiters.has(w)) return;
          this.waiters.delete(w);
          clearTimeout(timer);
          this.lastCall = Date.now();
          // On timeout nothing is consumed: last_id stays at `since`, so the next wait
          // still returns the in-between messages once something wakes it.
          if (!res.writableEnded) sendJson(res, 200, timedOut ? { messages: [], last_id: since, timed_out: true } : { ...this.batch(since), timed_out: false });
          resolve();
        };
        this.waiters.add(w);
        this.checkPresence();
        // res 'close' (not req 'close', which fires as soon as the request is read) = client went away.
        res.on('close', () => {
          if (!this.waiters.has(w)) return;
          this.waiters.delete(w);
          clearTimeout(timer);
          resolve();
        });
      });
      return true;
    }
    if (req.method === 'GET' && p === '/api/dev/workspace') {
      sendJson(res, 200, { files: store.listFiles().map((f) => ({ path: f.path, size: f.size, mtime: f.mtime, by: f.by })) });
      return true;
    }
    if (req.method === 'GET' && p === '/api/dev/workspace/file') {
      try {
        sendJson(res, 200, store.readFile(q.get('path')));
      } catch (e) {
        sendJson(res, 404, { error: e.message });
      }
      return true;
    }

    if (req.method !== 'POST') {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    let body;
    try { body = await readBody(req); } catch { sendJson(res, 400, { error: 'bad json' }); return true; }

    if (p === '/api/dev/messages') {
      const text = String(body.text ?? '').trim().slice(0, 4000);
      if (!text) { sendJson(res, 400, { error: 'empty' }); return true; }
      const replyTo = Number(body.reply_to);
      const msg = this.ctx.post({ from: DEV.id, text, replyTo: store.byId.has(replyTo) ? replyTo : undefined });
      const { cfg } = this.ctx;
      const chain = devChainState(store.recent(80), Date.now(), { ...cfg.dev, userName: cfg.userName });
      sendJson(res, 200, { ok: true, id: msg.id, ...(chain ? { warning: tx().paused(chain.why, cfg.userName) } : {}) });
      return true;
    }
    if (p === '/api/dev/leave') {
      sendJson(res, 200, { ok: true });
      this.leave();
      return true;
    }
    if (p === '/api/dev/workspace/file') {
      try {
        const r = store.applyFileOp({ op: 'write', path: body.path, content: body.content }, DEV.id);
        this.ctx.fileChanged(r);
        sendJson(res, 200, { ok: true, path: r.rel, op: r.op, size: r.size });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
      return true;
    }
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
}
