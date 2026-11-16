// graphql.ts — GitHub GraphQL v4 for exactly the documents gh and
// github-mcp-server send: a small tokenizer, a recursive-descent parser for
// the GraphQL subset those documents use, and an executor over the shared
// store. No schema library, no dependency.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from './app.ts';
import { isAuthenticated, readBody, sendJson } from './httputil.ts';

// ---------------------------------------------------------------- tokenizer

type TokenKind =
  | 'name'
  | 'string'
  | 'int'
  | 'float'
  | 'punct'
  | 'ellipsis'
  | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string): boolean => /[0-9]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input[i + 1] === '.' && input[i + 2] === '.') {
      tokens.push({ kind: 'ellipsis', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1]!;
          if (esc === 'u' && i + 5 < input.length) {
            value += String.fromCharCode(Number.parseInt(input.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[esc] ?? esc;
            i += 2;
          }
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (c === '-' || isDigit(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && isDigit(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && isDigit(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && isDigit(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && isDigit(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- AST + parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selectionSet: SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] };

export interface OperationNode {
  readonly operation: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  readonly selectionSet: SelectionNode[];
}

export interface FragmentNode {
  readonly name: string;
  readonly typeCondition: string;
  readonly selectionSet: SelectionNode[];
}

export interface DocumentNode {
  readonly operations: OperationNode[];
  readonly fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}", got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name${value === undefined ? '' : ` "${value}"`}, got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          operation: 'query',
          name: null,
          variables: [],
          selectionSet: this.parseSelectionSet(),
        });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.parseOperation());
      } else if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        throw new Error(`unexpected definition ${JSON.stringify(token.value)}`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const operation = this.next().value as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        this.skipDirectives();
        variables.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    return { operation, name, variables, selectionSet: this.parseSelectionSet() };
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseFragment(): FragmentNode {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    this.skipDirectives();
    return { name, typeCondition, selectionSet: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'ellipsis') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selectionSet =
      this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

/** Parse a GraphQL document string. Throws on syntax errors. */
export function parseDocument(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------- executor

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  addComment,
  branchTip,
  createIssue,
  createPull,
  diffCommits,
  mergeableState,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

/** A resolved object: its concrete GraphQL type plus its payload. */
interface Obj {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface GqlError {
  readonly message: string;
}

interface ExecContext {
  readonly store: Store;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fragments: ReadonlyMap<string, FragmentNode>;
  readonly errors: GqlError[];
}

/** Resolve a value node against the operation's variables. */
function resolveValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, variables);
  return args;
}

// ---------------------------------------------------------------- schema data

/** The fields each type answers (validation: anything else is an error). */
const FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'url', 'comments']),
  PullRequest: new Set(['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'merged', 'mergedAt', 'files', 'author', 'createdAt', 'updatedAt', 'repository', 'url']),
  User: new Set(['id', 'login', 'name', 'email']),
  IssueConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PullRequestChangedFileConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PullRequestChangedFile: new Set(['path', 'additions', 'deletions', 'changeType']),
  Ref: new Set(['name', 'id', 'target']),
  PageInfo: new Set(['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description']),
  __Field: new Set(['name', 'description']),
  __EnumValue: new Set(['name', 'description']),
  IssueComment: new Set(['id', 'body', 'author', 'createdAt']),
  IssueCommentEdge: new Set(['node', 'cursor']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId']),
  Node: new Set(['id']),
};

/** The object type a field's sub-selections resolve against (absent = scalar). */
const FIELD_TYPE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestChangedFileConnection' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

/** The field lists introspection reports per type. */
const INTROSPECTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'merged', 'mergedAt', 'files', 'author', 'createdAt', 'updatedAt', 'repository', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email'],
};

/** The enum values introspection reports per enum type. */
const INTROSPECTION_ENUMS: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

/** Types that implement the Node interface. */
const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User']);

// ---------------------------------------------------------------- global ids + cursors

/** An opaque, stable global id: base64("<Kind>:<repoId>[:<number>]"). */
export function globalId(kind: string, repoId: number, number?: number): string {
  const text = number === undefined ? `${kind}:${repoId}` : `${kind}:${repoId}:${number}`;
  return Buffer.from(text, 'utf8').toString('base64');
}

function parseGlobalId(id: unknown): { kind: string; repoId: number; number: number | null } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^(Repository|Issue|PullRequest|IssueComment):(\d+)(?::(\d+))?$/.exec(text);
  if (match === null) return null;
  return { kind: match[1]!, repoId: Number.parseInt(match[2]!, 10), number: match[3] === undefined ? null : Number.parseInt(match[3], 10) };
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.listRepos()) if (repo.id === id) return repo;
  return undefined;
}

/** An opaque page cursor for an issue/PR number. */
function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1]!, 10);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- validation

/** Collect unknown-field errors for a selection set against `typeName`. */
function validateSelections(
  selections: readonly SelectionNode[],
  typeName: string,
  doc: DocumentNode,
  errors: GqlError[],
): void {
  const fields = FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      if (fields === undefined || !fields.has(selection.name)) {
        errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
        continue;
      }
      if (selection.selectionSet !== null) {
        const childType = FIELD_TYPE[typeName]?.[selection.name];
        if (childType !== undefined) validateSelections(selection.selectionSet, childType, doc, errors);
      }
    } else if (selection.kind === 'inlineFragment') {
      const narrowed = selection.typeCondition ?? typeName;
      validateSelections(selection.selectionSet, narrowed, doc, errors);
    } else {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push({ message: `Unknown fragment "${selection.name}".` });
      } else {
        validateSelections(fragment.selectionSet, fragment.typeCondition, doc, errors);
      }
    }
  }
}

// ---------------------------------------------------------------- resolvers

type Resolver = (source: Obj, args: Record<string, unknown>, ctx: ExecContext) => unknown;

function issueObj(repo: Repo, issue: Issue): Obj {
  return { type: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: Pull): Obj {
  return { type: 'PullRequest', repo, pull };
}

function repoObj(repo: Repo): Obj {
  return { type: 'Repository', repo };
}

function userObj(): Obj {
  return { type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID };
}

function pageInfoObj(hasNextPage: boolean, endCursor: string | null, hasPreviousPage: boolean, startCursor: string | null): Obj {
  return { type: 'PageInfo', hasNextPage, endCursor, hasPreviousPage, startCursor };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Obj {
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
  const orderBy = (args.orderBy as { field?: unknown; direction?: unknown } | undefined) ?? null;
  const first = typeof args.first === 'number' ? args.first : null;
  const afterNumber = numberOfCursor(args.after);
  let issues = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states);
    issues = issues.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : orderBy !== null ? 'DESC' : 'ASC';
  issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  let start = 0;
  if (afterNumber !== null) {
    const index = issues.findIndex((i) => i.number === afterNumber);
    if (index !== -1) start = index + 1;
  }
  const window = issues.slice(start);
  const taken = first === null ? window : window.slice(0, Math.max(0, first));
  const hasNextPage = taken.length < window.length;
  const endCursor = taken.length === 0 ? null : cursorFor(taken[taken.length - 1]!.number);
  const startCursor = taken.length === 0 ? null : cursorFor(taken[0]!.number);
  return {
    type: 'IssueConnection',
    nodes: taken.map((issue) => issueObj(repo, issue)),
    pageInfo: pageInfoObj(hasNextPage, endCursor, start > 0, startCursor),
    totalCount: issues.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Obj {
  const first = typeof args.first === 'number' ? args.first : null;
  const pulls = [...repo.pulls.values()].filter((p) => p.state === 'open').sort((a, b) => b.number - a.number);
  const taken = first === null ? pulls : pulls.slice(0, Math.max(0, first));
  const hasNextPage = taken.length < pulls.length;
  const endCursor = taken.length === 0 ? null : cursorFor(taken[taken.length - 1]!.number);
  const startCursor = taken.length === 0 ? null : cursorFor(taken[0]!.number);
  return {
    type: 'PullRequestConnection',
    nodes: taken.map((pull) => pullObj(repo, pull)),
    pageInfo: pageInfoObj(hasNextPage, endCursor, false, startCursor),
    totalCount: pulls.length,
  };
}

function filesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): Obj {
  const first = typeof args.first === 'number' ? args.first : null;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  const diff = baseTip === undefined || headTip === undefined ? [] : diffCommits(repo, baseTip, headTip);
  const taken = first === null ? diff : diff.slice(0, Math.max(0, first));
  return {
    type: 'PullRequestChangedFileConnection',
    nodes: taken.map((d) => ({ type: 'PullRequestChangedFile', path: d.path, additions: d.additions, deletions: d.deletions, changeType: d.status.toUpperCase() })),
    pageInfo: pageInfoObj(taken.length < diff.length, null, false, null),
    totalCount: diff.length,
  };
}

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: () => userObj(),
    repository: (_source, args, ctx) => {
      const owner = args.owner;
      const name = args.name;
      if (owner !== VIEWER_LOGIN || typeof name !== 'string') return null;
      const repo = ctx.store.getRepo(VIEWER_LOGIN, name);
      return repo === undefined ? null : repoObj(repo);
    },
    node: (_source, args, ctx) => {
      const parsed = parseGlobalId(args.id);
      if (parsed === null) return null;
      const repo = findRepoById(ctx.store, parsed.repoId);
      if (repo === undefined) return null;
      if (parsed.kind === 'Repository') return repoObj(repo);
      if (parsed.kind === 'Issue' && parsed.number !== null) {
        const issue = repo.issues.get(parsed.number);
        return issue === undefined ? null : issueObj(repo, issue);
      }
      if (parsed.kind === 'PullRequest' && parsed.number !== null) {
        const pull = repo.pulls.get(parsed.number);
        return pull === undefined ? null : pullObj(repo, pull);
      }
      return null;
    },
    __type: (_source, args) => {
      const name = args.name;
      if (typeof name !== 'string') return null;
      const fieldNames = INTROSPECTION_FIELDS[name];
      const enumNames = INTROSPECTION_ENUMS[name];
      if (fieldNames === undefined && enumNames === undefined) return null;
      return {
        type: '__Type',
        name,
        kind: fieldNames !== undefined ? 'OBJECT' : 'ENUM',
        fieldNames: fieldNames ?? null,
        enumNames: enumNames ?? null,
      };
    },
  },
  Repository: {
    id: (source) => globalId('Repository', (source.repo as Repo).id),
    databaseId: (source) => (source.repo as Repo).id,
    name: (source) => (source.repo as Repo).name,
    nameWithOwner: (source) => {
      const repo = source.repo as Repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: () => userObj(),
    defaultBranchRef: (source) => {
      const repo = source.repo as Repo;
      return branchTip(repo, repo.defaultBranch) === undefined ? null : { type: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (source, args) => {
      const repo = source.repo as Repo;
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueObj(repo, issue);
    },
    issues: (source, args) => issuesConnection(source.repo as Repo, args),
    pullRequests: (source, args) => pullsConnection(source.repo as Repo, args),
    pullRequest: (source, args) => {
      const repo = source.repo as Repo;
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullObj(repo, pull);
    },
    description: (source) => (source.repo as Repo).description,
    isPrivate: (source) => (source.repo as Repo).private,
  },
  Issue: {
    id: (source) => globalId('Issue', (source.repo as Repo).id, (source.issue as Issue).number),
    number: (source) => (source.issue as Issue).number,
    title: (source) => (source.issue as Issue).title,
    state: (source) => ((source.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (source) => (source.issue as Issue).body,
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', (source.repo as Repo).id, (source.pull as Pull).number),
    number: (source) => (source.pull as Pull).number,
    title: (source) => (source.pull as Pull).title,
    state: (source) => {
      const pull = source.pull as Pull;
      if (pull.merged) return 'MERGED';
      return pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    body: (source) => (source.pull as Pull).body,
    merged: (source) => (source.pull as Pull).merged,
    mergedAt: (source) => (source.pull as Pull).mergedAt,
    headRefName: (source) => (source.pull as Pull).headRef,
    baseRefName: (source) => (source.pull as Pull).baseRef,
    mergeable: (source) => mergeableState(source.repo as Repo, source.pull as Pull),
    files: (source, args) => filesConnection(source.repo as Repo, source.pull as Pull, args),
  },
  User: {
    id: () => globalId('User', VIEWER_ID),
    login: () => VIEWER_LOGIN,
    name: () => 'ada iversen',
    email: () => 'adaiversen@example.invalid',
  },
  Ref: {
    name: (source) => source.name,
  },
  IssueConnection: {
    nodes: (source) => source.nodes,
    pageInfo: (source) => source.pageInfo,
    totalCount: (source) => source.totalCount,
  },
  PullRequestConnection: {
    nodes: (source) => source.nodes,
    pageInfo: (source) => source.pageInfo,
    totalCount: (source) => source.totalCount,
  },
  PullRequestChangedFileConnection: {
    nodes: (source) => source.nodes,
    pageInfo: (source) => source.pageInfo,
    totalCount: (source) => source.totalCount,
  },
  PullRequestChangedFile: {
    path: (source) => source.path,
    additions: (source) => source.additions,
    deletions: (source) => source.deletions,
    changeType: (source) => source.changeType,
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage,
    endCursor: (source) => source.endCursor,
    hasPreviousPage: (source) => source.hasPreviousPage,
    startCursor: (source) => source.startCursor,
  },
  __Type: {
    name: (source) => source.name,
    kind: (source) => source.kind,
    fields: (source) => {
      const names = source.fieldNames as readonly string[] | null;
      return names === null ? null : names.map((name) => ({ type: '__Field', name }));
    },
    enumValues: (source) => {
      const names = source.enumNames as readonly string[] | null;
      return names === null ? null : names.map((name) => ({ type: '__EnumValue', name }));
    },
  },
  __Field: {
    name: (source) => source.name,
  },
  __EnumValue: {
    name: (source) => source.name,
  },
  IssueComment: {
    id: (source) => source.globalId,
    body: (source) => source.body,
  },
  IssueCommentEdge: {
    node: (source) => source.node,
    cursor: () => null,
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(input.repositoryId);
      if (parsed === null || parsed.kind !== 'Repository') {
        ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
        return null;
      }
      const repo = findRepoById(ctx.store, parsed.repoId);
      if (repo === undefined) {
        ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
        return null;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = createIssue(ctx.store, repo, title, body, []);
      return { type: 'CreateIssuePayload', issue: issueObj(repo, issue) };
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(input.issueId);
      if (parsed === null || parsed.kind !== 'Issue' || parsed.number === null) {
        ctx.errors.push({ message: 'closeIssue: unknown issueId' });
        return null;
      }
      const repo = findRepoById(ctx.store, parsed.repoId);
      const issue = repo?.issues.get(parsed.number);
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'closeIssue: unknown issueId' });
        return null;
      }
      issue.state = 'closed';
      repo.version += 1;
      return { type: 'CloseIssuePayload', issue: issueObj(repo, issue) };
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(input.repositoryId);
      if (parsed === null || parsed.kind !== 'Repository') {
        ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
        return null;
      }
      const repo = findRepoById(ctx.store, parsed.repoId);
      if (repo === undefined) {
        ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
        return null;
      }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (branchTip(repo, head) === undefined || branchTip(repo, base) === undefined) {
        ctx.errors.push({ message: 'createPullRequest: the head or base branch does not exist' });
        return null;
      }
      const pull = createPull(ctx.store, repo, title, body, head, base);
      return { type: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(input.pullRequestId);
      if (parsed === null || parsed.kind !== 'PullRequest' || parsed.number === null) {
        ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
        return null;
      }
      const repo = findRepoById(ctx.store, parsed.repoId);
      const pull = repo?.pulls.get(parsed.number);
      if (repo === undefined || pull === undefined) {
        ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
        return null;
      }
      const outcome = squashMerge(repo, pull);
      if (!outcome.ok) {
        ctx.errors.push({ message: `mergePullRequest: ${outcome.reason}` });
        return null;
      }
      return { type: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
    },
    addComment: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(input.subjectId);
      if (parsed === null || parsed.number === null) {
        ctx.errors.push({ message: 'addComment: unknown subjectId' });
        return null;
      }
      const repo = findRepoById(ctx.store, parsed.repoId);
      const target = repo !== undefined && (repo.issues.has(parsed.number) || repo.pulls.has(parsed.number)) ? parsed.number : null;
      if (repo === undefined || target === null) {
        ctx.errors.push({ message: 'addComment: unknown subjectId' });
        return null;
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = addComment(repo, target, body);
      return {
        type: 'AddCommentPayload',
        commentEdge: {
          type: 'IssueCommentEdge',
          node: { type: 'IssueComment', globalId: globalId('IssueComment', repo.id, comment.id), body: comment.body },
        },
      };
    },
  },
  CreateIssuePayload: {
    issue: (source) => source.issue,
  },
  CloseIssuePayload: {
    issue: (source) => source.issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => source.pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => source.pullRequest,
  },
  AddCommentPayload: {
    commentEdge: (source) => source.commentEdge,
  },
};

// ---------------------------------------------------------------- execution

/** Whether a fragment's type condition applies to an object of `typeName`. */
function fragmentApplies(condition: string | null, typeName: string): boolean {
  if (condition === null) return true;
  if (condition === typeName) return true;
  if (condition === 'Node') return NODE_TYPES.has(typeName);
  return false;
}

/** Expand fragments into the flat field list a selection set yields. */
function collectFields(
  selections: readonly SelectionNode[],
  typeName: string,
  ctx: ExecContext,
  out: FieldNode[],
  seenFragments: Set<string>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push(selection);
    } else if (selection.kind === 'inlineFragment') {
      if (fragmentApplies(selection.typeCondition, typeName)) {
        collectFields(selection.selectionSet, typeName, ctx, out, seenFragments);
      }
    } else {
      if (seenFragments.has(selection.name)) continue;
      seenFragments.add(selection.name);
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragmentApplies(fragment.typeCondition, typeName)) {
        collectFields(fragment.selectionSet, typeName, ctx, out, seenFragments);
      }
    }
  }
}

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as Obj).type === 'string';
}

/** Execute a selection set against one object; null stays null. */
function executeSelections(
  selections: readonly SelectionNode[],
  typeName: string,
  source: Obj,
  ctx: ExecContext,
): Record<string, unknown> {
  const fields: FieldNode[] = [];
  collectFields(selections, typeName, ctx, fields, new Set());
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    const args = resolveArgs(field, ctx.variables);
    let value: unknown;
    if (field.name === '__typename') {
      value = source.type;
    } else {
      const resolver = RESOLVERS[typeName]?.[field.name] ?? RESOLVERS[source.type]?.[field.name];
      if (resolver === undefined) {
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
        value = null;
      } else {
        try {
          value = resolver(source, args, ctx);
        } catch (err) {
          ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
          value = null;
        }
      }
    }
    if (field.selectionSet !== null && value !== null && value !== undefined) {
      const childType = FIELD_TYPE[typeName]?.[field.name];
      if (Array.isArray(value)) {
        value = value.map((item) =>
          isObj(item) ? executeSelections(field.selectionSet!, childType === 'Node' ? item.type : (childType ?? item.type), item, ctx) : item,
        );
      } else if (isObj(value)) {
        const effective = childType === 'Node' || childType === undefined ? value.type : childType;
        value = executeSelections(field.selectionSet, effective, value, ctx);
      }
    }
    out[key] = value ?? null;
  }
  return out;
}

/** Run one operation document: {data} or {data, errors}. */
function executeOperation(body: Record<string, unknown>, store: Store): Record<string, unknown> {
  const query = body.query;
  if (typeof query !== 'string' || query === '') {
    return { data: null, errors: [{ message: 'the request carries no query document' }] };
  }
  let doc: DocumentNode;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation =
    operationName !== null
      ? doc.operations.find((op) => op.name === operationName)
      : doc.operations.length === 1
        ? doc.operations[0]
        : undefined;
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'the document names no operation to run' }] };
  }
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  for (const variable of operation.variables) {
    if (!(variable.name in variables) && variable.defaultValue !== null) {
      variables[variable.name] = resolveValue(variable.defaultValue, variables);
    }
  }
  const errors: GqlError[] = [];
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(operation.selectionSet, rootType, doc, errors);
  if (errors.length > 0) return { data: null, errors };
  const ctx: ExecContext = { store, variables, fragments: doc.fragments, errors };
  const data = executeSelections(operation.selectionSet, rootType, { type: rootType }, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

// ---------------------------------------------------------------- HTTP handler

/** Route POST /api/graphql (single operations and batched arrays). */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  if (!isAuthenticated(req, ctx.token)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) =>
      typeof entry === 'object' && entry !== null ? executeOperation(entry as Record<string, unknown>, ctx.store) : { data: null, errors: [{ message: 'a batched entry is not an object' }] },
    );
    sendJson(res, 200, results);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  sendJson(res, 200, executeOperation(parsed as Record<string, unknown>, ctx.store));
}
