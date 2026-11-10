"use client";

const FAQS = [
  "How do I set up the game?",
  "What can I do on my turn?",
  "What are the phases of a round?",
  "How do I win?",
];

/**
 * A non-sticky list of starter questions, kept out of the chat box so it
 * doesn't add height to the sticky bar (a problem on small screens). Tapping
 * one pastes the question into the chat input and focuses it.
 */
export default function Faq() {
  function ask(q: string) {
    window.dispatchEvent(new CustomEvent("parlor:prefill", { detail: q }));
  }

  return (
    <section className="mt-10">
      <h2 className="font-serif text-2xl text-espresso dark:text-parchment">
        Frequently asked
      </h2>
      <p className="mt-1 text-sm text-cocoa dark:text-latte">
        Tap one to drop it into the chat below.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {FAQS.map((q) => (
          <button
            key={q}
            onClick={() => ask(q)}
            className="rounded-lg border border-latte/60 bg-parchment/40 px-3 py-1.5 text-left text-sm text-cocoa hover:border-terracotta hover:text-terracotta dark:border-cocoa/40 dark:bg-night dark:text-latte dark:hover:text-amberglow"
          >
            {q}
          </button>
        ))}
      </div>
    </section>
  );
}
