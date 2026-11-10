import { NextRequest, NextResponse } from "next/server";

/**
 * Optional bearer-token auth for personal-data endpoints.
 * If the `PARLOR_AUTH_TOKEN` env var is set, requests to protected routes
 * must include a matching `Authorization: Bearer <token>` header or a
 * `parlor_token` cookie. If the env var is unset, the endpoint is open
 * (suitable for localhost-only use).
 */
export function requireAuth(req: NextRequest): NextResponse | null {
  const token = process.env.PARLOR_AUTH_TOKEN;
  if (!token) return null; // auth disabled — open access

  // Check Authorization header first.
  const header = req.headers.get("authorization");
  if (header === `Bearer ${token}`) return null;

  // Fall back to cookie.
  const cookie = req.cookies.get("parlor_token")?.value;
  if (cookie === token) return null;

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
