import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  decodeHtmlEntities,
  resolveFileShareUrl,
  isUrlForBaseGame,
  detectLanguage,
  isLanguageCompatible,
  isValidPdf,
  fetchTextWithLimit,
  MAX_HTML_SIZE,
  HtmlTooLargeError,
} from "../fetch-rulebook-utils";

// ─── Shared fetch mock helpers ────────────────────────────────────────────────

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

function bytesResponse(bytes: number[], init?: ResponseInit): Response {
  return new Response(new Uint8Array(bytes), init);
}

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── isUrlForBaseGame ───────────────────────────────────────────────────────────

describe("isUrlForBaseGame", () => {
  describe("accepted (base game)", () => {
    it("exact folder match with generic filename", () => {
      expect(isUrlForBaseGame("https://x.com/Nemesis/ENG/rulebook.pdf", "Nemesis")).toBe(true);
    });

    it("URL-encoded filename with rulebook descriptor", () => {
      // %20 decodes to a space: "scythe rules.pdf"
      expect(isUrlForBaseGame("https://boardgame.bg/scythe%20rules.pdf", "Scythe")).toBe(true);
    });

    it("short name variant (≤ 3 chars suffix)", () => {
      // "cluedo" is the regional name for "Clue"
      expect(isUrlForBaseGame("https://www.hasbro.com/common/instruct/cluedo.pdf", "Clue")).toBe(true);
    });

    it("game name in the middle of the filename + rulebook descriptor", () => {
      // CN3082 CATAN – 5-6 Rulebook 2025 reduced.pdf
      const url =
        "https://www.catan.com/sites/default/files/2025-03/CN3082%20CATAN%20%E2%80%93%205-6%20Rulebook%202025%20reduced.pdf";
      expect(isUrlForBaseGame(url, "Catan")).toBe(true);
    });

    it("filename with underscore descriptor", () => {
      expect(isUrlForBaseGame("https://x.com/scythe_rules.pdf", "Scythe")).toBe(true);
    });

    it("filename with manual descriptor", () => {
      expect(isUrlForBaseGame("https://x.com/nemesis_manual.pdf", "Nemesis")).toBe(true);
    });
  });

  describe("rejected (expansion)", () => {
    it("expansion folder with descriptor name", () => {
      expect(isUrlForBaseGame("https://x.com/NEMESIS_GUIDE/ENG/rulebook.pdf", "Nemesis")).toBe(false);
    });

    it("expansion folder (game name + extra words)", () => {
      expect(isUrlForBaseGame("https://x.com/Nemesis_Lockdown/ENG/rulebook.pdf", "Nemesis")).toBe(false);
    });

    it("expansion filename under a base-game folder", () => {
      expect(
        isUrlForBaseGame("https://x.com/Nemesis/IT/NEMESIS_VOIDSEEDERS_RULEBOOK.pdf", "Nemesis")
      ).toBe(false);
    });

    it("expansion folder with descriptor name (Risk)", () => {
      expect(isUrlForBaseGame("https://x.com/RISK_RULES/ENG/rulebook.pdf", "Risk")).toBe(false);
    });

    it("expansion filename with extra words before the descriptor", () => {
      // "rulebook" is a descriptor, but "voidseeders" comes first → expansion.
      expect(isUrlForBaseGame("https://x.com/nemesis_voidseeders_rulebook.pdf", "Nemesis")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("filename that is exactly the game name", () => {
      expect(isUrlForBaseGame("https://x.com/nemesis.pdf", "Nemesis")).toBe(true);
    });

    it("is case-insensitive (uppercase folder + filename)", () => {
      expect(isUrlForBaseGame("https://x.com/NEMESIS/ENG/RULEBOOK.PDF", "Nemesis")).toBe(true);
    });

    it("multi-word game names normalize spaces to underscores", () => {
      expect(isUrlForBaseGame("https://x.com/Clue_Junior/ENG/rules.pdf", "Clue Junior")).toBe(true);
    });

    it("rejects URLs whose filename has no game name at all", () => {
      // "rulebook.pdf" under a sibling folder is not this game's rulebook.
      expect(isUrlForBaseGame("https://x.com/some-other-game/rulebook.pdf", "Nemesis")).toBe(false);
    });

    it("allows unparseable URLs (can't determine → allow)", () => {
      expect(isUrlForBaseGame("not a url at all", "Nemesis")).toBe(true);
    });

    it("handles URL-encoded special characters in the path", () => {
      // %E2%80%93 is an en dash; decoding must not crash matching.
      // When the game name STARTS the filename, only a short variant (≤ 3 chars)
      // or a pure descriptor suffix is accepted — "–5-6 rulebook" has extra words
      // before the descriptor, so it reads as an expansion ("Catan 5-6").
      const url = "https://x.com/CATAN%E2%80%935-6%20Rulebook.pdf";
      expect(isUrlForBaseGame(url, "Catan")).toBe(false);
    });

    it("accepts URL-encoded special characters when the name is mid-filename", () => {
      // Same en dash, but the name is in the MIDDLE of the filename and a
      // descriptor word is present → base game (mirrors the catan.com case).
      const url = "https://x.com/5th%20Edition%E2%80%93CATAN%20Rulebook.pdf";
      expect(isUrlForBaseGame(url, "Catan")).toBe(true);
    });
  });
});

// ─── isValidPdf (mocked fetch) ──────────────────────────────────────────────────

describe("isValidPdf", () => {
  it("accepts content starting with the %PDF magic bytes", async () => {
    mockFetch.mockResolvedValue(bytesResponse([...PDF_MAGIC, 0x2d, 0x31]));
    await expect(isValidPdf("https://x.com/a.pdf")).resolves.toBe(true);
  });

  it("rejects HTML content", async () => {
    // "<!DO" — typical start of an HTML document.
    mockFetch.mockResolvedValue(bytesResponse([0x3c, 0x21, 0x44, 0x4f]));
    await expect(isValidPdf("https://x.com/a.pdf")).resolves.toBe(false);
  });

  it("rejects ZIP content (PK..)", async () => {
    mockFetch.mockResolvedValue(bytesResponse([0x50, 0x4b, 0x03, 0x04]));
    await expect(isValidPdf("https://x.com/a.pdf")).resolves.toBe(false);
  });

  it("rejects bodies shorter than 4 bytes", async () => {
    mockFetch.mockResolvedValue(bytesResponse([0x25, 0x50, 0x44]));
    await expect(isValidPdf("https://x.com/a.pdf")).resolves.toBe(false);
  });

  it("rejects non-OK HTTP status", async () => {
    mockFetch.mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(isValidPdf("https://x.com/a.pdf")).resolves.toBe(false);
  });

  it("returns false when the network request fails", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(isValidPdf("https://x.com/a.pdf")).resolves.toBe(false);
  });

  it("resolves Dropbox share URLs to dl=1 before fetching", async () => {
    mockFetch.mockResolvedValue(bytesResponse(PDF_MAGIC));
    await isValidPdf("https://www.dropbox.com/scl/fo/abc/def?dl=0");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = String(mockFetch.mock.calls[0][0]);
    expect(calledUrl).toBe("https://www.dropbox.com/scl/fo/abc/def?dl=1");
  });

  it("resolves Google Drive file URLs to the direct download endpoint", async () => {
    mockFetch.mockResolvedValue(bytesResponse(PDF_MAGIC));
    await isValidPdf("https://drive.google.com/file/d/FILEID/view");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = String(mockFetch.mock.calls[0][0]);
    expect(calledUrl).toBe("https://drive.google.com/uc?export=download&id=FILEID");
  });
});

// ─── decodeHtmlEntities ─────────────────────────────────────────────────────────

describe("decodeHtmlEntities", () => {
  it.each([
    ["&amp;", "&"],
    ["&lt;", "<"],
    ["&gt;", ">"],
    ["&quot;", '"'],
    ["&#39;", "'"],
    ["&#x27;", "'"],
  ])("decodes %s to %s", (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });

  it("decodes multiple entities in one string", () => {
    expect(decodeHtmlEntities("a&amp;b&amp;c")).toBe("a&b&c");
  });

  it("passes through strings with no entities unchanged", () => {
    const url = "https://x.com/Nemesis/ENG/rulebook.pdf?ref=abc";
    expect(decodeHtmlEntities(url)).toBe(url);
  });
});

// ─── resolveFileShareUrl ────────────────────────────────────────────────────────

describe("resolveFileShareUrl", () => {
  it("sets dl=1 on a basic Dropbox share link", () => {
    expect(resolveFileShareUrl("https://www.dropbox.com/scl/fo/abc/def?dl=0")).toBe(
      "https://www.dropbox.com/scl/fo/abc/def?dl=1"
    );
  });

  it("preserves existing query params and sets dl=1", () => {
    expect(resolveFileShareUrl("https://www.dropbox.com/scl/fo/abc/def?rlkey=xyz&st=abc&dl=0")).toBe(
      "https://www.dropbox.com/scl/fo/abc/def?rlkey=xyz&st=abc&dl=1"
    );
  });

  it("decodes HTML entities in the query string first", () => {
    expect(
      resolveFileShareUrl("https://www.dropbox.com/scl/fo/abc/def?rlkey=xyz&amp;st=abc&amp;dl=0")
    ).toBe("https://www.dropbox.com/scl/fo/abc/def?rlkey=xyz&st=abc&dl=1");
  });

  it("converts a Google Drive file link to the download endpoint", () => {
    expect(resolveFileShareUrl("https://drive.google.com/file/d/FILEID/view")).toBe(
      "https://drive.google.com/uc?export=download&id=FILEID"
    );
  });

  it("returns null for non file-share URLs", () => {
    expect(resolveFileShareUrl("https://x.com/Nemesis/ENG/rulebook.pdf")).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(resolveFileShareUrl("not a url at all")).toBeNull();
  });
});

// ─── detectLanguage ──────────────────────────────────────────────────────────────

describe("detectLanguage", () => {
  it("detects a 3-letter code path segment (ENG → en)", () => {
    expect(detectLanguage("https://x.com/Nemesis/ENG/rulebook.pdf")).toBe("en");
  });

  it("detects a 2-letter code path segment (DE → de)", () => {
    expect(detectLanguage("https://x.com/Nemesis/DE/rulebook.pdf")).toBe("de");
  });

  it("detects a language token in the filename (rulebook_IT.pdf → it)", () => {
    expect(detectLanguage("https://x.com/rulebook_IT.pdf")).toBe("it");
  });

  it("does NOT false-positive on IT_LIVES (not an Italian tag)", () => {
    expect(detectLanguage("https://x.com/IT_LIVES/rulebook.pdf")).toBeNull();
  });

  it("detects a leading code + generic descriptor filename (EN_rulebook.pdf → en)", () => {
    expect(detectLanguage("https://x.com/EN_rulebook.pdf")).toBe("en");
  });

  it("maps 3-letter codes to their 2-letter equivalent (GER → de)", () => {
    expect(detectLanguage("https://x.com/Nemesis/GER/rulebook.pdf")).toBe("de");
  });

  it("returns null when no language tag is present", () => {
    expect(detectLanguage("https://x.com/Nemesis/rulebook.pdf")).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(detectLanguage("not a url at all")).toBeNull();
  });
});

// ─── isLanguageCompatible ────────────────────────────────────────────────────────

describe("isLanguageCompatible", () => {
  it("allows anything when no language is requested", () => {
    expect(isLanguageCompatible("https://x.com/Nemesis/DE/rulebook.pdf")).toBe(true);
  });

  it("allows URLs with no detectable language tag", () => {
    expect(isLanguageCompatible("https://x.com/Nemesis/rulebook.pdf", "en")).toBe(true);
  });

  it("allows a matching language tag", () => {
    expect(isLanguageCompatible("https://x.com/Nemesis/ENG/rulebook.pdf", "en")).toBe(true);
  });

  it("rejects a non-matching language tag", () => {
    expect(isLanguageCompatible("https://x.com/Nemesis/DE/rulebook.pdf", "en")).toBe(false);
  });

  it("compares the desired language case-insensitively", () => {
    expect(isLanguageCompatible("https://x.com/Nemesis/ENG/rulebook.pdf", "EN")).toBe(true);
  });
});

// ─── fetchTextWithLimit ────────────────────────────────────────────────────────

describe("fetchTextWithLimit", () => {
  it("returns the full body as a UTF-8 string when within the limit", async () => {
    const html = "<!DOCTYPE html><html><body><h1>Hello</h1></body></html>";
    mockFetch.mockResolvedValue(new Response(html, { status: 200 }));

    const result = await fetchTextWithLimit("https://x.com/page", MAX_HTML_SIZE);
    expect(result).toBe(html);
  });

  it("decodes multi-byte UTF-8 characters correctly", async () => {
    // "café" contains a multi-byte character (é = 0xC3 0xA9 in UTF-8).
    const html = "<p>café</p>";
    mockFetch.mockResolvedValue(new Response(html, { status: 200 }));

    const result = await fetchTextWithLimit("https://x.com/page", MAX_HTML_SIZE);
    expect(result).toBe("<p>café</p>");
  });

  it("throws HtmlTooLargeError when the body exceeds maxSize", async () => {
    // A body just over the limit (1 MB + 64 bytes).
    const oversized = new Uint8Array(MAX_HTML_SIZE + 64);
    oversized.set(new TextEncoder().encode("<html>"));
    mockFetch.mockResolvedValue(new Response(oversized, { status: 200 }));

    await expect(fetchTextWithLimit("https://x.com/page", MAX_HTML_SIZE)).rejects.toThrow(HtmlTooLargeError);
  });

  it("throws on non-OK HTTP status", async () => {
    mockFetch.mockResolvedValue(new Response("not found", { status: 404 }));

    await expect(fetchTextWithLimit("https://x.com/page", MAX_HTML_SIZE)).rejects.toThrow("HTTP 404");
  });

  it("returns an empty string for a bodyless response", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

    const result = await fetchTextWithLimit("https://x.com/page", MAX_HTML_SIZE);
    expect(result).toBe("");
  });

  it("resolves to an empty string when the response has no body stream", async () => {
    // A Response with a string body still has a readable stream, so this is
    // covered by the first test. This edge case ensures no crash.
    mockFetch.mockResolvedValue(new Response("", { status: 200 }));

    const result = await fetchTextWithLimit("https://x.com/page", MAX_HTML_SIZE);
    expect(result).toBe("");
  });

  it("respects a custom maxSize smaller than the default", async () => {
    // A 10-byte body with a 5-byte limit.
    mockFetch.mockResolvedValue(new Response("hello world", { status: 200 }));

    await expect(fetchTextWithLimit("https://x.com/page", 5)).rejects.toThrow(HtmlTooLargeError);
  });
});
