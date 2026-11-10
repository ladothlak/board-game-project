import fs from "fs";
import path from "path";
import { getGame } from "./games";
import { loadIndex, pageMap } from "./retrieve";

// Unsloth runs locally (Unsloth Studio / `unsloth run`) and exposes an
// OpenAI-compatible API, typically on http://localhost:8888.
const BASE_URL = process.env.UNSLOTH_BASE_URL ?? "http://localhost:8888/v1";
const MODEL =
  process.env.UNSLOTH_MODEL ?? "ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF";

export interface Concept {
  name: string;
  /** Page numbers where this concept is defined or explained. */
  pages: number[];
  /** Short description (one sentence). */
  description: string;
}

interface ConceptsFile {
  game: string;
  generatedAt: string;
  concepts: Concept[];
}

/**
 * Ask the LLM to identify the key gameplay concepts in a game's rulebook.
 * Returns a JSON array of { name, pages, description } objects.
 */
export async function generateConcepts(
  slug: string,
  apiKey: string
): Promise<Concept[]> {
  const game = getGame(slug);
  if (!game) throw new Error(`Unknown game: ${slug}`);

  const chunks = loadIndex().filter((c) => c.slug === slug);
  if (chunks.length === 0) throw new Error(`No rulebook index for ${slug}`);

  // Build a per-page map so the LLM knows what each page covers.
  const toc = pageMap(chunks).join("\n");

  // Sample a few pages' text to give the model context about the game's mechanics.
  const samplePages = [
    ...new Set(
      chunks.slice(0, 3).map((c) => c.text.slice(0, 300))
    ),
  ].join("\n\n---\n\n");

  const system = `You are an expert on the board game "${game.title}". 
Identify the 8-15 KEY gameplay concepts that a new player needs to understand. 
These are the major mechanical elements (not flavor text) — things like card types, 
phases, resources, abilities, special rules, etc.

For each concept:
- "name": the concept name as it appears in the rulebook
- "pages": array of page numbers where this concept is defined or explained (1-3 pages max)
- "description": one short sentence explaining what it is

Return ONLY a JSON array. No markdown, no explanation.`;

  const user = `Rulebook page map:\n${toc}\n\nSample text from early pages:\n${samplePages}\n\nList the key gameplay concepts as a JSON array.`;

  // Try up to 3 times (the model is a reasoning model and can be flaky).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.2,
          max_tokens: 4000,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Provider error ${res.status}`);
      const data = await res.json();
      const raw = (data.choices?.[0]?.message?.content ?? "").trim();

      // Extract the JSON array.
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start === -1 || end === -1) continue;

      const arr = JSON.parse(raw.slice(start, end + 1));
      if (!Array.isArray(arr) || arr.length === 0) continue;

      // Validate and normalize.
      const concepts: Concept[] = arr
        .filter(
          (c: any) =>
            typeof c.name === "string" &&
            Array.isArray(c.pages) &&
            c.pages.every((p: any) => Number.isInteger(p) && p > 0)
        )
        .map((c: any) => ({
          name: c.name,
          pages: c.pages.map(Number),
          description: typeof c.description === "string" ? c.description : "",
        }));

      if (concepts.length >= 5) return concepts;
    } catch {
      continue;
    }
  }

  throw new Error("Failed to generate concepts after 3 attempts");
}

/** Read stored concepts from disk. */
export function readConcepts(slug: string): ConceptsFile | null {
  const p = path.join(process.cwd(), "content", "games", slug, "concepts.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Write generated concepts to disk. */
export function writeConcepts(slug: string, concepts: Concept[]) {
  const dir = path.join(process.cwd(), "content", "games", slug);
  fs.mkdirSync(dir, { recursive: true });
  const file: ConceptsFile = {
    game: slug,
    generatedAt: new Date().toISOString(),
    concepts,
  };
  fs.writeFileSync(
    path.join(dir, "concepts.json"),
    JSON.stringify(file, null, 2)
  );
}
