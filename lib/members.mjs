// Static facts about the room members. Personality and speech style are deliberately
// absent: they are supposed to emerge from the conversation itself (see prompt.mjs).

export const AI_IDS = ['claude', 'gpt', 'grok', 'gemini'];

export const MEMBERS = {
  claude: {
    name: 'Claude',
    maker: 'Anthropic',
    color: '#d97a3a',
    aliases: ['claude', '클로드'],
    look: '긴 회갈색 머리(안쪽은 주황빛), 보라색 눈, 검은 리본, 크림색 블라우스에 짙은 조끼',
    imageGen: false,
  },
  gpt: {
    name: 'ChatGPT',
    maker: 'OpenAI',
    color: '#2f7cf6',
    aliases: ['chatgpt', 'gpt', '지피티', '챗지피티', '쳇지피티'],
    look: '은발 단발, 파란 눈, 삼각형 머리핀, 흰 테크 후드 재킷',
    imageGen: true,
  },
  grok: {
    name: 'Grok',
    maker: 'xAI',
    color: '#b8912a',
    aliases: ['grok', '그록'],
    look: '긴 금발, 회색 눈, 검은 X 머리핀, 검은 오버사이즈 재킷과 초커',
    imageGen: true,
  },
  gemini: {
    name: 'Gemini',
    maker: 'Google',
    color: '#5b6cf0',
    aliases: ['gemini', '제미나이', '제미니'],
    look: '끝이 분홍·보라로 물든 금발 트윈테일, 파란 눈, 청록 리본, 멜빵',
    imageGen: true,
  },
};

// The development session (the Claude Code session that builds this room). It is not
// scheduled like the AIs: it joins through the dev bridge (lib/dev.mjs) only while the
// user has connected it, and its messages are authored by the server from the bridge token.
export const DEV = {
  id: 'dev',
  name: '개발자',
  color: '#0f766e',
  aliases: ['개발자', '개발 세션', '개발세션', '빌더'],
};

// Does `text` call the dev session (@개발자, 개발자, 빌더 ...)?
export function mentionsDev(text) {
  const t = (text || '').toLowerCase();
  return DEV.aliases.some((a) => t.includes(a));
}

export function displayName(id, userName) {
  if (id === 'user') return userName;
  if (id === 'system') return '시스템';
  if (id === DEV.id) return DEV.name;
  return MEMBERS[id]?.name ?? id;
}

// Korean particles: "Grok이" but "Claude가". AI names are read aloud in Korean
// (그록 has a final consonant, 클로드/챗지피티/제미나이 do not).
const FINAL_CONSONANT = { claude: false, gpt: false, grok: true, gemini: false };
function endsWithBatchim(word) {
  const c = word.charCodeAt(word.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0;
}
// withJosa('grok', '방장', '이/가') -> 'Grok이'. `id` may also be a plain word.
export function withJosa(id, userName, pair) {
  const [withFinal, without] = pair.split('/');
  const word = MEMBERS[id] || id === 'user' || id === 'system' || id === DEV.id ? displayName(id, userName) : id;
  const fin = id in FINAL_CONSONANT ? FINAL_CONSONANT[id] : endsWithBatchim(word);
  return word + (fin ? withFinal : without);
}

// Does `text` address member `id`? Matches @Name and bare names/aliases.
export function mentions(text, id) {
  const t = (text || '').toLowerCase();
  const m = MEMBERS[id];
  if (!m) return false;
  return m.aliases.some((a) => t.includes('@' + a) || t.includes(a));
}

// Stricter: only an explicit @Name counts as calling someone.
export function atMentions(text, id) {
  const t = (text || '').toLowerCase();
  return !!MEMBERS[id]?.aliases.some((a) => t.includes('@' + a));
}
