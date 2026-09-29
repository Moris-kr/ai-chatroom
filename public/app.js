// AI 단톡방 client: renders the room, streams updates over SSE, drives the composer
// and the shared-workspace panel. UI text comes from i18n.js (room language in <html lang>).

import { t, applyI18n, locale } from '/i18n.js';

applyI18n();

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  reply: '<svg viewBox="0 0 24 24"><path d="M10 8L5 12l5 4M5 12h9a5 5 0 0 1 5 5v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  smile: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 14a4.2 4.2 0 0 0 7 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="9.3" cy="10" r="1.2" fill="currentColor"/><circle cx="14.7" cy="10" r="1.2" fill="currentColor"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
const QUICK_EMOJI = ['👍', '😂', '❤️', '😮', '🤔', '🔥', '👀', '🙏'];
const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'];
const AI_IDS = ['claude', 'gpt', 'grok', 'gemini'];
// Every spelling that calls a member, in any room language (same lists as lib/members.mjs).
const ALIASES = {
  claude: ['claude', '클로드', 'クロード'],
  gpt: ['chatgpt', 'gpt', '지피티', '챗지피티', '쳇지피티', 'チャットgpt', 'チャッピー', 'ジーピーティー'],
  grok: ['grok', '그록', 'グロック', 'グロク'],
  gemini: ['gemini', '제미나이', '제미니', 'ジェミニ', 'ジェミナイ'],
};
const STATUSES = ['idle', 'reading', 'typing', 'away', 'sleeping', 'off', 'missing', 'error'];
const statusText = (st) => (STATUSES.includes(st) ? t(`status.${st}`) : st);

const S = {
  room: {}, members: {}, messages: [], byId: new Map(), files: [], notes: {}, usage: {},
  replyTo: null, openPath: null, tab: 'files', stuck: true, unseen: 0,
  freshFiles: new Set(), hadError: false, mention: null, pending: null, sending: false,
};

const app = $('#app');
const tl = $('#timeline');
const msgsBox = $('#msgs');
const input = $('#input');

// ---------------------------------------------------------------------------
// helpers

const extOf = (p) => (String(p).split('.').pop() || '').toLowerCase();
const wsUrl = (p, bust) => '/ws/' + String(p).split('/').map(encodeURIComponent).join('/') + (bust ? `?t=${bust}` : '');
// The dev session (Claude Code, joined through the dev bridge) is a participant but not a scheduled AI.
const DEV = {
  id: 'dev', name: t('dev.name'), color: '#0f766e',
  aliases: ['개발자', '개발 세션', '개발세션', '빌더', 'dev', 'developer', '開発者', 'デベロッパー'],
};
const avatar = (id) => (id === DEV.id ? '/avatars/dev.svg' : `/avatars/${id}-128.webp`);
function nameOf(id) {
  if (id === 'user') return S.room.userName || t('user.default');
  if (id === 'system') return t('name.system');
  if (id === DEV.id) return DEV.name;
  return S.members[id]?.name || id;
}
function colorOf(id) {
  if (id === 'user') return 'var(--mine)';
  if (id === DEV.id) return DEV.color;
  return S.members[id]?.color || 'var(--muted)';
}
const devOnline = () => !!S.room.dev?.online;
function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}
function dayLabel(ts) {
  return new Date(ts).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return t('ago.now');
  if (s < 3600) return t('ago.min', { n: Math.round(s / 60) });
  if (s < 86400) return t('ago.hour', { n: Math.round(s / 3600) });
  return t('ago.day', { n: Math.round(s / 86400) });
}
const stickerName = (p) => String(p).split('/').pop().replace(/\.[^.]+$/, '');
const size = (n) => (n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`);

function toast(text, ms = 2600) {
  const box = $('#toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, ms);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Names are compared in lower case with hiragana folded to katakana (@くろーど finds クロード).
const norm = (x) => String(x).toLowerCase()
  .replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

// Who does the word after "@" call? Japanese (and Korean) put particles right after a name
// ("@Claudeさん", "@그록아"), so the longest name at the start of the word wins; a Latin
// name must not run on into more Latin letters ("@device" is not "@dev").
function mentionHit(word) {
  const cands = [];
  for (const id of AI_IDS) for (const a of [...ALIASES[id], nameOf(id)]) cands.push([norm(a), colorOf(id)]);
  cands.push([norm(nameOf('user')), 'var(--mine)']);
  for (const a of [...DEV.aliases, DEV.name]) cands.push([norm(a), DEV.color]);
  let best = null;
  for (const [a, color] of cands) {
    if (!a || (best && a.length <= best.len) || norm(word.slice(0, a.length)) !== a) continue;
    if (/[a-z0-9_]$/.test(a) && /^[A-Za-z0-9_]/.test(word.slice(a.length))) continue;
    best = { len: a.length, color };
  }
  return best;
}

// ---------------------------------------------------------------------------
// text rendering

function inline(s) {
  let h = esc(s);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/(https?:\/\/[^\s<]+[^\s<.,)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  // Any script: Latin, Hangul, kana, kanji.
  h = h.replace(/@([\p{L}\p{N}_]+)/gu, (m, word) => {
    const hit = mentionHit(word);
    if (!hit) return m;
    return `<span class="mention" style="--c:${hit.color}">@${word.slice(0, hit.len)}</span>${word.slice(hit.len)}`;
  });
  return h.replace(/\n/g, '<br>');
}

function renderText(text) {
  return String(text).split('```').map((part, i) => (i % 2
    ? `<pre>${esc(part.replace(/^[\w+-]*\n/, ''))}</pre>`
    : inline(part.replace(/^\n+|\n+$/g, '')))).join('');
}

function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${mdInline(para.join('\n'))}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flush(); const n = Math.min(m[1].length, 3); out.push(`<h${n}>${mdInline(m[2])}</h${n}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${mdInline(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const buf = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${buf.map((b) => `<li>${mdInline(b)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush();
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}
function mdInline(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return h.replace(/\n/g, '<br>');
}

// ---------------------------------------------------------------------------
// messages

function snippet(m) {
  if (m.text) return m.text.replace(/\s+/g, ' ').slice(0, 90);
  if (m.attach?.sticker) return t('snippet.sticker', { name: stickerName(m.attach.path) });
  if (m.attach) return m.attach.upload ? t('snippet.photo') : t('snippet.attach', { path: m.attach.path });
  return '';
}

function buildQuote(id) {
  const q = S.byId.get(id);
  const b = el('button', 'quote');
  b.type = 'button';
  if (q) {
    b.style.setProperty('--c', colorOf(q.from));
    b.innerHTML = `<span class="qn">${esc(nameOf(q.from))}</span>${esc(snippet(q))}`;
  } else {
    b.textContent = t('quote.missing', { id });
  }
  b.onclick = () => jumpTo(id);
  return b;
}

// Workspace pages run in a sandbox. The server's CSP header (`sandbox allow-scripts`, no network)
// already gives them an opaque origin, so allow-same-origin here does not let them reach this
// page; without it the Claude desktop browser pane refuses to load the frame at all.
const WS_FRAME_SANDBOX = 'allow-scripts allow-same-origin';

// What Grok and Gemini get instead of the photo (their CLIs take no images).
function descCap(desc) {
  const cap = el('div', 'att-cap att-desc');
  cap.textContent = t('desc.cap', { desc: desc.length > 140 ? desc.slice(0, 140) + '…' : desc });
  cap.title = `${t('desc.title')}\n\n${desc}`;
  return cap;
}

function buildAttach(a) {
  const e = extOf(a.path);
  const url = wsUrl(a.path);
  if (a.sticker && IMG_EXT.includes(e)) {
    const img = el('img', 'att-sticker');
    img.src = url;
    img.alt = stickerName(a.path);
    img.title = a.path;
    img.loading = 'lazy';
    img.onclick = () => lightbox(url, a.path);
    img.onload = () => { if (S.stuck) toBottom(); };
    return img;
  }
  if (IMG_EXT.includes(e)) {
    const wrap = el('div', 'att-img-wrap');
    const img = el('img', `att-img${e === 'svg' ? ' svg' : ''}`);
    img.src = url;
    img.alt = a.prompt || a.path;
    img.loading = 'lazy';
    img.onclick = () => lightbox(url, a.prompt ? `🎨 ${a.prompt}` : a.path);
    img.onload = () => { if (S.stuck) toBottom(); };
    wrap.append(img);
    if (a.prompt) {
      const cap = el('div', 'att-cap');
      cap.textContent = `🎨 ${a.prompt.length > 140 ? a.prompt.slice(0, 140) + '…' : a.prompt}`;
      cap.title = a.prompt;
      wrap.append(cap);
    }
    if (a.desc) wrap.append(descCap(a.desc));
    return wrap;
  }
  if (e === 'html' || e === 'htm') {
    const box = el('div', 'att-html');
    const f = el('iframe');
    f.setAttribute('sandbox', WS_FRAME_SANDBOX);
    f.loading = 'lazy';
    f.title = a.path;
    f.src = url;
    const bar = el('div', 'att-bar', `<span class="p">${esc(a.path)}</span>`);
    const btn = el('button', '', esc(t('attach.expand')));
    btn.type = 'button';
    btn.onclick = () => openFile(a.path);
    bar.append(btn);
    box.append(f, bar);
    return box;
  }
  const b = el('button', 'att-file', `<span class="ic">${esc(e.toUpperCase().slice(0, 4))}</span><span class="p">${esc(a.path)}</span>`);
  b.type = 'button';
  b.onclick = () => openFile(a.path);
  return b;
}

function buildTools(m) {
  const bar = el('div', 'tools');
  const r = el('button', '', ICON.reply);
  r.type = 'button';
  r.title = t('tools.reply');
  r.setAttribute('aria-label', t('tools.reply'));
  r.onclick = () => setReply(m.id);
  const e = el('button', '', ICON.smile);
  e.type = 'button';
  e.title = t('tools.react');
  e.setAttribute('aria-label', t('tools.reactAria'));
  e.onclick = (ev) => openReactPop(m.id, ev.currentTarget);
  bar.append(r, e);
  return bar;
}

function buildReacts(m) {
  const box = el('div', 'reacts');
  box.dataset.for = m.id;
  for (const [emo, list] of Object.entries(m.reactions || {})) {
    if (!list.length) continue;
    const c = el('button', `chip${list.includes('user') ? ' me' : ''}`, `${esc(emo)} <b>${list.length}</b>`);
    c.type = 'button';
    c.title = list.map(nameOf).join(t('list.sep'));
    c.onclick = () => sendReact(m.id, emo);
    box.append(c);
  }
  return box;
}

function buildSys(m, animate) {
  const d = el('div', `sys k-${m.kind || 'info'}${animate ? ' new' : ''}`);
  d.id = `m${m.id}`;
  if (m.by) {
    d.style.setProperty('--c', colorOf(m.by));
    const n = nameOf(m.by);
    const text = String(m.text || '');
    const at = text.indexOf(n);
    d.innerHTML = at >= 0
      ? `${esc(text.slice(0, at))}<span class="who">${esc(n)}</span>${esc(text.slice(at + n.length))}`
      : esc(text);
  } else {
    d.textContent = m.text;
  }
  if (m.kind === 'file' && m.file) {
    d.title = t('sys.openInWs');
    d.onclick = () => openFile(m.file);
  }
  return d;
}

function buildMsg(m, prev, animate) {
  const frag = document.createDocumentFragment();
  if (!prev || !sameDay(prev.ts, m.ts)) frag.append(el('div', 'day', esc(dayLabel(m.ts))));
  if (m.from === 'system') {
    frag.append(buildSys(m, animate));
    return frag;
  }
  const cont = prev && prev.from === m.from && m.ts - prev.ts < 180000 && sameDay(prev.ts, m.ts)
    && (prev.model || '') === (m.model || '') && !!prev.deep === !!m.deep;
  const mine = m.from === 'user';
  const row = el('div', `msg${mine ? ' mine' : ''}${cont ? ' cont' : ''}${animate ? ' new' : ''}`);
  row.id = `m${m.id}`;
  row.style.setProperty('--c', colorOf(m.from));
  if (!mine) {
    const av = el('img', 'm-av');
    av.src = avatar(m.from);
    av.alt = nameOf(m.from);
    av.title = t('msg.mention', { name: nameOf(m.from) });
    av.onclick = () => insertMention(m.from);
    row.append(av);
  }
  const body = el('div', 'm-body');
  if (!mine && !cont) {
    const model = m.model || S.members[m.from]?.model || (m.from === DEV.id ? t('dev.sub') : '');
    body.append(el('div', 'm-head', `<span class="n">${esc(nameOf(m.from))}</span><span class="model">${esc(model)}</span>${m.deep ? `<span class="deep-badge" title="${esc(m.boostWhy || t('boost.name'))}">${esc(t('boost.badge'))}</span>` : ''}`));
  }
  if (m.deep) row.classList.add('deep');
  const line = el('div', 'line');
  const bubble = el('div', 'bubble');
  if (m.replyTo) bubble.append(buildQuote(m.replyTo));
  if (m.text) bubble.append(el('div', 'text', renderText(m.text)));
  if (m.attach) {
    bubble.append(buildAttach(m.attach));
    if (!m.text && !m.replyTo) bubble.classList.add('media');
  }
  line.append(bubble, el('span', 'time', esc(timeLabel(m.ts))), buildTools(m));
  body.append(line, buildReacts(m));
  row.append(body);
  frag.append(row);
  if (cont && timeLabel(prev.ts) === timeLabel(m.ts)) {
    document.getElementById(`m${prev.id}`)?.querySelector('.time')?.classList.add('dim');
  }
  return frag;
}

function renderAllMessages() {
  msgsBox.innerHTML = '';
  let prev = null;
  for (const m of S.messages) {
    msgsBox.append(buildMsg(m, prev, false));
    prev = m;
  }
  $('#loadMore').hidden = !(S.messages.length && S.messages[0].id > 1);
}

function addMessage(m) {
  if (S.byId.has(m.id)) return;
  const prev = S.messages[S.messages.length - 1];
  S.messages.push(m);
  S.byId.set(m.id, m);
  const stick = S.stuck || m.from === 'user';
  msgsBox.append(buildMsg(m, prev, true));
  if (stick) toBottom();
  else {
    S.unseen++;
    const j = $('#jump');
    j.hidden = false;
    j.textContent = t('chat.jumpN', { n: S.unseen });
  }
  if ((m.kind === 'file' || m.attach) && !wsVisible()) $('#wsBadge').hidden = false;
}

function updateMessage(m) {
  const old = S.byId.get(m.id);
  if (!old) return;
  old.reactions = m.reactions;
  if (m.attach?.desc && old.attach && !old.attach.desc) {
    old.attach.desc = m.attach.desc;
    const wrap = msgsBox.querySelector(`#m${m.id} .att-img-wrap`);
    if (wrap) wrap.append(descCap(m.attach.desc));
  }
  const box = msgsBox.querySelector(`.reacts[data-for="${m.id}"]`);
  if (box) {
    const stick = S.stuck;
    box.replaceWith(buildReacts(old));
    if (stick) toBottom();
  }
}

function toBottom() {
  tl.scrollTop = tl.scrollHeight;
  S.stuck = true;
  S.unseen = 0;
  $('#jump').hidden = true;
}

tl.addEventListener('scroll', () => {
  S.stuck = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 140;
  if (S.stuck) { S.unseen = 0; $('#jump').hidden = true; }
});
$('#jump').onclick = toBottom;

function jumpTo(id) {
  const row = document.getElementById(`m${id}`);
  if (!row) { toast(t('toast.oldMessage')); return; }
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('hl');
  setTimeout(() => row.classList.remove('hl'), 1600);
}

$('#loadMore').onclick = async () => {
  const first = S.messages[0];
  if (!first) return;
  const { messages } = await api(`/api/history?before=${first.id}`);
  if (!messages.length) { $('#loadMore').hidden = true; return; }
  const fromBottom = tl.scrollHeight - tl.scrollTop;
  S.messages = messages.concat(S.messages);
  for (const m of messages) S.byId.set(m.id, m);
  renderAllMessages();
  tl.scrollTop = tl.scrollHeight - fromBottom;
};

// ---------------------------------------------------------------------------
// members, room, typing

function setMembers(list) {
  for (const m of list) S.members[m.id] = m;
  renderMembers();
  renderTyping();
  renderHead();
}

function renderMembers() {
  const ul = $('#members');
  ul.innerHTML = '';
  for (const id of AI_IDS) {
    const m = S.members[id];
    if (!m) continue;
    const li = el('li', `member st-${m.status}${m.drawing ? ' drawing' : ''}`);
    li.style.setProperty('--c', m.color);
    let status = statusText(m.status);
    if (m.deep && m.status === 'reading') status = t('status.deepReading');
    if (m.drawing) status = m.status === 'typing' ? t('status.typingDrawing') : t('status.drawing');
    if (m.deep) li.classList.add('deep');
    li.title = [
      `${m.name} · ${m.maker}`,
      t('member.default', { model: m.defaultModel || m.model }),
      m.boostModel ? t('member.boost', { model: m.boostModel }) : '',
      m.imageGen ? t('member.imageGen') : t('member.svg'),
      t('member.calls', { n: m.calls }) + (m.lastMs ? ` · ${t('member.last', { s: (m.lastMs / 1000).toFixed(1) })}` : ''),
      m.lastError ? t('member.error', { error: m.lastError }) : '',
    ].filter(Boolean).join('\n');
    li.innerHTML = `
      <div class="av-wrap"><img class="av" src="${avatar(id)}" alt=""><span class="st-dot"></span></div>
      <div class="m-info">
        <div class="m-name"><span class="n">${esc(m.name)}</span><span class="m-maker">${esc(m.maker)}</span></div>
        <div class="m-status">${esc(status)}</div>
      </div>`;
    const q = miniQuota(id);
    if (q) li.querySelector('.m-info').append(q);
    const sw = el('label', 'switch');
    sw.title = m.enabled ? t('member.remove') : t('member.bringBack');
    sw.innerHTML = `<input type="checkbox" ${m.enabled ? 'checked' : ''} ${m.available ? '' : 'disabled'} aria-label="${esc(t('member.toggleAria', { name: m.name }))}"><span></span>`;
    sw.querySelector('input').onchange = (e) => api('/api/member', { id, enabled: e.target.checked }).catch(() => toast(t('toast.changeFailed')));
    li.append(sw);
    ul.append(li);
  }
  const dev = el('li', `member dev st-${devOnline() ? 'idle' : 'off'}`);
  dev.style.setProperty('--c', DEV.color);
  dev.title = t('dev.tooltip');
  dev.innerHTML = `
    <div class="av-wrap"><img class="av" src="${avatar(DEV.id)}" alt=""><span class="st-dot"></span></div>
    <div class="m-info">
      <div class="m-name"><span class="n">${esc(DEV.name)}</span><span class="m-maker">${esc(t('dev.sub'))}</span></div>
      <div class="m-status">${esc(devOnline() ? t('dev.online') : t('dev.offline'))}</div>
    </div>`;
  ul.append(dev);
  const on = AI_IDS.filter((id) => S.members[id]?.enabled).length + (devOnline() ? 1 : 0);
  $('#memberCount').textContent = `· ${on + 1}`;
}

function renderTyping() {
  const box = $('#typing');
  box.innerHTML = '';
  if (!S.room.running) return;
  const typing = AI_IDS.filter((id) => S.members[id]?.status === 'typing');
  const drawing = AI_IDS.filter((id) => S.members[id]?.drawing);
  const reading = AI_IDS.filter((id) => S.members[id]?.status === 'reading');
  const group = (ids, key, cls) => {
    if (!ids.length) return;
    const g = el('span', `t ${cls}`);
    const names = ids.map((id) => `<b style="--c:${colorOf(id)}">${esc(nameOf(id))}</b>`).join(t('list.sep'));
    g.innerHTML = ids.map((id) => `<img src="${avatar(id)}" alt="">`).join('')
      + t(key, { names, n: ids.length })
      + ' <span class="dots"><i></i><i></i><i></i></span>';
    box.append(g);
  };
  group(typing, 'typing.typing', 'typing');
  group(drawing, 'typing.drawing', 'drawing');
  group(reading.filter((id) => S.members[id]?.deep), 'typing.deep', 'deep');
  group(reading.filter((id) => !S.members[id]?.deep), 'typing.reading', 'reading');
}

function renderRoom() {
  const r = S.room;
  app.classList.toggle('running', !!r.running);
  app.classList.toggle('sleeping', !r.running && !!r.sleeping);
  const roomName = r.roomName || t('app.title');
  $('#roomName').textContent = roomName;
  $('#headTitle').textContent = roomName;
  document.title = roomName;
  $('#roomSub').textContent = t(r.running ? 'room.on' : r.sleeping ? 'room.sleeping' : 'room.off');
  $('#power').setAttribute('aria-pressed', r.running ? 'true' : 'false');
  $('.power-label').textContent = t(r.running ? 'power.stop' : r.sleeping ? 'power.wake' : 'power.on');
  for (const b of document.querySelectorAll('#speed button')) b.classList.toggle('on', b.dataset.v === r.speed);
  $('#autosleep').value = String(r.autoSleepMin ?? 30);
  if (![...$('#autosleep').options].some((o) => o.value === String(r.autoSleepMin))) {
    $('#autosleep').append(new Option(t('autosleep.min', { n: r.autoSleepMin }), String(r.autoSleepMin)));
    $('#autosleep').value = String(r.autoSleepMin);
  }
  for (const b of document.querySelectorAll('#boostMode button')) b.classList.toggle('on', b.dataset.v === (r.boostMode || 'auto'));
  const bm = ['auto', 'manual', 'off'].includes(r.boostMode) ? r.boostMode : 'auto';
  $('#boostHint').textContent = t(`boost.hint.${bm}`);
  $('#stat').textContent = t('stat.calls', { n: r.calls ?? 0 });
  $('#meName').textContent = nameOf('user');
  $('#meAv').textContent = nameOf('user').slice(0, 1);
  const off = !r.running;
  $('#offbar').hidden = !off;
  $('#offbarText').textContent = t(r.sleeping ? 'offbar.sleeping' : 'offbar.off');
  $('#offbarOn').textContent = t(r.sleeping ? 'power.wake' : 'power.on');
  renderTyping();
  renderHead();
  renderMembers();
}

function renderHead() {
  const on = AI_IDS.filter((id) => S.members[id]?.enabled).map(nameOf);
  if (devOnline()) on.push(DEV.name);
  $('#headSub').textContent = [...on, nameOf('user')].join(t('list.sep'));
  $('#devChip').hidden = !devOnline();
}

$('#power').onclick = () => api('/api/room', { running: !S.room.running }).catch(() => toast(t('toast.noServer')));
$('#offbarOn').onclick = () => api('/api/room', { running: true }).catch(() => toast(t('toast.noServer')));
for (const b of document.querySelectorAll('#speed button')) {
  b.onclick = () => api('/api/room', { speed: b.dataset.v });
}
for (const b of document.querySelectorAll('#boostMode button')) {
  b.onclick = () => api('/api/room', { boostMode: b.dataset.v });
}
$('#autosleep').onchange = (e) => api('/api/room', { autoSleepMin: Number(e.target.value) });
for (const o of $('#autosleep').options) {
  const n = Number(o.value);
  if (n) o.textContent = n % 60 ? t('autosleep.min', { n }) : t('autosleep.hour', { n: n / 60 });
}

// ---------------------------------------------------------------------------
// reactions

function openReactPop(id, anchor) {
  const pop = $('#reactPop');
  pop.innerHTML = '';
  for (const e of QUICK_EMOJI) {
    const b = el('button', '', e);
    b.type = 'button';
    b.onclick = () => { sendReact(id, e); pop.hidden = true; };
    pop.append(b);
  }
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left - w / 2))}px`;
  pop.style.top = `${Math.max(8, r.top - pop.offsetHeight - 6)}px`;
}
document.addEventListener('pointerdown', (e) => {
  const pop = $('#reactPop');
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.tools')) pop.hidden = true;
});
function sendReact(id, emoji) {
  api('/api/react', { id, emoji }).catch(() => toast(t('toast.reactFailed')));
}

// ---------------------------------------------------------------------------
// composer

function setReply(id) {
  S.replyTo = id;
  const m = S.byId.get(id);
  const chip = $('#replyChip');
  if (!m) { chip.hidden = true; S.replyTo = null; return; }
  chip.style.setProperty('--c', colorOf(m.from));
  chip.innerHTML = `<span class="q">${t('reply.to', { name: esc(nameOf(m.from)), text: esc(snippet(m)) })}</span>`;
  const x = el('button', '', ICON.x);
  x.type = 'button';
  x.setAttribute('aria-label', t('reply.cancel'));
  x.onclick = clearReply;
  chip.append(x);
  chip.hidden = false;
  input.focus();
}
function clearReply() {
  S.replyTo = null;
  $('#replyChip').hidden = true;
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

// ---- photo attachment: one image per message, sent with the text as base64 ----

const UPLOAD_MAX = 2 * 1024 * 1024;
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const readAsDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// Re-encode a still image that is over the limit: smaller sides, then lower quality.
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const type = file.type === 'image/png' ? 'image/webp' : 'image/jpeg';
  try {
    for (const side of [2560, 2048, 1600, 1280]) {
      const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
      canvas.width = Math.round(bmp.width * k);
      canvas.height = Math.round(bmp.height * k);
      const ctx = canvas.getContext('2d');
      if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      for (const q of [0.88, 0.78]) {
        const blob = await new Promise((r) => canvas.toBlob(r, type, q));
        if (blob && blob.size <= UPLOAD_MAX) return blob;
      }
    }
  } finally {
    bmp.close();
  }
  return null;
}

async function pickImage(file) {
  if (!file) return;
  if (!UPLOAD_TYPES.includes(file.type)) { toast(t('upload.types')); return; }
  let blob = file;
  let shrunk = false;
  if (file.size > UPLOAD_MAX) {
    if (file.type === 'image/gif') { toast(t('upload.gifMax')); return; }
    try { blob = await shrinkImage(file); } catch { blob = null; }
    if (!blob) { toast(t('upload.shrinkFailed'), 3600); return; }
    shrunk = true;
  }
  clearAttach();
  const data = await readAsDataUrl(blob);
  S.pending = { name: file.name || t('upload.pastedName'), size: blob.size, data, url: URL.createObjectURL(blob), shrunk, orig: file.size };
  renderAttach();
  input.focus();
}

function renderAttach() {
  const chip = $('#attachChip');
  const p = S.pending;
  if (!p) { chip.hidden = true; chip.innerHTML = ''; return; }
  chip.innerHTML = `<img src="${p.url}" alt=""><span class="q"><b>${esc(p.name)}</b> · ${size(p.size)}${p.shrunk ? ` ${esc(t('attach.shrunk', { size: size(p.orig) }))}` : ''}</span>`;
  const x = el('button', '', ICON.x);
  x.type = 'button';
  x.setAttribute('aria-label', t('attach.cancel'));
  x.onclick = () => { clearAttach(); input.focus(); };
  chip.append(x);
  chip.hidden = false;
}
function clearAttach() {
  if (S.pending?.url) URL.revokeObjectURL(S.pending.url);
  S.pending = null;
  renderAttach();
}

$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => {
  pickImage(e.target.files[0]);
  e.target.value = '';
};
input.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  e.preventDefault();
  pickImage(file);
});
{
  const box = $('.composer');
  const hasFile = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  box.addEventListener('dragover', (e) => { if (!hasFile(e)) return; e.preventDefault(); box.classList.add('dragover'); });
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('dragover'); });
  box.addEventListener('drop', (e) => {
    box.classList.remove('dragover');
    if (!hasFile(e)) return;
    e.preventDefault();
    pickImage([...e.dataTransfer.files].find((f) => f.type.startsWith('image/')) || e.dataTransfer.files[0]);
  });
}

// ---- stickers: the owner's picker (images under stickers/<member>/ in the workspace) ----

const STICKER_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

function renderStickerPop() {
  const pop = $('#stickerPop');
  const list = S.files.filter((f) => f.path.startsWith('stickers/') && STICKER_EXT.includes(extOf(f.path)))
    .sort((a, b) => a.path.localeCompare(b.path));
  pop.innerHTML = '';
  if (!list.length) {
    pop.append(el('div', 'sticker-empty', esc(t('sticker.empty'))));
    return;
  }
  const groups = new Map();
  for (const f of list) {
    const who = f.path.split('/').length > 2 ? f.path.split('/')[1] : '';
    if (!groups.has(who)) groups.set(who, []);
    groups.get(who).push(f);
  }
  for (const [who, files] of groups) {
    const head = el('div', 'sticker-head');
    head.textContent = who ? (AI_IDS.includes(who) ? nameOf(who) : who) : t('sticker.other');
    if (AI_IDS.includes(who)) head.style.setProperty('--c', colorOf(who));
    const grid = el('div', 'sticker-grid');
    for (const f of files) {
      const b = el('button', 'sticker-item');
      b.type = 'button';
      b.title = stickerName(f.path);
      const img = el('img');
      img.src = wsUrl(f.path, Math.round(f.mtime));
      img.alt = stickerName(f.path);
      img.loading = 'lazy';
      b.append(img);
      b.onclick = () => sendSticker(f.path);
      grid.append(b);
    }
    pop.append(head, grid);
  }
}

function toggleStickerPop(open = $('#stickerPop').hidden) {
  const pop = $('#stickerPop');
  if (open) { closeMention(); renderStickerPop(); }
  pop.hidden = !open;
  $('#stickerBtn').setAttribute('aria-expanded', String(open));
}

async function sendSticker(p) {
  toggleStickerPop(false);
  try {
    const r = await api('/api/send', { sticker: p });
    if (!r.running) toast(t('toast.roomOff'), 3600);
  } catch (e) {
    toast(e.status === 400 ? e.message : t('toast.sendFailed'), 3600);
  }
  input.focus();
}

$('#stickerBtn').onclick = (e) => { e.stopPropagation(); toggleStickerPop(); };
document.addEventListener('click', (e) => {
  if (!$('#stickerPop').hidden && !e.target.closest('#stickerPop, #stickerBtn')) toggleStickerPop(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#stickerPop').hidden) toggleStickerPop(false);
});

async function send() {
  const text = input.value.trim();
  const pending = S.pending;
  if (!text && !pending) return;
  if (S.sending) return;
  const replyTo = S.replyTo;
  input.value = '';
  autosize();
  closeMention();
  S.sending = true;
  $('#send').disabled = true;
  $('#attachBtn').disabled = true;
  try {
    const r = await api('/api/send', { text, replyTo, image: pending ? { name: pending.name, data: pending.data } : undefined });
    clearReply();
    if (pending) clearAttach();
    if (!r.running) toast(t('toast.roomOff'), 3600);
  } catch (e) {
    input.value = text;
    autosize();
    toast(e.status === 400 || e.status === 413 ? e.message : t('toast.sendFailed'), 3600);
  } finally {
    S.sending = false;
    $('#send').disabled = false;
    $('#attachBtn').disabled = false;
  }
}

$('#send').onclick = send;
input.addEventListener('input', () => { autosize(); updateMention(); });
input.addEventListener('keydown', (e) => {
  if (S.mention && !$('#mentionPop').hidden) {
    const items = [...$('#mentionPop').querySelectorAll('button')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      S.mention.index = (S.mention.index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((b, i) => b.classList.toggle('on', i === S.mention.index));
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
      e.preventDefault();
      items[S.mention.index]?.click();
      return;
    }
    if (e.key === 'Escape') { closeMention(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    send();
  }
  if (e.key === 'Escape' && S.replyTo) clearReply();
});

function updateMention() {
  const upto = input.value.slice(0, input.selectionStart);
  const m = upto.match(/@([\p{L}\p{N}_]*)$/u);
  if (!m) { closeMention(); return; }
  const q = norm(m[1]);
  const ids = AI_IDS.filter((id) => S.members[id] && (!q || [nameOf(id), ...ALIASES[id]].some((a) => norm(a).startsWith(q))));
  if (!q || [DEV.name, ...DEV.aliases].some((a) => norm(a).startsWith(q))) ids.push(DEV.id);
  if (!ids.length) { closeMention(); return; }
  S.mention = { start: upto.length - m[0].length, index: 0 };
  const pop = $('#mentionPop');
  pop.innerHTML = '';
  ids.forEach((id, i) => {
    const b = el('button', i === 0 ? 'on' : '', `<img src="${avatar(id)}" alt=""><span class="n" style="--c:${colorOf(id)}">${esc(nameOf(id))}</span>`);
    b.type = 'button';
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      const before = input.value.slice(0, S.mention.start);
      const after = input.value.slice(input.selectionStart);
      input.value = `${before}@${nameOf(id)} ${after}`;
      const pos = before.length + nameOf(id).length + 2;
      input.setSelectionRange(pos, pos);
      closeMention();
      input.focus();
    };
    pop.append(b);
  });
  pop.hidden = false;
}
function closeMention() {
  S.mention = null;
  $('#mentionPop').hidden = true;
}
function insertMention(id) {
  const add = `@${nameOf(id)} `;
  input.value = input.value && !/\s$/.test(input.value) ? `${input.value} ${add}` : input.value + add;
  autosize();
  input.focus();
}

// ---------------------------------------------------------------------------
// workspace panel

const wide = () => window.matchMedia('(min-width: 1241px)').matches;
function wsVisible() {
  return wide() ? !app.classList.contains('ws-closed') : app.classList.contains('ws-open');
}
function showWs(show) {
  if (wide()) app.classList.toggle('ws-closed', !show);
  else {
    app.classList.toggle('ws-open', show);
    $('#scrim').hidden = !show && !app.classList.contains('side-open');
  }
  if (show) {
    $('#wsBadge').hidden = true;
    renderWs();
  }
  try { localStorage.setItem('ws-closed', show ? '0' : '1'); } catch { /* private mode */ }
}
$('#wsBtn').onclick = () => showWs(!wsVisible());
$('#closeWs').onclick = () => showWs(false);
$('#openSide').onclick = () => { app.classList.add('side-open'); $('#scrim').hidden = false; };
$('#scrim').onclick = () => {
  app.classList.remove('side-open', 'ws-open');
  $('#scrim').hidden = true;
};

const TAB_BODIES = { files: '#wsFiles', notes: '#wsNotes', usage: '#wsUsage' };
function selectTab(tab) {
  S.tab = tab;
  for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x.dataset.tab === tab);
  for (const [k, sel] of Object.entries(TAB_BODIES)) $(sel).hidden = k !== tab;
  if (tab === 'notes') loadNotes();
  renderWs();
}
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => selectTab(b.dataset.tab);

function renderWs() {
  if (S.tab === 'notes') renderNotes();
  else if (S.tab === 'usage') renderUsage();
  else if (S.openPath) renderViewer();
  else renderFileList();
}

function fileIcon(f) {
  const e = extOf(f.path);
  if (IMG_EXT.includes(e)) return `<span class="ic"><img src="${wsUrl(f.path, Math.round(f.mtime))}" alt="" loading="lazy"></span>`;
  const label = { md: 'MD', txt: 'TXT', html: 'HTML', htm: 'HTML', json: 'JSON', csv: 'CSV', js: 'JS', mjs: 'JS', py: 'PY', css: 'CSS' }[e] || e.toUpperCase().slice(0, 4);
  return `<span class="ic">${esc(label)}</span>`;
}

function renderFileList() {
  const box = $('#wsFiles');
  box.innerHTML = '';
  if (!S.files.length) {
    box.append(el('div', 'ws-empty', `<div class="big">🗂️</div>${t('ws.empty')}`));
    return;
  }
  box.append(el('div', 'ws-intro', esc(t('ws.intro', { n: S.files.length }))));
  const groups = new Map();
  for (const f of S.files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  const dirs = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  for (const dir of dirs) {
    const sec = el('div', 'folder');
    if (dir) sec.append(el('div', 'folder-name', `📁 ${esc(dir)}/`));
    for (const f of groups.get(dir)) {
      const b = el('button', `file${S.freshFiles.has(f.path) ? ' fresh' : ''}`);
      b.type = 'button';
      const base = f.path.slice(dir ? dir.length + 1 : 0);
      b.innerHTML = `${fileIcon(f)}<span class="fi"><div class="fn">${esc(base)}</div><div class="fm">${esc(f.by ? nameOf(f.by) : '?')} · ${esc(ago(f.mtime))} · ${esc(size(f.size))}</div></span>`;
      b.onclick = () => openFile(f.path);
      sec.append(b);
    }
    box.append(sec);
  }
}

async function openFile(p) {
  S.openPath = p;
  S.freshFiles.delete(p);
  selectTab('files');
  if (!wsVisible()) showWs(true);
}

async function renderViewer() {
  const p = S.openPath;
  const f = S.files.find((x) => x.path === p);
  const box = $('#wsFiles');
  box.innerHTML = '';
  const v = el('div', 'viewer');
  const head = el('div', 'viewer-head');
  const back = el('button', 'back', esc(t('viewer.back')));
  back.type = 'button';
  back.onclick = () => { S.openPath = null; renderWs(); };
  const info = el('div', 'vp', `<div class="p">${esc(p)}</div><div class="m">${f ? `${esc(f.by ? nameOf(f.by) : '?')}${f.createdBy && f.createdBy !== f.by ? ` ${esc(t('viewer.createdBy', { name: nameOf(f.createdBy) }))}` : ''} · ${esc(ago(f.mtime))} · ${esc(size(f.size))}` : esc(t('viewer.deleted'))}</div>`);
  const open = el('a', '', esc(t('viewer.newTab')));
  open.href = wsUrl(p);
  open.target = '_blank';
  open.rel = 'noopener';
  head.append(back, info, open);
  const body = el('div', 'viewer-body');
  v.append(head, body);
  box.append(v);
  if (!f) { body.append(el('div', 'ws-empty', esc(t('viewer.gone')))); return; }

  const e = extOf(p);
  if (IMG_EXT.includes(e)) {
    const w = el('div', 'img-wrap');
    const img = el('img');
    img.src = wsUrl(p, Math.round(f.mtime));
    img.alt = p;
    img.onclick = () => lightbox(img.src, p);
    w.append(img);
    body.append(w);
    return;
  }
  if (e === 'html' || e === 'htm') {
    const fr = el('iframe');
    fr.setAttribute('sandbox', WS_FRAME_SANDBOX);
    fr.title = p;
    fr.src = wsUrl(p, Math.round(f.mtime));
    body.append(fr);
    return;
  }
  try {
    const r = await api(`/api/file?path=${encodeURIComponent(p)}`);
    if (S.openPath !== p) return;
    if (e === 'md') body.append(el('div', 'md', renderMarkdown(r.text)));
    else {
      const pre = el('pre');
      pre.textContent = r.text;
      body.append(pre);
    }
  } catch {
    body.append(el('div', 'ws-empty', esc(t('viewer.readFailed'))));
  }
}

function onFiles(list) {
  const before = new Map(S.files.map((f) => [f.path, f.mtime]));
  for (const f of list) if (before.get(f.path) !== f.mtime) S.freshFiles.add(f.path);
  S.files = list;
  if (!$('#stickerPop').hidden) renderStickerPop();
  const changedOpen = S.openPath && before.get(S.openPath) !== list.find((f) => f.path === S.openPath)?.mtime;
  if (S.tab === 'files' && (!S.openPath || changedOpen)) renderWs();
  if (!wsVisible()) $('#wsBadge').hidden = false;
  setTimeout(() => { for (const f of list) S.freshFiles.delete(f.path); if (S.tab === 'files' && !S.openPath) renderFileList(); }, 20000);
}

async function loadNotes() {
  try {
    S.notes = await api('/api/notes');
    if (S.tab === 'notes') renderNotes();
  } catch { /* offline */ }
}

function renderNotes(flashId) {
  const box = $('#wsNotes');
  box.innerHTML = '';
  box.append(el('div', 'ws-intro', esc(t('notes.intro'))));
  const wrap = el('div', 'notes');
  for (const id of AI_IDS) {
    const m = S.members[id];
    const card = el('div', `note-card${flashId === id ? ' flash' : ''}`);
    card.style.setProperty('--c', colorOf(id));
    const text = (S.notes[id] || '').trim();
    card.innerHTML = `<div class="nh"><img src="${avatar(id)}" alt=""><span class="n">${esc(nameOf(id))}</span><span class="s">${text ? esc(t('notes.lines', { n: text.split('\n').length })) : ''}</span></div>`;
    if (text) {
      const pre = el('pre');
      pre.textContent = text;
      card.append(pre);
    } else {
      card.append(el('div', 'empty', m ? esc(t('notes.empty')) : ''));
    }
    wrap.append(card);
  }
  box.append(wrap);
}

function onNote({ id, text }) {
  S.notes[id] = text;
  if (S.tab === 'notes' && wsVisible()) renderNotes(id);
}

// ---------------------------------------------------------------------------
// usage limits (account-wide, polled by the server without spending model calls)

const LEVEL_LABEL = { warn: t('level.warn'), crit: t('level.crit') };
const level = (remaining) => (remaining < 10 ? 'crit' : remaining < 30 ? 'warn' : 'ok');
const fmtPct = (x) => `${Number.isInteger(x) ? x : Number(x).toFixed(1)}%`;

function untilLabel(ts) {
  const m = Math.round((ts - Date.now()) / 60000);
  if (m <= 0) return t('until.soon');
  if (m < 60) return t('until.min', { m });
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? t('until.hm', { h, m: m % 60 }) : t('until.h', { h });
  return t('until.d', { d: Math.round(h / 24) });
}
function resetLabel(ts) {
  if (!ts) return '';
  const when = sameDay(ts, Date.now())
    ? timeLabel(ts)
    : new Date(ts).toLocaleString(locale, { month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `${t('usage.reset', { when })} · ${untilLabel(ts)}`;
}

// The window closest to running out.
function tightest(u) {
  return (u?.windows || []).filter((w) => !w.minor)
    .reduce((a, b) => (!a || b.remainingPct < a.remainingPct ? b : a), null);
}

function miniQuota(id) {
  const u = S.usage[id];
  const w = tightest(u);
  if (!w) return null;
  const lv = level(w.remainingPct);
  const b = el('button', `m-quota lv-${lv}${u.ok === false ? ' stale' : ''}`);
  b.type = 'button';
  b.title = `${u.windows.filter((x) => !x.minor).map((x) => `${x.label} ${t('usage.left', { pct: fmtPct(x.remainingPct) })}`).join(' · ')}\n${t('usage.clickHint')}`;
  b.innerHTML = `<span class="track"><i style="width:${Math.max(2, w.remainingPct)}%"></i></span><span class="q"></span>`;
  b.querySelector('.q').textContent = `${w.label} ${fmtPct(w.remainingPct)}`;
  b.onclick = () => {
    selectTab('usage');
    if (!wsVisible()) showWs(true);
  };
  return b;
}

function renderUsage() {
  const box = $('#wsUsage');
  box.innerHTML = '';
  const head = el('div', 'usage-head');
  const intro = el('div', 'ws-intro');
  intro.textContent = t('usage.intro');
  const btn = el('button', 'refresh', esc(t('usage.refresh')));
  btn.type = 'button';
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = t('usage.checking');
    try { await api('/api/usage/refresh', {}); } catch { toast(t('toast.refreshFailed')); }
    setTimeout(() => { btn.disabled = false; btn.textContent = t('usage.refresh'); }, 5000);
  };
  head.append(intro, btn);
  const list = el('div', 'usage-list');
  for (const id of AI_IDS) list.append(usageCard(id));
  box.append(head, list);
}

function usageCard(id) {
  const u = S.usage[id] || {};
  const m = S.members[id];
  const card = el('section', 'u-card');
  card.setAttribute('aria-label', t('usage.cardAria', { name: nameOf(id) }));
  const h = el('div', 'u-head', `<img src="${avatar(id)}" alt=""><div class="u-title"><div class="n"></div><div class="s"></div></div>`);
  h.querySelector('.n').textContent = nameOf(id);
  h.querySelector('.s').textContent = [u.plan, u.at ? t('usage.checkedAgo', { ago: ago(u.at) }) : null].filter(Boolean).join(' · ') || t('usage.notChecked');
  card.append(h);
  if (u.ok === false) {
    const e = el('div', 'u-err');
    e.textContent = t('usage.failed', { error: u.error || t('usage.unknown') }) + (u.at ? ` · ${t('usage.lastValues')}` : '');
    card.append(e);
  }
  const ws = u.windows || [];
  if (!ws.length && u.ok !== false) card.append(el('div', 'u-empty', esc(t('usage.loading'))));
  for (const w of ws) card.append(windowBlock(w));
  const foot = el('div', 'u-foot');
  foot.textContent = t('usage.calls30', { n: u.calls30 ?? 0 }) + (m?.boostModel ? ` · ${t('usage.boostModel', { model: m.boostModel })}` : '');
  card.append(foot);
  return card;
}

function windowBlock(w) {
  const lv = level(w.remainingPct);
  const b = el('div', `u-win lv-${lv}${w.minor ? ' minor' : ''}`);
  const top = el('div', 'u-row', `<span class="u-label"></span><span class="u-val">${t('usage.left', { pct: '<b></b>' })}</span>`);
  top.querySelector('.u-label').textContent = `${w.label}${LEVEL_LABEL[lv] ? `  ${LEVEL_LABEL[lv]}` : ''}`;
  top.querySelector('b').textContent = fmtPct(w.remainingPct);
  const meter = el('div', 'u-meter', `<i style="width:${w.remainingPct}%"></i>`);
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-valuenow', String(w.remainingPct));
  meter.setAttribute('aria-label', t('usage.remainingAria', { label: w.label }));
  b.append(top, meter);

  const info = el('div', 'u-stats');
  if (!w.minor) {
    const d = w.delta30;
    const used = el('span', 'u-delta');
    if (!d) used.textContent = t('usage.recentPending');
    else {
      const mins = Math.round(d.coveredMs / 60000);
      used.innerHTML = t('usage.recentUsed');
      used.querySelector('b').textContent = t('usage.pp', { pct: fmtPct(d.pct) });
      if (d.partial) used.querySelector('.u-cov').textContent = ` ${t('usage.covered', { mins })}`;
    }
    info.append(used);
  } else {
    info.append(el('span', 'u-delta', esc(t('usage.used', { pct: fmtPct(w.usedPct) }))));
  }
  if (w.resetsAt) info.append(el('span', 'u-reset', esc(resetLabel(w.resetsAt))));
  b.append(info);
  if (!w.minor) b.append(sparkline(w.series || [], lv));
  return b;
}

// Remaining % over the last 3 hours; the last 30 minutes are highlighted.
function sparkline(series, lv) {
  const SPAN = 3 * 3600000;
  const RECENT = 30 * 60000;
  const W = 300, H = 46, PAD = 6;
  const wrap = el('div', `spark lv-${lv}`);
  if (series.length < 2) {
    wrap.append(el('div', 'spark-empty', esc(t('spark.empty'))));
    return wrap;
  }
  const now = Date.now();
  const t0 = now - SPAN;
  const pts = series.map(([ts, used]) => [ts, Math.max(0, 100 - used)]);
  const vals = pts.map((p) => p[1]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }
  const X = (ts) => Math.max(0, Math.min(W, ((ts - t0) / SPAN) * W));
  const Y = (v) => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);
  const path = (list) => list.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  const cut = now - RECENT;
  const older = pts.filter((p) => p[0] <= cut);
  const recent = pts.filter((p) => p[0] >= cut);
  if (older.length && recent.length) recent.unshift(older[older.length - 1]);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <rect class="band" x="${X(cut)}" y="0" width="${W - X(cut)}" height="${H}"/>
    <line class="grid" x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}"/>
    ${older.length > 1 ? `<path class="old" d="${path(older)}"/>` : ''}
    ${recent.length > 1 ? `<path class="now" d="${path(recent)}"/>` : ''}`;
  const plot = el('div', 'spark-plot');
  plot.tabIndex = 0;
  plot.setAttribute('role', 'img');
  plot.setAttribute('aria-label', t('spark.aria', { from: fmtPct(pts[0][1]), to: fmtPct(pts[pts.length - 1][1]) }));
  const last = pts[pts.length - 1];
  const dot = el('span', 'spark-dot');
  dot.style.left = `${(X(last[0]) / W) * 100}%`;
  dot.style.top = `${(Y(last[1]) / H) * 100}%`;
  const cross = el('span', 'spark-cross');
  const tip = el('span', 'spark-tip');
  cross.hidden = tip.hidden = true;
  plot.append(svg, dot, cross, tip);

  let idx = pts.length - 1;
  const show = (i) => {
    idx = Math.max(0, Math.min(pts.length - 1, i));
    const [ts, v] = pts[idx];
    const left = (X(ts) / W) * 100;
    cross.style.left = `${left}%`;
    tip.style.left = `${Math.min(78, Math.max(0, left - 11))}%`;
    tip.innerHTML = '<b></b> <span></span>';
    tip.querySelector('b').textContent = t('usage.left', { pct: fmtPct(v) });
    tip.querySelector('span').textContent = timeLabel(ts);
    cross.hidden = tip.hidden = false;
  };
  const hide = () => { cross.hidden = tip.hidden = true; };
  plot.addEventListener('pointermove', (e) => {
    const r = plot.getBoundingClientRect();
    const at = t0 + ((e.clientX - r.left) / r.width) * SPAN;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - at) < Math.abs(pts[best][0] - at)) best = i;
    show(best);
  });
  plot.addEventListener('pointerleave', hide);
  plot.addEventListener('focus', () => show(pts.length - 1));
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(idx - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(idx + 1); }
  });
  const axis = el('div', 'spark-axis', `<span>${esc(t('spark.ago3h'))}</span><span class="mid">${esc(t('spark.recent'))}</span><span>${esc(t('spark.now'))}</span>`);
  axis.querySelector('.mid').style.left = `${(X(cut) / W) * 100}%`;

  // The same numbers without hovering.
  const table = el('details', 'spark-table');
  table.innerHTML = `<summary>${esc(t('spark.table'))}</summary><table><thead><tr><th>${esc(t('spark.time'))}</th><th>${esc(t('spark.left'))}</th></tr></thead><tbody></tbody></table>`;
  const tb = table.querySelector('tbody');
  const every = Math.max(1, Math.ceil(pts.length / 12));
  for (let i = pts.length - 1; i >= 0; i -= every) {
    const tr = el('tr');
    tr.append(el('td', '', esc(timeLabel(pts[i][0]))), el('td', '', esc(fmtPct(pts[i][1]))));
    tb.append(tr);
  }
  wrap.append(plot, axis, table);
  return wrap;
}

function onUsage(data) {
  S.usage = data || {};
  renderMembers();
  if (S.tab === 'usage' && wsVisible()) renderUsage();
}

// ---------------------------------------------------------------------------
// lightbox + theme

function lightbox(src, cap) {
  $('#lbImg').src = src;
  $('#lbCap').textContent = cap || '';
  $('#lightbox').hidden = false;
}
$('#lightbox').onclick = () => { $('#lightbox').hidden = true; };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('#lightbox').hidden = true;
    $('#reactPop').hidden = true;
  }
});

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem('theme')); } catch { /* private mode */ }
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('theme', next); } catch { /* private mode */ }
};

// ---------------------------------------------------------------------------
// boot

async function load() {
  const st = await api('/api/state');
  S.room = st.room;
  S.members = {};
  for (const m of st.members) S.members[m.id] = m;
  S.messages = st.messages;
  S.byId = new Map(st.messages.map((m) => [m.id, m]));
  S.files = st.files;
  S.usage = st.usage || {};
  renderRoom();
  renderMembers();
  renderAllMessages();
  renderWs();
  toBottom();
}

function connect() {
  const es = new EventSource('/events');
  es.addEventListener('msg', (e) => addMessage(JSON.parse(e.data)));
  es.addEventListener('msgupdate', (e) => updateMessage(JSON.parse(e.data)));
  es.addEventListener('members', (e) => setMembers(JSON.parse(e.data)));
  es.addEventListener('room', (e) => { S.room = JSON.parse(e.data); renderRoom(); });
  es.addEventListener('ws', (e) => onFiles(JSON.parse(e.data)));
  es.addEventListener('notes', (e) => onNote(JSON.parse(e.data)));
  es.addEventListener('usage', (e) => onUsage(JSON.parse(e.data)));
  es.onopen = () => { if (S.hadError) { S.hadError = false; load().catch(() => {}); } };
  es.onerror = () => { S.hadError = true; };
}

try { if (localStorage.getItem('ws-closed') === '1' && wide()) app.classList.add('ws-closed'); } catch { /* private mode */ }
if (!wide()) app.classList.add('ws-closed');
connect();
load().catch(() => toast(t('toast.noServer'), 5000));
setInterval(() => {
  if (!wsVisible()) return;
  if (S.tab === 'files' && !S.openPath) renderFileList();
  if (S.tab === 'usage' && !document.activeElement?.closest?.('#wsUsage')) renderUsage();
}, 30000);
input.focus();
