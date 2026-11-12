"use client";

import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Citation {
  page: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
}

export default function ChatBar({ slug, title }: { slug: string; title: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [simpleMode, setSimpleMode] = useState(false);
  const [slowBrew, setSlowBrew] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const assistantIndexRef = useRef<number | null>(null);

  // Show "Still brewing…" if the LLM takes more than 15s.
  useEffect(() => {
    if (!loading) {
      setSlowBrew(false);
      return;
    }
    const id = setTimeout(() => setSlowBrew(true), 15_000);
    return () => clearTimeout(id);
  }, [loading]);

  // Conversations are intentionally in-memory only: navigating away from
  // the game page unmounts this component and starts a fresh chat.

  // "Ask about p. N" from the rulebook viewer prefills a focused question.
  useEffect(() => {
    const handler = (e: Event) => {
      const page = (e as CustomEvent<number>).detail;
      setInput(`Tell me more about what's on page ${page}.`);
      inputRef.current?.focus();
    };
    window.addEventListener("parlor:ask-page", handler);
    return () => window.removeEventListener("parlor:ask-page", handler);
  }, []);

  // The FAQ section (and any other UI) can paste a ready-made question into
  // the box and focus it, so the player just hits "Ask".
  useEffect(() => {
    const handler = (e: Event) => {
      setInput((e as CustomEvent<string>).detail);
      inputRef.current?.focus();
    };
    window.addEventListener("parlor:prefill", handler);
    return () => window.removeEventListener("parlor:prefill", handler);
  }, []);

  // Track fullscreen state (Escape exits natively).
  useEffect(() => {
    const handler = () => setIsFullscreen(document.fullscreenElement === cardRef.current);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // Speculative RAG: pre-warm the server-side context while the user types.
  // Fires a debounced request once the input has > 20 chars and been stable
  // for 800ms. By the time they hit "Ask," the RAG context is already built.
  useEffect(() => {
    if (input.trim().length < 20 || loading) return;
    const t = setTimeout(() => {
      fetch("/api/chat/prewarm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, question: input.trim() }),
      }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [input, slug, loading]);

  function toggleFullscreen() {
    const el = cardRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      el.requestFullscreen().catch(() => {});
    }
  }

  // Keep the newest message in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || loading) return;
    setCollapsed(false); // expand the chat so the conversation is visible
    const next: Message[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);
    assistantIndexRef.current = null;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, question: q, history: next.slice(-6), simpleMode }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Server responded ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          let j: { type: string; content?: string; citations?: Citation[]; message?: string };
          try {
            j = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (j.type === "token" && j.content) {
            setMessages((prev) => {
              if (assistantIndexRef.current === null) {
                assistantIndexRef.current = prev.length;
                return [...prev, { role: "assistant", content: j.content!, citations: [] }];
              }
              const c = [...prev];
              const i = assistantIndexRef.current!;
              c[i] = { ...c[i], content: c[i].content + j.content! };
              return c;
            });
          } else if (j.type === "done") {
            setMessages((prev) => {
              const i = assistantIndexRef.current;
              if (i === null) return prev;
              const c = [...prev];
              c[i] = { ...c[i], citations: j.citations ?? [] };
              return c;
            });
          } else if (j.type === "error") {
            throw new Error(j.message ?? "Something went wrong.");
          }
        }
      }
    } catch (e) {
      // If we never got a token, drop the empty assistant bubble.
      setMessages((prev) =>
        assistantIndexRef.current === null ? prev : prev.slice(0, assistantIndexRef.current)
      );
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function jumpToPage(page: number) {
    window.dispatchEvent(new CustomEvent("parlor:jump-page", { detail: page }));
  }

  // Transform page references in answer text into clickable markdown links.
  function linkifyPageRefs(text: string): string {
    return text.replace(
      /(\(p\. \d+\)|p\. \d+|pages? \d+(?:-\d+)?)/gi,
      (match) => {
        const p = Number(match.match(/\d+/g)![0]);
        return `[${match}](#page-${p})`;
      }
    );
  }

  // Custom anchor renderer: intercepts #page-N links and jumps to that page.
  function renderLink({ node, href, children }: { node?: unknown; href?: string; children?: React.ReactNode }) {
    if (href?.startsWith("#page-")) {
      const p = Number(href.slice(6));
      return (
        <button
          onClick={() => jumpToPage(p)}
          className="inline cursor-pointer rounded bg-latte/30 px-1 text-xs text-cocoa underline decoration-terracotta/50 hover:bg-terracotta/20 dark:bg-cocoa/30 dark:text-latte"
        >
          {children}
        </button>
      );
    }
    return <a href={href}>{children}</a>;
  }

  const hasAssistantContent = messages.length > 0 && messages[messages.length - 1].role === "assistant" && messages[messages.length - 1].content;
  // Compact when there are no messages yet, or when the user manually collapsed.
  // Once a conversation exists, the full chat stays visible everywhere on the page.
  const isCompact = (messages.length === 0 || collapsed) && !isFullscreen;

  // Compact pill: just the input + Ask button (+ Expand), shown before any
  // questions or after the user collapses the thread.
  if (isCompact) {
    return (
      <div>
        <form
          className="mx-auto flex max-w-3xl gap-2 rounded-2xl border border-latte/70 bg-parchment/75 p-2 shadow-lg backdrop-blur dark:border-cocoa/50 dark:bg-nightcard/80"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask about ${title}…`}
            aria-label={`Ask about ${title}`}
            className="flex-1 rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-sm text-espresso placeholder:text-cocoa/60 focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment dark:placeholder:text-latte/50"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-lg bg-sage/70 px-4 py-2 text-sm text-espresso transition-colors hover:bg-sage disabled:opacity-50 dark:text-parchment"
          >
            {loading ? "…" : "Ask"}
          </button>
          {collapsed && (
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              aria-label="Expand chat"
              title="Expand the chat thread"
              className="rounded-lg bg-latte/40 px-3 py-2 text-sm text-cocoa hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
            >
              ▴ Expand
            </button>
          )}
        </form>
      </div>
    );
  }

  return (
    <div>
      <div
        ref={cardRef}
        className="chat-card mx-auto flex max-w-3xl flex-col overflow-hidden rounded-2xl border border-latte/70 bg-parchment/75 shadow-lg backdrop-blur dark:border-cocoa/50 dark:bg-nightcard/80"
      >
        {/* Header with a fullscreen toggle for reading long answers. */}
        <div className="flex items-center justify-between border-b border-latte/50 px-4 py-2 dark:border-cocoa/40">
          <span className="font-serif text-sm text-espresso dark:text-parchment">☕ {title}</span>
          <div className="flex items-center gap-1.5">
            {messages.length > 0 && (
              <button
                onClick={() => setCollapsed(true)}
                aria-label="Collapse chat"
                title="Collapse the chat"
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-latte/40 text-sm text-cocoa hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
              >
                ▾
              </button>
            )}
            <button
              onClick={() => setSimpleMode(!simpleMode)}
              aria-label="Toggle simple explanations"
              title="Use plain language and analogies"
              className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm transition-colors ${
                simpleMode
                  ? "bg-sage/70 text-espresso dark:text-parchment"
                  : "bg-latte/40 text-cocoa hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
              }`}
            >
              🌱
            </button>
            <button
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen chat" : "Open chat fullscreen"}
              title={isFullscreen ? "Exit fullscreen" : "Read fullscreen"}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-latte/40 text-sm text-cocoa hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
            >
              {isFullscreen ? "✕" : "⛶"}
            </button>
          </div>
        </div>

        {/* Shorter on mobile so the sticky box doesn't eat the screen. In
            fullscreen the CSS (.chat-card:fullscreen) lets this flex to fill. */}
        <div ref={scrollRef} className="chat-scroll max-h-40 space-y-3 overflow-y-auto px-4 py-3 sm:max-h-56">
          {messages.length === 0 && (
            <p className="text-sm text-cocoa/80 dark:text-latte/70">
              Ask me anything about how {title} plays.
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} className="fade-up flex gap-2">
              <span
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                  m.role === "user"
                    ? "bg-sage/40 text-espresso dark:text-parchment"
                    : "bg-terracotta/30 text-espresso dark:text-parchment"
                }`}
              >
                {m.role === "user" ? "You" : "☕"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="chat-md">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{ a: renderLink }}
                  >
                    {m.role === "assistant" ? linkifyPageRefs(m.content) : m.content}
                  </ReactMarkdown>
                </div>
                {(m.citations ?? []).length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {m.citations!.map((c, j) => (
                      <button
                        key={j}
                        onClick={() => jumpToPage(c.page)}
                        className="rounded-full bg-latte/40 px-2 py-0.5 text-xs text-cocoa hover:bg-terracotta/30 dark:bg-cocoa/30 dark:text-latte dark:hover:bg-terracotta/40"
                      >
                        flip to p. {c.page}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {loading && !hasAssistantContent && (
            <div className="flex items-center gap-2 pl-8 text-sm text-cocoa dark:text-latte">
              <span className="steam" aria-hidden>
                <span />
                <span />
                <span />
              </span>
              {slowBrew ? "Still brewing — the model is thinking…" : "Brewing an answer…"}
            </div>
          )}
          {error && (
            <p className="pl-8 text-sm text-terracotta dark:text-amberglow">{error}</p>
          )}
        </div>

        <form
          className="flex gap-2 border-t border-latte/50 px-4 py-3 dark:border-cocoa/40"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask about ${title}…`}
            aria-label={`Ask about ${title}`}
            className="flex-1 rounded-lg border border-latte/70 bg-parchment/50 px-3 py-2 text-sm text-espresso placeholder:text-cocoa/60 focus:border-terracotta focus:outline-none dark:border-cocoa/50 dark:bg-night dark:text-parchment dark:placeholder:text-latte/50"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-lg bg-sage/70 px-4 py-2 text-sm text-espresso transition-colors hover:bg-sage disabled:opacity-50 dark:text-parchment"
          >
            Ask
          </button>
        </form>
      </div>
    </div>
  );
}
