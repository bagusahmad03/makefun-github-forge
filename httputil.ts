// httputil.ts — small shared HTTP helpers: JSON answers, body reading, bearer
// auth, and the request id every reply carries.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A fresh non-empty request id (a counter: deterministic, no randomness). */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Answer with a JSON body; the request id and JSON headers always ride along. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with a 204 and no body (DELETE repository). */
export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

/** Answer with raw bytes (git responses); the request id rides along. */
export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

/** Read a request body whole, capped at `limit` bytes (default 16 MiB). */
export function readBody(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        fail(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    req.on('error', fail);
  });
}

/** The bearer token a request carries, or null when the header is absent. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

/** Whether the request's bearer token is exactly the suite's token. */
export function isAuthenticated(req: IncomingMessage, token: string): boolean {
  if (token === '') return false;
  return bearerToken(req) === token;
}

/** The path of a request URL, or '/' when it does not parse (never throws). */
export function pathOf(req: IncomingMessage): string {
  return splitTarget(req.url).path;
}

/** The query of a request URL, or empty params when it does not parse. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  return splitTarget(req.url).query;
}

/** Split a request target into path + query without building a URL object. */
export function splitTarget(url: string | undefined): { path: string; query: URLSearchParams } {
  const target = url ?? '/';
  const q = target.indexOf('?');
  if (q === -1) return { path: target === '' ? '/' : target, query: EMPTY_PARAMS };
  return { path: target.slice(0, q) || '/', query: new URLSearchParams(target.slice(q + 1)) };
}

const EMPTY_PARAMS = new URLSearchParams();

/** Answer with a prebuilt JSON text (cached responses skip stringify). */
export function sendPrebuilt(
  res: ServerResponse,
  status: number,
  text: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}
