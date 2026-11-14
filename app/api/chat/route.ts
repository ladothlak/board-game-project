import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getGame } from "@/lib/games";
import { loadIndex, retrieve, docFreqFor } from "@/lib/retrieve";
import { getAnswer, storeAnswer } from "./answer-cache";
import { buildRagContext, finishRagContext, detectExplicitPages, type PrewarmHeadStart, type RagTimings } from "@/lib/rag";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { validateQuestion } from "@/lib/guard";
import { withQueue } from "@/lib/llm-queue";
import { logRequest } from "@/lib/audit-log";
import { getPrewarm, getInflightPrewarm, type PrewarmEntry } from "./prewarm/route";

// Unsloth runs locally (Unsloth Studio / `unsloth run`) and exposes an
// OpenAI-compatible API, typically on http://localhost:8888.
const BASE_URL = process.env.UNSLOTH_BASE_URL ?? "http://localhost:8888/v1";
const MODEL =
  process.env.UNSLOTH_MODEL ?? "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF";

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

function dedupePages(answer: string): { page: number }[] {
  const seen = new Set<number>();
  // Match "(p. 16)", bare "p. 18", "page 12", and "pages 8-11" (→ first page).
  const pattern = /(?:\()?p\.?\s*(\d+)\)?|pages?\s+(\d+)(?:-\d+)?/gi;
  const pages: number[] = [];
  for (const m of answer.matchAll(pattern)) {
    const p = Number(m[1] ?? m[2]);
    if (p > 0 && !seen.has(p)) {
      seen.add(p);
      pages.push(p);
    }
  }
  return pages.sort((a, b) => a - b).map((page) => ({ page }));
}

/**
 * One non-streaming provider call (issue #69). Returns the full answer text
 * on success, or the HTTP status + body excerpt on a provider 4xx/5xx. A
 * network failure (unreachable server) rejects, so callers can distinguish
 * "the model refused" from "we never reached the model".
 *
 * We request `stream: false` deliberately: citation validation (issue #69)
 * needs the COMPLETE answer before any token reaches the client, so we buffer
 * the whole generation and trade time-to-first-token for citation accuracy.
 * For P0 that is the right trade — a wrong page number is worse than a slower
 * first token.
 */
async function callProvider(
  apiKey: string,
  messages: { role: string; content: string }[],
  maxTokens: number,
): Promise<{ ok: true; content: string } | { ok: false; status: number; text: string }> {
  const res = await withQueue(() =>
    fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.3,
        // Budget scales with question type (issue #61) — set by the caller.
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    })
  );
  if (!res.ok) {
    return { ok: false, status: res.status, text: (await res.text()).slice(0, 200) };
  }
  const json = await res.json();
  return { ok: true, content: json.choices?.[0]?.message?.content ?? "" };
}

/**
 * The pages cited in `answer` that are NOT in `validPages` (issue #69). An
 * empty result means every citation is valid.
 */
function invalidCitations(answer: string, validPages: Set<number>): number[] {
  return dedupePages(answer)
    .filter((c) => !validPages.has(c.page))
    .map((c) => c.page);
}

/**
 * Remove citation markers for pages not in `validPages` (issue #69). Uses the
 * same pattern as `dedupePages`, so a marker is stripped exactly when it would
 * have been flagged as invalid. Leftover whitespace from a removed marker is
 * collapsed so the text stays readable.
 */
function stripInvalidCitations(answer: string, validPages: Set<number>): string {
  const pattern = /(?:\()?p\.?\s*(\d+)\)?|pages?\s+(\d+)(?:-\d+)?/gi;
  const stripped = answer.replace(pattern, (match, g1, g2) =>
    validPages.has(Number(g1 ?? g2)) ? match : ""
  );
  return stripped.replace(/\s{2,}/g, " ").replace(/\s+([.,;])/g, "$1");
}

/** Split buffered text into token-sized chunks for the SSE protocol (issue #69). */
function* chunkText(text: string, size = 64): Generator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

export async function POST(req: Request) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const start = Date.now();
  const ip = getClientIp(req);

  // Rate limit: 10 requests per minute per IP.
  const rate = checkRate(ip, "/api/chat", 10, 60_000);
  if (!rate.allowed) {
    logRequest({ ip, route: "/api/chat", method: "POST", status: 429, durationMs: Date.now() - start });
    const res = NextResponse.json({ error: "Too many requests — slow down." }, { status: 429 });
    res.headers.set("Retry-After", String(rate.retryAfter));
    return res;
  }

  let body: { slug?: string; question?: string; history?: HistoryMessage[]; compareSlug?: string; simpleMode?: boolean };
  try {
    body = await req.json();
  } catch {
    logRequest({ ip, route: "/api/chat", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { slug, question, history = [], compareSlug, simpleMode } = body;
  if (!slug || !question?.trim()) {
    logRequest({ ip, route: "/api/chat", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: "slug and question are required" }, { status: 400 });
  }

  // Input validation + prompt-injection guard.
  const guard = validateQuestion(question.trim());
  if (!guard.ok) {
    logRequest({ ip, route: "/api/chat", method: "POST", status: 400, durationMs: Date.now() - start });
    return NextResponse.json({ error: guard.reason }, { status: 400 });
  }

  const game = await getGame(slug);
  if (!game) {
    logRequest({ ip, route: "/api/chat", method: "POST", status: 404, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Unknown game" }, { status: 404 });
  }

  const apiKey = process.env.UNSLOTH_API_KEY;
  if (!apiKey) {
    logRequest({ ip, route: "/api/chat", method: "POST", status: 500, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  // Final-answer cache (issue #56): a repeat question is replayed verbatim —
  // no RAG, no generation, zero model cost. Checked only after auth, rate
  // limiting, and the prompt-injection guard, so blocked requests are never
  // served from cache.
  //
  // Refresh the index mtime before consulting the cache: `indexMtime()` only
  // advances when `loadIndex()` runs, and a cache hit returns before any other
  // loadIndex() call in this request — without this, a re-digest would leave
  // stale answers served until some unrelated request happened to reload the
  // index. Cheap: one fs.stat when the file is unchanged. (We refresh here
  // rather than statting the index inside the cache module, so the cache stays
  // decoupled from the index file's location.)
  await loadIndex();
  const cached = getAnswer(slug, question.trim());
  if (cached) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Replay through the existing SSE protocol: one token event with the
        // full answer, then done with citations.
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "token", content: cached.answer })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", citations: cached.citations })}\n\n`));
        controller.close();
        logRequest({
          ip, route: "/api/chat", method: "POST", status: 200, durationMs: Date.now() - start,
          prewarmHit: false, answerCacheHit: true, stages: { firstTokenMs: Date.now() - start },
        });
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // Stream tokens back to the client as Server-Sent Events. The local model is
  // slow to reason, so streaming keeps the chat bar feeling alive instead of
  // frozen. Protocol: {type:"token"} chunks, then a final {type:"done"} with
  // citations, or {type:"error"}. Stage events ({type:"stage"}) are additive
  // progress markers (issue #57) — old clients that ignore unknown event
  // types keep working. Everything from RAG onward runs inside the stream so
  // the response (and its first stage event) returns before retrieval starts.
  const encoder = new TextEncoder();
  let full = "";
  // Tier 0 measurement (issue #55): time from the request start to the first
  // streamed token, so the audit line can separate RAG latency from
  // generation latency.
  let firstTokenAt: number | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let prewarmHit = false;
      // Per-stage RAG timings (expand/retrieve/rerank) — only known when this
      // request built the context itself; a prewarm hit skips those stages.
      let ragTimings: RagTimings | null = null;
      try {
        // Stage event (issue #57): sent immediately, before any await, so the
        // client gets sub-second feedback while RAG runs. The answer-cache-hit
        // path above returns before this stream is created, so a replayed
        // answer never emits one — it never retrieves.
        send({ type: "stage", stage: "retrieving" });

        // Enhanced RAG pipeline — check the speculative prewarm cache first.
        // If the client fired a prewarm while the user was typing, its
        // deterministic head start (index load, DF table, base retrieval,
        // keyword classification) is already built and we skip that prefix.
        const prewarmed = getPrewarm(slug, question.trim());
        // In-flight deduplication (issue #60): a prewarm for this exact
        // question is still building its head start — await that promise
        // instead of starting a second head-start build.
        const inflight = prewarmed ? null : getInflightPrewarm(slug, question.trim());
        let context: string | undefined;
        let toc: string | undefined;
        let ragConfidence: number | undefined;
        // The pages retrieval surfaced, for the "pages-found" stage event.
        let pages: number[] | null = null;
        // The pages actually loaded into the excerpts (issue #63) — the valid
        // set for citation validation (issue #69).
        let excerptedPages: number[] = [];

        // A cached payload is a head start (quality "fast"), never a
        // final-answer-ready context (issue #67 rejection rule): on a hit we
        // ALWAYS finish the full quality pipeline over it below, so a prewarm
        // hit and a cold request produce byte-identical excerpts. A payload
        // without a quality flag is treated the same — never served verbatim.
        let headStart: PrewarmHeadStart | null = null;
        if (prewarmed) {
          prewarmHit = true;
          headStart = prewarmed.headStart;
        } else if (inflight) {
          // Await the in-flight build with a local guard: if it rejected, fall
          // back to building this request's own head start below so the real
          // question can still succeed.
          try {
            headStart = await inflight;
            prewarmHit = true;
          } catch {
            // The in-flight prewarm failed: fall through to the self-build
            // below. prewarmHit stays false so the audit line doesn't claim a
            // hit for a head start that never materialized.
          }
        }

        const expNames = (game.expansions ?? []).filter((e) => e.inChatContext).map((e) => e.name);
        // Default-on: use the fast decision model for classification + relevance
        // scoring (see PERFORMANCE-PLAN.md, "Decision-model RAG"). Set
        // USE_DECISION_MODEL=0 to disable for A/B benchmarking.
        const useDecisionModel = process.env.USE_DECISION_MODEL !== "0";

        if (headStart) {
          // Prewarm hit: finish the full quality pipeline over the cached head
          // start (issue #67). Both this and the cold path below share
          // buildPrewarmHeadStart + finishRagContext, so they produce identical
          // excerpts for the same question.
          const rag = await finishRagContext(headStart, slug, question.trim(), apiKey, expNames, {
            useDecisionModel,
          });
          context = rag.excerpts;
          toc = rag.toc;
          ragConfidence = rag.confidence;
          ragTimings = rag.timings;
          pages = rag.pages;
          excerptedPages = rag.excerptedPages;
        } else {
          const rag = await buildRagContext(slug, question.trim(), apiKey, expNames, {
            useDecisionModel,
          });
          context = rag.excerpts;
          toc = rag.toc;
          ragConfidence = rag.confidence;
          ragTimings = rag.timings;
          pages = rag.pages;
          excerptedPages = rag.excerptedPages;
        }

        // Stage event (issue #57): right after the RAG context is ready, so the
        // client can show which pages the answer will draw on. Skipped when the
        // page list is empty — an empty index or zero retrieval hits would
        // otherwise emit a useless `pages: []` frame.
        if (pages && pages.length > 0) send({ type: "stage", stage: "pages-found", pages });

        // Low-confidence fallback: if retrieval was weak, note it in the prompt.
        // (ragConfidence is always defined here — every branch above assigns it.)
        const confidenceNote =
          (ragConfidence ?? 0) < 0.25
            ? " NOTE: The rulebook excerpts below may not directly cover this question. If you cannot find a clear answer in the provided excerpts, say so plainly without guessing a specific page number."
            : "";

        // Optional cross-game comparison: pull a second game's most relevant pages.
        let compareContext = "";
        let compareTitle = "";
        // The second game's retrieved page numbers (issue #69): a comparison
        // answer may legitimately cite these, so they join the valid set.
        let comparePages: number[] = [];
        if (compareSlug && compareSlug !== slug) {
          const other = await getGame(compareSlug);
          if (other) {
            compareTitle = other.title;
            const otherChunks = (await loadIndex()).filter((c) => c.slug === compareSlug);
            const otherTop = retrieve(otherChunks, question, 3, await docFreqFor(compareSlug));
            comparePages = otherTop.map((c) => c.page);
            compareContext = otherTop
              .map((c) => `--- ${compareTitle}, page ${c.page} ---\n${c.text}`)
              .join("\n\n");
          }
        }

        const systemPrompt = compareContext
          ? `You are a warm, knowledgeable expert comparing the board games "${game.title}" and "${compareTitle}". ` +
            "Answer the player's question using ONLY the rulebook excerpts provided for both games. " +
            "When you reference a rule, cite its page like (p. 3) and name which game it belongs to. " +
            "If the answer isn't in the loaded excerpts, say so plainly without guessing a specific page number. " +
            "Keep answers concise and friendly."
          : `You are a warm, knowledgeable expert on the board game "${game.title}". ` +
            "Answer the player's question using ONLY the rulebook excerpts provided. " +
            "A table of contents for the whole rulebook (sections with their pages) is also included: " +
            "use it to orient yourself and to cite the right page from the loaded excerpts. If the answer isn't in the loaded excerpts, say so plainly without guessing a specific page number. " +
            "When you reference a rule, cite its page like (p. 3). Keep answers concise and friendly." +
            confidenceNote +
            (simpleMode
              ? " IMPORTANT: The player is new to this game. Use plain language, short sentences, and real-world analogies. Avoid jargon. Explain as if talking to a friend who has never played."
              : "");

        // Mention enabled expansions so the LLM knows it has access to their content.
        const enabledExpansions = (game.expansions ?? []).filter((e) => e.inChatContext);
        const expansionNote = enabledExpansions.length > 0
          ? ` Note: The rulebook excerpts also include content from the following expansion(s): ${enabledExpansions.map((e) => e.name).join(", ")}. Their pages are numbered after the base game's pages.`
          : "";

        const messages = [
          { role: "system", content: systemPrompt + expansionNote },
          {
            role: "system",
            content: `Table of contents for the rulebook (sections with their pages):\n${toc || "(none indexed yet)"}`,
          },
          {
            role: "system",
            content: `Rulebook excerpts:\n${context || "(no rulebook text available yet — ask the owner to add the PDF)"}`,
          },
          ...(compareContext
            ? [{ role: "system" as const, content: `Comparison excerpts:\n${compareContext}` }]
            : []),
          ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: question.trim() },
        ];

        // Trim the generation budget (issue #61): an explicit-page question has
        // its answer in-context and needs less thinking, so it gets a smaller
        // budget. The Unsloth endpoint exposes no per-request reasoning-effort
        // knob — `unsloth run` takes --reasoning-effort as a server-startup flag
        // only — so the token budget is the only per-question lever here.
        const explicitPages = detectExplicitPages(question.trim());
        const maxTokens = explicitPages.length > 0 ? 1000 : 2000;

        // ── Citation validation (issue #69) ────────────────────────────────
        // The set of pages a citation may legitimately reference: the pages
        // actually loaded into the excerpts (excerptedPages), plus — for
        // cross-game comparison requests — the second game's retrieved pages,
        // which the model is allowed to cite.
        const validPages = new Set<number>(excerptedPages);
        for (const p of comparePages) validPages.add(p);

        let validationOutcome: "clean" | "repaired" | "stripped" = "clean";
        let flagged = false;

        // Buffered generation (issue #69): request the FULL answer up front
        // (stream: false) so citations can be validated before any token
        // reaches the client. This trades time-to-first-token for citation
        // accuracy — acceptable for P0, where a wrong page number is worse
        // than a slower first token.
        const first = await callProvider(apiKey, messages, maxTokens);
        if (!first.ok) {
          send({ type: "error", message: `Provider error ${first.status}: ${first.text}` });
          controller.close();
          // A provider 4xx/5xx is a full request failure — audit it like the
          // other failure paths (issue #55). No token ever streamed, so only
          // the RAG stage durations are known.
          const stages: Record<string, number> = { ...(ragTimings ?? {}) };
          logRequest({ ip, route: "/api/chat", method: "POST", status: 502, durationMs: Date.now() - start, prewarmHit, stages });
          return;
        }
        full = first.content;

        // Validate the cited pages. An empty answer has nothing to check.
        if (full.trim()) {
          const invalid = invalidCitations(full, validPages);
          if (invalid.length > 0) {
            // Repair: retry ONCE with a strict reminder naming exactly which
            // pages may be cited. The model has no memory of its first attempt
            // (each provider call is independent), so the constraint is stated
            // fresh.
            const validList = [...validPages].sort((a, b) => a - b).join(", ");
            const reminder =
              `\n\nSTRICT CITATION RULE: Cite ONLY these pages: ${validList}. ` +
              "If the answer is not in the loaded excerpts, say so plainly — do not guess any other page number.";
            const retryMessages = messages.map((m, i) =>
              i === messages.length - 1 ? { ...m, content: m.content + reminder } : m
            );
            const second = await callProvider(apiKey, retryMessages, maxTokens);
            if (second.ok) {
              full = second.content;
              if (invalidCitations(full, validPages).length === 0) {
                validationOutcome = "repaired";
              } else {
                // The retry also cited pages outside the excerpts: strip those
                // markers and flag the answer so no invalid citation reaches
                // the client silently.
                full = stripInvalidCitations(full, validPages);
                flagged = true;
                validationOutcome = "stripped";
              }
            } else {
              // The retry hit a provider error: keep the first answer but strip
              // its bad citations and flag it, so no invalid marker reaches the
              // client silently.
              full = stripInvalidCitations(full, validPages);
              flagged = true;
              validationOutcome = "stripped";
            }
          }
        }

        // Make the flag visible in the text itself (issue #69): a stripped
        // answer says so plainly instead of silently dropping a citation.
        if (flagged) {
          full += " (Note: some cited pages could not be verified against the loaded rulebook and were removed.)";
        }

        // Stream the buffered answer as token events so the client protocol is
        // unchanged (issue #69). Only when there is real content — an empty
        // provider response delivers the fallback via `done` alone, as before.
        if (full.trim()) {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          for (const chunk of chunkText(full)) {
            send({ type: "token", content: chunk });
          }
        }

        const citations = dedupePages(full);
        // `citationsFlagged` is additive (issue #69): old clients that ignore
        // unknown fields keep working; new clients can surface the warning.
        send({ type: "done", citations, ...(flagged ? { citationsFlagged: true } : {}) });
        controller.close();
        // Cache only cleanly-validated answers with real content (issues #56,
        // #69): a stripped/flagged answer's text was altered, and a repaired
        // answer cost an extra generation — neither is cached, so a replayed
        // answer is always the exact, unaltered original whose citations are
        // all valid. Stamped with the current index mtime so a re-digest
        // invalidates it; evicts the oldest entry when over cap.
        if (full.trim() && validationOutcome === "clean") {
          storeAnswer(slug, question.trim(), full, citations);
        }
        // Per-stage breakdown for the audit log (Tier 0, issue #55): the
        // quality stages' durations (expand/retrieve/rerank) — known on every
        // path since both the prewarm-hit and cold paths run finishRagContext
        // (issue #67) — plus time to first token, plus the citation-validation
        // outcome (issue #69).
        const stages: Record<string, number> = { ...(ragTimings ?? {}) };
        if (firstTokenAt !== null) stages.firstTokenMs = firstTokenAt - start;
        logRequest({ ip, route: "/api/chat", method: "POST", status: 200, durationMs: Date.now() - start, prewarmHit, stages, citationValidation: validationOutcome });
      } catch (e) {
        send({
          type: "error",
          message: "Could not reach the LLM provider.",
        });
        controller.close();
        // No token ever streamed, so only the RAG stage durations are known.
        const stages: Record<string, number> = { ...(ragTimings ?? {}) };
        logRequest({ ip, route: "/api/chat", method: "POST", status: 502, durationMs: Date.now() - start, prewarmHit, stages });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
