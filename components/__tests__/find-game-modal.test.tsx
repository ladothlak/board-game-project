// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FindGameModal from "../find-game-modal";

const mockGames = [
  { slug: "nemesis-retaliation", title: "Nemesis: Retaliation", description: "Space survival", tags: ["cooperative", "sci-fi"], players: "1-4", playtimeMinutes: 90, complexity: 4 },
  { slug: "spirit-island", title: "Spirit Island", description: "Defend your island", tags: ["cooperative", "strategy"], players: "1-4", playtimeMinutes: 120, complexity: 5 },
];

function renderModal(props: Partial<Parameters<typeof FindGameModal>[0]> = {}) {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    games: mockGames,
    activeTags: new Set<string>(),
    query: "",
    shownCount: 2,
    onToggleTag: vi.fn(),
    onQuery: vi.fn(),
    onClear: vi.fn(),
    ...props,
  };
  return render(<FindGameModal {...defaultProps} />);
}

describe("FindGameModal", () => {
  it("renders the dialog with a heading", () => {
    renderModal();
    expect(screen.getByRole("dialog", { name: /find a game/i })).toBeInTheDocument();
  });

  it("shows a search input", () => {
    renderModal();
    expect(screen.getByRole("searchbox", { name: /search games/i })).toBeInTheDocument();
  });

  it("displays genre tag chips", () => {
    renderModal();
    expect(screen.getByRole("button", { name: /cooperative/i })).toBeInTheDocument();
  });

  it("shows a Done button to close", () => {
    renderModal();
    expect(screen.getByRole("button", { name: /done/i })).toBeInTheDocument();
  });

  it("calls onClose when Done is clicked", () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows game count", () => {
    renderModal();
    expect(screen.getByText(/2 of 2 games/)).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onQuery when the search input changes", () => {
    const onQuery = vi.fn();
    renderModal({ onQuery });
    const input = screen.getByRole("searchbox", { name: /search games/i });
    fireEvent.change(input, { target: { value: "nemesis" } });
    expect(onQuery).toHaveBeenCalledWith("nemesis");
  });

  it("calls onToggleTag when a chip is clicked", () => {
    const onToggleTag = vi.fn();
    renderModal({ onToggleTag });
    fireEvent.click(screen.getByRole("button", { name: /cooperative/i }));
    expect(onToggleTag).toHaveBeenCalledWith("cooperative");
  });
});
