import fs from "fs";
import path from "path";
import { getGame } from "./games";
import { loadIndex, retrieve, pageToc } from "./retrieve";

// Unsloth runs locally (Unsloth Studio / `unsloth run`) and exposes an
// OpenAI-compatible API, typically on http://localhost:8888.
const BASE_URL = process.env.UNSLOTH_BASE_URL ?? "http://localhost:8888/v1";
const MODEL =
  process.env.UNSLOTH_MODEL ?? "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF";

export interface Checklist {
  steps: string[];
  generatedAt: string;
}

function checklistPath(slug: string): string {
  return path.join(process.cwd(), "content", "games", slug, "checklist.json");
}

/** Read a previously generated checklist, or null if none exists. */
export function readChecklist(slug: string): Checklist | null {
  const p = checklistPath(slug);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    if (Array.isArray(data.steps) && data.steps.length > 0) {
      return { steps: data.steps, generatedAt: data.generatedAt ?? "" };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeChecklist(slug: string, checklist: Checklist) {
  const p = checklistPath(slug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(checklist, null, 2));
}

/** Ask the local model for the setup steps; returns the raw content. */
async function callLlm(key: string, title: string, context: string, toc: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      // Reasoning model: budget must cover internal reasoning AND the answer.
      max_tokens: 2000,
      messages: [
        {
          role: "system",
          content:
            "You extract the physical setup steps for a board game from its rulebook. You always answer with a single valid JSON array and nothing else.",
        },
        {
          role: "user",
          content:
            `Using ONLY the rulebook excerpts and page map below, return ONE valid JSON array of 4-10 short imperative steps in the order you would perform them while setting up the game "${title}" (e.g. "Place the Facility board in the center"). Plain strings — no numbering, no commentary, no markdown. Return ONLY the JSON array.`,
        },
        {
          role: "user",
          content: `Rulebook excerpts:\n${context}\n\nWhat's on each page (for orientation):\n${toc}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Provider error ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

/** Parse the LLM's output into a clean array of step strings; null if not an array. */
function parseSteps(raw: string): string[] | null {
  let text = (raw ?? "").trim();
  // Strip markdown code fences if the model added them anyway.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/g, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    const steps = arr.map((s) => String(s).trim()).filter(Boolean);
    return steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}

/**
 * Generate a setup checklist for a game from its rulebook, retrying on empty
 * or malformed responses (reasoning models occasionally burn all tokens on
 * internal reasoning). Returns null when it can't produce usable steps.
 */
export async function generateChecklist(slug: string): Promise<Checklist | null> {
  const key = process.env.UNSLOTH_API_KEY;
  if (!key) return null;
  const game = getGame(slug);
  if (!game) return null;

  const chunks = loadIndex().filter((c) => c.slug === slug);
  if (chunks.length === 0) return null;

  // Setup-relevant excerpts plus a whole-book page map for orientation.
  const top = retrieve(chunks, "how do I set up the game and what goes where to begin playing", 4);
  const context = top.map((c) => `--- Page ${c.page} ---\n${c.text}`).join("\n\n");
  const toc = pageToc(chunks).map((t) => `p. ${t.page}: ${t.label}`).join("\n");

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = await callLlm(key, game.title, context, toc);
      const steps = parseSteps(raw);
      if (steps) return { steps, generatedAt: new Date().toISOString() };
      console.log(`checklist ${slug}: LLM attempt ${attempt} not a usable array, retrying`);
    } catch (e) {
      console.error(`checklist ${slug}: LLM attempt ${attempt} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return null;
}
