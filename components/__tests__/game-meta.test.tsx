// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import GameMeta from "../game-meta";

describe("GameMeta", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders initial metadata pills from props", () => {
    render(
      <GameMeta
        slug="test-game"
        players="2-5"
        playtimeMinutes={45}
        ageRating="8+"
        tags={["strategy"]}
      />
    );
    expect(screen.getByText("2-5 players")).toBeInTheDocument();
    expect(screen.getByText("~45 min")).toBeInTheDocument();
    expect(screen.getByText("8+")).toBeInTheDocument();
    expect(screen.getByText("strategy")).toBeInTheDocument();
  });

  it("updates pills in place when rulebook-updated fires for its slug", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        slug: "test-game",
        title: "Test Game",
        description: "A fresh description.",
        players: "3-6",
        playtimeMinutes: 60,
        ageRating: "10+",
        tags: ["engine-building"],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <GameMeta
        slug="test-game"
        players="2-5"
        playtimeMinutes={45}
        ageRating="8+"
        tags={["strategy"]}
      />
    );

    window.dispatchEvent(
      new CustomEvent("rulebook-updated", { detail: { slug: "test-game" } })
    );

    // The pills must refresh from the API without a page reload.
    await waitFor(() => {
      expect(screen.getByText("3-6 players")).toBeInTheDocument();
    });
    expect(screen.getByText("~60 min")).toBeInTheDocument();
    expect(screen.getByText("10+")).toBeInTheDocument();
    expect(screen.getByText("engine-building")).toBeInTheDocument();
  });

  it("ignores rulebook-updated events for other slugs", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ players: "9-9" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(<GameMeta slug="test-game" players="2-5" />);

    window.dispatchEvent(
      new CustomEvent("rulebook-updated", { detail: { slug: "other-game" } })
    );

    // Give any (incorrect) fetch a chance to run, then assert nothing changed.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByText("2-5 players")).toBeInTheDocument();
  });
});
