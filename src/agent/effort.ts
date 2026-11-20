/**
 * Thinking "auto": decides per turn, from the prompt alone, whether reasoning is worth its wait. No extra model call
 * (that would cost the time it saves): short, plain requests (a question, a confirmation, "commit this") go without
 * thinking; anything that looks like debugging, building or reviewing, or that is long, carries code or a stack trace,
 * keeps it. When unsure it thinks: a wrong "off" costs quality, a wrong "on" only time.
 */

/** Work that benefits from reasoning (English stems, Korean words). */
const HARD =
  /\b(why|debug|fix|bug|error|exception|crash|fail|broken|refactor|implement|build|design|architect|optimi[sz]|review|analy[sz]|investigat|plan|migrat|secur|perf|race|deadlock|leak|test|compare|trade-?off|algorithm|prove|feature|rewrite)|왜|버그|오류|에러|예외|실패|원인|수정|고쳐|고치|구현|설계|리팩|최적화|분석|검토|리뷰|조사|계획|마이그|보안|성능|테스트|비교|추가|만들|개선|변경|바꿔|바꾸|작성|해결|안\s?돼|안\s?되|문제/i;
/** "Go on": the turn continues the previous one, so it inherits that one's decision. */
const CONTINUE = /^\s*(continue|go on|keep going|proceed|resume|계속|진행|이어서)/i;
const STACK = /^\s+at .+[:(]\d+|Traceback \(most recent|\w+(Error|Exception): /m;
const MAX_CHARS = 300;
const MAX_LINES = 3;

export function needsThinking(prompt: string, opts: { images?: boolean; previous?: boolean } = {}): boolean {
  const text = prompt.trim();
  if (CONTINUE.test(text) && text.length < 40) return opts.previous ?? true;
  if (opts.images) return true;
  if (text.length > MAX_CHARS || text.split('\n').length > MAX_LINES) return true;
  if (text.includes('```') || STACK.test(prompt)) return true;
  return HARD.test(text);
}
