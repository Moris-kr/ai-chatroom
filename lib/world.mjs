// Shared building world: a small voxel grid the members build in together.
// Flat grass ground at y=0 that can't be removed; blocks go at y=1..H-1.
// State lives in data/world.json; the server broadcasts changes to the 3D viewer
// (public/world.html) and describes the world to the AIs as text.

import fs from 'node:fs';
import path from 'node:path';
import { pick } from './i18n.mjs';

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

// Texts the members read: validation errors, the build log, the summary and world_look maps.
// Coordinates, letters and the map layout are the same in every language.
const many = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const T = {
  ko: {
    badName: '이름은 영어 소문자·숫자·_로 2~20자 (예: moss_brick)',
    builtIn: (n) => `${n}은 원래 있는 블록이야`,
    customMax: (max) => `직접 만든 블록은 ${max}개까지야`,
    badColor: (c) => `색 "${c}"은 #rrggbb 형식이어야 해`,
    colorCount: 'colors에 글자→색을 1~12개 넣어 (예: {"a": "#556b2f"})',
    pixelRows: 'pixels는 8글자짜리 줄 8개야',
    dotNeedsClear: '"."(빈칸)는 clear: true일 때만 돼',
    pixelNoColor: (ch) => `pixels의 "${ch}"가 colors에 없어`,
    unknownBlock: (v, names) => `모르는 블록 "${v}" (쓸 수 있는 것: ${names})`,
    doorFacing: 'door의 facing은 x(동서로 뻗은 문) 또는 z(남북으로 뻗은 문)',
    unknownShape: (s) => `모르는 모양 "${s}" (full, slab, stair)`,
    stairFacing: 'stair의 facing은 n, e, s, w (높은 쪽 방향)',
    badPoint: (label) => `${label} 좌표가 이상해`,
    boxMax: (max, vol) => `한 번에 ${max}칸까지야 (${vol}칸)`,
    outside: (x, y, z) => `월드 밖 (${x},${y},${z})`,
    signMax: (max) => `간판은 ${max}개까지야`,
    signFacing: '간판 facing은 n, e, s, w (글자가 보이는 쪽)',
    outsideRange: (x, y, z, mx, my) => `월드 밖 (${x},${y},${z}). x,z는 0~${mx}, y는 1~${my}`,
    unknownOp: (k) => `모르는 작업 "${k}" (place, fill, hollow, remove, sign)`,
    turnMax: (max) => `한 턴에 ${max}칸까지만 바뀌어서 나머지는 안 됐어`,
    placed: (n) => `${n}칸 놓음`,
    removed: (n) => `${n}칸 지움`,
    signs: (n) => `간판 ${n}개`,
    sep: ', ',
    me: '(나)',
    size: (mx, mz, my) => `크기 x 0~${mx}, z 0~${mz}, 높이 y 1~${my} (y=0은 잔디 땅). `,
    blocks: (n) => `블록 ${n}개`,
    span: (lo, hi) => ` · 쓰인 범위 (${lo})~(${hi})`,
    kinds: '종류',
    signList: '간판',
    more: (n) => ` …외 ${n}개`,
    custom: '직접 만든 블록',
    glow: ', 빛남',
    clear: ', 투명',
    positions: '캐릭터 위치(x,z)',
    recent: '최근 작업',
    legend: (letters) => `글자: ${letters} *=직접 만든 블록 .=빈칸 (반블록·계단은 재료 글자로 보여)`,
    layer: (y, xa, xb, za, zb) => `[층 y=${y}] x ${xa}~${xb}, z ${za}~${zb}`,
    top: (xa, xb, za, zb) => `[위에서 본 지도] x ${xa}~${xb}, z ${za}~${zb}. 맨 위 블록 글자와 높이(0~9, a=10 … v=31, .=맨땅)`,
  },
  en: {
    badName: 'The name must be 2-20 lowercase letters, digits or _ (e.g. moss_brick)',
    builtIn: (n) => `${n} is already a built-in block`,
    customMax: (max) => `Up to ${max} custom blocks`,
    badColor: (c) => `Color "${c}" must be #rrggbb`,
    colorCount: 'Put 1-12 letter→color pairs in colors (e.g. {"a": "#556b2f"})',
    pixelRows: 'pixels must be 8 rows of 8 characters',
    dotNeedsClear: '"." (empty) only works with clear: true',
    pixelNoColor: (ch) => `"${ch}" in pixels is not in colors`,
    unknownBlock: (v, names) => `Unknown block "${v}" (you can use: ${names})`,
    doorFacing: 'door facing is x (a door running east-west) or z (a door running north-south)',
    unknownShape: (s) => `Unknown shape "${s}" (full, slab, stair)`,
    stairFacing: 'stair facing is n, e, s or w (the high side)',
    badPoint: (label) => `"${label}" coordinates look wrong`,
    boxMax: (max, vol) => `Up to ${max} cells at once (${many(vol, 'cell')})`,
    outside: (x, y, z) => `Outside the world (${x},${y},${z})`,
    signMax: (max) => `Up to ${max} signs`,
    signFacing: 'sign facing is n, e, s or w (the side the text faces)',
    outsideRange: (x, y, z, mx, my) => `Outside the world (${x},${y},${z}). x,z are 0~${mx}, y is 1~${my}`,
    unknownOp: (k) => `Unknown op "${k}" (place, fill, hollow, remove, sign)`,
    turnMax: (max) => `Only ${max} cells can change per turn, so the rest didn't happen`,
    placed: (n) => `placed ${many(n, 'block')}`,
    removed: (n) => `removed ${many(n, 'block')}`,
    signs: (n) => many(n, 'sign'),
    sep: ', ',
    me: '(you)',
    size: (mx, mz, my) => `Size x 0~${mx}, z 0~${mz}, height y 1~${my} (y=0 is the grass ground). `,
    blocks: (n) => many(n, 'block'),
    span: (lo, hi) => ` · used area (${lo})~(${hi})`,
    kinds: 'Types',
    signList: 'Signs',
    more: (n) => ` …and ${n} more`,
    custom: 'Custom blocks',
    glow: ', glows',
    clear: ', see-through',
    positions: 'Positions (x,z)',
    recent: 'Recent work',
    legend: (letters) => `Letters: ${letters} *=custom block .=empty (slabs and stairs show their material's letter)`,
    layer: (y, xa, xb, za, zb) => `[Layer y=${y}] x ${xa}~${xb}, z ${za}~${zb}`,
    top: (xa, xb, za, zb) => `[Top view] x ${xa}~${xb}, z ${za}~${zb}. Top block letter and height (0~9, a=10 … v=31, .=bare ground)`,
  },
  ja: {
    badName: '名前は英小文字・数字・_で2~20文字(例: moss_brick)',
    builtIn: (n) => `${n}は元からあるブロックだよ`,
    customMax: (max) => `自作ブロックは${max}個まで`,
    badColor: (c) => `色 "${c}" は #rrggbb 形式にして`,
    colorCount: 'colorsに文字→色を1~12個入れて(例: {"a": "#556b2f"})',
    pixelRows: 'pixelsは8文字の行を8つにして',
    dotNeedsClear: '"."(空き)は clear: true のときだけ使える',
    pixelNoColor: (ch) => `pixelsの"${ch}"がcolorsにない`,
    unknownBlock: (v, names) => `知らないブロック "${v}" (使えるもの: ${names})`,
    doorFacing: 'doorのfacingは x(東西に延びるドア)か z(南北に延びるドア)',
    unknownShape: (s) => `知らない形 "${s}" (full, slab, stair)`,
    stairFacing: 'stairのfacingは n, e, s, w (高い側の向き)',
    badPoint: (label) => `${label}の座標がおかしい`,
    boxMax: (max, vol) => `一度に${max}マスまで(${vol}マス)`,
    outside: (x, y, z) => `ワールドの外 (${x},${y},${z})`,
    signMax: (max) => `看板は${max}個まで`,
    signFacing: '看板のfacingは n, e, s, w (文字が見える側)',
    outsideRange: (x, y, z, mx, my) => `ワールドの外 (${x},${y},${z})。x,zは0~${mx}、yは1~${my}`,
    unknownOp: (k) => `知らない操作 "${k}" (place, fill, hollow, remove, sign)`,
    turnMax: (max) => `1ターンで変えられるのは${max}マスまでだから、残りはできなかった`,
    placed: (n) => `${n}マス置いた`,
    removed: (n) => `${n}マス消した`,
    signs: (n) => `看板${n}個`,
    sep: '、',
    me: '(自分)',
    size: (mx, mz, my) => `サイズ x 0~${mx}, z 0~${mz}, 高さ y 1~${my} (y=0は草の地面)。`,
    blocks: (n) => `ブロック${n}個`,
    span: (lo, hi) => ` · 使われてる範囲 (${lo})~(${hi})`,
    kinds: '種類',
    signList: '看板',
    more: (n) => ` …ほか${n}個`,
    custom: '自作ブロック',
    glow: ', 光る',
    clear: ', 透明',
    positions: 'キャラの位置(x,z)',
    recent: '最近の作業',
    legend: (letters) => `文字: ${letters} *=自作ブロック .=空き (ハーフブロック・階段は素材の文字で表示)`,
    layer: (y, xa, xb, za, zb) => `[層 y=${y}] x ${xa}~${xb}, z ${za}~${zb}`,
    top: (xa, xb, za, zb) => `[上から見た地図] x ${xa}~${xb}, z ${za}~${zb}。一番上のブロックの文字と高さ(0~9, a=10 … v=31, .=地面)`,
  },
};
const tx = () => pick(T);

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
    if (!CUSTOM_NAME.test(name)) throw new Error(tx().badName);
    if (PALETTE[name]) throw new Error(tx().builtIn(name));
    if (!this.custom[name] && Object.keys(this.custom).length >= MAX_CUSTOM) throw new Error(tx().customMax(MAX_CUSTOM));
    const colors = {};
    for (const [ch, c] of Object.entries(d.colors || {})) {
      if (ch.length !== 1 || ch === '.') continue;
      if (!/^#[0-9a-fA-F]{6}$/.test(String(c))) throw new Error(tx().badColor(c));
      colors[ch] = String(c).toLowerCase();
    }
    if (!Object.keys(colors).length || Object.keys(colors).length > 12) throw new Error(tx().colorCount);
    const rows = Array.isArray(d.pixels) ? d.pixels.map(String) : [];
    if (rows.length !== 8 || rows.some((r) => [...r].length !== 8)) throw new Error(tx().pixelRows);
    const clear = d.clear === true;
    for (const r of rows) for (const ch of r) {
      if (ch === '.' ? !clear : !colors[ch]) throw new Error(ch === '.' ? tx().dotNeedsClear : tx().pixelNoColor(ch));
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
      if (!this.isBlock(n)) throw new Error(tx().unknownBlock(v, this.blockNames().join(', ')));
      const facing = String(op.facing ?? '').trim().toLowerCase();
      if (n === 'door') {
        if (facing && !['x', 'z', ...FACINGS].includes(facing)) throw new Error(tx().doorFacing);
        const f = facing === 'n' || facing === 's' ? 'x' : facing === 'e' || facing === 'w' ? 'z' : facing;
        return f ? `door/${f}` : 'door';
      }
      const shape = String(op.shape ?? 'full').trim().toLowerCase();
      if (shape === 'full' || !shape) return n;
      if (!SHAPES.includes(shape)) throw new Error(tx().unknownShape(op.shape));
      if (shape === 'slab') return `${n}/slab`;
      if (facing && !FACINGS.includes(facing)) throw new Error(tx().stairFacing);
      return `${n}/stair/${facing || 'n'}`;
    };
    const point = (p, label) => {
      const [x, y, z] = Array.isArray(p) ? p.map(int) : [int(p?.x), int(p?.y), int(p?.z)];
      if ([x, y, z].some(Number.isNaN)) throw new Error(tx().badPoint(label));
      return [x, y, z];
    };
    const box = (op) => {
      const a = point(op.from, 'from');
      const b = point(op.to, 'to');
      const lo = [0, 1, 2].map((i) => Math.min(a[i], b[i]));
      const hi = [0, 1, 2].map((i) => Math.max(a[i], b[i]));
      const vol = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
      if (vol > MAX_FILL) throw new Error(tx().boxMax(MAX_FILL, vol));
      return [lo, hi];
    };
    for (const op of (Array.isArray(ops) ? ops : [ops]).slice(0, MAX_OPS)) {
      if (!op || typeof op !== 'object') continue;
      try {
        const kind = String(op.op || 'place');
        if (kind === 'sign') {
          const [x, y, z] = point(op.at ?? op, 'at');
          if (!inside(x, y, z)) throw new Error(tx().outside(x, y, z));
          const k = key(x, y, z);
          const text = [...String(op.text ?? '').replace(/\s+/g, ' ').trim()].slice(0, MAX_SIGN_CHARS).join('');
          if (!text) { if (this.signs[k]) { delete this.signs[k]; signs++; } continue; }
          if (!this.signs[k] && Object.keys(this.signs).length >= MAX_SIGNS) throw new Error(tx().signMax(MAX_SIGNS));
          const facing = String(op.facing ?? 's').trim().toLowerCase();
          if (!FACINGS.includes(facing)) throw new Error(tx().signFacing);
          const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v ?? '')) ? String(v).toLowerCase() : d);
          const width = clamp(int(op.width ?? Math.ceil([...text].length / 2)), 1, 6); // ~2 Korean letters a cell
          this.signs[k] = { text, facing, width, bg: hex(op.bg, '#6b4a2a'), color: hex(op.color, '#fff4d6'), glow: op.glow === true, by };
          signs++;
          continue;
        }
        if (kind === 'place' || kind === 'remove' && !op.from) {
          const [x, y, z] = point(op.at ?? op, 'at');
          if (!inside(x, y, z)) throw new Error(tx().outsideRange(x, y, z, SIZE.x - 1, SIZE.y - 1));
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
          throw new Error(tx().unknownOp(kind));
        }
      } catch (e) {
        notes.push(e.message);
      }
    }
    if (budget <= 0) notes.push(tx().turnMax(MAX_CHANGES));
    const out = [...changes].map(([k, t]) => [...k.split(',').map(Number), t]);
    if (out.length || signs) {
      const t = tx();
      const placed = out.filter((c) => c[3]).length;
      const parts = [];
      if (placed) parts.push(t.placed(placed));
      if (out.length - placed) parts.push(t.removed(out.length - placed));
      if (signs) parts.push(t.signs(signs));
      this.log.push({ by, at: Date.now(), text: `${parts.join(t.sep)}${out.length ? ` (${describeSpan(out)})` : ''}` });
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
    const t = tx();
    const pos = Object.entries(this.avatarView()).map(([id, a]) => `${nameOf(id)}${id === selfId ? t.me : ''} (${a.x},${a.z})`).join(', ');
    const lines = [`${t.size(SIZE.x - 1, SIZE.z - 1, SIZE.y - 1)}${t.blocks(this.blocks.size)}${this.blocks.size ? t.span(lo.join(','), hi.join(',')) : ''}`];
    if (this.blocks.size) lines.push(`${t.kinds}: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    const signList = Object.entries(this.signs);
    if (signList.length) lines.push(`${t.signList}: ${signList.slice(0, 12).map(([k, s]) => `"${s.text}" (${k}, ${s.facing})`).join(', ')}${signList.length > 12 ? t.more(signList.length - 12) : ''}`);
    const custom = Object.entries(this.custom);
    if (custom.length) lines.push(`${t.custom}: ${custom.map(([n, c]) => `${n}(${nameOf(c.by)}${c.glow ? t.glow : ''}${c.clear ? t.clear : ''})`).join(', ')}`);
    lines.push(`${t.positions}: ${pos}`);
    const recent = this.log.slice(-8).map((l) => `- ${nameOf(l.by)}: ${l.text}`);
    if (recent.length) lines.push(`${t.recent}:\n${recent.join('\n')}`);
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
    const t = tx();
    const legend = t.legend(NAMES.map((n) => `${LETTER[n]}=${n}`).join(' '));
    const letterOf = (v) => LETTER[parseBlock(v).type] ?? '*';
    const header = (w) => `     x→ ${Array.from({ length: w }, (_, i) => String((xa + i) % 10)).join('')}`;
    const rows = [];
    if (Number.isFinite(int(r.y))) {
      const y = clamp(int(r.y), 1, SIZE.y - 1);
      rows.push(t.layer(y, xa, xb, za, zb), legend, header(xb - xa + 1));
      for (let z = za; z <= zb; z++) {
        let s = '';
        for (let x = xa; x <= xb; x++) { const t = this.blocks.get(key(x, y, z)); s += t ? letterOf(t) : '.'; }
        rows.push(`z${String(z).padStart(2, '0')}  ${s}`);
      }
      return rows.join('\n');
    }
    rows.push(t.top(xa, xb, za, zb), legend, header(xb - xa + 1));
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
