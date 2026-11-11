// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChatBar from "../chat-bar";

const slug = "nemesis-retaliation";
const title = "Nemesis: Retaliation";

describe("ChatBar", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    // jsdom doesn't implement scrollTo on arbitrary elements.
    window.HTMLElement.prototype.scrollTo = vi.fn();
  });

  it("renders the chat input with a placeholder", () => {
    render(<ChatBar slug={slug} title={title} />);
    const input = screen.getByRole("textbox", { name: /ask about/i });
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("placeholder", `Ask about ${title}…`);
  });

  it("disables the Ask button when input is empty", () => {
    render(<ChatBar slug={slug} title={title} />);
    const button = screen.getByRole("button", { name: "Ask" });
    expect(button).toBeDisabled();
  });

  it("enables the Ask button when input has content", async () => {
    render(<ChatBar slug={slug} title={title} />);
    const input = screen.getByRole("textbox", { name: /ask about/i });
    await userEvent.type(input, "How do I set up the game?");
    const button = screen.getByRole("button", { name: "Ask" });
    expect(button).not.toBeDisabled();
  });

  it("renders assistant response after streaming completes", async () => {
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"Set up the board"}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      ),
    );

    render(<ChatBar slug={slug} title={title} />);
    const input = screen.getByRole("textbox", { name: /ask about/i });
    await userEvent.type(input, "How do I set up?");
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    // After the stream completes, the response text should be visible.
    // ReactMarkdown may split text across elements, so match a fragment.
    await waitFor(() => {
      expect(screen.getByText(/set up/i)).toBeInTheDocument();
    });
  });

  it("shows user message in the chat history", async () => {
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"ok"}\n\n'));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(sseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      ),
    );

    render(<ChatBar slug={slug} title={title} />);
    const input = screen.getByRole("textbox", { name: /ask about/i });
    await userEvent.type(input, "What is the setup?");
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => {
      expect(screen.getByText("What is the setup?")).toBeInTheDocument();
    });
  });
});
