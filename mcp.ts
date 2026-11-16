// mcp.ts — Model Context Protocol over Streamable HTTP at POST /mcp: the
// modern 2026-07-28 era (server/discover, no handshake, no session) plus the
// legacy initialize handshake for older clients. Plain JSON answers; every
// request carries the suite's bearer token or answers 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from './app.ts';
import {
  branchTip,
  createIssue,
  createPull,
  issueJson,
  pullJson,
  repoJson,
  squashMerge,
  type Repo,
} from './store.ts';
import { isAuthenticated, readBody, sendJson } from './httputil.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** The six tools, built once: two tools/list answers are byte-identical. */
const TOOLS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'The repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

interface RpcError {
  readonly code: number;
  readonly message: string;
}

type ToolOutcome =
  | { kind: 'result'; payload: unknown }
  | { kind: 'toolError'; message: string }
  | { kind: 'rpcError'; error: RpcError };

/** A tool result envelope: JSON text plus the structured payload. */
function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Split a "owner/repo" full name, or null when it is not one. */
function splitFullName(value: unknown): { owner: string; repo: string } | null {
  if (typeof value !== 'string') return null;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  return { owner: value.slice(0, slash), repo: value.slice(slash + 1) };
}

/** The owner/repo pair a tool call names (directly, or via full_name). */
function ownerRepoOf(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = args.owner;
  const repo = args.repo;
  if (typeof owner === 'string' && owner !== '' && typeof repo === 'string' && repo !== '') {
    return { owner, repo };
  }
  return splitFullName(args.full_name ?? args.fullName);
}

function requiredArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

function numberArg(args: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

/** Run one tool; the store is shared with REST, so effects read back there. */
function callTool(ctx: AppContext, name: string, args: Record<string, unknown>): ToolOutcome {
  const missing = (what: string): ToolOutcome => ({
    kind: 'rpcError',
    error: { code: INVALID_PARAMS, message: `missing required argument: ${what}` },
  });

  if (name === 'create_repo') {
    const repoName = requiredArg(args, 'name') ?? requiredArg(args, 'repo');
    if (repoName === null) return missing('name');
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    const repo = ctx.store.createRepo(repoName, description, isPrivate);
    if (repo === null) return { kind: 'toolError', message: `repository ${repoName} already exists` };
    return { kind: 'result', payload: repoJson(repo) };
  }

  if (name === 'get_repo' || name === 'create_issue' || name === 'list_issues' || name === 'create_pull_request' || name === 'merge_pull_request') {
    const pair = ownerRepoOf(args);
    if (pair === null) return missing('owner and repo');
    const repo: Repo | undefined = ctx.store.getRepo(pair.owner, pair.repo);
    if (repo === undefined) return { kind: 'toolError', message: `repository ${pair.owner}/${pair.repo} not found` };

    if (name === 'get_repo') {
      return { kind: 'result', payload: repoJson(repo) };
    }
    if (name === 'create_issue') {
      const title = requiredArg(args, 'title');
      if (title === null) return missing('title');
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = createIssue(ctx.store, repo, title, body, []);
      return { kind: 'result', payload: issueJson(repo, issue) };
    }
    if (name === 'list_issues') {
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      issues.sort((a, b) => b.number - a.number);
      return { kind: 'result', payload: issues.map((i) => issueJson(repo, i)) };
    }
    if (name === 'create_pull_request') {
      const title = requiredArg(args, 'title');
      let head = requiredArg(args, 'head');
      let base = requiredArg(args, 'base');
      if (title === null) return missing('title');
      if (head === null) return missing('head');
      if (base === null) return missing('base');
      if (head.includes(':')) head = head.split(':').pop()!;
      if (base.includes(':')) base = base.split(':').pop()!;
      if (branchTip(repo, head) === undefined || branchTip(repo, base) === undefined) {
        return { kind: 'toolError', message: 'the head or base branch does not exist' };
      }
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return { kind: 'toolError', message: 'A pull request already exists for these branches' };
        }
      }
      const body = typeof args.body === 'string' ? args.body : '';
      const pull = createPull(ctx.store, repo, title, body, head, base);
      return { kind: 'result', payload: pullJson(repo, pull) };
    }
    // merge_pull_request
    const number = numberArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number']);
    if (number === null) return missing('pull_number');
    const pull = repo.pulls.get(number);
    if (pull === undefined) return { kind: 'toolError', message: `pull request #${number} not found` };
    const outcome = squashMerge(repo, pull);
    if (!outcome.ok) return { kind: 'toolError', message: outcome.reason };
    return { kind: 'result', payload: { ...pullJson(repo, pull), sha: outcome.sha } };
  }

  return { kind: 'rpcError', error: { code: INVALID_PARAMS, message: `unknown tool: ${name}` } };
}

/** Match a called tool name: exact, else a normalized suffix (server prefix). */
function matchTool(name: string): string | null {
  const canonical = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];
  if (canonical.includes(name)) return name;
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const tool of canonical) {
    if (normalized.endsWith(tool.replace(/[^a-z0-9]/g, ''))) return tool;
  }
  return null;
}

/** Answer one JSON-RPC request object. Null = a notification (no answer). */
function handleRpc(ctx: AppContext, request: Record<string, unknown>): Record<string, unknown> | null {
  const hasId = 'id' in request;
  const id = (request.id ?? null) as string | number | null;
  const method = request.method;
  if (typeof method !== 'string') {
    if (!hasId) return null;
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (method.startsWith('notifications/')) return null;
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      },
    };
  }
  if (method === 'initialize') {
    const requested = params.protocolVersion;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof requested === 'string' && requested !== '' ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const toolName = params.name;
    if (typeof toolName !== 'string' || toolName === '') {
      return { jsonrpc: '2.0', id, error: { code: INVALID_PARAMS, message: 'tools/call needs a tool name' } };
    }
    const matched = matchTool(toolName);
    if (matched === null) {
      return { jsonrpc: '2.0', id, error: { code: INVALID_PARAMS, message: `unknown tool: ${toolName}` } };
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return { jsonrpc: '2.0', id, error: { code: INVALID_PARAMS, message: 'tools/call arguments must be an object' } };
    }
    const outcome = callTool(ctx, matched, args);
    if (outcome.kind === 'rpcError') {
      return { jsonrpc: '2.0', id, error: outcome.error };
    }
    const result = outcome.kind === 'result' ? toolResult(outcome.payload) : toolErrorResult(outcome.message);
    return { jsonrpc: '2.0', id, result };
  }
  return { jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` } };
}

/** Route /mcp: POST answers JSON-RPC, DELETE closes a session (none held). */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    sendJson(res, 200, {});
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!isAuthenticated(req, ctx.token)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const answer = handleRpc(ctx, parsed as Record<string, unknown>);
  if (answer === null) {
    // A notification: acknowledged with an empty 202.
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}
