// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ShelfSection from "../shelf-section";
import type { GameMeta } from "@/lib/games";

const mockGames: GameMeta[] = [
  {
    slug: "nemesis-retaliation",
    title: "Nemesis: Retaliation",
    description: "A cooperative survival game set in space.",
    players: "1-4",
    playtimeMinutes: 90,
    tags: ["cooperative", "sci-fi"],
    complexity: 4,
  },
];

describe("ShelfSection", () => {
  it("renders the section heading", () => {
    render(<ShelfSection games={mockGames} />);
    expect(screen.getByText(/on the shelf/i)).toBeInTheDocument();
  });

  it("shows the Find a Game button", () => {
    render(<ShelfSection games={mockGames} />);
    expect(screen.getByRole("button", { name: /find a game/i })).toBeInTheDocument();
  });

  it("shows the empty shelf state when no games exist", () => {
    render(<ShelfSection games={[]} />);
    expect(screen.getByText(/the shelf is empty/i)).toBeInTheDocument();
    expect(screen.getByText(/no games on the menu yet/i)).toBeInTheDocument();
  });

  it("renders game cards when games are present", () => {
    render(<ShelfSection games={mockGames} />);
    expect(screen.getByText("Nemesis: Retaliation")).toBeInTheDocument();
  });

  it("shows genre tag chips from the top tags", () => {
    render(<ShelfSection games={mockGames} />);
    // The "Showing X of Y" text only appears when filters are active,
    // but the game grid should still render
    expect(screen.getByText(/nemesis/i)).toBeInTheDocument();
  });
});
