// gitobj.ts — the git object model: hashing, commit/tree/tag parse+build, tree
// flattening/building, and reachability. No I/O, no clock, no randomness: every
// function here is a pure function of its inputs, so the store stays deterministic.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The all-zero object id: "no object" in ref commands and empty advertisements. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The four git object types. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** Pack type numbers (git's on-the-wire numbering). */
export const TYPE_NUMBERS: Readonly<Record<GitObjectType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});

const NUMBER_TYPES: Readonly<Record<number, GitObjectType>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
});

/** The type number of a pack entry type, or null for delta types / unknown. */
export function typeOfNumber(n: number): GitObjectType | null {
  return NUMBER_TYPES[n] ?? null;
}

/** SHA-1 hex of `data`. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `data` as `type`: SHA-1 over "<type> <size>\0" + data. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

/** One stored object: its type and raw bytes. Objects are immutable. */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** A parsed commit: header fields plus the message after the blank line. */
export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object's headers. Throws on malformed input. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerPart = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerPart.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (tree === '') throw new Error('commit has no tree line');
  return { tree, parents, author, committer, message };
}

/** Build a commit object. `author`/`committer` are full "Name <email> ts tz" lines. */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let out = `tree ${input.tree}\n`;
  for (const parent of input.parents) out += `parent ${parent}\n`;
  out += `author ${input.author}\ncommitter ${input.committer}\n\n${input.message}`;
  return Buffer.from(out, 'utf8');
}

/** One tree entry: mode as stored ("100644", "40000"), name, target oid. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('tree entry has no mode separator');
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) throw new Error('tree entry has no name terminator');
    const name = data.toString('utf8', space + 1, nul);
    if (nul + 21 > data.length) throw new Error('tree entry is truncated');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** The sort key git uses for a tree entry: directories compare as name + "/". */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Compare two tree entries git-style: byte order of the sort key. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const ka = Buffer.from(treeSortKey(a), 'utf8');
  const kb = Buffer.from(treeSortKey(b), 'utf8');
  return Buffer.compare(ka, kb);
}

/** Serialize tree entries, sorted git-style. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A parsed annotated tag. */
export interface ParsedTag {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a tag object's headers. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerPart = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of headerPart.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Whether a tree entry mode names a directory. */
export function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** A flattened file: its blob oid. */
export interface FlatFile {
  readonly oid: string;
  readonly mode: string;
}

/**
 * Flatten a tree to path -> file, recursively. `get` reads objects by oid; a
 * missing object stops the walk for that subtree (the caller owns validity).
 */
export function flattenTree(
  get: (oid: string) => GitObject | undefined,
  rootOid: string,
): Map<string, FlatFile> {
  const out = new Map<string, FlatFile>();
  const walk = (treeOid: string, prefix: string): void => {
    const obj = get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isDirMode(entry.mode)) walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(rootOid, '');
  return out;
}

/**
 * Build nested trees from a flat path -> blob map, storing every tree object
 * through `put` (which returns the stored oid). Returns the root tree oid.
 * An empty map yields the empty tree.
 */
export function buildTreesFromFiles(
  files: ReadonlyMap<string, FlatFile>,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  interface DirNode {
    readonly files: Map<string, FlatFile>;
    readonly dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, file);
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    return put('tree', data);
  };
  return build(root);
}

/**
 * Peel an oid to the commit it names, following tags. Returns the commit oid,
 * or null when the chain leaves the store or ends at a non-commit.
 */
export function peelToCommit(
  get: (oid: string) => GitObject | undefined,
  oid: string,
): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * The set of commit oids reachable from `tips` (parents followed), optionally
 * capped at `maxDepth` generations from the tips (generation 1 = the tips).
 * Returns the commits plus, when capped, the boundary commits (at exactly
 * maxDepth that still have parents outside the set).
 */
export function reachableCommits(
  get: (oid: string) => GitObject | undefined,
  tips: readonly string[],
  maxDepth: number | null,
): { commits: Set<string>; boundary: Set<string> } {
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) {
    const peeled = peelToCommit(get, tip);
    if (peeled !== null) queue.push({ oid: peeled, depth: 1 });
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    commits.add(oid);
    const commit = parseCommit(obj.data);
    if (maxDepth !== null && depth >= maxDepth) {
      if (commit.parents.length > 0) boundary.add(oid);
      continue;
    }
    for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return { commits, boundary };
}

/**
 * Every object id reachable from a set of commits: the commits, their trees
 * (recursively), and the blobs those trees name. Tag objects passed as tips
 * are included themselves and peeled for the walk.
 */
export function closureOfCommits(
  get: (oid: string) => GitObject | undefined,
  tips: readonly string[],
  maxDepth: number | null,
): { objects: Set<string>; boundary: Set<string> } {
  const objects = new Set<string>();
  for (const tip of tips) {
    const obj = get(tip);
    if (obj !== undefined && obj.type === 'tag') objects.add(tip);
  }
  const { commits, boundary } = reachableCommits(get, tips, maxDepth);
  for (const oid of commits) objects.add(oid);
  const treeQueue: string[] = [];
  for (const oid of commits) {
    const obj = get(oid);
    if (obj !== undefined) treeQueue.push(parseCommit(obj.data).tree);
  }
  const seenTrees = new Set<string>();
  while (treeQueue.length > 0) {
    const treeOid = treeQueue.pop()!;
    if (seenTrees.has(treeOid)) continue;
    seenTrees.add(treeOid);
    objects.add(treeOid);
    const obj = get(treeOid);
    if (obj === undefined || obj.type !== 'tree') continue;
    for (const entry of parseTree(obj.data)) {
      if (isDirMode(entry.mode)) treeQueue.push(entry.oid);
      else if (entry.mode !== '160000') objects.add(entry.oid);
    }
  }
  return { objects, boundary };
}

/** Whether `descendant` reaches `ancestor` by following parents (or equals it). */
export function isAncestor(
  get: (oid: string) => GitObject | undefined,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}

/**
 * The merge base of two commits: the first commit reachable from `a` that is
 * also reachable from `b`, found by breadth-first walk from `a` (nearest to
 * `a` wins). Null when the histories share nothing.
 */
export function mergeBase(
  get: (oid: string) => GitObject | undefined,
  a: string,
  b: string,
): string | null {
  const bSide = reachableCommits(get, [b], null).commits;
  const seen = new Set<string>();
  const queue = [a];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (bSide.has(oid)) return oid;
    const obj = get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

/**
 * The commit history of a tip, newest first: depth-first, parents after the
 * commit, each commit once. Linear and single-parent-merge histories read in
 * commit order.
 */
export function commitHistory(
  get: (oid: string) => GitObject | undefined,
  tip: string,
  limit: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (out.length >= limit || seen.has(oid)) return;
    seen.add(oid);
    const obj = get(oid);
    if (obj === undefined || obj.type !== 'commit') return;
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) visit(parent);
  };
  const peeled = peelToCommit(get, tip);
  if (peeled !== null) visit(peeled);
  return out;
}

// ---------------------------------------------------------------- pkt-line

/** Encode one pkt-line: 4 lowercase hex length digits (header included) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 65520) throw new Error(`pkt-line payload of ${body.length} bytes exceeds the 65516 limit`);
  const header = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

/** The flush packet: "0000". */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet: "0001". */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export interface PktLine {
  /** 'data' | 'flush' | 'delim' | 'end'. */
  readonly kind: 'data' | 'flush' | 'delim' | 'end';
  readonly payload: Buffer;
}

/**
 * Parse pkt-lines from `buf` starting at `start`, stopping after the first
 * flush/delim/end packet or at the buffer's end. Returns the lines and the
 * offset just past the last packet consumed.
 */
export function parsePktLines(buf: Buffer, start: number): { lines: PktLine[]; next: number } {
  const lines: PktLine[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const header = buf.toString('ascii', offset, offset + 4);
    const len = parseInt(header, 16);
    if (!Number.isFinite(len) || len < 0 || len > 65520) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    if (len === 0) {
      lines.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { lines, next: offset + 4 };
    }
    if (len === 1) {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0) });
      return { lines, next: offset + 4 };
    }
    if (len === 2) {
      lines.push({ kind: 'end', payload: Buffer.alloc(0) });
      return { lines, next: offset + 4 };
    }
    if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line');
    lines.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { lines, next: offset };
}

/** Parse ALL pkt-lines in `buf` (used for request bodies that are pure pkt streams). */
export function parseAllPktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const { lines, next } = parsePktLines(buf, offset);
    out.push(...lines);
    if (next === offset) break;
    offset = next;
    if (lines.length > 0 && lines[lines.length - 1]!.kind === 'flush') {
      // A flush ends one section; keep parsing — callers decide what follows.
    }
  }
  return out;
}

// ---------------------------------------------------------------- packfile write

/** Encode one pack object header: type + size varint. */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeNum = TYPE_NUMBERS[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeNum << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  if (remaining !== 0) first |= 0x80;
  bytes.push(first);
  while (remaining !== 0) {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Serialize objects as a packfile version 2: plain (non-delta) entries sorted
 * by oid for determinism, then the SHA-1 trailer. `deflateCache`, when given,
 * memoizes the full entry bytes per oid (objects are immutable).
 */
export function writePack(
  entries: ReadonlyArray<{ oid: string; type: GitObjectType; data: Buffer }>,
  deflateCache?: Map<string, Buffer>,
): Buffer {
  const sorted = [...entries].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const entry of sorted) {
    let encoded = deflateCache?.get(entry.oid);
    if (encoded === undefined) {
      const deflated = deflateSync(entry.data);
      encoded = Buffer.concat([packObjectHeader(entry.type, entry.data.length), deflated]);
      deflateCache?.set(entry.oid, encoded);
    }
    parts.push(encoded);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- packfile read

/** Read the size/type varint at `offset`; returns type number, size, next offset. */
function readPackEntryHeader(buf: Buffer, offset: number): { typeNum: number; size: number; next: number } {
  let byte = buf[offset]!;
  const typeNum = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  offset += 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[offset]!;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    offset += 1;
  }
  return { typeNum, size, next: offset };
}

/** Read an OFS_DELTA base offset varint (git's +1-shift encoding). */
function readOfsDeltaOffset(buf: Buffer, offset: number): { value: number; next: number } {
  let byte = buf[offset]!;
  let value = byte & 0x7f;
  offset += 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[offset]!;
    value = ((value + 1) << 7) | (byte & 0x7f);
    offset += 1;
  }
  return { value, next: offset };
}

/** Read a plain 7-bit little-endian varint (delta sizes). */
function readDeltaVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[offset]!;
    offset += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: offset };
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and the next offset. */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine?.bytesWritten ?? 0;
  if (written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: Buffer.from(result.buffer), next: offset + written };
}

/** Apply a git delta to `base`, returning the reconstructed object bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const source = readDeltaVarint(delta, offset);
  offset = source.next;
  if (source.value !== base.length) throw new Error(`delta source size ${source.value} != base size ${base.length}`);
  const target = readDeltaVarint(delta, offset);
  offset = target.next;
  const out: Buffer[] = [];
  let outLen = 0;
  while (offset < delta.length) {
    const cmd = delta[offset]!;
    offset += 1;
    if ((cmd & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((cmd & (1 << i)) !== 0) {
          copyOffset |= delta[offset]! << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((cmd & (0x10 << i)) !== 0) {
          copySize |= delta[offset]! << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base');
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      outLen += copySize;
    } else if (cmd !== 0) {
      if (offset + cmd > delta.length) throw new Error('delta insert runs past the delta');
      out.push(delta.subarray(offset, offset + cmd));
      outLen += cmd;
      offset += cmd;
    } else {
      throw new Error('delta op byte 0x00 is reserved');
    }
  }
  if (outLen !== target.value) throw new Error(`delta result size ${outLen} != target size ${target.value}`);
  return Buffer.concat(out, outLen);
}

export interface ParsedPackEntry {
  readonly oid: string;
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/**
 * Parse a packfile version 2 (plain entries plus OFS_DELTA/REF_DELTA), verify
 * its trailer checksum, and return every object with its computed oid.
 * REF_DELTA bases outside the pack resolve through `externalGet` when given.
 */
export function parsePack(
  buf: Buffer,
  externalGet?: (oid: string) => GitObject | undefined,
): ParsedPackEntry[] {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack lacks the PACK signature');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart);
  const actual = createHash('sha1').update(buf.subarray(0, trailerStart)).digest();
  if (!actual.equals(trailer)) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    readonly offset: number;
    readonly typeNum: number;
    readonly size: number;
    /** The inflated entry bytes (object bytes, or delta bytes for deltas). */
    readonly data: Buffer;
    readonly baseOffset: number | null;
    readonly baseOid: string | null;
  }
  const raw: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readPackEntryHeader(buf, offset);
    offset = header.next;
    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    if (header.typeNum === 6) {
      const ofs = readOfsDeltaOffset(buf, offset);
      offset = ofs.next;
      baseOffset = entryOffset - ofs.value;
    } else if (header.typeNum === 7) {
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // One inflate per entry: the bytes are kept for delta resolution below.
    const inflated = inflateAt(buf.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    raw.push({ offset: entryOffset, typeNum: header.typeNum, size: header.size, data: inflated.data, baseOffset, baseOid });
    offset = inflated.next;
  }

  const byOffset = new Map<number, RawEntry>();
  for (const entry of raw) byOffset.set(entry.offset, entry);
  const resolved = new Map<number, ParsedPackEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawEntry): ParsedPackEntry => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    try {
      if (entry.typeNum === 6 || entry.typeNum === 7) {
        let base: ParsedPackEntry | GitObject | undefined;
        if (entry.typeNum === 6) {
          const baseEntry = byOffset.get(entry.baseOffset!);
          if (baseEntry === undefined) throw new Error('OFS_DELTA base offset is outside the pack');
          base = resolve(baseEntry);
        } else {
          base = undefined;
          for (const candidate of raw) {
            if (candidate.typeNum === 6 || candidate.typeNum === 7) continue;
            const resolvedCandidate = resolve(candidate);
            if (resolvedCandidate.oid === entry.baseOid) {
              base = resolvedCandidate;
              break;
            }
          }
          if (base === undefined) base = externalGet?.(entry.baseOid!);
          if (base === undefined) throw new Error(`REF_DELTA base ${entry.baseOid} is not in the pack or the store`);
        }
        const data = applyDelta(base.data, entry.data);
        const oid = hashObject(base.type, data);
        const out = { oid, type: base.type, data };
        resolved.set(entry.offset, out);
        return out;
      }
      const type = typeOfNumber(entry.typeNum);
      if (type === null) throw new Error(`unknown pack entry type ${entry.typeNum}`);
      const oid = hashObject(type, entry.data);
      const out = { oid, type, data: entry.data };
      resolved.set(entry.offset, out);
      return out;
    } finally {
      resolving.delete(entry.offset);
    }
  };

  return raw.map((entry) => resolve(entry));
}
