import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkRate, getClientIp } from "@/lib/rate-limit";
import { logRequest } from "@/lib/audit-log";
import { isValidPdf, isSafeUrl, SsrfBlockedError, PdfTooLargeError } from "@/lib/fetch-rulebook-utils";
import { findRulebookPdf, downloadRulebookPdf } from "@/lib/fetch-rulebook-core";

/**
 * Best-effort rulebook PDF fetch. Thin HTTP wrapper around the shared search
 * routine in @/lib/fetch-rulebook-core (known URLs → publisher probe → web
 * search → site scan, with learning into content/known-rulebooks.json).
 *
 * Accepts a game name (and optional publisher hints), finds the rulebook PDF,
 * downloads it, and returns the raw PDF bytes. A direct URL may also be
 * supplied to skip all strategies.
 */

export async function POST(req: Request) {
  const denied = requireAuth(req as any);
  if (denied) return denied;

  const start = Date.now();
  const ip = getClientIp(req);

  // Rate limit: 5 per minute (accommodates dismiss-and-retry flow).
  const rate = checkRate(ip, "/api/games/fetch-rulebook", 5, 60_000);
  if (!rate.allowed) {
    logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 429, durationMs: Date.now() - start });
    return NextResponse.json({ error: "Too many fetch attempts — wait a minute." }, { status: 429 });
  }

  let body: { publisherUrl?: string | null; gameName?: string; publisherName?: string; excludeUrls?: string[]; directUrl?: string; isExpansion?: boolean; language?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { publisherUrl: bodyPublisherUrl, gameName, publisherName: bodyPublisherName, excludeUrls, directUrl, isExpansion, language } = body;
  if (!gameName && !bodyPublisherUrl && !directUrl) {
    return NextResponse.json({ error: "Game name, publisher URL, or direct URL is required" }, { status: 400 });
  }

  // SSRF guard: reject user-supplied URLs that resolve to a private/internal
  // address (cloud metadata 169.254.x.x, RFC1918 ranges, non-localhost loopback).
  // Fail fast with a clear 403 before any server-side fetch is attempted.
  for (const u of [directUrl, bodyPublisherUrl]) {
    if (u && !(await isSafeUrl(u))) {
      logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 403, durationMs: Date.now() - start });
      return NextResponse.json(
        { error: "Blocked: that URL points to a private or internal address." },
        { status: 403 }
      );
    }
  }

  try {
    let pdfUrl: string | null = null;
    let foundVia = "";

    // Direct URL: skip all strategies, download from the given URL.
    if (directUrl) {
      if (await isValidPdf(directUrl)) {
        pdfUrl = directUrl;
        foundVia = "direct";
      }
    }

    // Shared search routine: known URLs → publisher probe → web search → site scan.
    if (!pdfUrl && gameName) {
      const found = await findRulebookPdf(gameName, {
        publisherName: bodyPublisherName ?? undefined,
        publisherUrl: bodyPublisherUrl ?? undefined,
        excludeUrls,
        isExpansion,
        language,
      });
      if (found) {
        pdfUrl = found.url;
        foundVia = found.foundVia;
      }
    }

    if (!pdfUrl) {
      logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 404, durationMs: Date.now() - start });
      return NextResponse.json(
        { error: "No rulebook PDF found automatically. Drag your copy in instead." },
        { status: 404 }
      );
    }

    // Download the PDF (size-capped, %PDF sanity-checked).
    const bytes = await downloadRulebookPdf(pdfUrl);

    logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 200, durationMs: Date.now() - start });
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "X-Pdf-Url": pdfUrl,
        "X-Found-Via": foundVia,
      },
    });
  } catch (e) {
    if (e instanceof SsrfBlockedError) {
      logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 403, durationMs: Date.now() - start });
      return NextResponse.json(
        { error: "Blocked: that URL points to a private or internal address." },
        { status: 403 }
      );
    }
    if (e instanceof PdfTooLargeError) {
      logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 413, durationMs: Date.now() - start });
      return NextResponse.json(
        { error: `The rulebook PDF is too large to download (${e.message}). Drag your copy in instead.` },
        { status: 413 }
      );
    }
    logRequest({ ip, route: "/api/games/fetch-rulebook", method: "POST", status: 502, durationMs: Date.now() - start });
    return NextResponse.json(
      { error: `Couldn't fetch the rulebook automatically (${e instanceof Error ? e.message : "unknown error"}). Drag your copy in instead.` },
      { status: 502 }
    );
  }
}
