import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getGame } from "@/lib/games";
import { loadIndex, retrieve, docFreqFor } from "@/lib/retrieve";
import { buildRagContext } from "@/lib/rag";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { validateQuestion } from "@/lib/guard";
import { withQueue } from "@/lib/llm-queue";
import { logRequest } from "@/lib/audit-log";
import { getPrewarm } from "./prewarm/route";

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

  // Enhanced RAG pipeline — check the speculative prewarm cache first.
  // If the client fired a prewarm while the user was typing, the context
  // is already built and we skip the (slow) LLM retrieval steps.
  const prewarmed = getPrewarm(slug, question.trim());
  let context: string;
  let toc: string;
  let ragConfidence: number;

  if (prewarmed) {
    context = prewarmed.context;
    toc = prewarmed.toc;
    ragConfidence = prewarmed.confidence;
  } else {
    const expNames = (game.expansions ?? []).filter((e) => e.inChatContext).map((e) => e.name);
    // Opt-in: use the fast decision model for classification + relevance
    // scoring (see PERFORMANCE-PLAN.md, "Decision-model RAG"). Off by default.
    const rag = await buildRagContext(slug, question.trim(), apiKey, expNames, {
      useDecisionModel: process.env.USE_DECISION_MODEL === "1",
    });
    context = rag.excerpts;
    toc = rag.toc;
    ragConfidence = rag.confidence;
  }

  // Low-confidence fallback: if retrieval was weak, note it in the prompt.
  const confidenceNote =
    ragConfidence < 0.25
      ? " NOTE: The rulebook excerpts below may not directly cover this question. If you cannot find a clear answer, say so and suggest which page the player should check."
      : "";

  // Optional cross-game comparison: pull a second game's most relevant pages.
  let compareContext = "";
  let compareTitle = "";
  if (compareSlug && compareSlug !== slug) {
    const other = await getGame(compareSlug);
    if (other) {
      compareTitle = other.title;
      const otherChunks = (await loadIndex()).filter((c) => c.slug === compareSlug);
      const otherTop = retrieve(otherChunks, question, 3, await docFreqFor(compareSlug));
      compareContext = otherTop
        .map((c) => `--- ${compareTitle}, page ${c.page} ---\n${c.text}`)
        .join("\n\n");
    }
  }

  const systemPrompt = compareContext
    ? `You are a warm, knowledgeable expert comparing the board games "${game.title}" and "${compareTitle}". ` +
      "Answer the player's question using ONLY the rulebook excerpts provided for both games. " +
      "When you reference a rule, cite its page like (p. 3) and name which game it belongs to. " +
      "Keep answers concise and friendly."
    : `You are a warm, knowledgeable expert on the board game "${game.title}". ` +
      "Answer the player's question using ONLY the rulebook excerpts provided. " +
      "A per-page map of the whole rulebook is also included: use it to orient yourself, " +
      "to cite the right page, and to tell the player which page to flip to when the " +
      "answer isn't in the loaded excerpts. If you're not sure, say so and point them to the likely page. " +
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
      content: `What's on each page of the rulebook (one line per page):\n${toc || "(none indexed yet)"}`,
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

  // Stream tokens back to the client as Server-Sent Events. The local model is
  // slow to reason, so streaming keeps the chat bar feeling alive instead of
  // frozen. Protocol: {type:"token"} chunks, then a final {type:"done"} with
  // citations, or {type:"error"}.
  const encoder = new TextEncoder();
  let full = "";

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        // Single-flight queue + 60s timeout to prevent resource exhaustion.
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
              // Reasoning model: needs room to think AND answer (see digest route).
              max_tokens: 2000,
              stream: true,
            }),
            signal: AbortSignal.timeout(60_000),
          })
        );

        if (!res.ok) {
          const text = await res.text();
          send({ type: "error", message: `Provider error ${res.status}: ${text.slice(0, 200)}` });
          controller.close();
          return;
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Process only complete SSE lines.
          let newline;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const j = JSON.parse(payload);
              const delta: string = j.choices?.[0]?.delta?.content ?? "";
              if (delta) {
                full += delta;
                send({ type: "token", content: delta });
              }
            } catch {
              /* ignore malformed keep-alive frames */
            }
          }
        }

        const answer = full.trim()
          ? full
          : "Hmm, I ran out of room to think that one through — try asking again, or break the question into smaller parts.";
        send({ type: "done", citations: dedupePages(answer) });
        controller.close();
        logRequest({ ip, route: "/api/chat", method: "POST", status: 200, durationMs: Date.now() - start });
      } catch (e) {
        send({
          type: "error",
          message: "Could not reach the LLM provider.",
        });
        controller.close();
        logRequest({ ip, route: "/api/chat", method: "POST", status: 502, durationMs: Date.now() - start });
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
