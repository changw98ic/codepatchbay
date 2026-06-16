/**
 * Poisoned session detection — classifies agent output that indicates
 * a broken or unusable session rather than genuine work product.
 *
 * Three classifiers:
 *   1. AGENT_FALLBACK      — refusal / safety-template responses
 *   2. INVALID_REQUEST     — API-level errors surfaced in output
 *   3. SEMANTIC_INACTIVITY — output too short to be meaningful
 */
/** Pattern sets exported for testing / introspection. */
export const POISON_SIGNALS = {
    AGENT_FALLBACK: [
        /i cannot assist/i,
        /as an ai model/i,
        /guidelines prevent/i,
        /i must decline/i,
        /ethical concerns/i,
        /我无法(?:协助|帮助|完成|回答)/,
        /抱歉.*?(?:无法|不能|不可以)/,
        /作为.*?(?:AI|人工智能|语言模型)/,
    ],
    INVALID_REQUEST: [
        /invalid_request_error/i,
        /context window exceeded/i,
        /rate_limit_exceeded/i,
        /server_error.*overloaded/i,
    ],
};
const SEMANTIC_INACTIVITY_THRESHOLD = 50;
/**
 * Classify phase output + stderr for poisoned-session indicators.
 *
 * Returns `{ poisoned, reasons, classifier }`.  When `poisoned` is
 * `true`, `classifier` names the first matching classifier and
 * `reasons` lists every matched pattern.
 */
export function classifyPoisonedSession(output, { stderr = "" } = {}) {
    const text = `${output}\n${stderr}`;
    const reasons = [];
    // 1. Agent fallback — refusal / template language
    for (const re of POISON_SIGNALS.AGENT_FALLBACK) {
        if (re.test(text)) {
            reasons.push(`agent_fallback:${re.source}`);
        }
    }
    if (reasons.some((r) => r.startsWith("agent_fallback:"))) {
        return { poisoned: true, reasons, classifier: "agent_fallback" };
    }
    // 2. Invalid request / API errors
    for (const re of POISON_SIGNALS.INVALID_REQUEST) {
        if (re.test(text)) {
            reasons.push(`invalid_request:${re.source}`);
        }
    }
    if (reasons.some((r) => r.startsWith("invalid_request:"))) {
        return { poisoned: true, reasons, classifier: "invalid_request" };
    }
    // 3. Semantic inactivity — output too short to be meaningful
    const combinedLength = output.length + stderr.length;
    if (combinedLength < SEMANTIC_INACTIVITY_THRESHOLD) {
        reasons.push(`semantic_inactivity:combined_length=${combinedLength}`);
        return { poisoned: true, reasons, classifier: "semantic_inactivity" };
    }
    return { poisoned: false, reasons: [], classifier: null };
}
