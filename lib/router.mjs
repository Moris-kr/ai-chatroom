// Per-turn model routing: before each turn, decide whether a member runs on its
// default model or its boost model (진심모드). Decided fresh every turn; when in
// doubt the answer is default (cheaper, faster).
//
// Boost triggers, strongest first:
//   1. a pending `/boost @member` command from the user
//   2. the user addresses the member and asks it to be serious ("진지하게", "각잡고", ...)
//   3. a message addressed to the member asks for code / file work, a calculation,
//      or multi-step reasoning   (only in "auto" mode; AI-to-AI requests are rate limited)
// The member itself can also ask for boost in its reply ("boost": "why"); that is
// handled by the server after the default call.

import { AI_IDS, MEMBERS, mentions, atMentions } from './members.mjs';

const SERIOUS = /(진지하게|진지한\s*(답|대답|얘기)|진지\s*모드|진심\s*모드|각\s*잡고|각\s*잡아|제대로\s*(생각|답|따져|분석|검토|설계|풀어|해\s*봐|해줘)|깊게\s*생각|신중하게|꼼꼼하게\s*(봐|따져|생각))/;
const REQUEST = /(해\s*줘|해줄래|해\s*봐|해봐|해\s*볼래|줘|줄래|할\s*수\s*있어|가능해|부탁|알려|설명|풀어|계산|\?|？)/;
const CODE_BLOCK = /```/;
const CODE = /(코드|코딩|디버깅|디버그|버그\s*(좀|찾|고쳐)|리팩터|리팩토링|스크립트|알고리즘|함수|정규식|쿼리|구현|자바스크립트|파이썬|javascript|python|typescript|html|css)/i;
const FILE_NOUN = /(파일|문서|규칙서|기획서|설계서|명세|스펙|보고서|페이지|게임|앱|표로|\.(md|html|js|py|json|svg|csv))/i;
const FILE_VERB = /(만들어|작성해|써\s*줘|써줘|써\s*봐|고쳐|수정해|정리해|추가해|구현해|짜\s*줘|짜줘|짜\s*봐|업데이트|바꿔\s*줘|옮겨)/;
const MATH = /(\d+(?:\.\d+)?\s*[+\-*/×÷^]\s*\d+(?:\.\d+)?\s*[+\-*/×÷^]\s*\d|확률|기댓값|방정식|적분|미분|증명|최적화|경우의\s*수|시간\s*복잡도|계산해)/;
const REASONING = /(단계별로|차근차근|논리적으로|근거\s*(를|까지)|비교\s*분석|장단점|트레이드\s*오프|반례|추론해|따져\s*(봐|줘))/;

// Is message `m` aimed at member `id`?
function addressedTo(m, id, store) {
  if (store.byId.get(m.replyTo)?.from === id) return true;
  if (atMentions(m.text, id)) return true;
  return mentions(m.text, id);
}

function heavyReason(text) {
  if (CODE_BLOCK.test(text)) return '코드 블록';
  if (FILE_NOUN.test(text) && FILE_VERB.test(text)) return '파일 작업 요청';
  if (!REQUEST.test(text)) return null;
  if (CODE.test(text)) return '코드 요청';
  if (MATH.test(text)) return '계산 요청';
  if (REASONING.test(text)) return '다단계 추론 질문';
  return null;
}

export class Router {
  constructor(cfg) {
    this.cfg = cfg;
    this.pending = {};      // id -> {at} from /boost
    this.lastAuto = {};     // id -> ms, last boost caused by another AI's request
  }

  boostOf(id) {
    const b = this.cfg.agents[id]?.boost;
    return b && (b.model || b.effort) ? b : null;
  }

  // mode: 'auto' | 'manual' (only user commands / serious phrases) | 'off'
  decide(id, store, seen, mode) {
    if (mode === 'off' || !this.boostOf(id)) return null;
    const now = Date.now();

    const p = this.pending[id];
    if (p && now - p.at < 10 * 60000) {
      delete this.pending[id];
      return { by: 'command', reason: '방장 /boost' };
    }

    const fresh = store.after(seen).filter((m) => m.from !== id && m.from !== 'system' && m.text).slice(-8);
    for (const m of [...fresh].reverse()) {
      if (m.from !== 'user' || !addressedTo(m, id, store)) continue;
      const hit = m.text.match(SERIOUS);
      if (hit) return { by: 'user', reason: `방장이 "${hit[0].trim()}"`, msg: m.id };
    }
    if (mode !== 'auto') return null;

    for (const m of [...fresh].reverse()) {
      if (!addressedTo(m, id, store)) continue;
      const why = heavyReason(m.text);
      if (!why) continue;
      if (m.from !== 'user') {
        // Members ask each other for work a lot; don't let that burn the boost quota.
        const cool = (this.cfg.boost?.aiRequestCooldownSec ?? 180) * 1000;
        if (now - (this.lastAuto[id] || 0) < cool) continue;
        this.lastAuto[id] = now;
      }
      return { by: 'context', reason: `${why} (#${m.id})`, msg: m.id };
    }
    return null;
  }

  // "/boost @Grok @Claude 나머지 말" -> {ids, rest}; null if the text is not a command.
  static parseCommand(text) {
    const m = String(text).match(/^\/boost\b([\s\S]*)$/i);
    if (!m) return null;
    let rest = m[1].trim();
    const ids = [];
    for (;;) {
      const t = rest.match(/^@?([A-Za-z가-힣]+)\s*/);
      if (!t) break;
      const id = AI_IDS.find((a) => MEMBERS[a].aliases.includes(t[1].toLowerCase()));
      if (!id) break;
      if (!ids.includes(id)) ids.push(id);
      rest = rest.slice(t[0].length);
    }
    return { ids, rest: rest.trim() };
  }

  arm(id) {
    this.pending[id] = { at: Date.now() };
  }
}

// Exported for tests.
export const _test = { heavyReason, SERIOUS };
