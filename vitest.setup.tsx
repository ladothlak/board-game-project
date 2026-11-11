import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

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
