import "@testing-library/jest-dom/vitest";
import { loadEnv } from "vite";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Load `.env` for every test (Vitest does not auto-load `.env` the way
// Next.js does at runtime). Populates process.env only for keys that are
// not already set, so a real environment always wins. This makes the
// hardcoded base-URL fallback in lib/rag.ts / lib/decision-model.ts a true
// last resort: live test paths resolve UNSLOTH_BASE_URL from `.env`.
// RUN_* is deliberately excluded: live-gating flags must only come from an
// explicit environment variable, never from a dotenv file — a stray
// `RUN_LIVE_BENCH=1` in `.env` would silently flip benchmark/diag tests
// into live mode.
const fileEnv = loadEnv("development", process.cwd(), [
  "UNSLOTH_",
  "DECISION_",
  "BRAVE_",
]);
for (const [k, v] of Object.entries(fileEnv)) {
  if (!(k in process.env)) process.env[k] = v;
}

// Auto-cleanup between tests to prevent DOM accumulation.
afterEach(() => {
  cleanup();
});

// Mock next/navigation (useRouter, usePathname, useRouter)
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    pathname: "/",
    query: {},
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock next/link as a simple <a> element
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// Mock next/image as a simple <img> element
vi.mock("next/image", () => ({
  default: (props: { src?: string; alt?: string; [key: string]: unknown }) => (
    <img src={props.src} alt={props.alt ?? ""} />
  ),
}));
