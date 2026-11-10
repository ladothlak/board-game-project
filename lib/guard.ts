/**
 * Input validation and prompt-injection guardrail.
 * Runs before user text is sent to the LLM.
 */

const MAX_QUESTION_LENGTH = 1000;
const MAX_QUERY_LENGTH = 500;

/** Common prompt-injection patterns. Matched case-insensitively. */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|context)/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /new\s+system\s+prompt/i,
  /###\s*system/i,
  /\boverride\b.*\binstruction/i,
  /reveal\s+(your|the)\s+(system\s+)?prompt/i,
  /print\s+(your|the)\s+(system\s+)?(prompt|instructions)/i,
  /show\s+me\s+(your|the)\s+(system\s+)?(prompt|instructions)/i,
  /\bact\s+as\s+(a|an)\s+/i,
  /pretend\s+(you\s+are|to\s+be)\s+/i,
  /\bDAN\b/i, // "Do Anything Now" jailbreak
  /jailbreak/i,
  /developer\s+mode/i,
  /\bI\s+am\s+(a|an)\s+(admin|developer|operator)/i,
];

/**
 * Validate a chat question. Returns `{ ok: true }` or `{ ok: false, reason }`.
 */
export function validateQuestion(text: string): { ok: true } | { ok: false; reason: string } {
  if (text.length > MAX_QUESTION_LENGTH) {
    return { ok: false, reason: `Question too long (max ${MAX_QUESTION_LENGTH} characters).` };
  }
  const injection = detectInjection(text);
  if (injection) {
    return { ok: false, reason: "Request blocked." };
  }
  return { ok: true };
}

/**
 * Validate a game-finder query. Returns `{ ok: true }` or `{ ok: false, reason }`.
 */
export function validateQuery(text: string): { ok: true } | { ok: false; reason: string } {
  if (text.length > MAX_QUERY_LENGTH) {
    return { ok: false, reason: `Query too long (max ${MAX_QUERY_LENGTH} characters).` };
  }
  const injection = detectInjection(text);
  if (injection) {
    return { ok: false, reason: "Request blocked." };
  }
  return { ok: true };
}

/**
 * Scan text for known prompt-injection patterns.
 * Returns the matched pattern string if found, null otherwise.
 */
function detectInjection(text: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}
