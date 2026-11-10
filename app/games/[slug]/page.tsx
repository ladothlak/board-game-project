import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getGame, listGames } from "@/lib/games";
import Faq from "@/components/faq";
import CoverTint from "@/components/cover-tint";
import DescriptionBlock from "@/components/description-block";
import GameMeta from "@/components/game-meta";
import PdfViewer from "@/components/pdf-viewer";
import ChatBar from "@/components/chat-bar";
import Rating from "@/components/rating";
import EditRulebook from "@/components/edit-rulebook";
import BelowFold from "@/components/below-fold";
import Expansions from "@/components/expansions";

export const dynamic = "force-dynamic";

export default async function GamePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const game = getGame(slug);
  if (!game) notFound();

  // Assets are served on demand from content/games/<slug>/ (not via the
  // static public/ dir, which snapshots at build time and won't serve
  // files added at runtime without a restart).
  const fileUrl = (name: string) =>
    `/api/games/${slug}/file?name=${encodeURIComponent(name)}`;
  const pdfSrc = game.pdf ? fileUrl(game.pdf) : null;
  const coverSrc = game.image ? fileUrl(game.image) : undefined;

  return (
    <CoverTint coverSrc={coverSrc}>
      <div className="mx-auto max-w-4xl px-4 py-10">
      <Link href="/" className="text-sm text-cocoa hover:text-terracotta dark:text-latte dark:hover:text-amberglow">
        ← Back to the shelf
      </Link>

      {/* 1) Picture of the game */}
      <section className="fade-up relative mt-6 h-96 overflow-hidden rounded-2xl border border-latte/60 bg-parchment/40 shadow-md dark:border-cocoa/40 dark:bg-nightcard/60">
        {game.image ? (
          <Image
            src={coverSrc!}
            alt={`${game.title} box`}
            fill
            priority
            sizes="100%"
            className="object-cover"
          />
        ) : (
          <div className="flex h-48 items-center justify-center bg-latte/30 text-cocoa dark:bg-cocoa/20 dark:text-latte">
            No cover photo yet — drop one into content/games/{slug}/
          </div>
        )}
      </section>

      {/* 2) Description */}
      <section className="mt-8">
        <h1 className="font-serif text-4xl tracking-wide text-espresso dark:text-parchment">
          {game.title}
        </h1>
        <GameMeta
          slug={slug}
          players={game.players}
          playtimeMinutes={game.playtimeMinutes}
          ageRating={game.ageRating}
          tags={game.tags}
          suggestions={game.suggestions}
        />
        <DescriptionBlock slug={slug} initialDescription={game.description} />
        <div className="mt-4">
          <Rating slug={slug} />
        </div>
      </section>

      {/* Frequently asked — pastes a starter question into the chat below. */}
      <Faq />

      {/* Chat — inline, just above the rulebook. */}
      <section className="mt-10">
        <ChatBar slug={slug} title={game.title} />
      </section>

      {/* 3) Rules viewer */}
      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-2xl text-espresso dark:text-parchment">The rulebook</h2>
          <EditRulebook slug={slug} />
        </div>
        {pdfSrc ? (
          <PdfViewer
            src={pdfSrc}
            slug={slug}
            expansionSrcs={(game.expansions ?? [])
              .filter((e) => e.inChatContext)
              .map((e) => fileUrl(e.pdf))}
          />
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-latte bg-parchment/40 p-6 text-center text-cocoa dark:border-cocoa/50 dark:bg-nightcard dark:text-latte">
            No rulebook PDF yet — drop one into content/games/{slug}/ and run{" "}
            <code className="rounded bg-latte/40 px-1 py-0.5 text-xs dark:bg-cocoa/30">npm run build:search</code>.
          </div>
        )}
      </section>

      {/* Expansions */}
      <Expansions slug={slug} expansions={game.expansions ?? []} />

      {/* Below-fold sections (lazy-loaded client component). */}
      <BelowFold slug={slug} title={game.title} game={game} games={listGames()} />
      </div>
    </CoverTint>
  );
}
