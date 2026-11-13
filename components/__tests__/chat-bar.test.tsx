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

  it("shows stage progress before the first token, then clears it as content streams", async () => {
    // Gate the stream so each stage line is observable: "retrieving" arrives,
    // the test asserts it, then "pages-found" arrives, then the first token.
    let releasePages!: () => void;
    let releaseToken!: () => void;
    const pagesGate = new Promise<void>((r) => (releasePages = r));
    const tokenGate = new Promise<void>((r) => (releaseToken = r));
    const enc = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode('data: {"type":"stage","stage":"retrieving"}\n\n'));
        await pagesGate;
        controller.enqueue(enc.encode('data: {"type":"stage","stage":"pages-found","pages":[3,7]}\n\n'));
        await tokenGate;
        controller.enqueue(enc.encode('data: {"type":"token","content":"Set up the board"}\n\n'));
        controller.enqueue(enc.encode('data: {"type":"done","citations":[]}\n\n'));
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

    // The "retrieving" stage shows before any token arrives.
    await waitFor(() => expect(screen.getByText(/finding pages/i)).toBeInTheDocument());
    releasePages();
    // Then "pages-found" lists the pages from the event.
    await waitFor(() => expect(screen.getByText(/found pp\. 3, 7/i)).toBeInTheDocument());
    releaseToken();
    // Once content streams, the stage line disappears and the answer renders.
    await waitFor(() => expect(screen.getByText(/set up the board/i)).toBeInTheDocument());
    expect(screen.queryByText(/brewing/i)).not.toBeInTheDocument();
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
