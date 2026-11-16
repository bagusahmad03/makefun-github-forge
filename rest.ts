// rest.ts — GitHub REST v3: repositories, branches, commits, git refs,
// contents, issues, comments, labels, and pull requests with squash merges.
// Auth is enforced on every route here: a missing or wrong bearer token is
// 401, a repository under any other owner is 404 (never 403).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from './app.ts';
import { FIXED_TIMESTAMP, branchTip, commitJson, branchJson, getRef, listRefs, repoJson, setRef, viewerJson } from './store.ts';
import { isAuthenticated, readBody, sendJson, sendNoContent, sendPrebuilt } from './httputil.ts';
import { branchHistory, resolveRef, type Repo } from './store.ts';

type JsonRecord = Record<string, unknown>;

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message });
}

/** Read and parse a JSON body: {} when empty, null when malformed. */
async function jsonBody(req: IncomingMessage): Promise<JsonRecord | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as JsonRecord;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Parse a positive-int query param with a default. */
function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface Page<T> {
  readonly items: T[];
  readonly link: string | null;
}

/**
 * Slice `items` into one page and build the GitHub `Link` header (absolute
 * same-origin URLs) when more pages exist.
 */
function paginate<T>(
  req: IncomingMessage,
  path: string,
  query: URLSearchParams,
  items: readonly T[],
): Page<T> {
  const perPage = Math.min(100, intParam(query, 'per_page', 30));
  const page = intParam(query, 'page', 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const sliced = items.slice(start, start + perPage);
  const host = req.headers.host ?? '127.0.0.1';
  const pageUrl = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `http://${host}${path}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${pageUrl(page + 1)}>; rel="next"`, `<${pageUrl(totalPages)}>; rel="last"`);
  if (page > 1) {
    links.push(`<${pageUrl(1)}>; rel="first"`);
    if (page > 2 || totalPages > 1) links.push(`<${pageUrl(page - 1)}>; rel="prev"`);
  }
  return { items: sliced, link: links.length > 0 ? links.join(', ') : null };
}

/** Split a path into decoded segments, dropping empty ones. */
function segmentsOf(path: string): string[] {
  return path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      if (!s.includes('%')) return s;
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/** Route one /api/v3 request. The API root is answered in app.ts, not here. */
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  path: string,
  query: URLSearchParams,
): Promise<void> {
  if (!isAuthenticated(req, ctx.token)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  const method = req.method ?? 'GET';
  const segments = segmentsOf(path);
  // segments[0] === 'api', segments[1] === 'v3'; the rest is the route.
  const route = segments.slice(2);

  try {
    // GET /api/v3/meta
    if (method === 'GET' && route.length === 1 && route[0] === 'meta') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }
    // GET /api/v3/user
    if (method === 'GET' && route.length === 1 && route[0] === 'user') {
      sendJson(res, 200, viewerJson());
      return;
    }
    // GET /api/v3/user/repos (paginated) / POST /api/v3/user/repos (create)
    if (route.length === 2 && route[0] === 'user' && route[1] === 'repos') {
      if (method === 'GET') {
        const repos = ctx.store.listRepos();
        const page = paginate(req, path, query, repos);
        sendJson(res, 200, page.items.map((r) => repoJson(r)), page.link !== null ? { link: page.link } : {});
        return;
      }
      if (method === 'POST') {
        const body = await jsonBody(req);
        if (body === null) {
          badRequest(res, 'Problems parsing JSON');
          return;
        }
        const name = asString(body.name);
        if (name === null || name === '') {
          unprocessable(res, 'name is required');
          return;
        }
        const repo = ctx.store.createRepo(name, asString(body.description) ?? '', asBoolean(body.private, false));
        if (repo === null) {
          unprocessable(res, `Repository ${name} already exists`);
          return;
        }
        sendJson(res, 201, repoJson(repo));
        return;
      }
    }

    // Everything below is /repos/{owner}/{repo}[/...].
    if (route.length >= 3 && route[0] === 'repos') {
      const owner = route[1]!;
      const repoName = route[2]!;
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) {
        notFound(res);
        return;
      }
      const handled = await handleRepoRoute(req, res, ctx, repo, route.slice(3), path, query, method);
      if (handled) return;
    }
    notFound(res);
  } catch (err) {
    sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
  }
}

/** Route a request under /repos/{owner}/{repo}. Returns false when unmatched. */
async function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  repo: Repo,
  tail: string[],
  path: string,
  query: URLSearchParams,
  method: string,
): Promise<boolean> {
  // GET/PATCH/DELETE /repos/{owner}/{repo}
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(req);
      if (body === null) {
        badRequest(res, 'Problems parsing JSON');
        return true;
      }
      const description = asString(body.description);
      if (description !== null) repo.description = description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.version += 1;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(repo.owner, repo.name);
      sendNoContent(res);
      return true;
    }
    return false;
  }

  const head = tail[0]!;

  // GET /repos/{o}/{r}/branches and /branches/{branch...}
  if (head === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches: Array<Record<string, unknown>> = [];
      for (const [refname, oid] of listRefs(repo)) {
        if (refname.startsWith('refs/heads/')) branches.push(branchJson(refname.slice('refs/heads/'.length), oid));
      }
      sendJson(res, 200, branches);
      return true;
    }
    if (method === 'GET' && tail.length >= 2) {
      const branch = tail.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === undefined) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, branchJson(branch, tip));
      return true;
    }
    return false;
  }

  // GET /repos/{o}/{r}/commits[?sha=]
  if (head === 'commits' && tail.length === 1 && method === 'GET') {
    const shaParam = query.get('sha');
    let tip: string | null | undefined;
    if (shaParam === null || shaParam === '') {
      tip = branchTip(repo, repo.defaultBranch);
      if (tip === undefined) {
        sendJson(res, 200, []);
        return true;
      }
    } else {
      tip = resolveRef(repo, shaParam);
      if (tip === null) {
        notFound(res);
        return true;
      }
    }
    const history = branchHistory(repo, tip, 500);
    const page = paginate(req, path, query, history);
    const commits: Array<Record<string, unknown>> = [];
    for (const oid of page.items) {
      const entry = commitJson(repo, oid);
      if (entry !== null) commits.push(entry);
    }
    sendJson(res, 200, commits, page.link !== null ? { link: page.link } : {});
    return true;
  }

  // /repos/{o}/{r}/git/refs...
  if (head === 'git' && tail.length >= 2 && tail[1] === 'refs') {
    return handleGitRefs(req, res, repo, tail.slice(2), method);
  }

  // Contents, labels, issues, comments, pulls.
  return handleRepoRouteMore(req, res, ctx, repo, tail, path, query, method);
}

/** The Git Data refs routes: list, create, and read one ref. */
async function handleGitRefs(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  method: string,
): Promise<boolean> {
  if (method === 'GET' && tail.length === 0) {
    const refs = listRefs(repo).map(([refname, oid]) => ({ ref: refname, object: { sha: oid, type: 'commit' } }));
    sendJson(res, 200, refs);
    return true;
  }
  if (method === 'POST' && tail.length === 0) {
    const body = await jsonBody(req);
    if (body === null) {
      badRequest(res, 'Problems parsing JSON');
      return true;
    }
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (ref === null || !ref.startsWith('refs/') || sha === null) {
      unprocessable(res, 'ref and sha are required');
      return true;
    }
    if (getRef(repo, ref) !== undefined) {
      unprocessable(res, `Reference ${ref} already exists`);
      return true;
    }
    if (repo.objects.get(sha) === undefined) {
      unprocessable(res, `Object ${sha} does not exist`);
      return true;
    }
    setRef(repo, ref, sha);
    sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
    return true;
  }
  if (method === 'GET' && tail.length >= 1) {
    const refname = `refs/${tail.join('/')}`;
    const oid = getRef(repo, refname);
    if (oid === undefined) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { ref: refname, object: { sha: oid, type: 'commit' } });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- contents, labels, issues, pulls

import {
  addComment,
  blobShaAt,
  branchRef,
  commitTree,
  createIssue,
  createPull,
  diffCommits,
  filesAtCommit,
  issueJson,
  commentJson,
  listComments,
  listTreeDir,
  pullJson,
  squashMerge,
  writeFileCommit,
} from './store.ts';

/** The remaining /repos/{o}/{r} routes. Returns false when unmatched. */
async function handleRepoRouteMore(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  repo: Repo,
  tail: string[],
  path: string,
  query: URLSearchParams,
  method: string,
): Promise<boolean> {
  const head = tail[0]!;

  if (head === 'contents') {
    return handleContents(req, res, repo, tail.slice(1).join('/'), query, method);
  }

  if (head === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
      return true;
    }
    if (method === 'POST' && tail.length === 1) {
      const body = await jsonBody(req);
      if (body === null) {
        badRequest(res, 'Problems parsing JSON');
        return true;
      }
      const name = asString(body.name);
      if (name === null || name === '') {
        unprocessable(res, 'name is required');
        return true;
      }
      const color = asString(body.color) ?? '000000';
      const existing = repo.labels.get(name);
      if (existing !== undefined) {
        sendJson(res, 201, { name: existing.name, color: existing.color });
        return true;
      }
      repo.labels.set(name, { name, color });
      repo.version += 1;
      sendJson(res, 201, { name, color });
      return true;
    }
    return false;
  }

  if (head === 'issues') {
    return handleIssues(req, res, ctx, repo, tail.slice(1), path, query, method);
  }

  if (head === 'pulls') {
    return handlePulls(req, res, ctx, repo, tail.slice(1), query, method);
  }

  return false;
}

/** The contents API: read a file or directory, write or delete a file. */
async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  filePath: string,
  query: URLSearchParams,
  method: string,
): Promise<boolean> {
  if (method === 'GET') {
    const refParam = query.get('ref');
    const tip = refParam === null || refParam === '' ? branchTip(repo, repo.defaultBranch) : resolveRef(repo, refParam);
    if (tip === undefined || tip === null) {
      notFound(res);
      return true;
    }
    const treeOid = commitTree(repo, tip);
    if (treeOid === null) {
      notFound(res);
      return true;
    }
    if (filePath === '') {
      const listing = listTreeDir(repo, treeOid, '');
      sendJson(res, 200, listing ?? []);
      return true;
    }
    const files = filesAtCommit(repo, tip);
    const file = files.get(filePath);
    if (file !== undefined) {
      const blob = repo.objects.get(file.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      const name = filePath.split('/').pop() ?? filePath;
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        sha: file.oid,
        size: data.length,
        name,
        path: filePath,
      });
      return true;
    }
    const listing = listTreeDir(repo, treeOid, filePath);
    if (listing === null) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, listing);
    return true;
  }

  if (method === 'PUT') {
    const body = await jsonBody(req);
    if (body === null) {
      badRequest(res, 'Problems parsing JSON');
      return true;
    }
    const contentB64 = asString(body.content);
    if (contentB64 === null) {
      unprocessable(res, 'content is required');
      return true;
    }
    const branch = asString(body.branch) ?? repo.defaultBranch;
    const message = asString(body.message) ?? `Update ${filePath}`;
    const sha = asString(body.sha);
    // The current blob: the branch tip when it exists, else the fork base.
    const effectiveTip = branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch);
    const currentSha = effectiveTip === undefined ? null : (filesAtCommit(repo, effectiveTip).get(filePath)?.oid ?? null);
    if (sha !== null && sha !== currentSha) {
      sendJson(res, 409, { message: 'sha does not match the current blob' });
      return true;
    }
    if (sha === null && currentSha !== null) {
      unprocessable(res, `file ${filePath} already exists`);
      return true;
    }
    const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const { commitOid, blobOid } = writeFileCommit(repo, branch, filePath, content, message);
    const name = filePath.split('/').pop() ?? filePath;
    sendJson(res, currentSha === null ? 201 : 200, {
      content: { name, path: filePath, sha: blobOid, size: content.length, encoding: 'base64' },
      commit: { sha: commitOid },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = await jsonBody(req);
    if (body === null) {
      badRequest(res, 'Problems parsing JSON');
      return true;
    }
    const branch = asString(body.branch) ?? repo.defaultBranch;
    const message = asString(body.message) ?? `Delete ${filePath}`;
    const sha = asString(body.sha);
    const currentSha = blobShaAt(repo, branch, filePath);
    if (currentSha === null) {
      notFound(res);
      return true;
    }
    if (sha !== null && sha !== currentSha) {
      sendJson(res, 409, { message: 'sha does not match the current blob' });
      return true;
    }
    const { commitOid } = writeFileCommit(repo, branch, filePath, null, message);
    sendJson(res, 200, { commit: { sha: commitOid }, content: null });
    return true;
  }

  return false;
}

/** The issues routes: create, list, read, patch, comments. */
async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  repo: Repo,
  tail: string[],
  path: string,
  query: URLSearchParams,
  method: string,
): Promise<boolean> {
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await jsonBody(req);
      if (body === null) {
        badRequest(res, 'Problems parsing JSON');
        return true;
      }
      const title = asString(body.title);
      if (title === null || title === '') {
        unprocessable(res, 'title is required');
        return true;
      }
      const labels: string[] = [];
      if (Array.isArray(body.labels)) {
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : asString((entry as JsonRecord)?.name);
          if (name === null) continue;
          if (!repo.labels.has(name)) {
            unprocessable(res, `label ${name} does not exist`);
            return true;
          }
          labels.push(name);
        }
      }
      const issue = createIssue(ctx.store, repo, title, asString(body.body) ?? '', labels);
      sendJson(res, 201, issueJson(repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(req, path, query, issues);
      sendJson(res, 200, page.items.map((i) => issueJson(repo, i)), page.link !== null ? { link: page.link } : {});
      return true;
    }
    return false;
  }

  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isInteger(number) || number <= 0) return false;
  const issue = repo.issues.get(number);

  if (tail.length === 1) {
    if (issue === undefined) {
      notFound(res);
      return true;
    }
    if (method === 'GET') {
      // The one-issue view is memoized per repository version: every mutation
      // bumps the version, so a hit can never serve stale state.
      const cached = repo.issueJsonCache.get(number);
      if (cached !== undefined && cached.version === repo.version) {
        sendPrebuilt(res, 200, cached.text);
        return true;
      }
      const text = `${JSON.stringify(issueJson(repo, issue))}\n`;
      if (repo.issueJsonCache.size > 1024) repo.issueJsonCache.clear();
      repo.issueJsonCache.set(number, { version: repo.version, text });
      sendPrebuilt(res, 200, text);
      return true;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(req);
      if (body === null) {
        badRequest(res, 'Problems parsing JSON');
        return true;
      }
      const title = asString(body.title);
      if (title !== null) issue.title = title;
      const bodyText = asString(body.body);
      if (bodyText !== null) issue.body = bodyText;
      const state = asString(body.state);
      if (state === 'open' || state === 'closed') issue.state = state;
      issue.updatedAt = FIXED_TIMESTAMP;
      repo.version += 1;
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    return false;
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    const target = issue ?? repo.pulls.get(number);
    if (target === undefined) {
      notFound(res);
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, listComments(repo, number).map((c) => commentJson(c)));
      return true;
    }
    if (method === 'POST') {
      const body = await jsonBody(req);
      if (body === null) {
        badRequest(res, 'Problems parsing JSON');
        return true;
      }
      const text = asString(body.body);
      if (text === null || text === '') {
        unprocessable(res, 'body is required');
        return true;
      }
      const comment = addComment(repo, number, text);
      sendJson(res, 201, commentJson(comment));
      return true;
    }
    return false;
  }

  return false;
}

/** The pull request routes: create, list, read, files, merge. */
async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
  method: string,
): Promise<boolean> {
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await jsonBody(req);
      if (body === null) {
        badRequest(res, 'Problems parsing JSON');
        return true;
      }
      const title = asString(body.title);
      let head = asString(body.head);
      let base = asString(body.base);
      if (title === null || title === '' || head === null || base === null) {
        unprocessable(res, 'title, head and base are required');
        return true;
      }
      // GitHub accepts "owner:branch" head refs; keep the branch part.
      if (head.includes(':')) head = head.split(':').pop()!;
      if (base.includes(':')) base = base.split(':').pop()!;
      if (branchTip(repo, head) === undefined || branchTip(repo, base) === undefined) {
        unprocessable(res, 'the head or base branch does not exist');
        return true;
      }
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          unprocessable(res, 'A pull request already exists for these branches');
          return true;
        }
      }
      const pull = createPull(ctx.store, repo, title, asString(body.body) ?? '', head, base);
      sendJson(res, 201, pullJson(repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      sendJson(res, 200, pulls.map((p) => pullJson(repo, p)));
      return true;
    }
    return false;
  }

  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isInteger(number) || number <= 0) return false;
  const pull = repo.pulls.get(number);

  if (tail.length === 1 && method === 'GET') {
    if (pull === undefined) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, pullJson(repo, pull));
    return true;
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pull === undefined) {
      notFound(res);
      return true;
    }
    const baseTip = branchTip(repo, pull.baseRef);
    const headTip = branchTip(repo, pull.headRef);
    if (baseTip === undefined || headTip === undefined) {
      sendJson(res, 200, []);
      return true;
    }
    const files = diffCommits(repo, baseTip, headTip).map((d) => ({
      filename: d.path,
      status: d.status,
      additions: d.additions,
      deletions: d.deletions,
      changes: d.additions + d.deletions,
    }));
    sendJson(res, 200, files);
    return true;
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) {
      notFound(res);
      return true;
    }
    const body = await jsonBody(req);
    if (body === null) {
      badRequest(res, 'Problems parsing JSON');
      return true;
    }
    const outcome = squashMerge(repo, pull);
    if (!outcome.ok) {
      sendJson(res, 405, { message: outcome.reason });
      return true;
    }
    sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }

  return false;
}
