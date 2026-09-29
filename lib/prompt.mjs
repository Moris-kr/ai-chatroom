// Builds the per-turn prompt for one AI. Every call is self-contained: the model sees
// the room brief, its private notes, the workspace and the recent chat, then answers
// with a single JSON action.
//
// The wording lives in language packs (lib/prompts/<lang>.mjs); the room language decides
// which one is used, so the members chat in that language.

import { MEMBERS, AI_IDS, DEV, displayName, mentions, defaultLook } from './members.mjs';
import { PALETTE as WORLD_PALETTE } from './world.mjs';
import { pick, DEV_REQUEST_FILE } from './i18n.mjs';
import ko from './prompts/ko.mjs';
import en from './prompts/en.mjs';
import ja from './prompts/ja.mjs';

const PACKS = { ko, en, ja };
const pack = () => pick(PACKS);

function clock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
const secs = (ms) => Math.round(ms / 1000);
function kb(n) { return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`; }

// "sonnet" / "grok-4.7 (effort high)": how a model setting is named to the members.
export function modelLabel(conf) {
  if (!conf?.model) return '';
  return conf.effort ? `${conf.model} (effort ${conf.effort})` : conf.model;
}

// opts.deep: this turn runs on the boost settings ({by, reason}).
// opts.mode: room boost mode, 'auto' | 'manual' | 'off'.
export function buildBrief(id, cfg, opts = {}) {
  const P = pack();
  const me = MEMBERS[id];
  const a = cfg.agents?.[id] || {};
  const mode = opts.mode || 'auto';
  const canDeep = !!(a.boost?.model || a.boost?.effort) && mode !== 'off';
  const def = modelLabel(a);
  const boost = modelLabel({ ...a, ...a.boost });
  let deepSection = '';
  if (canDeep && opts.deep) {
    const why = opts.deep.by === 'self' ? P.deepWhySelf(opts.deep.reason) : P.deepWhyServer(opts.deep.reason);
    deepSection = P.deepOn({ def, boost, why });
  } else if (canDeep) {
    deepSection = P.deepInfo({ def, boost, auto: mode === 'auto' });
  }
  // config.json members.<id>.look describes your own avatar if you swap the pictures.
  const lookOf = (x) => cfg.members?.[x]?.look ?? defaultLook(x);
  const roster = AI_IDS.map((x) => `  - ${MEMBERS[x].name} (${MEMBERS[x].maker})${x === id ? P.rosterYou : ''}${lookOf(x) ? P.rosterLook(lookOf(x)) : ''}`).join('\n');
  return P.brief({
    id,
    name: me.name,
    maker: me.maker,
    roomName: cfg.roomName,
    userName: cfg.userName,
    roster,
    devName: DEV.name,
    devOnline: !!opts.devOnline,
    devFree: cfg.dev?.requireApproval === false,
    devFile: pick(DEV_REQUEST_FILE),
    webSearch: !!cfg.webSearch,
    imageLine: me.imageGen ? P.imageLine({ id, cooldown: cfg.imageCooldownSec > 0 }) : P.noImageLine,
    stickerLine: P.stickerLine,
    photoLine: opts.canSee ? P.photoSee : P.photoNoSee,
    blocks: Object.keys(WORLD_PALETTE).join(', '),
    deepSection,
    imageGen: me.imageGen,
    boostField: canDeep && !opts.deep && mode === 'auto',
  });
}

// How an attachment reads in the history. view: {canSee, attached: Set of message ids
// whose photo rides along with this turn}.
function aboutAttach(m, view, P) {
  const a = m.attach;
  const t = P.attach;
  if (a.sticker) return t.sticker;
  if (a.shot) return t.shot;
  if (a.prompt) return t.generated(a.prompt);
  if (!a.upload) return '';
  if (view.attached?.has(m.id)) return t.attached;
  const desc = a.desc ? t.desc(a.desc) : '';
  if (view.canSee) return t.canSee(desc);
  return a.desc ? t.noSee(desc) : t.noSeeNoDesc;
}

function formatMessage(m, selfId, cfg, view, P) {
  const who = m.from === selfId ? `${displayName(m.from, cfg.userName)}${P.me}` : displayName(m.from, cfg.userName);
  if (m.from === 'system') return `#${m.id} ${clock(m.ts)} · ${m.text}`;
  let line = `#${m.id} ${clock(m.ts)} ${who}`;
  if (m.replyTo) line += ` ↪#${m.replyTo}`;
  line += ': ';
  if (m.text) line += m.text.replace(/\n/g, '\n    ');
  if (m.attach) line += `${m.text ? ' ' : ''}[${P.attachLabel}: ${m.attach.path}${aboutAttach(m, view, P)}]`;
  const reacts = Object.entries(m.reactions || {}).filter(([, l]) => l.length);
  if (reacts.length) line += `   [${P.reactLabel} ${reacts.map(([e, l]) => `${e} ${l.map((x) => displayName(x, cfg.userName)).join(',')}`).join(' / ')}]`;
  return line;
}

// Lines in a member's notes that hold things it wants to do (the brief asks for a
// "하고 싶은 것: …" / "Want to do: …" / "やりたいこと: …" line), in any of the languages.
const WISH = /하고\s*싶은\s*것|해보고\s*싶|하고싶|want\s*to\s*(do|try)|wanna|やりたいこと|やってみたい/i;

// Ideas for a member picked to break a silence. They come from the room (the member's own
// wishes, the hour, a random card), not from the user.
function sparkSituation(note, last, now, cfg, hasWorld, P) {
  const quietMin = last ? Math.max(1, Math.round((now - last.ts) / 60000)) : 0;
  const wishes = note.split('\n').map((l) => l.trim()).filter((l) => WISH.test(l)).slice(-5);
  const cards = [...P.sparkCards].sort(() => Math.random() - 0.5).slice(0, 2);
  const d = new Date(now);
  const ideas = [];
  if (wishes.length) ideas.push(P.spark.wishes(wishes.map((w) => `"${w.replace(/^[-*\s]+/, '')}"`).join(', ')));
  ideas.push(P.spark.continueWork(hasWorld));
  ideas.push(P.spark.now(P.week[d.getDay()], P.timeOfDay(d.getHours())));
  // Only sometimes: searching makes the turn slow, and members tend to grab it when offered.
  if (cfg.webSearch && Math.random() < 0.3) ideas.push(P.spark.search);
  ideas.push(...cards.map((c) => P.spark.card(c)));
  return P.spark.lines(quietMin, ideas.map((i) => `  · ${i}`).join('\n'));
}

// ctx: {store, cfg, agent, reason, openFile, deepWait, canSee, attached}
// openFile: {rel, text} for a text file, {rel, image} for a picture sent along with the turn.
export function buildTurn(id, ctx) {
  const P = pack();
  const T = P.turn;
  const { store, cfg, agent, reason, openFile, deepWait } = ctx;
  const view = { canSee: !!ctx.canSee, attached: ctx.attached };
  const now = Date.now();
  const d = new Date(now);
  const parts = [];

  parts.push(T.now(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, P.week[d.getDay()], clock(now)));

  const note = store.readNote(id).trim();
  parts.push(T.note(note));

  // workspace
  const files = store.listFiles();
  if (files.length) {
    const lines = files.slice(0, 40).map((f) => `- ${f.path} · ${kb(f.size)} · ${f.by ? displayName(f.by, cfg.userName) : '?'} · ${P.ago(secs(now - f.mtime))}`);
    if (files.length > 40) lines.push(T.more(files.length - 40));
    parts.push(T.files(files.length, lines.join('\n')));
    // Show the most recently touched text files so collaboration can continue without "open".
    const shown = [];
    let budget = 7000;
    for (const f of files) {
      if (shown.length >= 2 || budget <= 500) break;
      if (store.isImage(f.path) || now - f.mtime > 30 * 60 * 1000) continue;
      try {
        const { text } = store.readFile(f.path);
        const cut = text.length > budget ? text.slice(0, budget) + T.cut(text.length - budget) : text;
        budget -= cut.length;
        shown.push(`--- ${f.path} ---\n${cut}`);
      } catch { /* skip */ }
    }
    if (shown.length) parts.push(T.recent(shown.join('\n')));
    const stickers = files.filter((f) => f.path.startsWith('stickers/') && store.isImage(f.path)).map((f) => f.path).sort();
    if (stickers.length) parts.push(T.stickers(stickers.length, stickers.slice(0, 80).join('\n'), Math.max(0, stickers.length - 80)));
  } else {
    parts.push(T.wsEmpty);
  }

  if (ctx.world) parts.push(T.world(ctx.world));
  if (openFile?.image) parts.push(T.openedImage(openFile.rel));
  else if (openFile) parts.push(T.openedFile(openFile.rel, openFile.text));

  // chat history
  const hist = store.recent(cfg.historyForPrompt);
  parts.push(T.history(hist.length, hist.map((m) => formatMessage(m, id, cfg, view, P)).join('\n')));
  if (ctx.attached?.size) parts.push(T.photos([...ctx.attached].map((n) => `#${n}`).join(', ')));

  // situation
  const fresh = store.after(agent.seen).filter((m) => m.from !== id);
  const sit = [];
  if (fresh.length) sit.push(T.fresh(fresh.length, fresh[0].id));
  else sit.push(T.noFresh);
  const called = fresh.filter((m) => m.from !== 'system' && (mentions(m.text, id) || (m.replyTo && store.byId.get(m.replyTo)?.from === id)));
  if (called.length) sit.push(T.called(called.map((m) => '#' + m.id).join(', ')));
  const fromUser = fresh.filter((m) => m.from === 'user');
  if (fromUser.length) sit.push(T.fromUser(fromUser.map((m) => '#' + m.id).join(', '), cfg.userName));
  const last = store.lastMessage();
  if (last) sit.push(T.sinceLast(P.elapsed(secs(now - last.ts))));
  const mine = store.messages.filter((m) => m.from === id);
  if (mine.length) sit.push(T.myLast(P.ago(secs(now - mine[mine.length - 1].ts))));
  const window = store.recent(20).filter((m) => m.from !== 'system');
  const myShare = window.filter((m) => m.from === id).length;
  if (window.length >= 8 && myShare / window.length > 0.4) sit.push(T.tooMuch(window.length, myShare));
  if (deepWait > 0) sit.push(T.deepWait(Math.ceil(deepWait / 1000)));
  if (note.length > 1800) sit.push(T.longNote(note.length));
  if (reason === 'idle') sit.push(T.idle);
  if (reason === 'spark') sit.push(...sparkSituation(note, last, now, cfg, !!ctx.world, P));
  if (reason === 'open') sit.push(openFile?.image ? T.openedImageNow : T.openedFileNow);
  if (!store.messages.some((m) => m.from !== 'system')) sit.push(T.fresh0);
  parts.push(T.situation(sit.join('\n')));

  parts.push(T.go);
  return parts.join('\n\n');
}

// Pull the first balanced JSON object out of a model reply.
export function parseAction(raw) {
  if (!raw) return null;
  const text = String(raw).replace(/```(?:json)?/gi, '');
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1));
          if (obj && typeof obj === 'object' && ('action' in obj || 'messages' in obj)) return obj;
        } catch { /* try next start */ }
        break;
      }
    }
  }
  return null;
}
