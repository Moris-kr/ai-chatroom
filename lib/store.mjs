// Persistence: chat log (append-only JSONL), room settings, private notes and the
// shared workspace folder the AIs can read and write.

import fs from 'node:fs';
import path from 'node:path';

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.svg', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.py', '.yaml', '.yml', '.xml', '.tsv']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
export const MAX_FILE_BYTES = 60 * 1024;
const MAX_FILES = 300;
const MAX_NOTE_CHARS = 4000;

export class Store {
  constructor(root) {
    this.root = root;
    this.dataDir = path.join(root, 'data');
    this.notesDir = path.join(this.dataDir, 'notes');
    this.logDir = path.join(this.dataDir, 'logs');
    this.wsDir = path.join(root, 'workspace');
    for (const d of [this.dataDir, this.notesDir, this.logDir, this.wsDir]) fs.mkdirSync(d, { recursive: true });

    this.msgFile = path.join(this.dataDir, 'messages.jsonl');
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.metaFile = path.join(this.dataDir, 'workspace-meta.json');

    this.messages = [];
    this.byId = new Map();
    this.nextId = 1;
    this.loadMessages();
    this.state = readJson(this.stateFile, {});
    this.meta = readJson(this.metaFile, {});
  }

  // ---------- messages ----------
  loadMessages() {
    if (!fs.existsSync(this.msgFile)) return;
    const lines = fs.readFileSync(this.msgFile, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.kind === 'react') { this.applyReaction(rec.target, rec.by, rec.emoji, false); continue; }
      if (rec.kind === 'desc') { this.setAttachDesc(rec.target, rec.text, false); continue; }
      rec.reactions ??= {};
      this.messages.push(rec);
      this.byId.set(rec.id, rec);
      this.nextId = Math.max(this.nextId, rec.id + 1);
    }
  }

  addMessage(m) {
    const msg = { id: this.nextId++, ts: Date.now(), reactions: {}, ...m };
    this.messages.push(msg);
    this.byId.set(msg.id, msg);
    fs.appendFileSync(this.msgFile, JSON.stringify(msg) + '\n');
    return msg;
  }

  // Toggle-free: an emoji reaction is added once per (member, emoji).
  applyReaction(targetId, by, emoji, persist = true) {
    const msg = this.byId.get(targetId);
    if (!msg || !emoji) return null;
    const list = (msg.reactions[emoji] ??= []);
    if (list.includes(by)) return null;
    list.push(by);
    if (persist) fs.appendFileSync(this.msgFile, JSON.stringify({ kind: 'react', target: targetId, by, emoji, ts: Date.now() }) + '\n');
    return msg;
  }

  // Text description of an uploaded photo, for the members whose CLI cannot take images.
  setAttachDesc(targetId, text, persist = true) {
    const msg = this.byId.get(targetId);
    if (!msg?.attach || !text) return null;
    msg.attach.desc = String(text);
    if (persist) fs.appendFileSync(this.msgFile, JSON.stringify({ kind: 'desc', target: targetId, text: msg.attach.desc, ts: Date.now() }) + '\n');
    return msg;
  }

  get lastId() { return this.nextId - 1; }
  lastMessage() { return this.messages[this.messages.length - 1]; }
  after(id) {
    // messages are in id order; walk backwards for speed
    const out = [];
    for (let i = this.messages.length - 1; i >= 0 && this.messages[i].id > id; i--) out.push(this.messages[i]);
    return out.reverse();
  }
  recent(n) { return this.messages.slice(-n); }

  // ---------- room state ----------
  saveState() { writeJson(this.stateFile, this.state); }

  // ---------- notes (private per AI) ----------
  readNote(id) {
    const f = path.join(this.notesDir, `${id}.md`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  }
  writeNote(id, text) {
    let t = String(text ?? '');
    if (t.length > MAX_NOTE_CHARS) t = t.slice(t.length - MAX_NOTE_CHARS);
    fs.writeFileSync(path.join(this.notesDir, `${id}.md`), t);
    return t;
  }
  appendNote(id, line) {
    const cur = this.readNote(id);
    return this.writeNote(id, (cur ? cur.replace(/\s*$/, '\n') : '') + String(line).trim() + '\n');
  }

  // ---------- workspace ----------
  // Returns a safe relative path (forward slashes) or throws.
  safeRel(p) {
    let rel = String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!rel) throw new Error('빈 경로');
    rel = path.posix.normalize(rel);
    if (rel.startsWith('..') || path.posix.isAbsolute(rel) || rel.includes('\0')) throw new Error('작업공간 밖 경로');
    if (rel.split('/').length > 4) throw new Error('폴더가 너무 깊음');
    if (!/^[\p{L}\p{N} _.\-()/]+$/u.test(rel)) throw new Error('경로에 쓸 수 없는 문자');
    const ext = path.posix.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext) && !IMAGE_EXT.has(ext)) throw new Error(`허용 안 되는 확장자 ${ext || '(없음)'}`);
    return rel;
  }
  abs(rel) { return path.join(this.wsDir, ...rel.split('/')); }
  isImage(rel) { return IMAGE_EXT.has(path.posix.extname(rel).toLowerCase()); }

  listFiles() {
    const out = [];
    const walk = (dir, prefix) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
        else {
          const st = fs.statSync(path.join(dir, ent.name));
          const m = this.meta[rel] || {};
          out.push({ path: rel, size: st.size, mtime: st.mtimeMs, by: m.by || null, createdBy: m.createdBy || m.by || null });
        }
      }
    };
    walk(this.wsDir, '');
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  readFile(p) {
    const rel = this.safeRel(p);
    const f = this.abs(rel);
    if (!fs.existsSync(f)) throw new Error(`없는 파일 ${rel}`);
    if (this.isImage(rel)) return { rel, image: true, size: fs.statSync(f).size };
    return { rel, text: fs.readFileSync(f, 'utf8') };
  }

  // op: {op: write|append|edit|delete, path, content, find, replace}
  applyFileOp(op, by) {
    const rel = this.safeRel(op.path);
    if (this.isImage(rel) && op.op !== 'delete') throw new Error('이미지 파일은 직접 못 씀');
    const f = this.abs(rel);
    const exists = fs.existsSync(f);
    let text;
    switch (op.op) {
      case 'write':
        if (!exists && this.listFiles().length >= MAX_FILES) throw new Error('파일 개수 한도');
        text = String(op.content ?? '');
        break;
      case 'append': {
        const cur = exists ? fs.readFileSync(f, 'utf8') : '';
        const add = String(op.content ?? '');
        // Models often omit the leading newline when appending a line.
        const glue = cur && !cur.endsWith('\n') && !add.startsWith('\n') ? '\n' : '';
        text = cur + glue + add;
        break;
      }
      case 'edit': {
        if (!exists) throw new Error(`없는 파일 ${rel}`);
        const cur = fs.readFileSync(f, 'utf8');
        const find = String(op.find ?? '');
        if (!find || !cur.includes(find)) throw new Error(`${rel}에서 바꿀 부분을 못 찾음`);
        text = cur.replace(find, String(op.replace ?? ''));
        break;
      }
      case 'delete':
        if (!exists) throw new Error(`없는 파일 ${rel}`);
        fs.rmSync(f);
        delete this.meta[rel];
        writeJson(this.metaFile, this.meta);
        return { rel, op: 'delete' };
      default:
        throw new Error(`모르는 작업 ${op.op}`);
    }
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error(`${rel} 너무 큼(60KB 초과)`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    this.touchMeta(rel, by, !exists);
    return { rel, op: exists ? op.op : 'create', size: Buffer.byteLength(text) };
  }

  // Register a binary file (generated image) that was copied into the workspace.
  touchMeta(rel, by, created) {
    const m = (this.meta[rel] ??= {});
    if (created || !m.createdBy) m.createdBy = by;
    m.by = by;
    m.at = Date.now();
    writeJson(this.metaFile, this.meta);
  }

  log(id, text) {
    const line = `[${new Date().toISOString()}] ${text}\n`;
    fs.appendFileSync(path.join(this.logDir, `${id}.log`), line);
  }
}

function readJson(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; }
}
function writeJson(f, v) {
  fs.writeFileSync(f, JSON.stringify(v, null, 2));
}
