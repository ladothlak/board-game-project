import { listGames, listHiddenGames } from "@/lib/games";
import GameFinder from "@/components/game-finder";
import HiddenGames from "@/components/hidden-games";
import ShelfSection from "@/components/shelf-section";
import GameNightPlanner from "@/components/game-night-planner";

// The shelf changes at runtime (games get added), so render fresh.
export const dynamic = "force-dynamic";

export default function HomePage() {
  const games = listGames();
  const hidden = listHiddenGames();

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

      <section className="mt-10">
        <GameNightPlanner games={games} />
      </section>

      <HiddenGames games={hidden} />
    </div>
  );
}
