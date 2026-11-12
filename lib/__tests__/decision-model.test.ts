import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { askDecisionModel, askChoice } from "../decision-model";

// ─── Shared fetch mock ──────────────────────────────────────────────────────

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── askDecisionModel ───────────────────────────────────────────────────────

describe("askDecisionModel", () => {
  it("posts state + questions and returns the parsed answers with latency", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        model: "kev-0.8b",
        answers: {
          category: {
            type: "choice",
            choice: "billing",
            confidence: 0.73,
            probabilities: { billing: 0.82, technical: 0.05, other: 0.13 },
          },
        },
        usage: { input_tokens: 44, output_tokens: 0 },
      })
    );

    const result = await askDecisionModel("I was charged twice.", {
      category: {
        type: "choice",
        instructions: "What is this about?",
        criteria: { billing: "charges", technical: "bugs", other: "else" },
      },
    });

    expect(result).not.toBeNull();
    expect(result!.answers.category.choice).toBe("billing");
    expect(result!.answers.category.confidence).toBeCloseTo(0.73);
    expect(result!.usage?.input_tokens).toBe(44);
    expect(result!.latencyMs).toBeGreaterThanOrEqual(0);

    // The request body carries the state, model, and questions verbatim.
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/systemone");
    const body = JSON.parse(String(init?.body));
    expect(body.state).toBe("I was charged twice.");
    expect(body.model).toBe("default");
    expect(body.questions.category.type).toBe("choice");
  });

  it("returns null on a network error", async () => {
    mockFetch.mockRejectedValue(new Error("connection refused"));
    await expect(askDecisionModel("hi", { q: { type: "noul", instructions: "?" } })).resolves.toBeNull();
  });

  it("returns null on a non-OK status", async () => {
    mockFetch.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(askDecisionModel("hi", { q: { type: "noul", instructions: "?" } })).resolves.toBeNull();
  });

  it("returns null when the response has no answers field", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ model: "kev-0.8b" }));
    await expect(askDecisionModel("hi", { q: { type: "noul", instructions: "?" } })).resolves.toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    mockFetch.mockResolvedValue(new Response("not json", { status: 200 }));
    await expect(askDecisionModel("hi", { q: { type: "noul", instructions: "?" } })).resolves.toBeNull();
  });

  it("passes a custom timeout through to the fetch signal", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ answers: {} }));
    await askDecisionModel("hi", { q: { type: "noul", instructions: "?" } }, { timeoutMs: 1234 });
    const [, init] = mockFetch.mock.calls[0];
    // AbortSignal.timeout produces an object with the given delay; assert it's present.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

// ─── askChoice ──────────────────────────────────────────────────────────────

describe("askChoice", () => {
  it("returns the chosen option and confidence for a choice question", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        answers: { q: { type: "choice", choice: "setup", confidence: 0.6 } },
      })
    );

    const result = await askChoice("How do I set up?", "q", "Classify it.", { setup: "s", other: "o" });
    expect(result).toEqual({ choice: "setup", confidence: 0.6 });
  });

  it("returns null when the model is unavailable", async () => {
    mockFetch.mockRejectedValue(new Error("down"));
    await expect(askChoice("hi", "q", "?", { a: "a" })).resolves.toBeNull();
  });
});
