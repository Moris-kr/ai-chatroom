// Change the password for the external (outside-home) login.
//   node set-password.mjs
// Asks for the new password twice. The running server picks it up on the next request,
// and everyone who was logged in has to log in again.

import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPassword } from './lib/external.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.CHATROOM_HOME ? path.resolve(process.env.CHATROOM_HOME) : ROOT;

// Read line by line (works typed or piped).
const rl = readline.createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
const ask = async (q) => {
  process.stdout.write(q);
  const { value } = await lines.next();
  return (value ?? '').replace(/^﻿/, '').replace(/\r$/, ''); // PowerShell pipes add a BOM
};

const a = await ask('새 비밀번호: ');
const b = await ask('한 번 더: ');
rl.close();
if (!a) { console.log('비어 있어서 안 바꿨어.'); process.exit(1); }
if (a !== b) { console.log('두 번 입력한 게 달라서 안 바꿨어.'); process.exit(1); }
setPassword(HOME_DIR, a);
console.log('바꿨어. 로그인돼 있던 기기는 다시 로그인해야 돼.');
