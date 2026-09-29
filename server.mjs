// AI 단톡방 — Claude, ChatGPT, Grok and Gemini chatting in one web room.
// Zero-dependency Node server: static UI + SSE + one independent loop per AI.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setLang, getLang, pick, LANG_DEFAULTS } from './lib/i18n.mjs';
import { Store } from './lib/store.mjs';
import { Adapters, killAll } from './lib/agents.mjs';
import { UsageMonitor } from './lib/usage.mjs';
import { buildBrief, buildTurn, parseAction, modelLabel } from './lib/prompt.mjs';
import { Router } from './lib/router.mjs';
import { AI_IDS, MEMBERS, DEV, displayName, mentions, atMentions, withJosa } from './lib/members.mjs';
import { DevBridge, devChainState } from './lib/dev.mjs';
import { ExternalGate } from './lib/external.mjs';
import { World } from './lib/world.mjs';
import { shootWorld } from './lib/worldshot.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CFG = {
  port: 8321,
  host: '127.0.0.1',
  // ko | en | ja | auto (OS language). Also decides the default roomName / userName.
  language: 'auto',
  roomName: '',
  userName: '',
  maxInFlight: 3,
  historyForPrompt: 40,
  autoSleepMinutes: 30,
  speed: 'normal',
  imageGen: true,
  imageCooldownSec: 240,
  // Members may use their CLI's own web search (lib/agents.mjs chat()); nothing that
  // opens arbitrary pages locally.
  webSearch: false,
  turnTimeoutSec: 150,
  usagePollSec: 120,
  usagePollIdleSec: 600,
  // 진심모드 (per-turn model routing, see lib/router.mjs)
  boost: { mode: 'auto', timeoutSec: 360, selfCooldownSec: 180, aiRequestCooldownSec: 180 },
  // dev bridge (lib/dev.mjs): AI bubbles allowed after a dev message, and dev messages
  // allowed without the user, before the AIs pause until the user speaks
  dev: { enabled: true, replyCap: 6, roundsWithoutUser: 8 },
  // Breaking the silence: after SPEEDS[speed].spark seconds of quiet (or afterSec: [lo, hi]
  // if set) one member is picked; each pass multiplies the next wait by `backoff`, up to maxWaitSec.
  spark: { enabled: true, backoff: 1.6, maxWaitSec: 1800 },
  // Second listener for the owner away from home (lib/external.mjs): password login,
  // no dev bridge API. Off unless config.json turns it on.
  external: { enabled: false, port: 18321, host: '0.0.0.0', https: true },
  // model/effort = default; boost = what a 진심모드 turn overrides (null disables it)
  agents: {
    claude: { model: 'sonnet', boost: { model: 'opus' } },
    gpt: { model: 'gpt-6-sol', effort: 'low', boost: { model: 'gpt-6-astra', effort: 'medium' }, imageModel: 'gpt-6-luna' },
    grok: { model: 'grok-4.7', effort: 'low', boost: { effort: 'high' } },
    gemini: { model: 'gemini-3.8-flash-medium', rotate: 4, boost: { model: 'gemini-3.8-flash-high' } },
  },
};

function loadConfig() {
  let user = {};
  const file = process.env.CHATROOM_CONFIG ? path.resolve(process.env.CHATROOM_CONFIG) : path.join(ROOT, 'config.json');
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* defaults */ }
  const cfg = { ...DEFAULT_CFG, ...user, agents: {} };
  cfg.boost = { ...DEFAULT_CFG.boost, ...(user.boost || {}) };
  cfg.dev = { ...DEFAULT_CFG.dev, ...(user.dev || {}) };
  cfg.spark = { ...DEFAULT_CFG.spark, ...(user.spark || {}) };
  cfg.external = { ...DEFAULT_CFG.external, ...(user.external || {}) };
  // Older configs: ChatGPT-only deepModel / deepMode / deepTimeoutSec.
  if (user.deepMode && !user.boost?.mode) cfg.boost.mode = user.deepMode;
  if (user.deepTimeoutSec && !user.boost?.timeoutSec) cfg.boost.timeoutSec = user.deepTimeoutSec;
  for (const id of AI_IDS) {
    const u = user.agents?.[id] || {};
    const a = { ...DEFAULT_CFG.agents[id], ...u };
    if (!('boost' in u) && u.deepModel) a.boost = { model: u.deepModel, effort: u.deepEffort };
    else if ('boost' in u) a.boost = u.boost ? { ...(DEFAULT_CFG.agents[id].boost || {}), ...u.boost } : null;
    cfg.agents[id] = a;
  }
  // Config files written before the language setting existed all belong to Korean rooms.
  cfg.language = setLang(user.language ?? (Object.keys(user).length ? 'ko' : 'auto'));
  cfg.roomName = cfg.roomName || LANG_DEFAULTS[cfg.language].roomName;
  cfg.userName = cfg.userName || LANG_DEFAULTS[cfg.language].userName;
  return cfg;
}

const cfg = loadConfig();
// CHATROOM_HOME moves data/ and workspace/ elsewhere (a separate room, or tests); CHATROOM_CONFIG
// points at another config file; PORT overrides the port.
const HOME_DIR = process.env.CHATROOM_HOME ? path.resolve(process.env.CHATROOM_HOME) : ROOT;
if (process.env.PORT) cfg.port = Number(process.env.PORT);
const store = new Store(HOME_DIR);
const adapters = new Adapters(HOME_DIR, cfg);
// Shared building world (lib/world.mjs), watched in public/world.html.
const world = new World(HOME_DIR, AI_IDS);
const avail = adapters.available();

// Dev bridge: the development session joins the room as "개발자" (lib/dev.mjs).
const devBridge = new DevBridge(HOME_DIR, {
  store,
  cfg,
  post: (m) => post(m),
  roomView: () => roomView(),
  fileChanged: (r) => {
    post({ from: 'system', kind: 'file', by: DEV.id, file: r.op === 'delete' ? undefined : r.rel, text: `${DEV.name} → ${r.rel} ${tx().verb[r.op] || r.op}` });
    broadcast('ws', store.listFiles());
  },
  onPresence: (online) => {
    post({ from: 'system', kind: 'dev', by: DEV.id, online, text: online ? tx().devIn() : tx().devOut() });
    pushRoom();
  },
});

// Pacing presets. Seconds. `spark`: how long the room stays quiet before one member is
// picked to break the silence (see maybeSpark).
const SPEEDS = {
  slow: { read: [8, 22], idle: [100, 220], spark: [300, 600], cooldown: 15, perMin: 6, typing: 1.3 },
  normal: { read: [4, 12], idle: [50, 120], spark: [150, 330], cooldown: 8, perMin: 10, typing: 1 },
  fast: { read: [1, 6], idle: [25, 60], spark: [70, 160], cooldown: 3, perMin: 18, typing: 0.6 },
};

// ---------------------------------------------------------------------------
// Room + per-AI runtime state

const room = (store.state.room ??= {});
room.running ??= false;
room.sleeping ??= false;
room.speed ??= cfg.speed;
room.boostMode ??= cfg.boost.mode;
room.autoSleepMin ??= cfg.autoSleepMinutes;
room.enabled ??= {};
for (const id of AI_IDS) room.enabled[id] ??= true;
room.lastUserAt = Date.now();
room.calls ??= 0;
store.state.seen ??= {};

const agents = {};
for (const id of AI_IDS) {
  agents[id] = {
    id, busy: false, status: 'idle', seen: store.state.seen[id] ?? store.lastId,
    wakeAt: null, reason: null, idleAt: null, idleStreak: 0, lastEnd: 0,
    fails: 0, offlineUntil: 0, lastError: '', imageBusy: false, lastImageAt: 0, calls: 0, lastMs: 0,
    callTimes: [], lastSelfBoostAt: 0, deepNow: false,
  };
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    for (const id of AI_IDS) store.state.seen[id] = agents[id].seen;
    store.saveState();
  }, 500);
}

const isActive = (id) => room.enabled[id] && avail[id];
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const name = (id) => displayName(id, cfg.userName);
const nameJ = (id, pair) => withJosa(id, cfg.userName, pair);

// Room texts per language: system messages, API errors, notes handed to the members and
// console lines. Read with tx() at use time. Korean keeps its particles (nameJ / withJosa);
// English and Japanese use the plain name.
const T = {
  ko: {
    devIn: () => `🛠 ${DEV.name} 들어옴 (개발 세션 연결)`,
    devOut: () => `🛠 ${DEV.name} 나감`,
    devPause: (why) => `⏸ ${why} 쌓여서 ${withJosa(cfg.userName, cfg.userName, '이/가')} 말할 때까지 다들 잠깐 쉬어`,
    boostOn: (id, model, why) => `🔥 ${name(id)} 진심모드 — ${model} · ${why}`,
    boostFail: (id, timeout) => `${name(id)} 진심모드가 ${timeout ? '너무 오래 걸려서' : '실패해서'} 기본 모델로 답할게`,
    selfBoost: (why) => `스스로 판단: ${why}`,
    shotBlind: '(월드 스크린샷을 찍었는데 너한텐 사진이 안 보여)',
    worldMap: '건축 월드 지도',
    cut: (n) => `\n…(${n}자 잘림)`,
    autoDesc: (d) => `자동 설명: ${d}`,
    artistPrompt: (p) => `그린 사람이 쓴 프롬프트: ${p}`,
    noDesc: '설명 없음',
    blindImage: (about) => `(그림 파일이라 너한텐 직접 안 보여. ${about})`,
    verb: { create: '새로 만듦', write: '다시 씀', append: '내용 추가', edit: '수정', delete: '삭제' },
    fileFail: (id, err) => `${name(id)}의 파일 작업 실패: ${err}`,
    showMissing: (id, rel) => `${nameJ(id, '이/가')} 보여주려던 ${rel} 파일이 없어`,
    newBlock: (id, n) => `🎨 ${name(id)} → 새 블록 ${n} 만듦`,
    blockFail: (id, err) => `${name(id)}의 블록 만들기: ${err}`,
    buildNotes: (id, notes) => `${name(id)}의 건축: ${notes}`,
    stickerSaved: (id, rel) => `${name(id)} → ${rel} 스티커로 저장`,
    stickerFail: (id, err) => `${name(id)}의 스티커 저장 실패: ${err}`,
    noImage: (rel) => `없는 그림 ${rel}`,
    stickerPath: '저장 경로는 stickers/멤버/이름.png 식이어야 해',
    stickerExt: '확장자가 원본이랑 같아야 해',
    fileLimit: '파일 개수 한도',
    cameraLift: (id, x, y, z, fy) => `📸 ${name(id)} 카메라 칸 (${x},${y},${z})이 블록 안이라 (${x},${fy},${z})로 올려서 찍어`,
    shotFail: (id, err) => `${name(id)}의 월드 스크린샷 실패: ${err}`,
    cantDraw: (id, busy, sec) => `${nameJ(id, '은/는')} 아직 그림을 못 그려 (${busy ? '그리는 중' : `${sec}초 뒤 가능`})`,
    drawing: (id) => `🎨 ${name(id)} 그림 그리는 중…`,
    drawFail: (id) => `${name(id)}의 그림 생성 실패`,
    slept: () => `💤 ${withJosa(cfg.userName, cfg.userName, '이/가')} 한동안 조용해서 다들 잠들었어. 말 걸면 깨어나.`,
    imgEmpty: '이미지가 비어 있어',
    imgTooBig: (mb) => `이미지는 ${mb}MB까지만 돼`,
    imgType: 'PNG, JPG, GIF, WEBP 이미지만 올릴 수 있어',
    imgLimit: '작업공간 파일 개수 한도라 못 올려',
    tooLarge: '보낸 내용이 너무 커',
    noSticker: '없는 스티커야',
    boostWho: '누구를 진심모드로 할지 적어줘. 예: /boost @Grok 이거 봐줘',
    boostOff: '진심모드가 꺼져 있어. 방 설정에서 켜줘.',
    boostNone: '그 멤버는 진심모드 설정이 없어',
    boostArmed: (names) => `⚡ ${withJosa(cfg.userName, cfg.userName, '이/가')} ${names} 진심모드를 켰어 (다음 턴)`,
    joined: (id) => `${name(id)} 들어옴`,
    left: (id) => `${name(id)} 잠깐 나감`,
    sep: ', ',
    welcome: (members) => `${withJosa(cfg.roomName, cfg.userName, '이/가')} 열렸어. 멤버: ${members}, 그리고 ${cfg.userName}.`,
    extPortFail: (err) => `외부 접속 포트를 못 열었어: ${err}`,
    extOn: (proto, port) => `외부 접속 → ${proto}://<공인 IP>:${port} (비밀번호: data/external-password.txt)`,
    extFail: (err) => `외부 접속을 못 켰어: ${err}`,
    portBusy: (port, code) => `포트 ${port}을(를) 못 열었어 (${code}). 방이 이미 켜져 있거나, 다른 프로그램이 쓰거나, 막힌 포트야.`,
    portHint: 'config.json의 "port"를 바꾸거나 setup(setup.bat / ./setup.sh)을 다시 실행해서 빈 포트를 골라 줘.',
    listening: (url) => `AI 단톡방 → ${url}`,
    cliMissing: (list) => `찾을 수 없는 CLI: ${list} (그 멤버는 오프라인)`,
    cliHint: '설치·로그인은 setup.bat(Windows) / ./setup.sh(macOS·Linux)가 도와줘.',
  },
  en: {
    devIn: () => `🛠 ${DEV.name} joined (dev session connected)`,
    devOut: () => `🛠 ${DEV.name} left`,
    devPause: (why) => `⏸ ${why}, so everyone's taking a break until ${cfg.userName} says something`,
    boostOn: (id, model, why) => `🔥 ${name(id)} Boost mode — ${model} · ${why}`,
    boostFail: (id, timeout) => `${name(id)}'s Boost mode ${timeout ? 'took too long' : 'failed'}, so it's answering with the default model`,
    selfBoost: (why) => `self-requested: ${why}`,
    shotBlind: "(You took a world screenshot, but you can't see pictures.)",
    worldMap: 'Build World map',
    cut: (n) => `\n…(${n} more characters cut)`,
    autoDesc: (d) => `Auto description: ${d}`,
    artistPrompt: (p) => `Prompt the artist used: ${p}`,
    noDesc: 'No description',
    blindImage: (about) => `(It's a picture, so you can't see it directly. ${about})`,
    verb: { create: 'created', write: 'rewritten', append: 'appended', edit: 'edited', delete: 'deleted' },
    fileFail: (id, err) => `${name(id)}'s file operation failed: ${err}`,
    showMissing: (id, rel) => `${name(id)} tried to show ${rel}, but that file doesn't exist`,
    newBlock: (id, n) => `🎨 ${name(id)} → made a new block ${n}`,
    blockFail: (id, err) => `${name(id)} couldn't make the block: ${err}`,
    buildNotes: (id, notes) => `${name(id)}'s build: ${notes}`,
    stickerSaved: (id, rel) => `${name(id)} → saved ${rel} as a sticker`,
    stickerFail: (id, err) => `${name(id)} couldn't save the sticker: ${err}`,
    noImage: (rel) => `No such image ${rel}`,
    stickerPath: 'The save path must look like stickers/member/name.png',
    stickerExt: 'The extension must match the original',
    fileLimit: 'File limit reached',
    cameraLift: (id, x, y, z, fy) => `📸 ${name(id)}'s camera spot (${x},${y},${z}) is inside a block, so it moves up to (${x},${fy},${z}) for the shot`,
    shotFail: (id, err) => `${name(id)}'s world screenshot failed: ${err}`,
    cantDraw: (id, busy, sec) => `${name(id)} can't draw yet (${busy ? 'still drawing' : `ready in ${sec}s`})`,
    drawing: (id) => `🎨 ${name(id)} is drawing…`,
    drawFail: (id) => `${name(id)}'s image generation failed`,
    slept: () => `💤 Everyone dozed off since ${cfg.userName} went quiet. Say something to wake them up.`,
    imgEmpty: 'The image is empty',
    imgTooBig: (mb) => `Images can be up to ${mb}MB`,
    imgType: 'Only PNG, JPG, GIF and WEBP images can be uploaded',
    imgLimit: "The Workspace is at its file limit, so the image can't be uploaded",
    tooLarge: 'That was too big to send',
    noSticker: "That sticker doesn't exist",
    boostWho: 'Say who to put in Boost mode, e.g. /boost @Grok take a look at this',
    boostOff: 'Boost mode is off. Turn it on in the room settings.',
    boostNone: "That member doesn't have Boost mode settings",
    boostArmed: (names) => `⚡ ${cfg.userName} turned on Boost mode for ${names} (next turn)`,
    joined: (id) => `${name(id)} joined`,
    left: (id) => `${name(id)} stepped out for a bit`,
    sep: ', ',
    welcome: (members) => `${cfg.roomName} is open. Members: ${members}, and ${cfg.userName}.`,
    extPortFail: (err) => `Couldn't open the external access port: ${err}`,
    extOn: (proto, port) => `External access → ${proto}://<public IP>:${port} (password: data/external-password.txt)`,
    extFail: (err) => `Couldn't turn on external access: ${err}`,
    portBusy: (port, code) => `Couldn't open port ${port} (${code}). The room may already be running, another program may be using it, or the port is blocked.`,
    portHint: 'Change "port" in config.json, or run setup again (setup.bat / ./setup.sh) to pick a free port.',
    listening: (url) => `AI Group Chat → ${url}`,
    cliMissing: (list) => `CLI not found: ${list} (those members stay offline)`,
    cliHint: 'setup.bat (Windows) / ./setup.sh (macOS, Linux) helps with installing and logging in.',
  },
  ja: {
    devIn: () => `🛠 ${DEV.name}が入ってきた(開発セッション接続)`,
    devOut: () => `🛠 ${DEV.name}が抜けた`,
    devPause: (why) => `⏸ ${why}から、${cfg.userName}が話すまでみんなちょっと休憩ね`,
    boostOn: (id, model, why) => `🔥 ${name(id)} 本気モード — ${model} · ${why}`,
    boostFail: (id, timeout) => `${name(id)}の本気モードが${timeout ? '時間かかりすぎた' : '失敗した'}から、いつものモデルで答えるね`,
    selfBoost: (why) => `自分で判断: ${why}`,
    shotBlind: '(ワールドのスクショを撮ったけど、自分には画像が見えない)',
    worldMap: '建築ワールドの地図',
    cut: (n) => `\n…(${n}文字省略)`,
    autoDesc: (d) => `自動説明: ${d}`,
    artistPrompt: (p) => `描いた人が書いたプロンプト: ${p}`,
    noDesc: '説明なし',
    blindImage: (about) => `(画像ファイルだから自分には直接見えない。${about})`,
    verb: { create: '新規作成', write: '書き直し', append: '追記', edit: '修正', delete: '削除' },
    fileFail: (id, err) => `${name(id)}のファイル操作が失敗: ${err}`,
    showMissing: (id, rel) => `${name(id)}が見せようとした ${rel} ってファイルはないよ`,
    newBlock: (id, n) => `🎨 ${name(id)} → 新しいブロック ${n} を作った`,
    blockFail: (id, err) => `${name(id)}のブロック作り: ${err}`,
    buildNotes: (id, notes) => `${name(id)}の建築: ${notes}`,
    stickerSaved: (id, rel) => `${name(id)} → ${rel} をスタンプに保存`,
    stickerFail: (id, err) => `${name(id)}のスタンプ保存が失敗: ${err}`,
    noImage: (rel) => `画像 ${rel} がない`,
    stickerPath: '保存先は stickers/メンバー/名前.png の形にして',
    stickerExt: '拡張子は元のファイルと同じにして',
    fileLimit: 'ファイル数の上限',
    cameraLift: (id, x, y, z, fy) => `📸 ${name(id)}のカメラ位置 (${x},${y},${z}) がブロックの中だから、(${x},${fy},${z}) まで上げて撮るね`,
    shotFail: (id, err) => `${name(id)}のワールドのスクショが失敗: ${err}`,
    cantDraw: (id, busy, sec) => `${name(id)}はまだ絵を描けない(${busy ? '描いてる途中' : `あと${sec}秒`})`,
    drawing: (id) => `🎨 ${name(id)}が絵を描いてる…`,
    drawFail: (id) => `${name(id)}の画像生成が失敗`,
    slept: () => `💤 ${cfg.userName}がしばらく静かだったから、みんな寝ちゃった。話しかければ起きるよ。`,
    imgEmpty: '画像が空っぽだよ',
    imgTooBig: (mb) => `画像は${mb}MBまでだよ`,
    imgType: 'アップできるのはPNG、JPG、GIF、WEBPの画像だけだよ',
    imgLimit: 'ワークスペースのファイル数が上限だからアップできない',
    tooLarge: '送った内容が大きすぎる',
    noSticker: 'そのスタンプはないよ',
    boostWho: '誰を本気モードにするか書いて。例: /boost @Grok これ見て',
    boostOff: '本気モードがオフになってる。ルーム設定でオンにして。',
    boostNone: 'そのメンバーには本気モードの設定がないよ',
    boostArmed: (names) => `⚡ ${cfg.userName}が${names}の本気モードをオンにした(次のターン)`,
    joined: (id) => `${name(id)}が入ってきた`,
    left: (id) => `${name(id)}がちょっと抜けた`,
    sep: '、',
    welcome: (members) => `${cfg.roomName}がオープンしたよ。メンバー: ${members}、それと${cfg.userName}。`,
    extPortFail: (err) => `外部アクセス用のポートを開けなかった: ${err}`,
    extOn: (proto, port) => `外部アクセス → ${proto}://<グローバルIP>:${port} (パスワード: data/external-password.txt)`,
    extFail: (err) => `外部アクセスをオンにできなかった: ${err}`,
    portBusy: (port, code) => `ポート${port}を開けなかった(${code})。ルームがもう動いてるか、ほかのプログラムが使ってるか、ブロックされてるポートだよ。`,
    portHint: 'config.jsonの"port"を変えるか、setup(setup.bat / ./setup.sh)をもう一回実行して空いてるポートを選んで。',
    listening: (url) => `AIグループチャット → ${url}`,
    cliMissing: (list) => `見つからないCLI: ${list} (そのメンバーはオフライン)`,
    cliHint: 'インストールとログインは setup.bat (Windows) / ./setup.sh (macOS・Linux) が手伝ってくれるよ。',
  },
};
const tx = () => pick(T);

// ---------------------------------------------------------------------------
// SSE

const clients = new Set();
function broadcast(type, data) {
  const s = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(s);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

function memberView(id) {
  const a = agents[id];
  let status = a.status;
  if (!avail[id]) status = 'missing';
  else if (!room.enabled[id]) status = 'off';
  else if (!room.running && !a.busy) status = room.sleeping ? 'sleeping' : 'away';
  else if (Date.now() < a.offlineUntil) status = 'error';
  return {
    id, name: MEMBERS[id].name, maker: MEMBERS[id].maker, color: MEMBERS[id].color,
    model: cfg.agents[id].model, imageGen: MEMBERS[id].imageGen && cfg.imageGen,
    status, drawing: a.imageBusy, enabled: room.enabled[id], available: avail[id],
    calls: a.calls, lastMs: a.lastMs, lastError: a.lastError,
    deep: !!a.deepNow, defaultModel: defaultLabel(id), boostModel: hasBoost(id) ? boostLabel(id) : null,
  };
}
function roomView() {
  return {
    running: room.running, sleeping: room.sleeping, speed: room.speed, autoSleepMin: room.autoSleepMin,
    calls: room.calls, roomName: cfg.roomName, userName: cfg.userName, lang: getLang(), boostMode: boostMode(),
    dev: { online: devBridge.online },
  };
}
function pushMembers() { broadcast('members', AI_IDS.map(memberView)); }
function pushRoom() { broadcast('room', roomView()); }
function setStatus(a, status) {
  if (a.status === status) return;
  a.status = status;
  pushMembers();
}

function post(m) {
  const msg = store.addMessage(m);
  broadcast('msg', msg);
  devBridge.notify(msg);
  return msg;
}

function react(targetId, by, emoji) {
  const msg = store.applyReaction(targetId, by, emoji);
  if (msg) broadcast('msgupdate', msg);
}

// ---------------------------------------------------------------------------
// Scheduler

function tick() {
  if (!room.running) return;
  const now = Date.now();
  if (room.autoSleepMin > 0 && now - room.lastUserAt > room.autoSleepMin * 60000) {
    sleepRoom();
    return;
  }
  const sp = SPEEDS[room.speed] || SPEEDS.normal;
  let inflight = AI_IDS.filter((id) => agents[id].busy).length;
  const last = store.lastMessage();
  const quietMs = now - Math.max(last?.ts ?? 0, room.startedAt ?? 0);
  const aiBubbles = store.recent(60).filter((m) => AI_IDS.includes(m.from) && now - m.ts < 60000).length;
  // Dev <-> AI back-and-forth guard: while it holds, only the user's messages wake the AIs.
  const chain = cfg.dev.enabled ? devChainState(store.recent(80), now, { ...cfg.dev, userName: cfg.userName }) : null;
  noteDevPause(chain);
  if (!chain) maybeSpark(now, sp);

  for (const id of shuffle([...AI_IDS])) {
    const a = agents[id];
    if (!isActive(id) || a.busy || now < a.offlineUntil) continue;

    const fresh = store.after(a.seen).filter((m) => m.from !== id);
    if (chain && !fresh.some((m) => m.from === 'user')) {
      a.wakeAt = null;
      continue;
    }
    if (!adapters.canSee(id) && waitingForDesc(fresh, now)) continue;
    if (fresh.length) {
      a.idleStreak = 0;
      a.idleAt = null;
      const urgent = fresh.some((m) => isCalled(m, id));
      if (!a.wakeAt || (urgent && a.reason !== 'urgent')) {
        const [lo, hi] = urgent ? [1, 3] : sp.read;
        a.wakeAt = now + rand(lo, hi) * 1000;
        a.reason = urgent ? 'urgent' : 'new';
      }
    } else if (!a.wakeAt && !sparkOn()) {
      // Old quiet-time behaviour (spark off): everyone gets their own idle turn.
      a.idleAt ??= now + rand(...sp.idle) * 1000 * Math.pow(1.7, Math.min(a.idleStreak, 5));
      if (now >= a.idleAt && quietMs > sp.idle[0] * 500) {
        a.wakeAt = now;
        a.reason = 'idle';
      }
    }

    if (!a.wakeAt || now < a.wakeAt) continue;
    if (now - a.lastEnd < sp.cooldown * 1000) continue;
    if (inflight >= cfg.maxInFlight) continue;
    if (a.reason !== 'urgent' && aiBubbles >= sp.perMin) continue;
    if (a.reason === 'idle' && AI_IDS.some((o) => agents[o].busy && agents[o].turnReason === 'idle')) {
      a.wakeAt = null;
      a.idleAt = now + 15000;
      continue;
    }
    inflight++;
    runTurn(a);
  }
}

// ---- Breaking the silence ----
// When nobody has said anything for a while, every member used to get its own idle turn,
// and each one passed, waiting for someone else (bystander effect). Now one member at a
// time is picked, told it is its turn to start something, and given ideas that come from
// the room itself (its own "하고 싶은 것" notes, the time of day, a random card), never
// from the user. If it passes, the next pick waits longer.

const spark = { base: null, streak: 0, wait: null, lastEnd: 0, lastBy: null, who: null, quick: false };
const sparkOn = () => cfg.spark.enabled !== false;

function lastSaid(id) {
  for (let i = store.messages.length - 1; i >= 0; i--) if (store.messages[i].from === id) return store.messages[i].ts;
  return 0;
}

// The member who has been quiet the longest (not the one picked last time), with a little luck.
function pickSparker(now) {
  const cands = AI_IDS.filter((id) => isActive(id) && !agents[id].busy && !agents[id].wakeAt && now >= agents[id].offlineUntil);
  if (!cands.length) return null;
  const pool = cands.length > 1 ? cands.filter((id) => id !== spark.lastBy) : cands;
  pool.sort((x, y) => lastSaid(x) - lastSaid(y));
  const top = pool.slice(0, 2);
  return agents[top[Math.floor(Math.random() * top.length)]];
}

function maybeSpark(now, sp) {
  if (!sparkOn()) return;
  // Activity = anyone (user, members, dev) saying something; system notices don't count.
  const lastReal = [...store.recent(60)].reverse().find((m) => m.from !== 'system');
  const activity = Math.max(lastReal?.ts ?? 0, room.startedAt ?? 0);
  if (activity !== spark.base) {
    spark.base = activity;
    spark.streak = 0;
    spark.wait = spark.quick ? rand(4, 25) * 1000 : null;
    spark.quick = false;
  }
  if (spark.who) {
    const w = agents[spark.who];
    if (w.busy || w.wakeAt) return; // the pick is still running
    spark.who = null;
  }
  if (AI_IDS.some((id) => agents[id].busy || agents[id].wakeAt)) return; // the room is not actually idle
  const after = Array.isArray(cfg.spark.afterSec) ? cfg.spark.afterSec : sp.spark;
  spark.wait ??= Math.min(rand(...after) * Math.pow(cfg.spark.backoff, spark.streak), cfg.spark.maxWaitSec) * 1000;
  if (now < Math.max(spark.base, spark.lastEnd) + spark.wait) return;
  const a = pickSparker(now);
  if (!a) return;
  spark.who = a.id;
  a.wakeAt = now;
  a.reason = 'spark';
  store.log(a.id, `spark: picked after ${Math.round((now - spark.base) / 1000)}s of quiet (streak ${spark.streak})`);
}

// Called when a spark turn ends.
function sparkDone(a, spoke) {
  spark.lastEnd = Date.now();
  spark.lastBy = a.id;
  spark.wait = null;
  spark.streak = spoke ? 0 : spark.streak + 1;
  if (spark.who === a.id) spark.who = null;
}

// Should `id` answer `m` right away? Replies to it and @mentions do. A message from the
// user does too, unless the user is clearly talking to someone else.
function isCalled(m, id) {
  if (m.from === 'system' || m.from === id) return false;
  if (store.byId.get(m.replyTo)?.from === id) return true;
  if (atMentions(m.text, id)) return true;
  if (m.from !== 'user') return false;
  const named = AI_IDS.filter((o) => mentions(m.text, o));
  const repliedTo = store.byId.get(m.replyTo)?.from;
  if (AI_IDS.includes(repliedTo)) return false;
  return !named.length || named.includes(id);
}

// Tell the room once per dev message when the back-and-forth guard kicks in (checked
// against the log, so a server restart does not repeat it).
function noteDevPause(chain) {
  if (!chain) return;
  const lastDev = [...store.recent(80)].reverse().find((m) => m.from === DEV.id);
  if (!lastDev || store.after(lastDev.id).some((m) => m.kind === 'pause')) return;
  post({ from: 'system', kind: 'pause', text: tx().devPause(chain.why) });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- 진심모드: default model for chatter, boost settings when the turn needs it ----

const router = new Router(cfg);
const boostMode = () => room.boostMode || 'auto';
const hasBoost = (id) => boostMode() !== 'off' && !!router.boostOf(id);
const defaultLabel = (id) => cfg.agents[id].model;
const boostLabel = (id) => modelLabel({ ...cfg.agents[id], ...cfg.agents[id].boost });
function selfBoostWait(a) {
  return Math.max(0, cfg.boost.selfCooldownSec * 1000 - (Date.now() - a.lastSelfBoostAt));
}
function startDeep(a, deep) {
  a.deepNow = true;
  if (deep.by === 'self') a.lastSelfBoostAt = Date.now();
  post({ from: 'system', kind: 'deep', by: a.id, text: tx().boostOn(a.id, boostLabel(a.id), deep.reason) });
  store.log(a.id, `route BOOST ${boostLabel(a.id)} by=${deep.by} reason=${deep.reason}`);
  console.log(`[route] ${a.id} ${defaultLabel(a.id)} -> ${boostLabel(a.id)} (${deep.reason})`);
  pushMembers();
}
const turnMeta = (a, deep) => (deep
  ? { model: boostLabel(a.id), deep: true, boostWhy: deep.reason }
  : { model: defaultLabel(a.id) });

// ask() on the boost settings, falling back to the default ones if that call fails.
async function askRouted(a, reason, openFile, deep) {
  if (!deep) return { act: await ask(a, reason, openFile, null), deep: null };
  try {
    return { act: await ask(a, reason, openFile, deep), deep };
  } catch (e) {
    const msg = String(e.message || e);
    store.log(a.id, `route BOOST failed -> default ${defaultLabel(a.id)}: ${msg.slice(0, 200)}`);
    console.log(`[route] ${a.id} boost failed, falling back to ${defaultLabel(a.id)}`);
    a.deepNow = false;
    pushMembers();
    if (room.running) post({ from: 'system', kind: 'error', by: a.id, text: tx().boostFail(a.id, /timeout/.test(msg)) });
    return { act: await ask(a, reason, openFile, null), deep: null };
  }
}

// Photos the user posted since this member last looked (newest 3), for members that can see.
function unseenUploads(a) {
  return store.after(a.seen)
    .filter((m) => m.attach?.upload && fs.existsSync(store.abs(m.attach.path)))
    .slice(-3);
}

async function ask(a, reason, openFile, deep = null) {
  const canSee = adapters.canSee(a.id);
  const ups = canSee && !openFile ? unseenUploads(a) : [];
  const images = openFile?.image ? [openFile.image] : ups.map((m) => store.abs(m.attach.path));
  const attached = new Set(ups.map((m) => m.id));
  const brief = buildBrief(a.id, cfg, { deep, mode: boostMode(), devOnline: devBridge.online, canSee });
  const max = adapters.maxPromptChars(a.id) - brief.length - 200;
  const deepWait = !deep && hasBoost(a.id) && boostMode() === 'auto' ? selfBoostWait(a) : 0;
  let hist = cfg.historyForPrompt;
  let turn;
  for (;;) {
    turn = buildTurn(a.id, { store, cfg: { ...cfg, historyForPrompt: hist }, agent: a, reason, openFile, deepWait, canSee, attached, world: world.summary(a.id, name) });
    if (turn.length <= max || hist <= 8) break;
    hist -= 8;
  }
  a.calls++;
  room.calls++;
  const now = Date.now();
  a.callTimes = a.callTimes.filter((t) => now - t < 3600000);
  a.callTimes.push(now);
  pushRoom();
  pushUsageSoon();
  const res = await adapters.chat(a.id, brief, turn, { boost: !!deep, images });
  a.lastMs = res.ms;
  store.log(a.id, `turn reason=${reason} model=${deep ? `${boostLabel(a.id)} BOOST` : defaultLabel(a.id)}${images.length ? ` images=${images.length}` : ''} ms=${res.ms} ok=${res.ok}\n${res.text.slice(0, 4000)}${res.detail ? `\nDETAIL ${res.detail}` : ''}`);
  if (!res.ok) throw new Error(res.detail || 'empty reply');
  const act = parseAction(res.text);
  if (!act) store.log(a.id, 'could not parse a JSON action');
  return act;
}

async function runTurn(a) {
  const reason = a.reason;
  a.busy = true;
  a.turnReason = reason;
  a.wakeAt = null;
  a.reason = null;
  setStatus(a, 'reading');
  const snapshot = store.lastId;
  let spoke = false;
  // Routing is decided fresh every turn (see lib/router.mjs); no boost unless something asks for it.
  let deep = hasBoost(a.id) ? router.decide(a.id, store, a.seen, boostMode()) : null;
  try {
    if (deep) startDeep(a, deep);
    let r = await askRouted(a, reason, null, deep);
    let act = r.act;
    deep = r.deep;
    const selfAsk = act?.boost ?? act?.deep;
    if (!deep && selfAsk && hasBoost(a.id) && boostMode() === 'auto' && room.running) {
      if (selfBoostWait(a) > 0) {
        store.log(a.id, 'boost requested while cooling down; answering as usual');
      } else {
        deep = { by: 'self', reason: tx().selfBoost(String(selfAsk).replace(/\s+/g, ' ').slice(0, 100)) };
        // Let the default model's one-line lead-in ("잠깐, 제대로 답할게") through first.
        const lead = Array.isArray(act.messages) ? act.messages.filter(Boolean).slice(0, 1) : [];
        if (lead.length) spoke = await perform(a, { action: 'say', messages: lead, reply_to: act.reply_to }, snapshot, 'urgent', turnMeta(a, null));
        startDeep(a, deep);
        r = await askRouted(a, reason, null, deep);
        act = r.act;
        deep = r.deep;
      }
    }
    // world_shot: photograph the 3D world, post it, and show it to the member (like "open").
    if (act?.world_shot && room.running) {
      const shot = await takeWorldShot(a.id, act.world_shot);
      if (shot) {
        r = await askRouted(a, 'open', adapters.canSee(a.id) ? { rel: shot, image: store.abs(shot) } : { rel: shot, text: tx().shotBlind }, deep);
        act = r.act || act;
        deep = r.deep;
      }
      if (act) delete act.world_shot;
    }
    // world_look: hand over a text map of the building world and ask again (like "open").
    if (act?.world_look && room.running) {
      r = await askRouted(a, 'open', { rel: tx().worldMap, text: world.look(act.world_look) }, deep);
      act = r.act || act;
      deep = r.deep;
      if (act) delete act.world_look;
    }
    if (act?.open && room.running) {
      try {
        const f = store.readFile(act.open);
        let opened;
        if (!f.image) {
          const limit = a.id === 'gemini' ? 12000 : 40000;
          opened = { rel: f.rel, text: f.text.length > limit ? f.text.slice(0, limit) + tx().cut(f.text.length - limit) : f.text };
        } else if (adapters.canSee(a.id)) {
          opened = { rel: f.rel, image: store.abs(f.rel) };
        } else {
          // No eyes: hand over what the room knows about the picture instead.
          const src = [...store.messages].reverse().find((m) => m.attach?.path === f.rel)?.attach;
          const t = tx();
          const about = src?.desc ? t.autoDesc(src.desc) : src?.prompt ? t.artistPrompt(src.prompt) : t.noDesc;
          opened = { rel: f.rel, text: t.blindImage(about) };
        }
        r = await askRouted(a, 'open', opened, deep);
        act = r.act || act;
        deep = r.deep;
      } catch (e) {
        store.log(a.id, `open failed: ${e.message}`);
      }
    }
    // A boosted answer took a while; don't throw it away as stale.
    if (act && room.running) spoke = (await perform(a, act, snapshot, deep ? 'urgent' : reason, turnMeta(a, deep))) || spoke;
    a.fails = 0;
    a.lastError = '';
  } catch (e) {
    a.fails++;
    a.lastError = String(e.message || e).slice(0, 300);
    store.log(a.id, `ERROR ${a.lastError}`);
    // back off: 20s, 40s, 80s … up to 5 min
    a.offlineUntil = Date.now() + Math.min(20000 * 2 ** (a.fails - 1), 300000);
  }
  if (reason === 'idle' && !spoke) a.idleStreak++;
  if (reason === 'spark') sparkDone(a, spoke);
  else if (spark.who === a.id) spark.who = null; // the pick got pulled into a normal turn
  a.seen = Math.max(a.seen, snapshot);
  a.lastEnd = Date.now();
  a.idleAt = null;
  a.busy = false;
  a.deepNow = false;
  a.turnReason = null;
  a.status = 'idle';
  saveSoon();
  pushMembers();
}

function typingDelay(text) {
  const sp = SPEEDS[room.speed] || SPEEDS.normal;
  return Math.min(700 + text.length * 40, 4000) * sp.typing;
}

// Apply one parsed action. Returns true if the AI said something visible.
// meta: {model, deep} stamped on the messages this turn posts.
async function perform(a, act, snapshot, reason, meta = {}) {
  const id = a.id;
  let visible = false;

  if (act.react && Number(act.react.id) && act.react.emoji) {
    react(Number(act.react.id), id, String(act.react.emoji).slice(0, 8));
    visible = true;
  }

  let notesChanged = false;
  if (typeof act.note_replace === 'string' && act.note_replace.trim()) { store.writeNote(id, act.note_replace); notesChanged = true; }
  if (typeof act.note_add === 'string' && act.note_add.trim()) { store.appendNote(id, act.note_add); notesChanged = true; }
  if (notesChanged) broadcast('notes', { id, text: store.readNote(id) });

  let msgs = Array.isArray(act.messages) ? act.messages : (typeof act.messages === 'string' ? [act.messages] : []);
  msgs = msgs.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 4).map((s) => s.slice(0, 2000));
  if (act.action === 'pass' && !act.show) msgs = [];

  // If the room moved on a lot while this AI was thinking, drop the stale chatter.
  const movedOn = store.after(snapshot).filter((m) => m.from !== id && m.from !== 'system').length;
  if (msgs.length && movedOn >= 3 && reason !== 'urgent') {
    store.log(id, `dropped stale messages (${movedOn} new since snapshot)`);
    msgs = [];
  }

  const replyTo = Number(act.reply_to);
  let first = true;
  for (const text of msgs) {
    setStatus(a, 'typing');
    await sleep(typingDelay(text));
    if (!room.running) break;
    post({ from: id, text, replyTo: first && store.byId.has(replyTo) ? replyTo : undefined, ...meta });
    first = false;
    visible = true;
  }

  let wsChanged = false;
  for (const op of (Array.isArray(act.files) ? act.files : []).slice(0, 6)) {
    if (!op || typeof op !== 'object') continue;
    try {
      const r = store.applyFileOp(op, id);
      wsChanged = true;
      visible = true;
      post({ from: 'system', kind: 'file', by: id, file: r.op === 'delete' ? undefined : r.rel, text: `${name(id)} → ${r.rel} ${tx().verb[r.op] || r.op}` });
    } catch (e) {
      post({ from: 'system', kind: 'error', by: id, text: tx().fileFail(id, e.message) });
    }
  }
  if (wsChanged) broadcast('ws', store.listFiles());

  if (act.show && room.running) {
    try {
      const rel = store.safeRel(act.show);
      if (fs.existsSync(store.abs(rel))) {
        post({ from: id, text: '', attach: { path: rel }, ...meta });
        visible = true;
      } else {
        post({ from: 'system', kind: 'error', by: id, text: tx().showMissing(id, rel) });
      }
    } catch (e) {
      store.log(id, `show failed: ${e.message}`);
    }
  }

  // Building world: blocks first, then where the member stands (by default next to what it
  // just built, so the viewer shows who is working where).
  let moved = false;
  // New blocks first, so the same turn can build with them.
  for (const def of (Array.isArray(act.block_define) ? act.block_define : act.block_define ? [act.block_define] : []).slice(0, 4)) {
    try {
      const n = world.define(def, id);
      broadcast('worldblocks', world.custom);
      post({ from: 'system', kind: 'world', by: id, text: tx().newBlock(id, n) });
      visible = true;
    } catch (e) {
      post({ from: 'system', kind: 'error', by: id, text: tx().blockFail(id, e.message) });
    }
  }
  if (act.build) {
    const r = world.apply(act.build, id);
    if (r.changes.length) {
      broadcast('world', { by: id, changes: r.changes });
      const last = r.changes[r.changes.length - 1];
      if (!act.move) moved = world.move(id, { x: last[0], z: last[2] + 1 });
    }
    if (r.signs) broadcast('signs', world.signs);
    if (r.changes.length || r.signs) {
      post({ from: 'system', kind: 'world', by: id, text: `🧱 ${name(id)} ${world.log[world.log.length - 1].text}` });
      visible = true;
    }
    if (r.notes.length) post({ from: 'system', kind: 'error', by: id, text: tx().buildNotes(id, r.notes.slice(0, 3).join(' / ')) });
  }
  if (act.move) moved = world.move(id, act.move) || moved;
  if (moved) broadcast('avatars', world.avatarView());

  if (act.sticker_save && typeof act.sticker_save === 'object') {
    try {
      const r = saveSticker(act.sticker_save.from, act.sticker_save.to, id);
      post({ from: 'system', kind: 'file', by: id, file: r, text: tx().stickerSaved(id, r) });
      broadcast('ws', store.listFiles());
      visible = true;
    } catch (e) {
      post({ from: 'system', kind: 'error', by: id, text: tx().stickerFail(id, e.message) });
    }
  }

  if (act.sticker && room.running) {
    const rel = stickerPath(act.sticker);
    if (rel && fs.existsSync(store.abs(rel))) {
      post({ from: id, text: '', attach: { path: rel, sticker: true }, ...meta });
      visible = true;
    } else {
      store.log(id, `sticker not found: ${act.sticker}`);
    }
  }

  if (act.image && MEMBERS[id].imageGen && cfg.imageGen) {
    const req = imageRequest(act.image);
    if (req) {
      startImage(a, req);
      visible = true;
    }
  }
  return visible;
}

// ---- stickers: images under stickers/ in the workspace, shown small with no bubble ----

// A workspace path under stickers/ with an image extension, or null.
function stickerPath(p) {
  try {
    const rel = store.safeRel(p);
    return rel.startsWith('stickers/') && store.isImage(rel) ? rel : null;
  } catch {
    return null;
  }
}

// Copy a workspace image (e.g. a generated one in images/) into stickers/.
function saveSticker(from, to, by) {
  const src = store.safeRel(from);
  if (!store.isImage(src) || !fs.existsSync(store.abs(src))) throw new Error(tx().noImage(src));
  const dst = stickerPath(to);
  if (!dst) throw new Error(tx().stickerPath);
  if (path.posix.extname(dst).toLowerCase() !== path.posix.extname(src).toLowerCase()) throw new Error(tx().stickerExt);
  const existed = fs.existsSync(store.abs(dst));
  if (!existed && store.listFiles().length >= 300) throw new Error(tx().fileLimit);
  fs.mkdirSync(path.dirname(store.abs(dst)), { recursive: true });
  fs.copyFileSync(store.abs(src), store.abs(dst));
  store.touchMeta(dst, by, !existed);
  return dst;
}

// Screenshot of the 3D world for a member (lib/worldshot.mjs). Returns the workspace path
// of the PNG, or null (the failure is posted to the room).
async function takeWorldShot(id, req) {
  const v = req && typeof req === 'object' ? req : {};
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : undefined);
  const at = Array.isArray(v.at) ? v.at : [v.x, v.z];
  const vec = (a, n) => (Array.isArray(a) && a.length === n && a.every((x) => num(x) !== undefined) ? a.map(Number) : null);
  const from = vec(v.from, 3), lookAt = vec(v.look_at, 3), quat = vec(v.quat, 4);
  // A camera placed inside a block only sees that block's inside: lift it to the first
  // free cell above and say so.
  if (from) {
    const [fx, fy0, fz] = from.map(Math.round);
    let fy = Math.max(1, fy0);
    const solid = (y) => { const b = world.blocks.get(`${fx},${y},${fz}`); return b && !String(b).startsWith('door'); };
    while (fy < 40 && solid(fy)) fy++;
    if (fy !== from[1]) {
      post({ from: 'system', kind: 'world', by: id, text: tx().cameraLift(id, fx, from[1], fz, fy) });
      from[1] = fy;
    }
  }
  const opts = {
    night: v.night === true || v.night === 'true' || v.night === 1,
    view: v.view === 'top' ? 'top' : 'iso',
    // orbit camera: look at (at) from dist away, angle around it, pitch above the horizon
    tx: num(at[0]) !== undefined ? num(at[0]) + 0.5 : undefined,
    tz: num(at[1]) !== undefined ? num(at[1]) + 0.5 : undefined,
    dist: num(v.dist),
    angle: num(v.angle),
    elev: from ? undefined : num(v.pitch),
    // free camera: stand in a cell and look somewhere
    cx: from?.[0], cy: from?.[1], cz: from?.[2],
    lx: lookAt?.[0], ly: lookAt?.[1], lz: lookAt?.[2],
    yaw: from ? num(v.yaw) : undefined,
    pitch: from ? num(v.pitch) : undefined,
    qx: quat?.[0], qy: quat?.[1], qz: quat?.[2], qw: quat?.[3],
    fov: num(v.fov),
    cut: num(v.cut_y),
  };
  setStatus(agents[id], 'reading');
  try {
    const png = await shootWorld(HOME_DIR, cfg.port, opts);
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    let rel = `images/world-${id}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.png`;
    for (let i = 2; fs.existsSync(store.abs(rel)); i++) rel = rel.replace(/(-\d+)?\.png$/, `-${i}.png`);
    fs.mkdirSync(path.dirname(store.abs(rel)), { recursive: true });
    fs.writeFileSync(store.abs(rel), png);
    store.touchMeta(rel, id, true);
    post({ from: id, text: '', attach: { path: rel, shot: true } });
    broadcast('ws', store.listFiles());
    return rel;
  } catch (e) {
    store.log(id, `world_shot failed: ${e.message}`);
    post({ from: 'system', kind: 'error', by: id, text: tx().shotFail(id, e.message) });
    return null;
  }
}

// What the image generators may draw a member from (looks only): a character sheet in
// assets/sheets/<id>_sheet.png if you add one, otherwise the member's avatar.
function sheetOf(who) {
  const w = String(who ?? '').trim().toLowerCase();
  const id = AI_IDS.find((x) => x === w || MEMBERS[x].name.toLowerCase() === w);
  if (!id) return null;
  const cands = [
    path.join(ROOT, 'assets', 'sheets', `${id}_sheet.png`),
    path.join(ROOT, 'public', 'avatars', `${id}.png`),
    path.join(ROOT, 'public', 'avatars', `${id}.webp`),
  ];
  return cands.find((f) => fs.existsSync(f)) || null;
}

// "image" is a prompt string, or {prompt, ref, save_as}.
function imageRequest(v) {
  if (typeof v === 'string') return v.trim() ? { prompt: v.slice(0, 1200) } : null;
  if (!v || typeof v !== 'object' || !String(v.prompt ?? '').trim()) return null;
  return { prompt: String(v.prompt).slice(0, 1200), ref: v.ref ? String(v.ref) : null, saveAs: v.save_as ? String(v.save_as) : null };
}

async function startImage(a, req) {
  const { prompt } = req;
  const id = a.id;
  const wait = cfg.imageCooldownSec * 1000 - (Date.now() - a.lastImageAt);
  if (a.imageBusy || wait > 0) {
    post({ from: 'system', kind: 'error', by: id, text: tx().cantDraw(id, a.imageBusy, Math.ceil(wait / 1000)) });
    return;
  }
  a.imageBusy = true;
  pushMembers();
  post({ from: 'system', kind: 'drawing', by: id, text: tx().drawing(id) });
  try {
    const refSheet = req.ref ? sheetOf(req.ref) : null;
    const res = await adapters.image(id, prompt, { refSheet });
    store.log(id, `image ok=${res.ok} ref=${refSheet ? path.basename(refSheet) : '-'} ${res.file || res.detail}`);
    if (res.ok) {
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
      const rel = `images/${id}-${stamp}${path.extname(res.file).toLowerCase() || '.png'}`;
      fs.mkdirSync(path.dirname(store.abs(rel)), { recursive: true });
      fs.copyFileSync(res.file, store.abs(rel));
      store.touchMeta(rel, id, true);
      post({ from: id, text: '', attach: { path: rel, prompt } });
      if (req.saveAs) {
        // save_as gets the generator's extension (it may hand back a .jpg).
        const want = req.saveAs.replace(/\.(png|jpe?g|webp|gif)$/i, '') + path.posix.extname(rel);
        try {
          const dst = saveSticker(rel, want, id);
          post({ from: 'system', kind: 'file', by: id, file: dst, text: tx().stickerSaved(id, dst) });
        } catch (e) {
          post({ from: 'system', kind: 'error', by: id, text: tx().stickerFail(id, e.message) });
        }
      }
      broadcast('ws', store.listFiles());
    } else {
      post({ from: 'system', kind: 'error', by: id, text: tx().drawFail(id) });
    }
  } catch (e) {
    store.log(id, `image error ${e.message}`);
    post({ from: 'system', kind: 'error', by: id, text: tx().drawFail(id) });
  }
  a.imageBusy = false;
  a.lastImageAt = Date.now();
  pushMembers();
}

// ---------------------------------------------------------------------------
// Room controls

function startRoom() {
  const now = Date.now();
  room.running = true;
  room.sleeping = false;
  room.startedAt = now;
  room.lastUserAt = now;
  for (const id of AI_IDS) {
    const a = agents[id];
    a.offlineUntil = 0;
    a.fails = 0;
    a.idleStreak = 0;
    // someone should speak up soon after the room opens
    a.idleAt = now + rand(4, 25) * 1000;
  }
  // Opening a room that has been quiet for a while: the first pick comes within seconds.
  // (Not after a quick server restart mid-conversation.)
  const lastReal = [...store.recent(60)].reverse().find((m) => m.from !== 'system');
  spark.quick = !lastReal || now - lastReal.ts > 10 * 60000;
  store.saveState();
  pushRoom();
  pushMembers();
}

function stopRoom(sleeping = false) {
  room.running = false;
  room.sleeping = sleeping;
  killAll();
  store.saveState();
  pushRoom();
  pushMembers();
}

function sleepRoom() {
  post({ from: 'system', kind: 'sleep', text: tx().slept() });
  stopRoom(true);
}

// ---------------------------------------------------------------------------
// HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8', '.xml': 'text/plain; charset=utf-8', '.tsv': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

// Workspace files are written by the AIs: serve them sandboxed with no network access.
const WS_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; sandbox allow-scripts";

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 200000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); }
      else chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); }
    });
  });
}

// The user's photo attachments: base64 in the /api/send JSON, stored under images/.
const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const UPLOAD_BODY_LIMIT = Math.ceil(UPLOAD_MAX_BYTES * 4 / 3) + 16384;

// Trust the bytes, not the file name: png / jpeg / gif / webp only.
function sniffImage(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return '.gif';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
}

// Returns the workspace path of the saved image, or throws with a message for the user.
function saveUpload(img) {
  const b64 = String(img?.data ?? '').replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error(tx().imgEmpty);
  if (buf.length > UPLOAD_MAX_BYTES) throw new Error(tx().imgTooBig(UPLOAD_MAX_BYTES / 1048576));
  const ext = sniffImage(buf);
  if (!ext) throw new Error(tx().imgType);
  if (store.listFiles().length >= 300) throw new Error(tx().imgLimit);
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  let rel = `images/user-${stamp}${ext}`;
  for (let i = 2; fs.existsSync(store.abs(rel)); i++) rel = `images/user-${stamp}-${i}${ext}`;
  fs.mkdirSync(path.dirname(store.abs(rel)), { recursive: true });
  fs.writeFileSync(store.abs(rel), buf);
  store.touchMeta(rel, 'user', true);
  return rel;
}

// Members without eyes (Grok, Gemini) get a text description of each photo. Their turns
// wait for it for a little while (see tick) so they don't answer before it exists.
const DESC_WAIT_MS = 45000;
const describing = new Set();
async function describeUpload(msg) {
  describing.add(msg.id);
  try {
    const res = await adapters.describeImage(store.abs(msg.attach.path));
    store.log('describe', `#${msg.id} ${msg.attach.path} ok=${res.ok} ${res.ok ? res.text : res.detail}`);
    if (res.ok && store.setAttachDesc(msg.id, res.text)) broadcast('msgupdate', msg);
  } catch (e) {
    store.log('describe', `#${msg.id} error ${e.message}`);
  } finally {
    describing.delete(msg.id);
  }
}
const waitingForDesc = (fresh, now) => fresh.some((m) => describing.has(m.id) && now - m.ts < DESC_WAIT_MS);

// Only the room page itself may call the API (blocks workspace mini-apps and other sites).
function trustedPost(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/state') {
    return sendJson(res, 200, {
      room: roomView(),
      members: AI_IDS.map(memberView),
      messages: store.recent(300),
      files: store.listFiles(),
      usage: usageView(),
    });
  }
  if (req.method === 'GET' && p === '/api/world') {
    return sendJson(res, 200, world.view());
  }
  if (req.method === 'GET' && p === '/api/notes') {
    return sendJson(res, 200, Object.fromEntries(AI_IDS.map((id) => [id, store.readNote(id)])));
  }
  if (req.method === 'GET' && p === '/api/file') {
    try {
      const f = store.readFile(url.searchParams.get('path'));
      const meta = store.listFiles().find((x) => x.path === f.rel);
      return sendJson(res, 200, { ...f, meta });
    } catch (e) {
      return sendJson(res, 404, { error: e.message });
    }
  }
  if (req.method === 'GET' && p === '/api/history') {
    const before = Number(url.searchParams.get('before')) || Infinity;
    const older = store.messages.filter((m) => m.id < before).slice(-200);
    return sendJson(res, 200, { messages: older });
  }

  if (req.method !== 'POST') return sendJson(res, 404, { error: 'not found' });
  if (!trustedPost(req)) return sendJson(res, 403, { error: 'forbidden' });
  let body;
  try {
    body = await readBody(req, p === '/api/send' ? UPLOAD_BODY_LIMIT : undefined);
  } catch (e) {
    return sendJson(res, e.message === 'too large' ? 413 : 400, { error: e.message === 'too large' ? tx().tooLarge : 'bad json' });
  }

  if (p === '/api/send' && body.sticker) {
    const rel = stickerPath(body.sticker);
    if (!rel || !fs.existsSync(store.abs(rel))) return sendJson(res, 400, { error: tx().noSticker });
    room.lastUserAt = Date.now();
    const msg = post({ from: 'user', text: '', attach: { path: rel, sticker: true } });
    if (!room.running && room.sleeping) startRoom();
    return sendJson(res, 200, { ok: true, msg, running: room.running });
  }
  if (p === '/api/send') {
    let text = String(body.text ?? '').trim().slice(0, 4000);
    const hasImage = !!body.image?.data;
    if (!text && !hasImage) return sendJson(res, 400, { error: 'empty' });
    room.lastUserAt = Date.now();
    // "/boost @멤버 [할 말]": that member's next turn runs on its boost settings.
    const cmd = Router.parseCommand(text);
    if (cmd) {
      if (!cmd.ids.length) return sendJson(res, 400, { error: tx().boostWho });
      if (boostMode() === 'off') return sendJson(res, 400, { error: tx().boostOff });
      const ids = cmd.ids.filter((id) => hasBoost(id));
      if (!ids.length) return sendJson(res, 400, { error: tx().boostNone });
      for (const id of ids) router.arm(id);
      post({ from: 'system', kind: 'deep', text: tx().boostArmed(ids.map(name).join(tx().sep)) });
      if (!room.running && room.sleeping) startRoom();
      if (!cmd.rest && !hasImage) return sendJson(res, 200, { ok: true, running: room.running });
      text = `${ids.map((id) => `@${MEMBERS[id].name}`).join(' ')} ${cmd.rest}`.trim();
    }
    let attach;
    if (hasImage) {
      try { attach = { path: saveUpload(body.image), upload: true }; } catch (e) { return sendJson(res, 400, { error: e.message }); }
      broadcast('ws', store.listFiles());
    }
    const replyTo = Number(body.replyTo);
    const msg = post({ from: 'user', text, replyTo: store.byId.has(replyTo) ? replyTo : undefined, attach });
    if (attach) describeUpload(msg);
    if (!room.running && room.sleeping) startRoom();
    return sendJson(res, 200, { ok: true, msg, running: room.running });
  }
  if (p === '/api/react') {
    const emoji = String(body.emoji ?? '').slice(0, 8);
    if (emoji) react(Number(body.id), 'user', emoji);
    room.lastUserAt = Date.now();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/room') {
    if (typeof body.speed === 'string' && SPEEDS[body.speed]) room.speed = body.speed;
    if (['auto', 'manual', 'off'].includes(body.boostMode)) room.boostMode = body.boostMode;
    if (Number.isFinite(body.autoSleepMin)) room.autoSleepMin = Math.max(0, Math.min(600, body.autoSleepMin));
    if (body.running === true && !room.running) startRoom();
    else if (body.running === false && room.running) stopRoom(false);
    store.saveState();
    pushRoom();
    pushMembers();
    return sendJson(res, 200, roomView());
  }
  if (p === '/api/usage/refresh') {
    const fresh = Date.now() - usage.lastPoll < 15000;
    if (!usage.polling && !fresh) usage.pollAll();
    return sendJson(res, 200, { ok: true, polling: true });
  }
  if (p === '/api/member') {
    if (AI_IDS.includes(body.id) && typeof body.enabled === 'boolean') {
      room.enabled[body.id] = body.enabled;
      const a = agents[body.id];
      if (body.enabled) {
        a.offlineUntil = 0;
        a.fails = 0;
        a.seen = store.lastId;
        post({ from: 'system', kind: 'join', by: body.id, text: tx().joined(body.id) });
      } else {
        post({ from: 'system', kind: 'leave', by: body.id, text: tx().left(body.id) });
      }
      store.saveState();
      pushMembers();
    }
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'not found' });
}

function serveStatic(res, file, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      ...extraHeaders,
    });
    fs.createReadStream(file).pipe(res);
  });
}

// Pages go out with the room language in <html lang>, which public/i18n.js translates from.
function serveHtml(res, file) {
  fs.readFile(file, 'utf8', (err, text) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const body = Buffer.from(text.replace(/<html lang="[a-z]+">/, `<html lang="${getLang()}">`));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    res.end(body);
  });
}

// Decoded request path, or null for a malformed one (e.g. a stray "%").
function pathOf(url) {
  try { return decodeURIComponent(url.pathname); } catch { return null; }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = pathOf(url);
  if (p === null) { res.writeHead(400); res.end(); return; }
  try {
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p.startsWith('/api/dev/')) { await devBridge.handle(req, res, url, { sendJson, readBody }); return; }
    if (p.startsWith('/api/')) return await handleApi(req, res, url);
    if (p.startsWith('/ws/')) {
      let rel;
      try { rel = store.safeRel(p.slice(4)); } catch { res.writeHead(404); res.end(); return; }
      return serveStatic(res, store.abs(rel), { 'Content-Security-Policy': WS_CSP, 'X-Content-Type-Options': 'nosniff' });
    }
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.normalize(path.join(ROOT, 'public', rel));
    if (!file.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); res.end(); return; }
    if (file.endsWith('.html')) return serveHtml(res, file);
    return serveStatic(res, file);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
  }
}

const server = http.createServer(handleRequest);

// External listener: login first, and the dev bridge API does not exist here at all.
let extServer = null;
if (cfg.external.enabled) {
  const gate = new ExternalGate(HOME_DIR, { log: (t) => store.log('external', t) });
  const secure = cfg.external.https !== false;
  const onExternal = async (req, res) => {
    try {
      const url = new URL(req.url, 'https://external');
      const p = pathOf(url);
      if (p === null) { res.writeHead(400); res.end(); return; }
      if (path.posix.normalize(p).toLowerCase().startsWith('/api/dev')) { res.writeHead(404); res.end('not found'); return; }
      if (await gate.handle(req, res, p, { secure })) return;
      await handleRequest(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    }
  };
  try {
    extServer = secure ? https.createServer(gate.tls(), onExternal) : http.createServer(onExternal);
    extServer.on('error', (e) => console.log(tx().extPortFail(e.message)));
    extServer.listen(cfg.external.port, cfg.external.host, () => {
      console.log(tx().extOn(secure ? 'https' : 'http', cfg.external.port));
    });
  } catch (e) {
    console.log(tx().extFail(e.message));
  }
}

// First run: say hello once.
if (!store.messages.length) {
  post({ from: 'system', kind: 'welcome', text: tx().welcome(AI_IDS.map((id) => MEMBERS[id].name).join(tx().sep)) });
}

// Resume after a restart only if the room was on.
room.sleeping = false;
if (room.running) startRoom();

// Photos posted before descriptions existed (or while the server was down): describe the
// last few, one at a time.
(async () => {
  const todo = store.recent(300).filter((m) => m.attach?.upload && !m.attach.desc && fs.existsSync(store.abs(m.attach.path))).slice(-5);
  for (const m of todo) await describeUpload(m);
})();

setInterval(tick, 500);

// ---------------------------------------------------------------------------
// Usage limits: poll every usagePollSec while the room is on, usagePollIdleSec when off.

const usage = new UsageMonitor(HOME_DIR, adapters.bins, { onUpdate: () => broadcast('usage', usageView()) });
function usageView() {
  const v = usage.view();
  const now = Date.now();
  for (const id of AI_IDS) {
    const calls30 = agents[id].callTimes.filter((t) => now - t < 30 * 60000).length;
    v[id] = v[id] ? { ...v[id], calls30 } : { calls30, windows: [] };
  }
  return v;
}
let usagePushTimer = null;
function pushUsageSoon() {
  if (usagePushTimer) return;
  usagePushTimer = setTimeout(() => { usagePushTimer = null; broadcast('usage', usageView()); }, 2000);
}
setInterval(() => {
  const every = (room.running ? cfg.usagePollSec : cfg.usagePollIdleSec) * 1000;
  if (!usage.polling && Date.now() - usage.lastPoll >= every) usage.pollAll();
}, 10000);
usage.pollAll();

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
  console.log(tx().portBusy(cfg.port, e.code));
  console.log(tx().portHint);
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  const miss = AI_IDS.filter((id) => !avail[id]);
  const url = `http://localhost:${cfg.port}`;
  console.log(tx().listening(url));
  console.log(`CLI: ${JSON.stringify(adapters.bins)}`);
  if (miss.length) {
    console.log(tx().cliMissing(miss.join(', ')));
    console.log(tx().cliHint);
  }
  // start.bat / start.sh pass --open: show the room in the default browser.
  if (process.argv.includes('--open')) {
    const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser */ }
  }
});

function shutdown() {
  devBridge.close();
  killAll();
  for (const id of AI_IDS) store.state.seen[id] = agents[id].seen;
  store.saveState();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
