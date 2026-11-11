// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import HealthStrip from "../health-strip";

// Mock the /api/health endpoint
function mockHealth(overrides: Partial<ReturnType<typeof defaultHealth>> = {}) {
  const data = {
    provider: true,
    indexMtime: "2026-11-10T12:00:00Z",
    gameCount: 7,
    ...overrides,
  };
  return Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
}

function defaultHealth() {
  return { provider: true, indexMtime: "2026-11-10T12:00:00Z", gameCount: 7 };
}

describe("HealthStrip", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("/api/health")) return mockHealth();
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );
  });

  it("shows AI status when provider is online", async () => {
    render(<HealthStrip />);
    await waitFor(() =>
      expect(screen.getByText(/parlor AI online/i)).toBeInTheDocument(),
    );
  });

  it("shows AI offline status when provider is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ provider: false, indexMtime: null, gameCount: 3 }), { status: 200 }),
      ),
    );
    render(<HealthStrip />);
    await waitFor(() =>
      expect(screen.getByText(/parlor AI offline/i)).toBeInTheDocument(),
    );
  });

  it("displays the game count with coffee emoji", async () => {
    render(<HealthStrip />);
    await waitFor(() =>
      expect(screen.getByText(/7 games on the shelf/)).toBeInTheDocument(),
    );
  });

  it("shows singular 'game' for count of 1", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ provider: true, indexMtime: "2026-01-01T00:00:00Z", gameCount: 1 }), { status: 200 }),
      ),
    );
    render(<HealthStrip />);
    await waitFor(() =>
      expect(screen.getByText(/1 game on the shelf/)).toBeInTheDocument(),
    );
  });

  it("shows index date in the footer line", async () => {
    render(<HealthStrip />);
    await waitFor(() =>
      expect(screen.getByText(/indexed/i)).toBeInTheDocument(),
    );
  });

  it("renders nothing until data loads", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
    );
    const { container } = render(<HealthStrip />);
    expect(container.innerHTML).toBe("");
  });
});
