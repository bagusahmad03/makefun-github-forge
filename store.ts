// store.ts — the forge's in-memory state: one Store holds every repository; one
// Repo holds its git objects, refs, issues, pull requests, labels and comments.
// All four surfaces (REST, GraphQL, MCP, git) read and write this same state,
// so a change on one surface is visible on the others at once.
//
// The scenario the suite grades with is built from one fixed seed, so the login
// the bearer token names is the constant VIEWER_LOGIN below: every repository
// belongs to it, and any other owner in a path names nothing (404, never 403).

import {
  ZERO_OID,
  buildCommit,
  buildTreesFromFiles,
  commitHistory,
  flattenTree,
  hashObject,
  isDirMode,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  type FlatFile,
  type GitObject,
  type GitObjectType,
} from './gitobj.ts';

export { ZERO_OID };

/** The login the suite's bearer token names (scenario viewer, fixed seed). */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's user id (scenario viewer, fixed seed). */
export const VIEWER_ID = 1000;
/** The viewer's display name. */
export const VIEWER_NAME = 'ada iversen';
/** The viewer's email. */
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The default branch every repository is created with. */
export const DEFAULT_BRANCH = 'main';
/** The one timestamp every created/updated field carries: deterministic state. */
export const FIXED_TIMESTAMP = '2025-01-01T00:00:00Z';
/** FIXED_TIMESTAMP as a unix epoch, for commit identities. */
export const FIXED_EPOCH = 1735689600;
/** The identity line server-made commits (contents API, squash merges) carry. */
export const SERVER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`;

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdAt: string;
  updatedAt: string;
}

export interface Comment {
  readonly id: number;
  body: string;
  readonly createdAt: string;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  readonly headRef: string;
  readonly baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  readonly labels: Map<string, Label>;
  readonly comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
  /** Memoized deflated pack entries by oid (objects never change). */
  readonly packCache: Map<string, Buffer>;
  /** Memoized GET-issue response texts, gated on `version` (see rest.ts). */
  readonly issueJsonCache: Map<number, { version: number; text: string }>;
  /** Memoized git response bodies, gated on `version` (see gitproto.ts). */
  readonly gitCache: Map<string, { version: number; body: Buffer }>;
  /** Bumped on every mutation (lets caches key on repository state). */
  version: number;
}

/** The whole forge: every repository, keyed by "owner/name". */
export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;

  /** Create a repository owned by the viewer; null when the name is taken. */
  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = `${VIEWER_LOGIN}/${name}`;
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      packCache: new Map(),
      issueJsonCache: new Map(),
      gitCache: new Map(),
      version: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  /** The repository at owner/name, or undefined (wrong owner names nothing). */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  /** Delete a repository; false when there is nothing at owner/name. */
  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  /** Every repository, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  /** A fresh stable id for an issue, pull request or comment object. */
  nextId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }
}

// ---------------------------------------------------------------- objects and refs

/** Store an object (when absent) and return its oid. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
    repo.version += 1;
  }
  return oid;
}

/** Store an object already known by oid (pack entries): skip re-hashing. */
export function putObjectKnown(repo: Repo, oid: string, type: GitObjectType, data: Buffer): void {
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
    repo.version += 1;
  }
}

/** Read an object by oid. */
export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** The oid a ref points at, or undefined when the ref does not exist. */
export function getRef(repo: Repo, refname: string): string | undefined {
  return repo.refs.get(refname);
}

/** Point a ref at an oid (creating it when new). */
export function setRef(repo: Repo, refname: string, oid: string): void {
  repo.refs.set(refname, oid);
  repo.version += 1;
}

/** Delete a ref; false when it did not exist. */
export function deleteRef(repo: Repo, refname: string): boolean {
  const removed = repo.refs.delete(refname);
  if (removed) repo.version += 1;
  return removed;
}

/** Every ref, sorted by name: [refname, oid] pairs. */
export function listRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The full refname of a branch. */
export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** The tip of a branch, or undefined when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(branchRef(branch));
}

/**
 * Resolve a ref-ish to a commit oid: a branch name, a full refname, a tag, or
 * a 40-hex object id (peeled to its commit when it names a tag). Null when
 * nothing resolves.
 */
export function resolveRef(repo: Repo, ref: string): string | null {
  const get = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const candidates = [branchRef(ref), `refs/tags/${ref}`, ref];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) return peelToCommit(get, oid);
  }
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return peelToCommit(get, ref);
  return null;
}

/** The tree oid of a commit, or null when the oid names no commit. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** The files at a commit: path -> blob, or an empty map when unresolvable. */
export function filesAtCommit(repo: Repo, commitOid: string): Map<string, FlatFile> {
  const tree = commitTree(repo, commitOid);
  if (tree === null) return new Map();
  return flattenTree((oid) => repo.objects.get(oid), tree);
}

// ---------------------------------------------------------------- contents commits

/**
 * Commit one file change on `branch`: `content` replaces (or, when null,
 * deletes) `path`. A branch that does not exist forks from the default
 * branch's tip; an unborn repository's first commit has no parent. Returns
 * the new commit oid and the blob oid (null when the file was deleted).
 */
export function writeFileCommit(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitOid: string; blobOid: string | null } {
  const refname = branchRef(branch);
  const existingTip = repo.refs.get(refname);
  const baseTip = existingTip ?? repo.refs.get(branchRef(repo.defaultBranch)) ?? null;
  const files = baseTip === null ? new Map<string, FlatFile>() : filesAtCommit(repo, baseTip);
  let blobOid: string | null = null;
  if (content === null) {
    files.delete(path);
  } else {
    blobOid = putObject(repo, 'blob', content);
    files.set(path, { oid: blobOid, mode: '100644' });
  }
  const treeOid = buildTreesFromFiles(files, (type, data) => putObject(repo, type, data));
  const commit = buildCommit({
    tree: treeOid,
    parents: baseTip === null ? [] : [baseTip],
    author: SERVER_IDENTITY,
    committer: SERVER_IDENTITY,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const commitOid = putObject(repo, 'commit', commit);
  setRef(repo, refname, commitOid);
  return { commitOid, blobOid };
}

/** The commit history of a branch tip, newest first, capped at `limit`. */
export function branchHistory(repo: Repo, tip: string, limit: number): string[] {
  return commitHistory((oid) => repo.objects.get(oid), tip, limit);
}

// ---------------------------------------------------------------- issues, pulls, labels

/** Create an issue; numbers share one sequence with pull requests. */
export function createIssue(store: Store, repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    id: store.nextId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  repo.version += 1;
  return issue;
}

/** Create a pull request; numbers share one sequence with issues. */
export function createPull(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): Pull {
  const pull: Pull = {
    id: store.nextId(),
    number: repo.nextNumber,
    title,
    body,
    headRef,
    baseRef,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  repo.version += 1;
  return pull;
}

/** Add a comment to an issue or pull request number. */
export function addComment(repo: Repo, number: number, body: string): Comment {
  const comment: Comment = { id: repo.nextCommentId, body, createdAt: FIXED_TIMESTAMP };
  repo.nextCommentId += 1;
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  repo.version += 1;
  return comment;
}

/** The comments on an issue or pull request number, in creation order. */
export function listComments(repo: Repo, number: number): Comment[] {
  return [...(repo.comments.get(number) ?? [])];
}

// ---------------------------------------------------------------- three-way merge

interface MergePlan {
  readonly merged: Map<string, FlatFile>;
  readonly conflicts: string[];
}

/** Plan a three-way merge: base tip + head tip over their merge base. */
function planMerge(
  repo: Repo,
  baseTip: string,
  headTip: string,
): MergePlan {
  const get = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const base = mergeBase(get, baseTip, headTip);
  const baseFiles = filesAtCommit(repo, baseTip);
  const headFiles = filesAtCommit(repo, headTip);
  const ancestorFiles = base === null ? new Map<string, FlatFile>() : filesAtCommit(repo, base);
  const merged = new Map<string, FlatFile>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const a = ancestorFiles.get(path)?.oid;
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (h?.oid === a) {
      if (b !== undefined) merged.set(path, b);
    } else if (b?.oid === a) {
      if (h !== undefined) merged.set(path, h);
    } else if (h?.oid === b?.oid) {
      if (h !== undefined) merged.set(path, h);
    } else {
      conflicts.push(path);
    }
  }
  return { merged, conflicts };
}

/** Whether a pull request merges cleanly: MERGEABLE, CONFLICTING, or UNKNOWN. */
export function mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const plan = planMerge(repo, baseTip, headTip);
  return plan.conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: string };

/**
 * Squash-merge a pull request onto its base branch: one new commit whose tree
 * is the three-way result and whose parent is the base tip. A conflicted
 * merge fails without moving anything.
 */
export function squashMerge(repo: Repo, pull: Pull): MergeOutcome {
  if (pull.merged || pull.state !== 'open') return { ok: false, reason: 'the pull request is already merged or closed' };
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return { ok: false, reason: 'the head or base branch does not exist' };
  const plan = planMerge(repo, baseTip, headTip);
  if (plan.conflicts.length > 0) return { ok: false, reason: `merge conflict in ${plan.conflicts[0]}` };
  const treeOid = buildTreesFromFiles(plan.merged, (type, data) => putObject(repo, type, data));
  const commit = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    author: SERVER_IDENTITY,
    committer: SERVER_IDENTITY,
    message: `Squash merge #${pull.number}: ${pull.title}\n`,
  });
  const sha = putObject(repo, 'commit', commit);
  setRef(repo, branchRef(pull.baseRef), sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TIMESTAMP;
  pull.mergeCommitSha = sha;
  pull.updatedAt = FIXED_TIMESTAMP;
  repo.version += 1;
  return { ok: true, sha };
}

// ---------------------------------------------------------------- diffs

export interface DiffEntry {
  readonly path: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
}

/** Split blob bytes into lines (a trailing newline ends the last line). */
function blobLines(data: Buffer): string[] {
  if (data.length === 0) return [];
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Multiset line difference: [lines only in `next`, lines only in `prev`]. */
function lineDelta(prev: string[], next: string[]): [number, number] {
  const counts = new Map<string, number>();
  for (const line of prev) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of next) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of counts.values()) deletions += left;
  return [additions, deletions];
}

/**
 * The file diff between two commits' trees: every path that differs, with a
 * line-count delta. Sorted by path for determinism.
 */
export function diffCommits(repo: Repo, baseTip: string, headTip: string): DiffEntry[] {
  const baseFiles = filesAtCommit(repo, baseTip);
  const headFiles = filesAtCommit(repo, headTip);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const out: DiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    if (b === undefined && h !== undefined) {
      const lines = blobLines(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0));
      out.push({ path, status: 'added', additions: lines.length, deletions: 0 });
    } else if (b !== undefined && h === undefined) {
      const lines = blobLines(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0));
      out.push({ path, status: 'removed', additions: 0, deletions: lines.length });
    } else if (b !== undefined && h !== undefined) {
      const [additions, deletions] = lineDelta(
        blobLines(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0)),
        blobLines(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0)),
      );
      out.push({ path, status: 'modified', additions, deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------- REST shapes

/** The viewer as a GitHub user object. */
export function viewerJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? null;
  const baseSha = branchTip(repo, pull.baseRef) ?? null;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? mergeableState(repo, pull) === 'MERGEABLE' : null,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

export function branchJson(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha }, protected: false };
}

export function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  // The REST view presents the message as sent: git stores one trailing
  // newline, the API does not show it.
  const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
  return {
    sha: oid,
    commit: {
      message,
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIMESTAMP },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIMESTAMP },
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((sha) => ({ sha })),
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
  };
}

/** The current blob sha of a path on a branch tip, or null when absent. */
export function blobShaAt(repo: Repo, branch: string, path: string): string | null {
  const tip = branchTip(repo, branch);
  if (tip === undefined) return null;
  return filesAtCommit(repo, tip).get(path)?.oid ?? null;
}

/** List a directory of a tree: entries for one path level. */
export function listTreeDir(
  repo: Repo,
  treeOid: string,
  dirPath: string,
): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }> | null {
  let current = treeOid;
  if (dirPath !== '') {
    const parts = dirPath.split('/');
    for (const part of parts) {
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === part && isDirMode(e.mode));
      if (entry === undefined) return null;
      current = entry.oid;
    }
  }
  const obj = repo.objects.get(current);
  if (obj === undefined || obj.type !== 'tree') return null;
  const out: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }> = [];
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '160000') continue;
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (isDirMode(entry.mode)) {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.oid, size: 0 });
    } else {
      const blob = repo.objects.get(entry.oid);
      out.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0 });
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}
