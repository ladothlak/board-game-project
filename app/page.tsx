import { unstable_cache } from "next/cache";
import { listGames, listHiddenGames } from "@/lib/games";
import GameFinder from "@/components/game-finder";
import HiddenGames from "@/components/hidden-games";
import ShelfSection from "@/components/shelf-section";
import GameNightPlanner from "@/components/game-night-planner";

// The shelf changes at runtime (games get added), so the reads are tagged:
// write routes call revalidateTag("games") via invalidateGamesCache(), and
// pages serve from Next's data cache until then.
// (unstable_cache's generic collapses the return type to Promise<any>, so
// cast back to the original signatures.)
const cachedListGames = unstable_cache(listGames, undefined, { tags: ["games"] }) as typeof listGames;
const cachedListHiddenGames = unstable_cache(listHiddenGames, undefined, { tags: ["games"] }) as typeof listHiddenGames;

export default async function HomePage() {
  const games = await cachedListGames();
  const hidden = await cachedListHiddenGames();

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <section className="fade-up text-center">
        <h1 className="font-serif text-4xl tracking-wide text-espresso dark:text-parchment sm:text-5xl">
          Board Game Parlor
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-cocoa dark:text-latte">
          A quiet shelf of games, ready when you are. Every rulebook lives here —
          searchable, browsable, and always a cup&apos;s distance from an answer.
        </p>
      </section>

      <section className="mt-8">
        <GameFinder />
      </section>

      <ShelfSection games={games} />

      {games.length > 0 && (
        <section className="mt-10">
          <GameNightPlanner games={games} />
        </section>
      )}

      <HiddenGames games={hidden} />
    </div>
  );
}
