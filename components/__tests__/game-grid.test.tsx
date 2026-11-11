// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import GameGrid from "../game-grid";
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
  {
    slug: "spirit-island",
    title: "Spirit Island",
    description: "Defend your island from invaders.",
    players: "1-4",
    playtimeMinutes: 120,
    tags: ["cooperative", "strategy"],
    complexity: 5,
  },
];

describe("GameGrid", () => {
  it("renders game cards with titles", () => {
    render(<GameGrid games={mockGames} />);
    expect(screen.getByText("Nemesis: Retaliation")).toBeInTheDocument();
    expect(screen.getByText("Spirit Island")).toBeInTheDocument();
  });

  it("shows descriptions on cards", () => {
    render(<GameGrid games={mockGames} />);
    expect(
      screen.getByText("A cooperative survival game set in space."),
    ).toBeInTheDocument();
  });

  it("displays complexity rating", () => {
    render(<GameGrid games={mockGames} />);
    // Complexity is shown as a title attribute on the span
    const el = screen.getByTitle(/Complexity 4\/5/);
    expect(el).toBeInTheDocument();
  });

  it("renders an empty state when no games are passed", () => {
    render(<GameGrid games={[]} />);
    expect(
      screen.getByText(/The shelf is empty so far/i),
    ).toBeInTheDocument();
  });

  it("shows a placeholder when description is missing", () => {
    const noDesc: GameMeta[] = [
      { slug: "x", title: "X", description: "", players: "1", playtimeMinutes: 30, tags: [], complexity: 1 },
    ];
    render(<GameGrid games={noDesc} />);
    expect(screen.getByText(/still brewing/i)).toBeInTheDocument();
  });

  it("links each card to its game page", () => {
    render(<GameGrid games={mockGames} />);
    const link = screen.getByRole("link", { name: /nemesis/i });
    expect(link).toHaveAttribute("href", "/games/nemesis-retaliation");
  });

  it("shows tags on cards", () => {
    render(<GameGrid games={mockGames} />);
    expect(screen.getAllByText("cooperative").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("sci-fi")).toBeInTheDocument();
  });

  it("renders a sort dropdown", () => {
    render(<GameGrid games={mockGames} />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});
