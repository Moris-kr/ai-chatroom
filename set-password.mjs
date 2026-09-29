// Change the password for the external (outside-home) login.
//   node set-password.mjs
// Asks for the new password twice. The running server picks it up on the next request,
// and everyone who was logged in has to log in again.

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPassword } from './lib/external.mjs';
import { setLang, pick } from './lib/i18n.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.CHATROOM_HOME ? path.resolve(process.env.CHATROOM_HOME) : ROOT;

// Same config file and language rule as server.mjs loadConfig().
let user = {};
const cfgFile = process.env.CHATROOM_CONFIG ? path.resolve(process.env.CHATROOM_CONFIG) : path.join(ROOT, 'config.json');
try { user = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* defaults */ }
setLang(user.language ?? (Object.keys(user).length ? 'ko' : 'auto'));

const T = {
  ko: {
    first: '새 비밀번호: ',
    again: '한 번 더: ',
    empty: '비어 있어서 안 바꿨어.',
    mismatch: '두 번 입력한 게 달라서 안 바꿨어.',
    done: '바꿨어. 로그인돼 있던 기기는 다시 로그인해야 돼.',
  },
  en: {
    first: 'New password: ',
    again: 'Once more: ',
    empty: 'It was empty, so nothing changed.',
    mismatch: "The two entries didn't match, so nothing changed.",
    done: 'Changed. Devices that were logged in have to log in again.',
  },
  ja: {
    first: '新しいパスワード: ',
    again: 'もう一回: ',
    empty: '空っぽだったから変えなかったよ。',
    mismatch: '2回の入力が違ったから変えなかったよ。',
    done: '変えたよ。ログインしてた端末はもう一回ログインが必要。',
  },
};
const t = pick(T);

// Read line by line (works typed or piped).
const rl = readline.createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
const ask = async (q) => {
  process.stdout.write(q);
  const { value } = await lines.next();
  return (value ?? '').replace(/^﻿/, '').replace(/\r$/, ''); // PowerShell pipes add a BOM
};

const a = await ask(t.first);
const b = await ask(t.again);
rl.close();
if (!a) { console.log(t.empty); process.exit(1); }
if (a !== b) { console.log(t.mismatch); process.exit(1); }
setPassword(HOME_DIR, a);
console.log(t.done);
