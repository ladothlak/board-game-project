import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-parchment/40 px-6 dark:bg-nightcard/60">
      <div className="text-6xl" aria-hidden>☕</div>
      <h1 className="font-serif text-3xl font-bold text-espresso dark:text-parchment">
        This page has left the parlor.
      </h1>
      <p className="max-w-md text-center text-cocoa/70 dark:text-latte/70">
        The shelf we were looking for isn&apos;t here — maybe it was tucked
        away in a different corner, or perhaps it never made it onto the
        menu.
      </p>
      <Link
        href="/"
        className="rounded-full bg-terracotta px-6 py-3 font-medium text-parchment transition hover:bg-terracotta/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta"
      >
        Back to the parlor
      </Link>
    </main>
  );
}
