import { THINKING_LEVELS, type ThinkingLevel } from '../config.js';

/**
 * Thinking "auto": picks the reasoning level per turn from the prompt alone, capped at the configured level. No extra
 * model call (that would cost the time it saves). Short, plain requests (a question, a confirmation, "commit this") go
 * without thinking; small changes think a little; debugging, building or reviewing, long prompts, code and images
 * think more; design, performance, security and root-cause work the most. When unsure it thinks: a wrong "off" costs
 * quality, a wrong "on" only time.
 */
export type AutoLevel = ThinkingLevel | 'none';

/** Design-level work: the deepest reasoning pays off. */
const DEEP =
  /\b(architect|design|race|deadlock|concurren|secur|perf|optimi[sz]|algorithm|migrat|root cause|trade-?off|leak|refactor)|설계|아키텍|동시성|보안|성능|최적화|알고리즘|마이그|원인|누수|리팩/i;
/** Debugging, building, reviewing. */
const HARD =
  /\b(why|debug|fix|bug|error|exception|crash|fail|broken|implement|build|review|analy[sz]|investigat|plan|test|compare|prove|feature|rewrite)|왜|버그|오류|에러|예외|실패|수정|고쳐|고치|구현|분석|검토|리뷰|조사|계획|테스트|비교|개선|해결|안\s?돼|안\s?되|문제/i;
/** Small, well-defined changes. */
const LIGHT = /\b(add|change|update|rename|write|create|move|remove|delete|convert)\b|추가|만들|변경|바꿔|바꾸|작성|삭제|옮겨|이름/i;
/** "Go on": the turn continues the previous one, so it inherits that one's decision. */
const CONTINUE = /^\s*(continue|go on|keep going|proceed|resume|계속|진행|이어서)/i;
const STACK = /^\s+at .+[:(]\d+|Traceback \(most recent|\w+(Error|Exception): /m;
const MAX_CHARS = 300;
const LONG_CHARS = 1500;
const MAX_LINES = 3;

const rank = (l: AutoLevel) => (l === 'none' ? -1 : THINKING_LEVELS.indexOf(l));

/** The level the prompt calls for, before the cap. */
export function promptLevel(prompt: string, opts: { images?: boolean; previous?: AutoLevel } = {}): AutoLevel {
  const text = prompt.trim();
  if (CONTINUE.test(text) && text.length < 40) return opts.previous ?? 'high';
  if (DEEP.test(text) || STACK.test(prompt) || text.length > LONG_CHARS) return 'high';
  if (HARD.test(text) || opts.images || text.includes('```') || text.length > MAX_CHARS || text.split('\n').length > MAX_LINES) return 'medium';
  return LIGHT.test(text) ? 'low' : 'none';
}

/** The level a turn uses in auto: what the prompt calls for, at most `max`. */
export function autoLevel(prompt: string, max: ThinkingLevel, opts: { images?: boolean; previous?: AutoLevel } = {}): AutoLevel {
  const want = promptLevel(prompt, opts);
  return rank(want) > rank(max) ? max : want;
}
