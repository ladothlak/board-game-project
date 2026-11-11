// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AddRulebook from "../add-rulebook";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Mock the useDialog hook
vi.mock("@/hooks/use-dialog", () => ({
  useDialog: (_open: boolean, _onClose: () => void) => ({ panelRef: null }),
}));

/** The trigger button has a 📖 emoji prefix, making it unique. */
const triggerBtn = () => screen.getByRole("button", { name: /📖/i });
/** The submit button lives inside the dialog. */
const submitBtn = () =>
  within(screen.getByRole("dialog")).getByRole("button", { name: /upload/i });

describe("AddRulebook", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the trigger button with correct label", () => {
    render(<AddRulebook slug="test-game" title="Test Game" />);
    expect(triggerBtn()).toBeInTheDocument();
  });

  it("does not render the modal when closed", () => {
    render(<AddRulebook slug="test-game" title="Test Game" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the modal when the button is clicked", async () => {
    const user = userEvent.setup();
    render(<AddRulebook slug="test-game" title="Test Game" />);
    await user.click(triggerBtn());
    expect(screen.getByRole("dialog", { name: /add a rulebook for test game/i })).toBeInTheDocument();
  });

  it("shows the source method dropdown with three options", async () => {
    const user = userEvent.setup();
    render(<AddRulebook slug="test-game" title="Test Game" />);
    await user.click(triggerBtn());

    const select = screen.getByRole("combobox", { name: /rulebook source/i });
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /manual/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /link/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /intellisearch/i })).toBeInTheDocument();
  });

  it("shows the manual drag-drop zone when manual is selected", async () => {
    const user = userEvent.setup();
    render(<AddRulebook slug="test-game" title="Test Game" />);
    await user.click(triggerBtn());

    const select = screen.getByRole("combobox", { name: /rulebook source/i });
    await user.selectOptions(select, "manual");

    expect(screen.getByText(/drag & drop your pdf here/i)).toBeInTheDocument();
  });

  it("shows the URL input when link method is selected", async () => {
    const user = userEvent.setup();
    render(<AddRulebook slug="test-game" title="Test Game" />);
    await user.click(triggerBtn());

    const select = screen.getByRole("combobox", { name: /rulebook source/i });
    await user.selectOptions(select, "link");

    expect(screen.getByRole("textbox", { name: /rulebook pdf url/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /fetch/i })).toBeInTheDocument();
  });

  it("shows the intellisearch button when intellisearch method is selected", async () => {
    const user = userEvent.setup();
    render(<AddRulebook slug="test-game" title="Test Game" />);
    await user.click(triggerBtn());

    const select = screen.getByRole("combobox", { name: /rulebook source/i });
    await user.selectOptions(select, "intellisearch");

    expect(screen.getByRole("button", { name: /find the rulebook/i })).toBeInTheDocument();
  });

  it("shows a Cancel button when not in done state", async () => {
    const user = userEvent.setup();
    render(<AddRulebook slug="test-game" title="Test Game" />);
    await user.click(triggerBtn());

    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("shows a submit button (disabled without PDF)", async () => {
    const user = userEvent.setup();
    render(<AddRulebook slug="test-game" title="Test Game" />);
    await user.click(triggerBtn());

    const btn = submitBtn();
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it("closes the modal when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(<AddRulebook slug="test-game" title="Test Game" />);
    await user.click(triggerBtn());

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows an error message when upload fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "Server exploded" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const user = userEvent.setup();
    render(<AddRulebook slug="test-game" title="Test Game" />);
    await user.click(triggerBtn());

    // Select manual and wait for the file input to appear (in portal)
    const select = screen.getByRole("combobox", { name: /rulebook source/i });
    await user.selectOptions(select, "manual");
    const fileInput = (await waitFor(() => {
      const el = document.querySelector('input[type="file"]');
      if (!el) throw new Error("file input not in DOM yet");
      return el;
    })) as HTMLInputElement;

    const file = new File(["%PDF-1.4 fake"], "test.pdf", { type: "application/pdf" });
    await user.upload(fileInput, file);

    // Click the submit button to trigger upload
    await user.click(submitBtn());

    await waitFor(() => {
      expect(screen.getByText(/server exploded/i)).toBeInTheDocument();
    });
  });

  it("shows Alright button after successful upload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "digesting" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const user = userEvent.setup();
    render(<AddRulebook slug="test-game" title="Test Game" />);
    await user.click(triggerBtn());

    // Select manual and wait for the file input to appear (in portal)
    const select = screen.getByRole("combobox", { name: /rulebook source/i });
    await user.selectOptions(select, "manual");
    const fileInput = (await waitFor(() => {
      const el = document.querySelector('input[type="file"]');
      if (!el) throw new Error("file input not in DOM yet");
      return el;
    })) as HTMLInputElement;

    const file = new File(["%PDF-1.4 fake"], "test.pdf", { type: "application/pdf" });
    await user.upload(fileInput, file);

    // Click the Upload button to trigger upload
    await user.click(submitBtn());

    // After successful upload, the Alright button appears.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /alright/i })).toBeInTheDocument();
    });
  });

  it("dispatches rulebook-replaced event on successful upload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "digesting" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const handler = vi.fn();
    window.addEventListener("rulebook-replaced", handler);

    const user = userEvent.setup();
    render(<AddRulebook slug="test-game" title="Test Game" />);
    await user.click(triggerBtn());

    const select = screen.getByRole("combobox", { name: /rulebook source/i });
    await user.selectOptions(select, "manual");
    const fileInput = (await waitFor(() => {
      const el = document.querySelector('input[type="file"]');
      if (!el) throw new Error("file input not in DOM yet");
      return el;
    })) as HTMLInputElement;

    const file = new File(["%PDF-1.4 fake"], "test.pdf", { type: "application/pdf" });
    await user.upload(fileInput, file);
    await user.click(submitBtn());

    // After upload, the event should have been dispatched.
    await waitFor(() => {
      expect(handler).toHaveBeenCalledWith(expect.any(Event));
    });

    window.removeEventListener("rulebook-replaced", handler);
  });

  it("closes the modal when Alright is clicked", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "digesting" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const user = userEvent.setup();
    render(<AddRulebook slug="test-game" title="Test Game" />);
    await user.click(triggerBtn());

    const select = screen.getByRole("combobox", { name: /rulebook source/i });
    await user.selectOptions(select, "manual");
    const fileInput = (await waitFor(() => {
      const el = document.querySelector('input[type="file"]');
      if (!el) throw new Error("file input not in DOM yet");
      return el;
    })) as HTMLInputElement;

    const file = new File(["%PDF-1.4 fake"], "test.pdf", { type: "application/pdf" });
    await user.upload(fileInput, file);

    await user.click(submitBtn());

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /alright/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /alright/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
