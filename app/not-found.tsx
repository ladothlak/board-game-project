import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 px-6">
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
        className="rounded-lg bg-sage/70 px-6 py-3 font-medium text-espresso transition-colors hover:bg-sage dark:text-parchment"
      >
        Back to the parlor
      </Link>
    </div>
  );
}
