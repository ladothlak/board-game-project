// Decision model client for the local Unsloth "systemone" endpoint.
//
// Unlike the main chat/completions model (a 27B reasoning model that can take
// tens of seconds per call), the decision model is a small classifier
// (`kev-0.8b`) that answers a batch of questions in a single fast request
// (~0.5 s) and returns, for each question, a structured answer plus a
// confidence / probability distribution.
//
// It supports three question types:
//   - `choice`: multiple choice over a criteria map → chosen option +
//     confidence + full probability distribution.
//   - `noul`: a binary/continuous yes-no probe → a single 0–1 probability.
//   - `score`: rating along an ordered list of levels (an array) → a
//     continuous score on the 0..(levels-1) scale + per-level probabilities.
//
// It is used to make *decisions* about a user's question cheaply and
// reliably — what kind of question it is, whether it needs rephrasing, how
// relevant each retrieved candidate is — so the RAG pipeline can spend its
// slow LLM budget on generation instead of on decisions it can make for free.
//
// The endpoint is OpenAI-ish but NOT chat/completions: it takes a `state`
// (the text to reason about) plus a map of named questions and returns
// `answers` keyed by question name. See the curl examples in README /
// DOCUMENTATION.

/**
 * Resolve the decision-model URL from the environment at call time (not import
 * time), so a `.env` loaded after module evaluation — as in the benchmark — is
 * honored. Derives `<base>/systemone` from the existing Unsloth base URL and
 * allows an explicit override for unusual deployments.
 */
export function resolveDecisionModelUrl(): string {
  const base = process.env.UNSLOTH_BASE_URL ?? "http://localhost:8888/v1";
  return process.env.DECISION_MODEL_URL ?? `${base}/systemone`;
}

/** The `model` field the endpoint expects. It reports back as `kev-0.8b`. */
export const DECISION_MODEL_NAME = process.env.DECISION_MODEL_NAME ?? "default";

// ─── Types ────────────────────────────────────────────────────────────────

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Map of option id → human-readable description of that option. */
  criteria: Record<string, string>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered list of levels, lowest → highest. Index i is level i. */
  criteria: string[];
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type QuestionSpec = Record<string, Question>;

export interface DecisionAnswer {
  type: "choice" | "noul" | "score";
  /** `choice`: the chosen option id (a key of `criteria`). */
  choice?: string;
  /** `noul`: a 0–1 probability that the answer is "yes". */
  noul?: number;
  /** `score`: a continuous value on the 0..(levels-1) scale. */
  score?: number;
  /** Present for `choice` and `score`. */
  confidence?: number;
  /** Full probability distribution over the options/levels. */
  probabilities?: Record<string, number>;
}

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
  /** Wall-clock time for the request, in milliseconds. */
  latencyMs: number;
}

// ─── Client ───────────────────────────────────────────────────────────────

/**
 * Ask the decision model a batch of questions about `state`.
 *
 * Returns a `DecisionResult` on success, or `null` when the endpoint is
 * unreachable, times out, returns a non-OK status, or returns an unexpected
 * shape. Callers are expected to fall back to a deterministic heuristic — the
 * decision model is an enhancement, never a hard dependency.
 */
export async function askDecisionModel(
  state: string,
  questions: QuestionSpec,
  opts: { timeoutMs?: number } = {}
): Promise<DecisionResult | null> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const start = Date.now();
  try {
    const res = await fetch(resolveDecisionModelUrl(), {
      method: "POST",
      headers: {
        // The local endpoint does not require a real key.
        Authorization: `Bearer ${process.env.UNSLOTH_API_KEY ?? "not-needed"}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state,
        model: DECISION_MODEL_NAME,
        questions,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      answers?: Record<string, DecisionAnswer>;
      usage?: { input_tokens: number; output_tokens: number };
    };
    if (!data.answers) return null;

    return {
      answers: data.answers,
      usage: data.usage,
      latencyMs: Date.now() - start,
    };
  } catch {
    // Network error / timeout / bad JSON — treat as "unavailable".
    return null;
  }
}

/**
 * Convenience wrapper for a single multiple-choice question. Returns the
 * chosen option id plus its confidence, or `null` when the model is
 * unavailable.
 */
export async function askChoice(
  state: string,
  name: string,
  instructions: string,
  criteria: Record<string, string>
): Promise<{ choice?: string; confidence?: number } | null> {
  const result = await askDecisionModel(state, {
    [name]: { type: "choice", instructions, criteria },
  });
  const answer = result?.answers[name];
  if (!answer) return null;
  return { choice: answer.choice, confidence: answer.confidence };
}
