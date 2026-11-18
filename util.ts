// Small HTTP helpers shared by every surface handler.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A non-empty, deterministic request id (the wire contract requires the header). */
export function nextRequestId(): string {
  requestCounter += 1;
  return `CF${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Answer with a JSON body and the headers every REST reply carries. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with GitHub's error shape: a JSON body with a string message. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** The request's absolute URL (the suite dials the address it registered, Host is set). */
export function requestUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? '127.0.0.1';
  return new URL(req.url ?? '/', `http://${host}`);
}

/** Parse a JSON request body; null when it is not valid JSON (the caller answers 400). */
export function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A query parameter as a positive integer, or the fallback. */
export function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Slice one page out of a list and build the Link header GitHub sends: rel="next" while
 * more pages remain (plus rel="last"/"prev"/"first" like GitHub). The suite follows the
 * next link verbatim, so it must be an absolute URL on this server.
 */
export function paginate<T>(
  req: IncomingMessage,
  url: URL,
  items: readonly T[],
): { page: T[]; link: string | null } {
  const perPage = Math.min(intParam(url, 'per_page', 30), 100);
  const page = intParam(url, 'page', 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (totalPages <= 1) return { page: slice, link: null };
  const base = requestUrl(req);
  const linkFor = (p: number): string => {
    const u = new URL(base.toString());
    u.searchParams.set('page', String(p));
    if (!u.searchParams.has('per_page')) u.searchParams.set('per_page', String(perPage));
    return u.toString();
  };
  const parts: string[] = [];
  if (page < totalPages) {
    parts.push(`<${linkFor(page + 1)}>; rel="next"`, `<${linkFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    parts.push(`<${linkFor(page - 1)}>; rel="prev"`, `<${linkFor(1)}>; rel="first"`);
  }
  return { page: slice, link: parts.length > 0 ? parts.join(', ') : null };
}
