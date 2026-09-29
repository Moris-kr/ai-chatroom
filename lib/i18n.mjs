// Room language. One setting (config.json "language": "ko" | "en" | "ja" | "auto") drives the
// web UI, the members' prompts (so the chat itself happens in that language), the room's
// system messages and the setup helper.
//
// Each module keeps its own strings next to the code as a table {ko: {...}, en: {...}, ja: {...}}
// and reads them with pick(table) at use time (not at import time: the server sets the
// language after loading its config).

export const LANGS = ['ko', 'en', 'ja'];
export const LANG_NAMES = { ko: '한국어', en: 'English', ja: '日本語' };

// Room defaults that depend on the language (config.json may leave them empty).
export const LANG_DEFAULTS = {
  ko: { roomName: 'AI 단톡방', userName: '방장' },
  en: { roomName: 'AI Group Chat', userName: 'Host' },
  ja: { roomName: 'AIグループチャット', userName: 'オーナー' },
};

// Where members leave requests for the dev session while it is offline (workspace path).
export const DEV_REQUEST_FILE = {
  ko: '설계/개발자_요청함.md',
  en: 'design/dev-requests.md',
  ja: '設計/開発者リクエスト.md',
};

// Glossary (keep these the same everywhere: UI, prompts, system messages, docs):
//   진심모드 / Boost mode / 本気モード        침묵 깨기 / Break the silence / 沈黙を破る
//   건축 월드 / Build World / 建築ワールド    작업공간 / Workspace / ワークスペース
//   개인 메모 / Notes / メモ                  스티커 / Stickers / スタンプ
//   개발자 / Dev / 開発者                     방 켜기 / Start room / ルームを開始
//   방장 / Host / オーナー (the default userName)

function fromLocale(s) {
  const l = String(s || '').toLowerCase();
  if (/^ko\b|^ko[-_]|korean/.test(l)) return 'ko';
  if (/^ja\b|^ja[-_]|japanese/.test(l)) return 'ja';
  if (/^en\b|^en[-_]|english/.test(l)) return 'en';
  return null;
}

// OS language. macOS / Linux: LC_ALL / LC_MESSAGES / LANG first. Windows: the system locale
// first (LANG there usually comes from Git Bash, not from the user's settings).
// Any language other than Korean or Japanese means English.
export function detectLang(env = process.env, platform = process.platform) {
  const fromEnv = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v && !/^(C|POSIX)([._@]|$)/.test(v));
  let system;
  try { system = Intl.DateTimeFormat().resolvedOptions().locale; } catch { /* no ICU */ }
  const locale = platform === 'win32' ? system || fromEnv : fromEnv || system;
  return fromLocale(locale) || 'en';
}

export function resolveLang(v, env) {
  const l = String(v || 'auto').toLowerCase();
  return LANGS.includes(l) ? l : detectLang(env);
}

let current = 'ko';
export function setLang(l) { current = resolveLang(l); return current; }
export function getLang() { return current; }

// table[current], falling back to English, then Korean.
export function pick(table, lang = current) {
  return table[lang] || table.en || table.ko;
}
