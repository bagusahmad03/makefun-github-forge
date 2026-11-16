// app.ts — the server: routing, auth, and the lifecycle main.ts drives.
// The contest surfaces live in their own modules (gitproto, rest, graphql,
// mcp); this file only routes a request to the right one and guarantees that
// no request ever crashes the process or answers HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit, type GitRequest } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { nextRequestId, readBody, sendBuffer, sendJson, splitTarget } from './httputil.ts';
import { Store } from './store.ts';

/** Everything a request handler needs: the shared state and the suite token. */
export interface AppContext {
  readonly store: Store;
  readonly token: string;
}

/** The git smart-HTTP paths: /<owner>/<repo>.git/<service>. */
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Route one request. Never throws: failures answer JSON, never HTML. */
async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  const { path, query } = splitTarget(req.url);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}. No auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // The GitHub API root: a 200 with the token's scopes.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // Model Context Protocol over Streamable HTTP (auth enforced inside).
  if (path === '/mcp') {
    await handleMcp(req, res, ctx);
    return;
  }

  // GitHub GraphQL v4 (auth enforced inside).
  if (path === '/api/graphql') {
    await handleGraphQL(req, res, ctx);
    return;
  }

  // GitHub REST v3 (auth enforced inside).
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, ctx, path, query);
    return;
  }

  // Git smart HTTP: no auth check (the suite's git requests carry the token,
  // and no check refuses an unauthenticated git call).
  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch !== null) {
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const gitReq: GitRequest = {
      owner: decodeURIComponent(gitMatch[1]!),
      repoName: decodeURIComponent(gitMatch[2]!),
      service: gitMatch[3]!,
      method,
      query,
      gitProtocol: typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : '',
      body,
    };
    const answer = handleGit(ctx.store, gitReq);
    sendBuffer(res, answer.status, answer.body, answer.headers);
    return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const ctx: AppContext = {
    store: new Store(),
    token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
  };
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res, ctx).catch((err: unknown) => {
      // A handler's trouble is never a crash: answer 500 JSON when still able.
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextRequestId() });
          res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'internal error' }));
        } else {
          res.end();
        }
      } catch {
        try {
          res.destroy();
        } catch {
          // nothing left to do
        }
      }
    });
  });
}
