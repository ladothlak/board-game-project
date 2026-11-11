// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import NotFound from "../not-found";

describe("404 Page", () => {
  it("renders the themed heading", () => {
    render(<NotFound />);
    expect(screen.getByText("This page has left the parlor.")).toBeInTheDocument();
  });

  it("shows a helpful description", () => {
    render(<NotFound />);
    expect(
      screen.getByText(/The shelf we were looking for isn't here/),
    ).toBeInTheDocument();
  });

  it("has a link back to the parlor (home)", () => {
    render(<NotFound />);
    const link = screen.getByRole("link", { name: /back to the parlor/i });
    expect(link).toHaveAttribute("href", "/");
  });

  it("displays a coffee emoji as decoration", () => {
    const { container } = render(<NotFound />);
    expect(container.querySelector("[aria-hidden]")).toHaveTextContent("☕");
  });
});
