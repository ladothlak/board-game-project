import { NextRequest, NextResponse } from "next/server";

const MAX_BODY_BYTES = 100 * 1024; // 100 KB for JSON API routes.

// Routes that accept file uploads (PDFs can be tens of MB).
const UPLOAD_ROUTES = ["/api/games", "/api/games/"];

/**
 * Global middleware: adds security headers to every response and rejects
 * oversized request bodies on non-upload routes. Runs on all API routes.
 */
export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const isUpload = UPLOAD_ROUTES.some((r) => path.startsWith(r));

  // Reject oversized request bodies early (but allow file uploads).
  if (!isUpload) {
    const length = req.headers.get("content-length");
    // Chunked transfer encoding (no content-length) is rejected on non-upload
    // routes: JSON APIs always have a known body size, and allowing chunked
    // bodies would bypass the size check.
    if (!length) {
      return NextResponse.json(
        { error: "Content-Length header required." },
        { status: 411 }
      );
    }
    if (Number(length) > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "Request body too large." },
        { status: 413 }
      );
    }
  }

  const res = NextResponse.next();

  // Security headers.
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // For API routes, prevent caching of potentially sensitive data.
  res.headers.set("Cache-Control", "no-store");

  return res;
}

/**
 * Match all API routes.
 */
export const config = {
  matcher: ["/api/:path*"],
};
