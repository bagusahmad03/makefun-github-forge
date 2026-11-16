// gitproto.ts — git smart HTTP: info/refs advertisements (v0 + v2), the v2
// ls-refs and fetch commands, the v0 fetch, and receive-pack with
// fast-forward enforcement. Plain (non-delta) packs on the way out; full pack
// parsing (OFS_DELTA + REF_DELTA) on the way in.

import {
  ZERO_OID,
  closureOfCommits,
  isAncestor,
  isDirMode,
  parseCommit,
  parsePack,
  parsePktLines,
  parseTree,
  peelToCommit,
  pktFlush,
  pktLine,
  writePack,
  type GitObject,
  type GitObjectType,
} from './gitobj.ts';
import {
  DEFAULT_BRANCH,
  branchRef,
  branchTip,
  deleteRef,
  getObject,
  getRef,
  listRefs,
  putObjectKnown,
  setRef,
  type Repo,
  type Store,
} from './store.ts';

export interface GitRequest {
  readonly owner: string;
  readonly repoName: string;
  /** 'info/refs' | 'git-upload-pack' | 'git-receive-pack' */
  readonly service: string;
  readonly method: string;
  readonly query: URLSearchParams;
  readonly gitProtocol: string;
  readonly body: Buffer;
}

export interface GitResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

function textResponse(status: number, text: string, contentType = 'text/plain; charset=utf-8'): GitResponse {
  return { status, headers: { 'content-type': contentType }, body: Buffer.from(text, 'utf8') };
}

/**
 * A git response body memoized per repository version: objects and refs only
 * change through mutations that bump the version, so a hit can never serve
 * stale refs or packs. The clone workload's 50 identical fetches build once.
 */
function cachedBody(repo: Repo, key: string, build: () => Buffer): Buffer {
  const entry = repo.gitCache.get(key);
  if (entry !== undefined && entry.version === repo.version) return entry.body;
  const body = build();
  if (repo.gitCache.size > 128) repo.gitCache.clear();
  repo.gitCache.set(key, { version: repo.version, body });
  return body;
}

/** The protocol-v2 advertisement never changes: built once, shared. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  pktFlush(),
  pktLine('version 2\n'),
  pktLine('fetch=shallow\n'),
  pktLine('ls-refs=unborn\n'),
  pktFlush(),
]);

/** Split `data` into sideband packets on `band` (1 = data), each <= 32768 bytes. */
function sideband(data: Buffer, band: number): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

/** The ref lines for a v0 advertisement: HEAD first, refs sorted, peeled tags. */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = listRefs(repo);
  const mainTip = branchTip(repo, DEFAULT_BRANCH);
  const capSuffix = `\0${caps}`;
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}${capSuffix}\n`));
    return lines;
  }
  let first = true;
  const pushLine = (text: string): void => {
    lines.push(pktLine(first ? `${text}${capSuffix}\n` : `${text}\n`));
    first = false;
  };
  if (mainTip !== undefined) pushLine(`${mainTip} HEAD`);
  for (const [name, oid] of refs) {
    pushLine(`${oid} ${name}`);
    const obj = getObject(repo, oid);
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = peelToCommit((o) => getObject(repo, o), oid);
      if (peeled !== null) pushLine(`${peeled} ${name}^{}`);
    }
  }
  return lines;
}

/** A v0 info/refs advertisement for `service`. */
function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): GitResponse {
  const body = cachedBody(repo, `adv0:${service}`, () => {
    const caps =
      service === 'git-upload-pack'
        ? 'side-band-64k shallow thin-pack ofs-delta symref=HEAD:refs/heads/main'
        : 'report-status side-band-64k delete-refs';
    const parts = [pktLine(`# service=${service}\n`), pktFlush(), ...v0RefLines(repo, caps), pktFlush()];
    return Buffer.concat(parts);
  });
  return {
    status: 200,
    headers: { 'content-type': `application/x-${service}-advertisement` },
    body,
  };
}

/** The protocol-v2 advertisement: version line plus the two capabilities. */
function advertiseV2(): GitResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
    body: V2_ADVERTISEMENT,
  };
}

/** Parse a v2 command request: `command=<name>`, delim, argument lines, flush. */
function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const first = parsePktLines(body, 0);
  const commandLine = first.lines.find((l) => l.kind === 'data');
  if (commandLine === undefined) throw new Error('v2 request has no command line');
  const commandText = commandLine.payload.toString('utf8').trim();
  if (!commandText.startsWith('command=')) throw new Error(`v2 request line is not a command: ${commandText}`);
  const command = commandText.slice('command='.length);
  const rest = parsePktLines(body, first.next);
  const args: string[] = [];
  for (const line of rest.lines) {
    if (line.kind === 'data') args.push(line.payload.toString('utf8').replace(/\n$/, ''));
  }
  return { command, args };
}

/** Build the `command=ls-refs` answer body. */
function buildLsRefsBody(repo: Repo, args: readonly string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Buffer[] = [];
  const mainTip = branchTip(repo, DEFAULT_BRANCH);
  const get = (oid: string): GitObject | undefined => getObject(repo, oid);
  if (mainTip !== undefined) {
    if (matches('HEAD')) {
      const attrs = wantSymrefs ? ' symref-target:refs/heads/main' : '';
      lines.push(pktLine(`${mainTip} HEAD${attrs}\n`));
    }
    for (const [name, oid] of listRefs(repo)) {
      if (!matches(name)) continue;
      let attrs = '';
      if (wantPeel) {
        const obj = getObject(repo, oid);
        if (obj !== undefined && obj.type === 'tag') {
          const peeled = peelToCommit(get, oid);
          if (peeled !== null) attrs += ` peeled:${peeled}`;
        }
      }
      lines.push(pktLine(`${oid} ${name}${attrs}\n`));
    }
  } else if (wantUnborn && matches('HEAD')) {
    const attrs = wantSymrefs ? ' symref-target:refs/heads/main' : '';
    lines.push(pktLine(`unborn HEAD${attrs}\n`));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

/** Answer `command=ls-refs` (memoized per repository version). */
function lsRefs(repo: Repo, args: readonly string[]): GitResponse {
  const body = cachedBody(repo, `lsrefs:${args.join('\n')}`, () => buildLsRefsBody(repo, args));
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body,
  };
}

// ---------------------------------------------------------------- fetch selection

export interface FetchSelection {
  /** Oids to pack, in send order (sorted for determinism). */
  readonly objects: string[];
  /** Boundary commits of this fetch (depth limit reached, parents withheld). */
  readonly shallow: string[];
  /** Former boundary commits that are interior after this fetch. */
  readonly unshallow: string[];
}

/**
 * Select the objects a fetch sends: reachable(wants) at the requested depth,
 * minus what the client already holds (haves, honoring its shallow boundary).
 */
export function selectFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowLines: readonly string[],
  deepen: number | null,
): FetchSelection {
  const get = (oid: string): GitObject | undefined => getObject(repo, oid);
  const shallowSet = new Set(shallowLines);
  // What the client holds: full closures of ordinary haves; a shallow have
  // contributes only itself and its tree (its parents are not held).
  const excluded = new Set<string>();
  for (const have of haves) {
    const peeled = peelToCommit(get, have);
    if (peeled === null) continue;
    if (shallowSet.has(have) || shallowSet.has(peeled)) {
      const obj = get(peeled);
      if (obj !== undefined && obj.type === 'commit') {
        excluded.add(peeled);
        for (const oid of treeClosureIds(get, parseCommit(obj.data).tree)) excluded.add(oid);
      }
    } else {
      for (const oid of closureOfCommits(get, [peeled], null).objects) excluded.add(oid);
    }
  }
  const { objects, boundary } = closureOfCommits(get, wants, deepen);
  const send = [...objects].filter((oid) => !excluded.has(oid)).sort();
  const sendSet = new Set(send);
  const shallow = [...boundary].filter((oid) => sendSet.has(oid)).sort();
  // Unshallow: a former boundary commit with at least one parent in this pack.
  const unshallow: string[] = [];
  for (const oid of shallowLines) {
    const peeled = peelToCommit(get, oid);
    if (peeled === null) continue;
    const obj = get(peeled);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((p) => sendSet.has(p)) && !unshallow.includes(oid)) unshallow.push(oid);
  }
  unshallow.sort();
  return { objects: send, shallow, unshallow };
}

/** Every object id in a tree's closure: the tree, subtrees, and blobs. */
function treeClosureIds(
  get: (oid: string) => GitObject | undefined,
  rootTree: string,
): Set<string> {
  const out = new Set<string>();
  const queue = [rootTree];
  while (queue.length > 0) {
    const treeOid = queue.pop()!;
    if (out.has(treeOid)) continue;
    out.add(treeOid);
    const obj = get(treeOid);
    if (obj === undefined || obj.type !== 'tree') continue;
    for (const entry of parseTree(obj.data)) {
      if (isDirMode(entry.mode)) queue.push(entry.oid);
      else if (entry.mode !== '160000') out.add(entry.oid);
    }
  }
  return out;
}

/** Build the pack for a fetch selection, using the repo's deflate cache. */
function buildFetchPack(repo: Repo, selection: FetchSelection): Buffer {
  const entries: Array<{ oid: string; type: GitObjectType; data: Buffer }> = [];
  for (const oid of selection.objects) {
    const obj = getObject(repo, oid);
    if (obj !== undefined) entries.push({ oid, type: obj.type, data: obj.data });
  }
  return writePack(entries, repo.packCache);
}

// ---------------------------------------------------------------- fetch

/** Build a v2 fetch answer body from parsed arguments. */
function fetchV2Body(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowLines: readonly string[],
  deepen: number | null,
): Buffer {
  const selection = selectFetch(repo, wants, haves, shallowLines, deepen);
  const pack = buildFetchPack(repo, selection);
  const parts: Buffer[] = [
    pktLine('acknowledgments\n'),
    pktLine('NAK\n'),
    pktFlush(),
  ];
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'), ...sideband(pack, 1), pktFlush());
  return Buffer.concat(parts);
}

/** Answer `command=fetch` (protocol v2, memoized per repository version). */
function fetchV2(repo: Repo, args: readonly string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowLines: string[] = [];
  let deepen: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowLines.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) deepen = n;
    }
  }
  const key = `fetch2:${wants.join(',')}|${haves.join(',')}|${shallowLines.join(',')}|${deepen ?? ''}`;
  const body = cachedBody(repo, key, () => fetchV2Body(repo, wants, haves, shallowLines, deepen));
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body,
  };
}

/** Build a v0 fetch answer body from parsed arguments. */
function fetchV0Body(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowLines: readonly string[],
  deepen: number | null,
): Buffer {
  const selection = selectFetch(repo, wants, haves, shallowLines, deepen);
  const pack = buildFetchPack(repo, selection);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sideband(pack, 1), pktFlush());
  return Buffer.concat(parts);
}

/** Answer a v0 upload-pack POST (memoized per repository version). */
function fetchV0(repo: Repo, body: Buffer): GitResponse {
  const first = parsePktLines(body, 0);
  const wants: string[] = [];
  const shallowLines: string[] = [];
  let deepen: number | null = null;
  for (const line of first.lines) {
    if (line.kind !== 'data') continue;
    let text = line.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul);
    text = text.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowLines.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) deepen = n;
    }
  }
  const haves: string[] = [];
  if (first.next < body.length) {
    const second = parsePktLines(body, first.next);
    for (const line of second.lines) {
      if (line.kind !== 'data') continue;
      const text = line.payload.toString('utf8').replace(/\n$/, '');
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    }
  }
  const key = `fetch0:${wants.join(',')}|${haves.join(',')}|${shallowLines.join(',')}|${deepen ?? ''}`;
  const out = cachedBody(repo, key, () => fetchV0Body(repo, wants, haves, shallowLines, deepen));
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body: out,
  };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Apply one ref command; returns the report line's outcome. */
function applyCommand(
  repo: Repo,
  command: PushCommand,
): { ok: boolean; reason: string } {
  const get = (oid: string): GitObject | undefined => getObject(repo, oid);
  if (!/^[0-9a-f]{40}$/.test(command.oldOid) || !/^[0-9a-f]{40}$/.test(command.newOid)) {
    return { ok: false, reason: 'malformed object id' };
  }
  if (!command.ref.startsWith('refs/') || command.ref.includes('..')) {
    return { ok: false, reason: 'invalid ref name' };
  }
  const current = getRef(repo, command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete: the ref must exist and the old value must match.
    if (current === undefined) return { ok: false, reason: 'ref does not exist' };
    if (current !== command.oldOid) return { ok: false, reason: 'old value mismatch' };
    deleteRef(repo, command.ref);
    return { ok: true, reason: '' };
  }
  if (getObject(repo, command.newOid) === undefined) {
    return { ok: false, reason: 'object not found' };
  }
  if (command.oldOid === ZERO_OID) {
    // Create: the ref must not exist.
    if (current !== undefined) return { ok: false, reason: 'ref already exists' };
    setRef(repo, command.ref, command.newOid);
    return { ok: true, reason: '' };
  }
  // Update: the old value must match and the move must fast-forward.
  if (current === undefined) return { ok: false, reason: 'ref does not exist' };
  if (current !== command.oldOid) return { ok: false, reason: 'old value mismatch' };
  if (command.newOid !== command.oldOid && !isAncestor(get, command.oldOid, command.newOid)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  setRef(repo, command.ref, command.newOid);
  return { ok: true, reason: '' };
}

/** Answer a receive-pack POST: unpack the pack, apply the commands in order. */
function receivePack(repo: Repo, body: Buffer): GitResponse {
  let commands: PushCommand[] = [];
  let packStart = 0;
  try {
    const parsed = parsePktLines(body, 0);
    packStart = parsed.next;
    for (const line of parsed.lines) {
      if (line.kind !== 'data') continue;
      let text = line.payload.toString('utf8');
      const nul = text.indexOf('\0');
      if (nul !== -1) text = text.slice(0, nul);
      text = text.replace(/\n$/, '');
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
      if (match !== null) {
        commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
      }
    }
  } catch {
    return textResponse(400, 'bad request');
  }
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes.length > 0) {
    try {
      const entries = parsePack(packBytes, (oid) => getObject(repo, oid));
      for (const entry of entries) putObjectKnown(repo, entry.oid, entry.type, entry.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  // The report: a pkt-line stream carried on sideband band 1.
  const report: Buffer[] = [];
  if (unpackOk) {
    report.push(pktLine('unpack ok\n'));
    for (const command of commands) {
      const outcome = applyCommand(repo, command);
      report.push(
        outcome.ok ? pktLine(`ok ${command.ref}\n`) : pktLine(`ng ${command.ref} ${outcome.reason}\n`),
      );
    }
  } else {
    report.push(pktLine(`unpack ${unpackDetail}\n`));
    for (const command of commands) {
      report.push(pktLine(`ng ${command.ref} unpack failed\n`));
    }
  }
  report.push(pktFlush());
  const stream = Buffer.concat(report);
  const parts = [...sideband(stream, 1), pktFlush()];
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
    body: Buffer.concat(parts),
  };
}

// ---------------------------------------------------------------- dispatcher

/** Route one git smart-HTTP request. Missing repositories are 404, always. */
export function handleGit(store: Store, req: GitRequest): GitResponse {
  const repo = store.getRepo(req.owner, req.repoName);
  if (repo === undefined) return textResponse(404, 'Not Found');
  try {
    if (req.service === 'info/refs') {
      if (req.method !== 'GET') return textResponse(405, 'Method Not Allowed');
      const service = req.query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        return req.gitProtocol === 'version=2' ? advertiseV2() : advertiseV0(repo, service);
      }
      if (service === 'git-receive-pack') return advertiseV0(repo, service);
      return textResponse(404, 'Not Found');
    }
    if (req.service === 'git-upload-pack') {
      if (req.method !== 'POST') return textResponse(405, 'Method Not Allowed');
      if (req.gitProtocol === 'version=2') {
        const { command, args } = parseV2Command(req.body);
        if (command === 'ls-refs') return lsRefs(repo, args);
        if (command === 'fetch') return fetchV2(repo, args);
        return textResponse(400, 'bad request');
      }
      return fetchV0(repo, req.body);
    }
    if (req.service === 'git-receive-pack') {
      if (req.method !== 'POST') return textResponse(405, 'Method Not Allowed');
      return receivePack(repo, req.body);
    }
    return textResponse(404, 'Not Found');
  } catch {
    // A malformed git request never kills the server: answer an error.
    return textResponse(400, 'bad request');
  }
}
