// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SearchBar from "../search-bar";

const mockIndex = {
  entries: [
    { id: "nemesis-p1", slug: "nemesis-retaliation", title: "Nemesis: Retaliation", page: 1, text: "The outbreak reaches critical mass when the voidseeders emerge." },
    { id: "spirit-p1", slug: "spirit-island", title: "Spirit Island", page: 1, text: "Defend your island from the invaders with the power of the spirits." },
  ],
};

const mockVisible = { slugs: ["nemesis-retaliation", "spirit-island"] };

describe("SearchBar", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        if (u.includes("/search-index.json")) {
          return Promise.resolve(new Response(JSON.stringify(mockIndex), { status: 200 }));
        }
        if (u.includes("/api/games/visible")) {
          return Promise.resolve(new Response(JSON.stringify(mockVisible), { status: 200 }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );
  });

  it("renders a search input", () => {
    render(<SearchBar />);
    expect(screen.getByRole("searchbox", { name: /search rulebooks/i })).toBeInTheDocument();
  });

  it("shows results when typing a matching query", async () => {
    render(<SearchBar />);
    const input = screen.getByRole("searchbox", { name: /search rulebooks/i });
    await userEvent.type(input, "outbreak");

    await waitFor(() => {
      expect(screen.getByText(/Nemesis: Retaliation/)).toBeInTheDocument();
    });
  });

  it("shows page numbers in results", async () => {
    render(<SearchBar />);
    const input = screen.getByRole("searchbox", { name: /search rulebooks/i });
    await userEvent.type(input, "outbreak");

    await waitFor(() => {
      expect(screen.getByText(/p\. 1/)).toBeInTheDocument();
    });
  });

  it("does not show results for queries under 3 chars", async () => {
    render(<SearchBar />);
    const input = screen.getByRole("searchbox", { name: /search rulebooks/i });
    await userEvent.type(input, "ou");
    // No results should appear
    expect(screen.queryByText(/Nemesis/)).toBeNull();
  });

  it("links results to the game page with page param", async () => {
    render(<SearchBar />);
    const input = screen.getByRole("searchbox", { name: /search rulebooks/i });
    await userEvent.type(input, "outbreak");

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /nemesis/i });
      expect(link).toHaveAttribute("href", "/games/nemesis-retaliation?page=1");
    });
  });
});
