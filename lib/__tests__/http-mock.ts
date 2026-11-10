/**
 * Shared mock for the `http`/`https` modules used by fetchPinned.
 *
 * fetchPinned calls (isHttps ? https : http).request(options, callback) and
 * expects a ClientRequest-like object back. Tests wire this up to a vi.fn()
 * (`requestMock`) so they can queue one fake response per hop and assert on
 * the request options (the pinned IP, SNI, Host header, ...).
 */
import { EventEmitter } from "events";
import { Readable } from "stream";
import { vi } from "vitest";

/**
 * Build a fake ClientRequest that delivers `status`/`headers`/`body` to
 * `callback` (asynchronously) when the request is ended.
 */
export function makeFakeRequest(
  status: number,
  headers: Record<string, string | string[]> = {},
  body = "",
  callback: (res: Readable) => void,
): unknown {
  const res = new Readable();
  (res as unknown as { headers: Record<string, string | string[]> }).headers = headers;
  (res as unknown as { statusCode: number }).statusCode = status;
  if (body) res.push(Buffer.from(body));
  res.push(null);

  return Object.assign(new EventEmitter(), {
    write: vi.fn(),
    destroy: vi.fn(),
    end: () => {
      // Deliver the response asynchronously, like a real socket would.
      process.nextTick(() => callback(res));
    },
  });
}

/**
 * Queue fake responses onto `requestMock` (the mocked http/https.request).
 */
export function createHttpMock(requestMock: ReturnType<typeof vi.fn>) {
  /** Queue a response for the next request. */
  function queueResponse(status: number, headers: Record<string, string | string[]> = {}, body = ""): void {
    requestMock.mockImplementationOnce((_options: unknown, callback: (res: Readable) => void) =>
      makeFakeRequest(status, headers, body, callback)
    );
  }

  /** Queue a request that fails with the given error (e.g. ECONNREFUSED). */
  function queueError(err: Error): void {
    requestMock.mockImplementationOnce((_options: unknown, _callback: unknown) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        destroy: vi.fn(),
        end: () => {
          process.nextTick(() => req.emit("error", err));
        },
      });
      return req;
    });
  }

  return { queueResponse, queueError };
}
