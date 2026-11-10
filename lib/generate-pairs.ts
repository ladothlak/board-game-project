import { listGames } from "./games";
import { withQueue } from "./llm-queue";

interface PairResult {
  slug: string;
  reason: string;
}

/**
 * Asks the LLM to suggest 1–2 games that complement the given game
 * for a longer session. Returns an array of { slug, reason } objects.
 */
export async function generatePairs(
  slug: string,
  apiKey: string
): Promise<PairResult[]> {
  const games = await listGames();
  const current = games.find((g) => g.slug === slug);
  if (!current) return [];

  // Build a compact list of other games for the LLM to choose from.
  const others = games
    .filter((g) => g.slug !== slug)
    .map(
      (g) =>
        `- ${g.title} (${g.players ?? "?"} players, ~${g.playtimeMinutes ?? "?"} min, tags: ${(g.tags ?? []).join(", ") || "none"}): ${g.description.slice(0, 120)}`
    )
    .join("\n");

  const prompt = `Suggest 1-2 games from this list that pair well with "${current.title}" for a game night. Consider complementing tone, variety in mechanics, and time balance.

Our games:
${others}

Respond with ONLY a JSON array: [{"slug":"<exact-slug>","reason":"<one short sentence>"}]. If no good pairing, return []. No other text.`;

  const result = await withQueue(async () => {
    // Retry up to 3 times (reasoning model can return empty/truncated content).
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(
        `${process.env.UNSLOTH_BASE_URL}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: process.env.UNSLOTH_MODEL,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.4,
            max_tokens: 2000,
          }),
          signal: AbortSignal.timeout(45_000),
        }
      );
      if (!res.ok) throw new Error(`LLM responded ${res.status}`);
      const data = await res.json();
      const text: string = data.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) continue; // Empty — retry.

      // Extract JSON array from the response.
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) continue; // No JSON found — retry.
      try {
        const arr = JSON.parse(match[0]);
        if (!Array.isArray(arr)) continue;
        const validSlugs = new Set(games.map((g) => g.slug));
        return arr
          .filter((p: any) => p?.slug && validSlugs.has(p.slug) && p.reason)
          .slice(0, 2)
          .map((p: any) => ({ slug: p.slug, reason: String(p.reason) }));
      } catch {
        continue; // Malformed JSON — retry.
      }
    }
    return [] as PairResult[];
  });

  return result;
}
