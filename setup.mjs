#!/usr/bin/env node
// Setup helper (run by setup.bat / setup.sh): picks the room language, finds the four member
// CLIs, offers to install the missing ones with each vendor's official installer and to log
// in, writes config.json, and can start the room. Nothing is installed or changed without
// asking first.
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
import { LANGS, LANG_NAMES, LANG_DEFAULTS, resolveLang, setLang, pick } from './lib/i18n.mjs';

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
    need: {
      ko: 'Claude Pro·Max·Team 등 유료 요금제 (무료 요금제는 안 됨)',
      en: "a paid Claude plan (Pro, Max, Team…; the free plan doesn't include Claude Code)",
      ja: '有料のClaudeプラン（Pro・Max・Teamなど。無料プランではClaude Codeは使えない）',
    },
    win: 'irm https://claude.ai/install.ps1 | iex',
    unix: 'curl -fsSL https://claude.ai/install.sh | bash',
    login: ['auth', 'login'],
  },
  {
    id: 'gpt', bin: 'codex', member: 'ChatGPT', product: 'Codex CLI',
    need: { ko: 'ChatGPT 계정', en: 'a ChatGPT account', ja: 'ChatGPTアカウント' },
    win: 'irm https://chatgpt.com/codex/install.ps1 | iex',
    unix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    login: ['login'],
  },
  {
    id: 'grok', bin: 'grok', member: 'Grok', product: 'Grok Build CLI',
    need: { ko: 'SuperGrok 또는 X Premium+', en: 'SuperGrok or X Premium+', ja: 'SuperGrok または X Premium+' },
    win: 'irm https://x.ai/cli/install.ps1 | iex',
    unix: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    login: ['login'],
  },
  {
    id: 'gemini', bin: 'agy', member: 'Gemini', product: 'Antigravity CLI',
    need: { ko: 'Google 계정', en: 'a Google account', ja: 'Googleアカウント' },
    win: 'irm https://antigravity.google/cli/install.ps1 | iex',
    unix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    login: [], // no login command: the first interactive run opens the browser
  },
];

// ---- strings ----
// Read with tr() at use time: the language is only known after the first question.

const T = {
  ko: {
    langRetry: '1, 2, 3 중에서 골라 줘.',
    langNote: '방 화면도, 멤버들 대화도 한국어로 돼.',
    title: 'AI 단톡방 설치 도우미',
    introCheck: '상태만 확인해 (아무것도 바꾸지 않아).',
    intro: '설치나 변경은 전부 먼저 물어볼게. 그냥 Enter를 누르면 [대문자] 쪽으로 가.',
    nodeOld: (v) => `Node.js ${v}: 22 이상이 필요해. https://nodejs.org 에서 LTS를 설치해 줘.`,
    stepClis: '멤버 CLI',
    searching: '찾는 중... (로그인 확인에 몇 초 걸려)',
    stepSettings: '설정',
    cfgState: (exists) => (exists ? 'config.json 있음' : 'config.json 없음 (기본값으로 돌아)'),
    langState: (name) => `언어 ${name}`,
    portState: (port) => `포트 ${port}`,
    portFree: '비어 있음',
    roomOn: '방이 켜져 있음',
    portBad: (st) => `못 씀 (${st})`,
    stepInstall: '없는 CLI 설치',
    installNote: '각 회사 공식 설치 명령을 이 창에서 그대로 실행해. 없는 멤버는 방에서 오프라인으로 떠 (나중에 설치해도 돼).',
    need: (n) => `필요: ${n}`,
    installQ: '설치할까?',
    installed: (bin) => `설치됨: ${bin}`,
    notFound: (code) => `아직 못 찾았어 (종료 코드 ${code}). 새 창에서 setup을 다시 실행하거나, config.json "bins"에 실행 파일 경로를 적어 줘.`,
    stepLogin: '로그인',
    needLogin: '로그인이 필요해.',
    unknownLogin: (note) => `로그인 상태를 확인 못 했어${note ? ` (${note})` : ''}. 로그인돼 있으면 건너뛰어도 돼.`,
    loginExit: (bin) => `${bin}를 실행하면 브라우저가 열려. 로그인이 끝나면 Ctrl+C로 빠져나와.`,
    loginBrowser: '브라우저가 열리면 거기서 로그인해 줘.',
    loginQ: (how) => `지금 로그인할까? (${how})`,
    stepNow: '지금 상태',
    noneReady: '쓸 수 있는 멤버가 아직 없어. 방은 켜지지만 아무도 말하지 않아. 나중에 setup을 다시 실행해 줘.',
    stepConfig: '설정 (config.json)',
    stepTest: '테스트 대화 (선택)',
    testNote: '모델 이름·로그인이 실제로 되는지 멤버마다 한 번 불러 봐. 사용량이 아주 조금 들어.',
    testQ: '해 볼까?',
    testing: '멤버마다 "OK" 한마디만 받아 볼게 (각 10~60초).',
    secs: (s) => `${s}초`,
    failed: '[실패]',
    modelHint: (id) => `모델 이름이 이 계정에서 안 될 수 있어. config.json의 agents.${id}.model을 바꿔 봐.`,
    stepShortcut: '바탕화면 바로가기 (선택)',
    shortcutQ: (name) => `바탕화면에 '${name}' 바로가기를 만들까?`,
    shortcutMade: (f) => `만들었어: ${f}`,
    shortcutFail: (e) => `못 만들었어: ${e}`,
    stepDone: '다 됐어',
    nextTime: (how) => `다음부터 켜기: ${how}`,
    startWin: (sc) => `start.bat 더블클릭${sc ? ' (또는 바탕화면 바로가기)' : ''}`,
    browserLine: (url) => `브라우저: ${url} → 왼쪽 위 ${bold('방 켜기')}`,
    closeNote: '서버 창을 닫거나 Ctrl+C를 누르면 방이 꺼져. 상태만 다시 보려면: node setup.mjs --check',
    alreadyOn: '방 서버가 이미 켜져 있어.',
    openBrowserQ: '브라우저로 열까?',
    openRoomQ: '지금 방을 열까?',
    serverWindow: '(이 창이 서버야. 닫으면 방이 꺼져.)',
    error: '설치 도우미 오류',
    badJson: (m) => `config.json을 읽을 수 없어 (JSON 오류: ${m}). 고치거나 지운 뒤 다시 실행해 줘.`,
    cfgExists: (rel, name, port) => `${rel} 있음: 이름 ${name}, 포트 ${port}`,
    portBusy: (p) => `포트 ${p}은(는) 지금 다른 프로그램이 쓰고 있어. 바꾸는 걸 추천해.`,
    editQ: '이름이나 포트를 바꿀까?',
    cfgNew: (rel) => `${rel}을(를) 새로 만들게.`,
    nameQ: '멤버들이 부를 내 이름',
    portCant: (p, why) => `포트 ${p}은(는) 못 써 (${why}).`,
    portInUse: '다른 프로그램이 사용 중',
    portReserved: (st) => `${st}, Windows 예약 포트일 수 있음`,
    portSuggest: (p) => ` ${p}번을 추천해.`,
    portQ: '포트',
    portRange: '1024~65535 사이 숫자로 적어 줘.',
    saved: (rel) => `저장했어: ${rel}`,
    savedWhat: (name, port) => ` (이름 ${name}, 포트 ${port})`,
    noResponse: '응답 없음, 잠시 후 다시',
    google503: 'Google 서버 일시 오류, 잠시 후 다시',
    notInstalled: '설치 안 됨',
    loggedIn: '로그인됨',
    loginNeeded: '로그인 필요',
    loginUnknown: '로그인 확인 못 함',
  },
  en: {
    langRetry: 'Pick 1, 2 or 3.',
    langNote: "The room's screens and the members' chat will be in English.",
    title: 'AI Group Chat setup',
    introCheck: 'Status only (nothing gets changed).',
    intro: "I'll ask before installing or changing anything. Pressing just Enter picks the [CAPITAL] option.",
    nodeOld: (v) => `Node.js ${v}: version 22 or newer is needed. Install the LTS from https://nodejs.org`,
    stepClis: 'Member CLIs',
    searching: 'Looking... (checking the logins takes a few seconds)',
    stepSettings: 'Settings',
    cfgState: (exists) => (exists ? 'config.json found' : 'no config.json (runs on defaults)'),
    langState: (name) => `language ${name}`,
    portState: (port) => `port ${port}`,
    portFree: 'free',
    roomOn: 'room is running',
    portBad: (st) => `unusable (${st})`,
    stepInstall: 'Install missing CLIs',
    installNote: "Runs each vendor's official install command right in this window. Members without their CLI just show as offline in the room (you can install later).",
    need: (n) => `needs: ${n}`,
    installQ: 'Install it?',
    installed: (bin) => `Installed: ${bin}`,
    notFound: (code) => `Still can't find it (exit code ${code}). Run setup again in a new window, or put the executable's path in config.json "bins".`,
    stepLogin: 'Log in',
    needLogin: 'needs to log in.',
    unknownLogin: (note) => `couldn't check the login${note ? ` (${note})` : ''}. If you're already logged in, you can skip this.`,
    loginExit: (bin) => `Running ${bin} opens the browser. Once you're logged in, press Ctrl+C to come back here.`,
    loginBrowser: 'Log in there when the browser opens.',
    loginQ: (how) => `Log in now? (${how})`,
    stepNow: 'Status now',
    noneReady: 'No member is ready yet. The room will start, but nobody will talk. Run setup again later.',
    stepConfig: 'Settings (config.json)',
    stepTest: 'Test chat (optional)',
    testNote: 'Calls each member once to check that the model name and login really work. Uses a tiny bit of usage.',
    testQ: 'Try it?',
    testing: 'Asking each member for a single "OK" (10–60 s each).',
    secs: (s) => `${s}s`,
    failed: '[FAIL]',
    modelHint: (id) => `This account may not have that model. Try changing agents.${id}.model in config.json.`,
    stepShortcut: 'Desktop shortcut (optional)',
    shortcutQ: (name) => `Create a desktop shortcut called '${name}'?`,
    shortcutMade: (f) => `Created: ${f}`,
    shortcutFail: (e) => `Couldn't create it: ${e}`,
    stepDone: 'All set',
    nextTime: (how) => `To start it next time: ${how}`,
    startWin: (sc) => `double-click start.bat${sc ? ' (or the desktop shortcut)' : ''}`,
    browserLine: (url) => `Browser: ${url} → top left, ${bold('Start room')}`,
    closeNote: 'Closing the server window or pressing Ctrl+C stops the room. To just check the status again: node setup.mjs --check',
    alreadyOn: 'The room server is already running.',
    openBrowserQ: 'Open it in the browser?',
    openRoomQ: 'Open the room now?',
    serverWindow: '(This window is the server. Closing it stops the room.)',
    error: 'Setup helper error',
    badJson: (m) => `Can't read config.json (JSON error: ${m}). Fix or delete it, then run this again.`,
    cfgExists: (rel, name, port) => `${rel} found: name ${name}, port ${port}`,
    portBusy: (p) => `Port ${p} is in use by another program right now. Better change it.`,
    editQ: 'Change the name or port?',
    cfgNew: (rel) => `Creating ${rel}.`,
    nameQ: 'Your name (what the members call you)',
    portCant: (p, why) => `Can't use port ${p} (${why}).`,
    portInUse: 'in use by another program',
    portReserved: (st) => `${st}, may be reserved by Windows`,
    portSuggest: (p) => ` Try ${p}.`,
    portQ: 'Port',
    portRange: 'Enter a number from 1024 to 65535.',
    saved: (rel) => `Saved: ${rel}`,
    savedWhat: (name, port) => ` (name ${name}, port ${port})`,
    noResponse: 'no response, try again in a bit',
    google503: 'temporary Google server error, try again in a bit',
    notInstalled: 'not installed',
    loggedIn: 'logged in',
    loginNeeded: 'login needed',
    loginUnknown: "couldn't check login",
  },
  ja: {
    langRetry: '1、2、3から選んでね。',
    langNote: 'ルームの画面もメンバーの会話も日本語になるよ。',
    title: 'AIグループチャット セットアップ',
    introCheck: '状態を確認するだけ（何も変更しないよ）。',
    intro: 'インストールや変更は全部、先に確認するね。Enterだけ押すと[大文字]のほうを選ぶよ。',
    nodeOld: (v) => `Node.js ${v}: 22以上が必要だよ。https://nodejs.org からLTS版をインストールしてね。`,
    stepClis: 'メンバーのCLI',
    searching: '探しているところ...（ログインの確認に数秒かかるよ）',
    stepSettings: '設定',
    cfgState: (exists) => (exists ? 'config.jsonあり' : 'config.jsonなし（デフォルト設定で動くよ）'),
    langState: (name) => `言語 ${name}`,
    portState: (port) => `ポート ${port}`,
    portFree: '空いている',
    roomOn: 'ルームが起動中',
    portBad: (st) => `使えない (${st})`,
    stepInstall: '足りないCLIのインストール',
    installNote: '各社の公式インストールコマンドを、このウィンドウでそのまま実行するよ。CLIがないメンバーはルームでオフライン表示になるだけ（後からインストールしてもOK）。',
    need: (n) => `必要: ${n}`,
    installQ: 'インストールする？',
    installed: (bin) => `インストールできたよ: ${bin}`,
    notFound: (code) => `まだ見つからない（終了コード ${code}）。新しいウィンドウでsetupをもう一度実行するか、config.jsonの"bins"に実行ファイルのパスを書いてね。`,
    stepLogin: 'ログイン',
    needLogin: 'ログインが必要だよ。',
    unknownLogin: (note) => `ログイン状態を確認できなかった${note ? `（${note}）` : ''}。ログイン済みならスキップしてOK。`,
    loginExit: (bin) => `${bin}を実行するとブラウザが開くよ。ログインが終わったらCtrl+Cで戻ってきてね。`,
    loginBrowser: 'ブラウザが開いたら、そこでログインしてね。',
    loginQ: (how) => `今ログインする？ (${how})`,
    stepNow: '今の状態',
    noneReady: '使えるメンバーがまだいないよ。ルームは起動するけど、誰もしゃべらない。後でsetupをもう一度実行してね。',
    stepConfig: '設定 (config.json)',
    stepTest: 'テスト会話（任意）',
    testNote: 'モデル名とログインが本当に使えるか、メンバーごとに1回ずつ呼んでみるよ。使用量がほんの少しかかる。',
    testQ: 'やってみる？',
    testing: 'メンバーごとに「OK」を一言だけもらうね（それぞれ10〜60秒）。',
    secs: (s) => `${s}秒`,
    failed: '[失敗]',
    modelHint: (id) => `このアカウントではそのモデルが使えないかも。config.jsonのagents.${id}.modelを変えてみて。`,
    stepShortcut: 'デスクトップのショートカット（任意）',
    shortcutQ: (name) => `デスクトップに「${name}」のショートカットを作る？`,
    shortcutMade: (f) => `作ったよ: ${f}`,
    shortcutFail: (e) => `作れなかった: ${e}`,
    stepDone: '完了',
    nextTime: (how) => `次からの起動: ${how}`,
    startWin: (sc) => `start.batをダブルクリック${sc ? '（またはデスクトップのショートカット）' : ''}`,
    browserLine: (url) => `ブラウザ: ${url} → 左上の「${bold('ルームを開始')}」`,
    closeNote: 'サーバーのウィンドウを閉じるかCtrl+Cを押すとルームが止まるよ。状態だけもう一度見るなら: node setup.mjs --check',
    alreadyOn: 'ルームのサーバーはもう起動しているよ。',
    openBrowserQ: 'ブラウザで開く？',
    openRoomQ: '今ルームを開く？',
    serverWindow: '（このウィンドウがサーバーだよ。閉じるとルームが止まる。）',
    error: 'セットアップのエラー',
    badJson: (m) => `config.jsonが読めない（JSONエラー: ${m}）。直すか削除してから、もう一度実行してね。`,
    cfgExists: (rel, name, port) => `${rel}あり: 名前 ${name}、ポート ${port}`,
    portBusy: (p) => `ポート${p}は今ほかのプログラムが使っているよ。変えるのがおすすめ。`,
    editQ: '名前かポートを変える？',
    cfgNew: (rel) => `${rel}を新しく作るね。`,
    nameQ: 'メンバーから呼ばれるあなたの名前',
    portCant: (p, why) => `ポート${p}は使えない（${why}）。`,
    portInUse: 'ほかのプログラムが使用中',
    portReserved: (st) => `${st}、Windowsの予約ポートかも`,
    portSuggest: (p) => `${p}番がおすすめ。`,
    portQ: 'ポート',
    portRange: '1024〜65535の数字で入力してね。',
    saved: (rel) => `保存したよ: ${rel}`,
    savedWhat: (name, port) => `（名前 ${name}、ポート ${port}）`,
    noResponse: '応答なし、少し待ってからもう一度',
    google503: 'Googleサーバーの一時的なエラー、少し待ってからもう一度',
    notInstalled: '未インストール',
    loggedIn: 'ログイン済み',
    loginNeeded: 'ログインが必要',
    loginUnknown: 'ログインを確認できず',
  },
};
const tr = () => pick(T);

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

// Accepts y/yes/예/네/응/はい/うん, ㅛ (y typed with the Korean keyboard on) and a full-width ｙ
// from a Japanese IME. (Only the Latin side is NFKC-folded: NFKC would turn ㅛ into another
// code point.)
async function yes(q, def = false) {
  const a = (await ask(`${q} ${dim(def ? '[Y/n]' : '[y/N]')} `)).toLowerCase();
  if (!a) return def;
  const ok = ['y', 'yes', 'ㅛ', '예', '네', '응', 'ㅇ', 'はい', 'うん'];
  return ok.includes(a) || ok.includes(a.normalize('NFKC'));
}

// ---- room language ----

// Same rule as the server: a config.json without "language" belongs to a room made before the
// setting existed (Korean); no config.json at all follows the OS language.
function currentLang(user = readConfig()) {
  return resolveLang(user.language ?? (Object.keys(user).length ? 'ko' : 'auto'));
}

const LANG_ANSWERS = {
  ko: ['1', 'ko', 'kr', 'kor', 'korean', '한국어', '한국', '한글'],
  en: ['2', 'en', 'eng', 'english', '영어', '英語'],
  ja: ['3', 'ja', 'jp', 'jpn', 'japanese', '日本語', 'にほんご', '일본어'],
};

async function chooseLang(def) {
  say(bold(cyan('■ 언어 · Language · 言語')));
  LANGS.forEach((l, i) => say(`  ${i + 1}) ${LANG_NAMES[l]}`));
  for (let tries = 0; tries < 3; tries++) {
    const a = (await ask(`  1 / 2 / 3 ${dim(`[${LANGS.indexOf(def) + 1}]`)}: `)).normalize('NFKC').toLowerCase().replace(/[).]$/, '');
    if (!a) return def;
    const l = LANGS.find((k) => LANG_ANSWERS[k].includes(a));
    if (l) return l;
    say(yellow(`  ${pick(T, def).langRetry}`));
  }
  return def;
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
      if (r.timedOut) return { ok: null, note: tr().noResponse };
      if (/\b503\b|UNAVAILABLE/.test(t)) return { ok: null, note: tr().google503 };
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
  const t = tr();
  if (!s.bin) return red(t.notInstalled);
  if (s.login.ok === true) return green(t.loggedIn) + (s.login.note ? dim(` (${s.login.note})`) : '');
  if (s.login.ok === false) return yellow(t.loginNeeded);
  return yellow(t.loginUnknown) + (s.login.note ? dim(` (${s.login.note})`) : '');
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

// Key order does not matter when checking a patched file against the intended settings.
function canonical(v) {
  return JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
    : x));
}

// Edits values in place so the file keeps its layout (keys the file does not have yet, like
// "language" in a config.json from before that setting, go in at the top); falls back to
// rewriting it when the edit would not give exactly the intended result.
function patchJson(text, orig, updates) {
  const want = { ...orig, ...updates };
  let out = text;
  const add = [];
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`("${k}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?|true|false|null|\\{[^{}]*\\})`);
    if (!(k in orig)) add.push(`${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    else if (re.test(out)) out = out.replace(re, (_, pre) => pre + JSON.stringify(v));
    else { out = null; break; }
  }
  if (out && add.length) {
    out = out.replace(/^(\s*\{)([ \t]*\r?\n[ \t]*|\s*)/, (_, open, ws) => `${open}${ws}${add.map((a) => `${a},${ws || ' '}`).join('')}`);
  }
  try { if (out && canonical(JSON.parse(out)) === canonical(want)) return out; } catch { /* fall back */ }
  return `${JSON.stringify(want, null, 2)}\n`;
}

// lang: the room language picked in the first step; prevLang: what the room used before.
async function configure(pins, lang, prevLang) {
  const t = tr();
  const exists = fs.existsSync(CONFIG);
  const text = fs.readFileSync(exists ? CONFIG : EXAMPLE, 'utf8');
  let cfg;
  try { cfg = JSON.parse(text); } catch (e) {
    say(red(`  ${t.badJson(e.message)}`));
    return null;
  }
  const rel = path.relative(ROOT, CONFIG).startsWith('..') ? CONFIG : path.relative(ROOT, CONFIG);
  // Empty names get the language's default; so do names still at a default when the language
  // changes (a Korean room's "방장" becomes "Host" in English). Custom names stay.
  const isDefault = (k) => LANGS.some((l) => LANG_DEFAULTS[l][k] === cfg[k]);
  const follow = (k) => (!cfg[k] || (lang !== prevLang && isDefault(k)) ? LANG_DEFAULTS[lang][k] : cfg[k]);
  const roomName = follow('roomName');
  let userName = follow('userName');
  let port = Number(cfg.port) || 8321;
  let edit = true;
  if (exists) {
    say(`  ${t.cfgExists(rel, bold(userName), bold(port))}`);
    const busy = (await portState(port)) !== 'free' && !(await roomAt(port));
    if (busy) say(yellow(`  ${t.portBusy(port)}`));
    edit = await yes(`  ${t.editQ}`, busy);
  } else {
    say(`  ${t.cfgNew(rel)}`);
  }

  if (edit) {
    const n = await ask(`  ${t.nameQ} ${dim(`[${userName}]`)}: `, userName);
    userName = n.slice(0, 20);
    for (let tries = 0; tries < 3; tries++) {
      const st = await portState(port);
      const mine = st !== 'free' && await roomAt(port);
      let suggest = port;
      if (st !== 'free' && !mine) {
        suggest = await freePortFrom(port + 1);
        say(yellow(`  ${t.portCant(port, st === 'EADDRINUSE' ? t.portInUse : t.portReserved(st))}`) + (suggest ? t.portSuggest(suggest) : ''));
      }
      const p = Number(await ask(`  ${t.portQ} ${dim(`[${suggest}]`)}: `, String(suggest)));
      if (!Number.isInteger(p) || p < 1024 || p > 65535) { say(yellow(`  ${t.portRange}`)); continue; }
      port = p;
      if ((await portState(port)) === 'free' || await roomAt(port)) break;
    }
  }

  const updates = { language: lang, roomName, userName, port };
  if (Object.keys(pins).length) updates.bins = { ...(cfg.bins || {}), ...pins };
  if (exists && !edit && Object.entries(updates).every(([k, v]) => canonical(cfg[k]) === canonical(v))) return cfg;
  const out = patchJson(text, cfg, updates);
  fs.writeFileSync(CONFIG, out);
  say(green(`  ${t.saved(rel)}`) + dim(t.savedWhat(userName, port)));
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
  const t = tr();
  say(dim(`  ${t.testing}`));
  await Promise.all(ready.map(async (s) => {
    const id = s.c.id;
    const model = cfg.agents[id].model;
    let r;
    try { r = await ad.chat(id, 'This is a connection test. Reply with exactly: OK', 'ping'); } catch (e) { r = { ok: false, detail: String(e) }; }
    if (r.ok) {
      say(`  ${green('[OK]')} ${s.c.member.padEnd(8)} ${dim(`${model} · ${t.secs((r.ms / 1000).toFixed(1))}`)}`);
      return;
    }
    const last = (r.detail || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
    say(`  ${red(t.failed)} ${s.c.member.padEnd(8)} ${dim(model)} ${last.slice(0, 160)}`);
    if (/model/i.test(r.detail || '')) say(dim(`         ${t.modelHint(id)}`));
  }));
}

// ---- Windows desktop shortcut ----

function makeShortcut(roomName) {
  const fallback = pick(LANG_DEFAULTS).roomName;
  const name = String(roomName || fallback).replace(/[<>:"/\\|?*]/g, '').trim() || fallback;
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
  // Room language first: everything after it is printed in that language.
  const prevLang = currentLang();
  setLang(prevLang);
  const lang = CHECK ? prevLang : await chooseLang(prevLang);
  setLang(lang);
  const t = tr();
  if (!CHECK) say(dim(`  ${t.langNote}\n`));

  say(bold(t.title));
  say(dim(CHECK ? t.introCheck : t.intro));

  step('Node.js');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    say(red(`  ${t.nodeOld(process.versions.node)}`));
    process.exitCode = 1;
    return;
  }
  say(`  ${green('[OK]')} ${process.versions.node}`);

  step(t.stepClis);
  say(dim(`  ${t.searching}`));
  let bins = resolveBins(readConfig().bins || {});
  let list = await Promise.all(CLIS.map((c) => inspect(c, bins)));
  printTable(list);

  if (CHECK) {
    step(t.stepSettings);
    const cfg = readConfig();
    const port = Number(cfg.port) || 8321;
    const st = await portState(port);
    const running = st !== 'free' && await roomAt(port);
    const auto = !LANGS.includes(String(cfg.language ?? (Object.keys(cfg).length ? 'ko' : 'auto')).toLowerCase());
    say(`  ${t.cfgState(fs.existsSync(CONFIG))} · ${t.langState(LANG_NAMES[lang])}${auto ? dim(' (auto)') : ''} · ${t.portState(port)}: ${
      st === 'free' ? green(t.portFree) : running ? green(t.roomOn) : yellow(t.portBad(st))}`);
    return;
  }

  const missing = list.filter((s) => !s.bin);
  if (missing.length) {
    step(t.stepInstall);
    say(dim(`  ${t.installNote}`));
    for (const s of missing) {
      const cmd = WIN ? s.c.win : s.c.unix;
      say(`\n  ${bold(s.c.member)} ← ${s.c.product}  ${dim(t.need(pick(s.c.need)))}`);
      say(`  ${dim(WIN ? 'PowerShell>' : '$')} ${cmd}`);
      if (!(await yes(`  ${t.installQ}`))) continue;
      const [exe, args] = shellCommand(cmd);
      const code = await interactive(exe, args, { cwd: HOME });
      refreshPath();
      bins = resolveBins(readConfig().bins || {});
      const idx = list.indexOf(s);
      list[idx] = await inspect(s.c, bins);
      if (list[idx].bin) say(green(`  ${t.installed(list[idx].bin)}`));
      else say(yellow(`  ${t.notFound(code)}`));
    }
  }

  const needLogin = list.filter((s) => s.bin && s.login.ok !== true);
  if (needLogin.length) {
    step(t.stepLogin);
    for (const s of needLogin) {
      const how = s.c.login.length ? `${s.c.bin} ${s.c.login.join(' ')}` : s.c.bin;
      const why = s.login.ok === false ? t.needLogin : t.unknownLogin(s.login.note);
      say(`\n  ${bold(s.c.member)}: ${why} ${dim(t.need(pick(s.c.need)))}`);
      if (!s.c.login.length) say(dim(`  ${t.loginExit(s.c.bin)}`));
      else say(dim(`  ${t.loginBrowser}`));
      if (!(await yes(`  ${t.loginQ(how)}`, s.login.ok === false))) continue;
      await interactive(s.bin, s.c.login, { cwd: HOME });
      const idx = list.indexOf(s);
      list[idx] = { ...s, login: await loggedIn(s.c, s.bin) };
      say(`  → ${loginText(list[idx])}`);
    }
  }

  if (missing.length || needLogin.length) {
    step(t.stepNow);
    printTable(list);
  }
  const ready = list.filter((s) => s.bin && s.login.ok !== false);
  if (!ready.length) say(yellow(`  ${t.noneReady}`));

  // A CLI found only thanks to the refreshed PATH may be invisible to the room's own process
  // (an old window's PATH), so pin those paths in config.json.
  const before = resolveWithPath(ORIG_PATH);
  const pins = {};
  for (const s of list) if (s.bin && !before[s.c.bin]) pins[s.c.bin] = s.bin;

  step(t.stepConfig);
  const cfg = await configure(pins, lang, prevLang);
  const port = Number(cfg?.port) || 8321;

  if (ready.length) {
    step(t.stepTest);
    say(dim(`  ${t.testNote}`));
    if (await yes(`  ${t.testQ}`)) await testCalls(ready, bins);
  }

  let shortcut = false;
  if (WIN) {
    step(t.stepShortcut);
    const roomName = cfg?.roomName || LANG_DEFAULTS[lang].roomName;
    if (await yes(`  ${t.shortcutQ(roomName)}`)) {
      try {
        say(green(`  ${t.shortcutMade(makeShortcut(roomName))}`));
        shortcut = true;
      } catch (e) { say(yellow(`  ${t.shortcutFail(String(e.message || e).split('\n')[0])}`)); }
    }
  }

  step(t.stepDone);
  say(`  ${t.nextTime(bold(WIN ? t.startWin(shortcut) : './start.sh'))}`);
  say(`  ${t.browserLine(bold(`http://localhost:${port}`))}`);
  say(dim(`  ${t.closeNote}`));

  const running = (await portState(port)) !== 'free' && await roomAt(port);
  if (running) {
    say(green(`\n  ${t.alreadyOn}`));
    if (await yes(`  ${t.openBrowserQ}`, true)) openBrowser(`http://localhost:${port}`);
    return;
  }
  if (await yes(`\n  ${t.openRoomQ}`, true)) {
    if (pipeRl) pipeRl.close();
    say(dim(`  ${t.serverWindow}\n`));
    await interactive(process.execPath, [path.join(ROOT, 'server.mjs'), '--open'], { cwd: ROOT });
  }
}

function openBrowser(url) {
  const [cmd, args] = WIN ? ['explorer.exe', [url]] : MAC ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser */ }
}

main()
  .catch((e) => { console.error(red(`\n${tr().error}: ${e.stack || e}`)); process.exitCode = 1; })
  .finally(() => { if (pipeRl) pipeRl.close(); });
