// Shared building world: a small voxel grid the members build in together.
// Flat grass ground at y=0 that can't be removed; blocks go at y=1..H-1.
// State lives in data/world.json; the server broadcasts changes to the 3D viewer
// (public/world.html) and describes the world to the AIs as text.

import fs from 'node:fs';
import path from 'node:path';

export const SIZE = { x: 48, y: 32, z: 48 };

// name -> [map letter, color]. Letters are what the AIs see in world_look maps.
export const PALETTE = {
  stone: ['s', '#9a9da3'],
  cobble: ['c', '#76787d'],
  dirt: ['d', '#8b5a2b'],
  grass: ['g', '#5fa04e'],
  sand: ['a', '#e2d39b'],
  log: ['w', '#7a5230'],
  planks: ['p', '#c8a063'],
  leaves: ['l', '#3f8f3a'],
  brick: ['b', '#b5533c'],
  glass: ['G', '#cfeefc'],
  water: ['W', '#3d7fd8'],
  snow: ['n', '#f5f7fa'],
  gold: ['o', '#f2c230'],
  lamp: ['L', '#ffe9a0'],
  white: ['h', '#ececec'],
  black: ['k', '#26272b'],
  red: ['r', '#d23c3c'],
  orange: ['O', '#e8872e'],
  yellow: ['y', '#e8d23c'],
  green: ['e', '#3fbf5f'],
  blue: ['u', '#3c5fd2'],
  purple: ['v', '#8a4fd0'],
  pink: ['i', '#f28fb8'],
  // textured in the viewer
  bookshelf: ['B', '#8b5a2b'],
  door: ['D', '#9a6a3a'], // always a thin panel; members walk through it
};
const NAMES = Object.keys(PALETTE);
const LETTER = Object.fromEntries(NAMES.map((n) => [n, PALETTE[n][0]]));

// Stored block value: "name", "name/slab", "name/stair/<n|e|s|w>", "door/<x|z>".
export const SHAPES = ['slab', 'stair'];
const FACINGS = ['n', 'e', 's', 'w'];
export const parseBlock = (v) => {
  const [type, shape, facing] = String(v).split('/');
  if (type === 'door') return { type, shape: 'door', facing: shape || '' };
  return { type, shape: shape || 'full', facing: facing || '' };
};

// Member-made blocks (block_define): an 8x8 pixel picture on every face.
const MAX_CUSTOM = 40;
const CUSTOM_NAME = /^[a-z][a-z0-9_]{1,19}$/;
const MAX_SIGNS = 60;
const MAX_SIGN_CHARS = 24;

const MAX_OPS = 60;          // entries per turn
const MAX_FILL = 4096;       // blocks in one fill/hollow/remove box
const MAX_CHANGES = 12000;   // blocks changed per turn
const MAX_BLOCKS = 80000;    // whole world

const key = (x, y, z) => `${x},${y},${z}`;
const inside = (x, y, z) => x >= 0 && x < SIZE.x && z >= 0 && z < SIZE.z && y >= 1 && y < SIZE.y;
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

export class World {
  constructor(home, ids) {
    this.file = path.join(home, 'data', 'world.json');
    const saved = readJson(this.file, {});
    this.blocks = new Map(Object.entries(saved.blocks || {})); // "x,y,z" -> block name
    this.avatars = saved.avatars || {};
    this.log = saved.log || []; // recent ops: {by, at, text}
    this.custom = saved.custom || {}; // name -> {pixels: [8 strings], colors: {ch: '#rrggbb'}, glow, clear, by}
    this.signs = saved.signs || {}; // "x,y,z" -> {text, facing, width, bg, color, glow, by}
    // Spawn points near the corners, facing the middle.
    const spawn = [[6, 6], [41, 6], [6, 41], [41, 41]];
    ids.forEach((id, i) => { this.avatars[id] ??= { x: spawn[i % 4][0], z: spawn[i % 4][1] }; });
    this.saveTimer = null;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.writeFileSync(this.file, JSON.stringify({ blocks: Object.fromEntries(this.blocks), avatars: this.avatars, log: this.log.slice(-60), custom: this.custom, signs: this.signs }));
    }, 400);
  }

  // Standing height at a column: on top of the highest block (ground is y=0). Doors don't
  // count, so a member standing in a doorway isn't lifted onto the door.
  topY(x, z) {
    for (let y = SIZE.y - 1; y >= 1; y--) {
      const v = this.blocks.get(key(x, y, z));
      if (v && parseBlock(v).type !== 'door') return y;
    }
    return 0;
  }

  // Register a member-made block. Returns its name, or throws with a message for the member.
  define(def, by) {
    const d = def && typeof def === 'object' ? def : {};
    const name = String(d.name ?? '').trim().toLowerCase();
    if (!CUSTOM_NAME.test(name)) throw new Error('이름은 영어 소문자·숫자·_로 2~20자 (예: moss_brick)');
    if (PALETTE[name]) throw new Error(`${name}은 원래 있는 블록이야`);
    if (!this.custom[name] && Object.keys(this.custom).length >= MAX_CUSTOM) throw new Error(`직접 만든 블록은 ${MAX_CUSTOM}개까지야`);
    const colors = {};
    for (const [ch, c] of Object.entries(d.colors || {})) {
      if (ch.length !== 1 || ch === '.') continue;
      if (!/^#[0-9a-fA-F]{6}$/.test(String(c))) throw new Error(`색 "${c}"은 #rrggbb 형식이어야 해`);
      colors[ch] = String(c).toLowerCase();
    }
    if (!Object.keys(colors).length || Object.keys(colors).length > 12) throw new Error('colors에 글자→색을 1~12개 넣어 (예: {"a": "#556b2f"})');
    const rows = Array.isArray(d.pixels) ? d.pixels.map(String) : [];
    if (rows.length !== 8 || rows.some((r) => [...r].length !== 8)) throw new Error('pixels는 8글자짜리 줄 8개야');
    const clear = d.clear === true;
    for (const r of rows) for (const ch of r) {
      if (ch === '.' ? !clear : !colors[ch]) throw new Error(ch === '.' ? '"."(빈칸)는 clear: true일 때만 돼' : `pixels의 "${ch}"가 colors에 없어`);
    }
    this.custom[name] = { pixels: rows, colors, glow: d.glow === true, clear, by, at: Date.now() };
    this.save();
    return name;
  }
  isBlock(name) { return !!(PALETTE[name] || this.custom[name]); }
  blockNames() { return [...NAMES, ...Object.keys(this.custom)]; }

  view() {
    return {
      size: SIZE,
      palette: Object.fromEntries(NAMES.map((n) => [n, PALETTE[n][1]])),
      custom: this.custom,
      signs: this.signs,
      blocks: [...this.blocks].map(([k, t]) => [...k.split(',').map(Number), t]),
      avatars: this.avatarView(),
    };
  }
  avatarView() {
    return Object.fromEntries(Object.entries(this.avatars).map(([id, a]) => [id, { x: a.x, z: a.z, y: this.topY(a.x, a.z) + 1 }]));
  }

  // Apply one member's "build" list. Returns {changes: [[x,y,z,name|null]], notes: [..],
  // signs: number of signs placed/changed/removed}.
  apply(ops, by) {
    const changes = new Map();
    const notes = [];
    let budget = MAX_CHANGES;
    let signs = 0;
    const set = (x, y, z, t) => {
      if (!inside(x, y, z) || budget <= 0) return;
      const k = key(x, y, z);
      if (!t && this.signs[k]) { delete this.signs[k]; signs++; } // clearing a cell takes its sign too
      const cur = this.blocks.get(k) ?? null;
      if (cur === t) return;
      if (t && !cur && this.blocks.size >= MAX_BLOCKS) return;
      if (t) this.blocks.set(k, t); else this.blocks.delete(k);
      changes.set(k, t);
      budget--;
    };
    // Block name plus the op's shape/facing, encoded as stored (see parseBlock).
    const blockOf = (v, op) => {
      const n = String(v ?? '').trim().toLowerCase();
      if (!this.isBlock(n)) throw new Error(`모르는 블록 "${v}" (쓸 수 있는 것: ${this.blockNames().join(', ')})`);
      const facing = String(op.facing ?? '').trim().toLowerCase();
      if (n === 'door') {
        if (facing && !['x', 'z', ...FACINGS].includes(facing)) throw new Error('door의 facing은 x(동서로 뻗은 문) 또는 z(남북으로 뻗은 문)');
        const f = facing === 'n' || facing === 's' ? 'x' : facing === 'e' || facing === 'w' ? 'z' : facing;
        return f ? `door/${f}` : 'door';
      }
      const shape = String(op.shape ?? 'full').trim().toLowerCase();
      if (shape === 'full' || !shape) return n;
      if (!SHAPES.includes(shape)) throw new Error(`모르는 모양 "${op.shape}" (full, slab, stair)`);
      if (shape === 'slab') return `${n}/slab`;
      if (facing && !FACINGS.includes(facing)) throw new Error('stair의 facing은 n, e, s, w (높은 쪽 방향)');
      return `${n}/stair/${facing || 'n'}`;
    };
    const point = (p, label) => {
      const [x, y, z] = Array.isArray(p) ? p.map(int) : [int(p?.x), int(p?.y), int(p?.z)];
      if ([x, y, z].some(Number.isNaN)) throw new Error(`${label} 좌표가 이상해`);
      return [x, y, z];
    };
    const box = (op) => {
      const a = point(op.from, 'from');
      const b = point(op.to, 'to');
      const lo = [0, 1, 2].map((i) => Math.min(a[i], b[i]));
      const hi = [0, 1, 2].map((i) => Math.max(a[i], b[i]));
      const vol = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
      if (vol > MAX_FILL) throw new Error(`한 번에 ${MAX_FILL}칸까지야 (${vol}칸)`);
      return [lo, hi];
    };
    for (const op of (Array.isArray(ops) ? ops : [ops]).slice(0, MAX_OPS)) {
      if (!op || typeof op !== 'object') continue;
      try {
        const kind = String(op.op || 'place');
        if (kind === 'sign') {
          const [x, y, z] = point(op.at ?? op, 'at');
          if (!inside(x, y, z)) throw new Error(`월드 밖 (${x},${y},${z})`);
          const k = key(x, y, z);
          const text = [...String(op.text ?? '').replace(/\s+/g, ' ').trim()].slice(0, MAX_SIGN_CHARS).join('');
          if (!text) { if (this.signs[k]) { delete this.signs[k]; signs++; } continue; }
          if (!this.signs[k] && Object.keys(this.signs).length >= MAX_SIGNS) throw new Error(`간판은 ${MAX_SIGNS}개까지야`);
          const facing = String(op.facing ?? 's').trim().toLowerCase();
          if (!FACINGS.includes(facing)) throw new Error('간판 facing은 n, e, s, w (글자가 보이는 쪽)');
          const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v ?? '')) ? String(v).toLowerCase() : d);
          const width = clamp(int(op.width ?? Math.ceil([...text].length / 2)), 1, 6); // ~2 Korean letters a cell
          this.signs[k] = { text, facing, width, bg: hex(op.bg, '#6b4a2a'), color: hex(op.color, '#fff4d6'), glow: op.glow === true, by };
          signs++;
          continue;
        }
        if (kind === 'place' || kind === 'remove' && !op.from) {
          const [x, y, z] = point(op.at ?? op, 'at');
          if (!inside(x, y, z)) throw new Error(`월드 밖 (${x},${y},${z}). x,z는 0~${SIZE.x - 1}, y는 1~${SIZE.y - 1}`);
          set(x, y, z, kind === 'remove' ? null : blockOf(op.block, op));
        } else if (kind === 'fill' || kind === 'hollow' || kind === 'remove') {
          const [lo, hi] = box(op);
          const t = kind === 'remove' ? null : blockOf(op.block, op);
          for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
            const edge = x === lo[0] || x === hi[0] || y === lo[1] || y === hi[1] || z === lo[2] || z === hi[2];
            if (kind === 'hollow' && !edge) set(x, y, z, null);
            else set(x, y, z, t);
          }
        } else {
          throw new Error(`모르는 작업 "${kind}" (place, fill, hollow, remove, sign)`);
        }
      } catch (e) {
        notes.push(e.message);
      }
    }
    if (budget <= 0) notes.push(`한 턴에 ${MAX_CHANGES}칸까지만 바뀌어서 나머지는 안 됐어`);
    const out = [...changes].map(([k, t]) => [...k.split(',').map(Number), t]);
    if (out.length || signs) {
      const placed = out.filter((c) => c[3]).length;
      const parts = [];
      if (placed) parts.push(`${placed}칸 놓음`);
      if (out.length - placed) parts.push(`${out.length - placed}칸 지움`);
      if (signs) parts.push(`간판 ${signs}개`);
      this.log.push({ by, at: Date.now(), text: `${parts.join(', ')}${out.length ? ` (${describeSpan(out)})` : ''}` });
      this.log = this.log.slice(-60);
      this.save();
    }
    return { changes: out, notes, signs };
  }

  move(id, to) {
    const x = int(Array.isArray(to) ? to[0] : to?.x);
    const z = int(Array.isArray(to) ? to[1] : to?.z);
    if (Number.isNaN(x) || Number.isNaN(z)) return false;
    this.avatars[id] = { x: Math.max(0, Math.min(SIZE.x - 1, x)), z: Math.max(0, Math.min(SIZE.z - 1, z)) };
    this.save();
    return true;
  }

  // Short summary that goes into every turn.
  summary(selfId, nameOf) {
    const counts = {};
    let lo = null, hi = null;
    for (const [k, v] of this.blocks) {
      const t = parseBlock(v).type;
      counts[t] = (counts[t] || 0) + 1;
      const p = k.split(',').map(Number);
      lo = lo ? lo.map((v, i) => Math.min(v, p[i])) : p;
      hi = hi ? hi.map((v, i) => Math.max(v, p[i])) : p;
    }
    const pos = Object.entries(this.avatarView()).map(([id, a]) => `${nameOf(id)}${id === selfId ? '(나)' : ''} (${a.x},${a.z})`).join(', ');
    const lines = [`크기 x 0~${SIZE.x - 1}, z 0~${SIZE.z - 1}, 높이 y 1~${SIZE.y - 1} (y=0은 잔디 땅). 블록 ${this.blocks.size}개${this.blocks.size ? ` · 쓰인 범위 (${lo.join(',')})~(${hi.join(',')})` : ''}`];
    if (this.blocks.size) lines.push(`종류: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ')}`);
    const signList = Object.entries(this.signs);
    if (signList.length) lines.push(`간판: ${signList.slice(0, 12).map(([k, s]) => `"${s.text}" (${k}, ${s.facing})`).join(', ')}${signList.length > 12 ? ` …외 ${signList.length - 12}개` : ''}`);
    const custom = Object.entries(this.custom);
    if (custom.length) lines.push(`직접 만든 블록: ${custom.map(([n, c]) => `${n}(${nameOf(c.by)}${c.glow ? ', 빛남' : ''}${c.clear ? ', 투명' : ''})`).join(', ')}`);
    lines.push(`캐릭터 위치(x,z): ${pos}`);
    const recent = this.log.slice(-8).map((l) => `- ${nameOf(l.by)}: ${l.text}`);
    if (recent.length) lines.push(`최근 작업:\n${recent.join('\n')}`);
    return lines.join('\n');
  }

  // Text map for world_look: {y} gives that layer, otherwise a top view (top block letter
  // plus height). Optional region x1,z1,x2,z2.
  look(req = {}) {
    const r = typeof req === 'object' && req ? req : {};
    const x1 = clamp(int(r.x1 ?? 0), 0, SIZE.x - 1), x2 = clamp(int(r.x2 ?? SIZE.x - 1), 0, SIZE.x - 1);
    const z1 = clamp(int(r.z1 ?? 0), 0, SIZE.z - 1), z2 = clamp(int(r.z2 ?? SIZE.z - 1), 0, SIZE.z - 1);
    const [xa, xb] = [Math.min(x1, x2), Math.max(x1, x2)];
    const [za, zb] = [Math.min(z1, z2), Math.max(z1, z2)];
    const legend = `글자: ${NAMES.map((n) => `${LETTER[n]}=${n}`).join(' ')} *=직접 만든 블록 .=빈칸 (반블록·계단은 재료 글자로 보여)`;
    const letterOf = (v) => LETTER[parseBlock(v).type] ?? '*';
    const header = (w) => `     x→ ${Array.from({ length: w }, (_, i) => String((xa + i) % 10)).join('')}`;
    const rows = [];
    if (Number.isFinite(int(r.y))) {
      const y = clamp(int(r.y), 1, SIZE.y - 1);
      rows.push(`[층 y=${y}] x ${xa}~${xb}, z ${za}~${zb}`, legend, header(xb - xa + 1));
      for (let z = za; z <= zb; z++) {
        let s = '';
        for (let x = xa; x <= xb; x++) { const t = this.blocks.get(key(x, y, z)); s += t ? letterOf(t) : '.'; }
        rows.push(`z${String(z).padStart(2, '0')}  ${s}`);
      }
      return rows.join('\n');
    }
    rows.push(`[위에서 본 지도] x ${xa}~${xb}, z ${za}~${zb}. 맨 위 블록 글자와 높이(0~9, a=10 … v=31, .=맨땅)`, legend, header(xb - xa + 1));
    for (let z = za; z <= zb; z++) {
      let s = '', h = '';
      for (let x = xa; x <= xb; x++) {
        const y = this.topY(x, z);
        s += y ? letterOf(this.blocks.get(key(x, y, z))) : '.';
        h += y ? y.toString(32) : '.';
      }
      rows.push(`z${String(z).padStart(2, '0')}  ${s}   ${h}`);
    }
    return rows.join('\n');
  }
}

function describeSpan(changes) {
  const lo = [0, 1, 2].map((i) => Math.min(...changes.map((c) => c[i])));
  const hi = [0, 1, 2].map((i) => Math.max(...changes.map((c) => c[i])));
  return lo.join(',') === hi.join(',') ? `${lo.join(',')}` : `${lo.join(',')}~${hi.join(',')}`;
}
function clamp(v, a, b) { return Number.isNaN(v) ? a : Math.max(a, Math.min(b, v)); }
function readJson(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; }
}
