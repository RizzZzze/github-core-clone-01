// A small GraphQL v4 engine for POST /api/graphql: a lexer and parser for the
// query language subset gh and github-mcp-server send (operations, variables,
// aliases, inline input objects and enum lists, inline fragments), a validator
// that reports unknown fields as GraphQL errors (HTTP 200, never an HTTP error),
// and an executor over the same in-memory store the REST routes use. No
// dependency, no clock: global ids are base64 of a typed payload, so repeated
// reads answer the same id.
//
// The schema surface is exactly what the suite's documents use: Query.viewer,
// Query.repository, Query.node, Query.__type, Repository (with issue, issues,
// pullRequest, pullRequests), Issue, PullRequest (with files), the five
// mutations (createIssue, closeIssue, createPullRequest, mergePullRequest,
// addComment), and cursor pagination on issues.

import { FIXED_TIME, RepoStore, VIEWER_LOGIN, type IssueRecord, type PullRecord, type RepoRecord } from './store.ts';
import { mergeableState, pullChangedPaths, type MergeOutcome } from './merge.ts';

export interface GraphqlDeps {
  store: RepoStore;
  merge: (rec: RepoRecord, pull: PullRecord) => MergeOutcome;
}

// -------------------------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, decodable. 'R:12', 'I:12:3', 'PR:12:1', 'IC:12:5'.
// -------------------------------------------------------------------------------------------

export function encodeGlobalId(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`).toString('base64');
}

export function decodeGlobalId(id: unknown): { kind: string; payload: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const sep = text.indexOf(':');
    if (sep <= 0) return null;
    return { kind: text.slice(0, sep), payload: text.slice(sep + 1) };
  } catch {
    return null;
  }
}

const repoGlobalId = (rec: RepoRecord): string => encodeGlobalId('R', String(rec.id));
const issueGlobalId = (rec: RepoRecord, issue: IssueRecord): string =>
  encodeGlobalId('I', `${rec.id}:${issue.number}`);
const pullGlobalId = (rec: RepoRecord, pull: PullRecord): string =>
  encodeGlobalId('PR', `${rec.id}:${pull.number}`);
const commentGlobalId = (rec: RepoRecord, commentId: number): string =>
  encodeGlobalId('IC', `${rec.id}:${commentId}`);

// -------------------------------------------------------------------------------------------
// Lexer.
// -------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const advance = (n = 1): void => {
    for (let k = 0; k < n; k += 1) {
      if (source[i] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      i += 1;
    }
  };
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      advance();
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...', line, column });
      advance(3);
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch, line, column });
      advance();
      continue;
    }
    if (ch === '"') {
      const startLine = line;
      const startColumn = column;
      advance();
      let value = '';
      while (i < source.length && source[i] !== '"') {
        const c = source[i] as string;
        if (c === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          value += map[esc] ?? esc;
          advance(2);
        } else {
          value += c;
          advance();
        }
      }
      if (i >= source.length) throw new Error(`Unterminated string at ${startLine}:${startColumn}`);
      advance();
      tokens.push({ kind: 'string', value, line: startLine, column: startColumn });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const start = i;
      const startColumn = column;
      if (ch === '-') advance();
      while (i < source.length && /[0-9]/.test(source[i] as string)) advance();
      let isFloat = false;
      if (source[i] === '.' && /[0-9]/.test(source[i + 1] ?? '')) {
        isFloat = true;
        advance();
        while (i < source.length && /[0-9]/.test(source[i] as string)) advance();
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(start, i), line, column: startColumn });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const start = i;
      const startColumn = column;
      while (i < source.length && /[_A-Za-z0-9]/.test(source[i] as string)) advance();
      tokens.push({ kind: 'name', value: source.slice(start, i), line, column: startColumn });
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at ${line}:${column}`);
  }
  return tokens;
}

// -------------------------------------------------------------------------------------------
// Parser.
// -------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface ArgumentNode {
  name: string;
  value: ValueNode;
}

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: ArgumentNode[];
  children: SelectionNode[] | null;
  line: number;
  column: number;
}

export type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; children: SelectionNode[] };

export interface TypeNode {
  kind: 'named' | 'list' | 'nonNull';
  name?: string;
  of?: TypeNode;
}

export interface VariableDef {
  name: string;
  type: TypeNode;
  defaultValue?: ValueNode;
}

export interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDef[];
  children: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): Token {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected '${value}' at ${token.line}:${token.column}, got ${JSON.stringify(token.value)}`);
    }
    return token;
  }

  private expectName(what = 'a name'): Token {
    const token = this.next();
    if (token.kind !== 'name') {
      throw new Error(`Expected ${what} at ${token.line}:${token.column}, got ${JSON.stringify(token.value)}`);
    }
    return token;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variables: [], children: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('a fragment name').value;
        const on = this.expectName("the 'on' keyword");
        if (on.value !== 'on') throw new Error(`Expected 'on' at ${on.line}:${on.column}`);
        this.expectName('a type name');
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      if (token.kind === 'name' && ['query', 'mutation', 'subscription'].includes(token.value)) {
        const kind = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName !== undefined && maybeName.kind === 'name') name = this.next().value;
        let variables: VariableDef[] = [];
        const maybeParen = this.peek();
        if (maybeParen !== undefined && maybeParen.kind === 'punct' && maybeParen.value === '(') {
          variables = this.parseVariableDefinitions();
        }
        operations.push({ kind, name, variables, children: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`Unexpected token ${JSON.stringify(token.value)} at ${token.line}:${token.column}`);
    }
    if (operations.length === 0) throw new Error('Document holds no operation');
    return { operations, fragments };
  }

  private parseVariableDefinitions(): VariableDef[] {
    this.expectPunct('(');
    const defs: VariableDef[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('Unterminated variable definitions');
      if (token.kind === 'punct' && token.value === ')') {
        this.next();
        return defs;
      }
      this.expectPunct('$');
      const name = this.expectName('a variable name').value;
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      const maybeEq = this.peek();
      if (maybeEq !== undefined && maybeEq.kind === 'punct' && maybeEq.value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, type, defaultValue });
    }
  }

  private parseType(): TypeNode {
    const token = this.peek();
    if (token === undefined) throw new Error('Unexpected end of type');
    let type: TypeNode;
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', of: inner };
    } else {
      type = { kind: 'named', name: this.expectName('a type name').value };
    }
    const bang = this.peek();
    if (bang !== undefined && bang.kind === 'punct' && bang.value === '!') {
      this.next();
      return { kind: 'nonNull', of: type };
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('Unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const token = this.peek() as Token;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type name').value;
        return { kind: 'inlineFragment', typeCondition, children: this.parseSelectionSet() };
      }
      if (next !== undefined && next.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      return { kind: 'inlineFragment', typeCondition: null, children: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first.value;
    const colon = this.peek();
    if (colon !== undefined && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = name;
      name = this.expectName('a field name after the alias').value;
    }
    let args: ArgumentNode[] = [];
    const paren = this.peek();
    if (paren !== undefined && paren.kind === 'punct' && paren.value === '(') {
      args = this.parseArguments();
    }
    let children: SelectionNode[] | null = null;
    const brace = this.peek();
    if (brace !== undefined && brace.kind === 'punct' && brace.value === '{') {
      children = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, children, line: first.line, column: first.column };
  }

  private parseArguments(): ArgumentNode[] {
    this.expectPunct('(');
    const args: ArgumentNode[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('Unterminated arguments');
      if (token.kind === 'punct' && token.value === ')') {
        this.next();
        return args;
      }
      const name = this.expectName('an argument name').value;
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'punct':
        if (token.value === '$') {
          const name = this.expectName('a variable name');
          return { kind: 'variable', name: name.value };
        }
        if (token.value === '[') {
          const items: ValueNode[] = [];
          while (true) {
            const next = this.peek();
            if (next === undefined) throw new Error('Unterminated list value');
            if (next.kind === 'punct' && next.value === ']') {
              this.next();
              return { kind: 'list', items };
            }
            items.push(this.parseValue());
          }
        }
        if (token.value === '{') {
          const fields: { name: string; value: ValueNode }[] = [];
          while (true) {
            const next = this.peek();
            if (next === undefined) throw new Error('Unterminated object value');
            if (next.kind === 'punct' && next.value === '}') {
              this.next();
              return { kind: 'object', fields };
            }
            const name = this.expectName('an object field name').value;
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
        }
        throw new Error(`Unexpected '${token.value}' as a value at ${token.line}:${token.column}`);
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error(`Unexpected token ${JSON.stringify(token.value)} as a value`);
    }
  }
}

function parseDocument(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

// -------------------------------------------------------------------------------------------
// Schema: the field names each type carries (drives validation and __type), and the enums.
// -------------------------------------------------------------------------------------------

const FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'description',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'createdAt', 'updatedAt',
  ],
  User: ['login', 'id', 'name'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
};

const ENUMS: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const TYPE_KIND: Record<string, string> = {
  Query: 'OBJECT', Mutation: 'OBJECT', Repository: 'OBJECT', Issue: 'OBJECT',
  PullRequest: 'OBJECT', User: 'OBJECT', Ref: 'OBJECT', IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT', PullRequestChangedFileConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT', IssueCommentEdge: 'OBJECT', IssueComment: 'OBJECT',
  PageInfo: 'OBJECT', __Type: 'OBJECT', __Field: 'OBJECT', __EnumValue: 'OBJECT',
  CreateIssuePayload: 'OBJECT', CloseIssuePayload: 'OBJECT', CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT', AddCommentPayload: 'OBJECT',
  SearchType: 'ENUM', IssueState: 'ENUM', PullRequestState: 'ENUM', MergeableState: 'ENUM',
  IssueOrderField: 'ENUM', OrderDirection: 'ENUM', RepositoryPermission: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
};

// -------------------------------------------------------------------------------------------
// Nodes: every resolved object carries its GraphQL type; scalars are plain values.
// -------------------------------------------------------------------------------------------

type Node = Record<string, unknown> & { __type: string };

interface ExecCtx {
  deps: GraphqlDeps;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string; path: (string | number)[] }[];
}

const makeCursor = (seq: number): string => encodeGlobalId('C', String(seq));

function decodeCursor(after: unknown): number | null {
  if (typeof after !== 'string' || after === '') return null;
  const decoded = decodeGlobalId(after);
  if (decoded === null || decoded.kind !== 'C') return null;
  const seq = Number.parseInt(decoded.payload, 10);
  return Number.isFinite(seq) ? seq : null;
}

function repoNode(rec: RepoRecord): Node {
  return { __type: 'Repository', rec };
}

function issueNode(rec: RepoRecord, issue: IssueRecord): Node {
  return { __type: 'Issue', rec, issue };
}

function pullNode(rec: RepoRecord, pull: PullRecord): Node {
  return { __type: 'PullRequest', rec, pull };
}

function userNode(login: string): Node {
  return { __type: 'User', login };
}

function createIssueRecord(rec: RepoRecord, title: string, body: string): IssueRecord {
  const number = ++rec.issueSeq;
  const issue: IssueRecord = {
    id: number, number, title, body, state: 'open', labels: [], comments: [], seq: number,
  };
  rec.issues.set(number, issue);
  return issue;
}

function createPullRecord(rec: RepoRecord, head: string, base: string, title: string, body: string): PullRecord {
  const headSha = rec.refs.get(`refs/heads/${head}`) as string;
  const baseSha = rec.refs.get(`refs/heads/${base}`) as string;
  const number = ++rec.pullSeq;
  const pull: PullRecord = {
    id: number, number, title, body, state: 'open', head, base, headSha, baseSha,
    merged: false, mergedAt: null, mergeCommitSha: null, seq: number,
  };
  rec.pulls.set(number, pull);
  return pull;
}

function repoByGlobalId(deps: GraphqlDeps, id: unknown): RepoRecord | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'R') return null;
  const numeric = Number.parseInt(decoded.payload, 10);
  if (!Number.isFinite(numeric)) return null;
  return deps.store.list().find((rec) => rec.id === numeric) ?? null;
}

function issueByGlobalId(deps: GraphqlDeps, id: unknown): { rec: RepoRecord; issue: IssueRecord } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'I') return null;
  const [repoId, num] = decoded.payload.split(':');
  const rec = deps.store.list().find((r) => r.id === Number.parseInt(repoId ?? '', 10));
  if (rec === undefined) return null;
  const issue = rec.issues.get(Number.parseInt(num ?? '', 10));
  return issue === undefined ? null : { rec, issue };
}

function pullByGlobalId(deps: GraphqlDeps, id: unknown): { rec: RepoRecord; pull: PullRecord } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PR') return null;
  const [repoId, num] = decoded.payload.split(':');
  const rec = deps.store.list().find((r) => r.id === Number.parseInt(repoId ?? '', 10));
  if (rec === undefined) return null;
  const pull = rec.pulls.get(Number.parseInt(num ?? '', 10));
  return pull === undefined ? null : { rec, pull };
}

// -------------------------------------------------------------------------------------------
// Resolvers.
// -------------------------------------------------------------------------------------------

type Resolver = (parent: Node, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

function issuesConnection(rec: RepoRecord, args: Record<string, unknown>): Node {
  let list = [...rec.issues.values()];
  const states = args.states;
  if (Array.isArray(states)) {
    list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction ?? 'DESC';
  list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  const cursorSeq = decodeCursor(args.after);
  if (cursorSeq !== null) {
    list = list.filter((issue) => (direction === 'ASC' ? issue.seq > cursorSeq : issue.seq < cursorSeq));
  }
  const first = typeof args.first === 'number' ? args.first : undefined;
  const page = first !== undefined ? list.slice(0, first) : list;
  const hasNextPage = first !== undefined ? list.length > first : false;
  const last = page.length > 0 ? page[page.length - 1] : undefined;
  const firstPage = page.length > 0 ? page[0] : undefined;
  const endCursor = last === undefined ? null : makeCursor(last.seq);
  const startCursor = firstPage === undefined ? null : makeCursor(firstPage.seq);
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => issueNode(rec, issue)),
    pageInfo: { __type: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor, endCursor },
    totalCount: list.length,
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userNode(VIEWER_LOGIN),
    repository: (parent, args, ctx) => {
      if (args.owner !== VIEWER_LOGIN) return null;
      const rec = ctx.deps.store.get(String(args.name ?? ''));
      return rec === undefined ? null : repoNode(rec);
    },
    node: (parent, args, ctx) => {
      const decoded = decodeGlobalId(args.id);
      if (decoded === null) return null;
      if (decoded.kind === 'R') {
        const rec = repoByGlobalId(ctx.deps, args.id);
        return rec === null ? null : repoNode(rec);
      }
      if (decoded.kind === 'I') {
        const found = issueByGlobalId(ctx.deps, args.id);
        return found === null ? null : issueNode(found.rec, found.issue);
      }
      if (decoded.kind === 'PR') {
        const found = pullByGlobalId(ctx.deps, args.id);
        return found === null ? null : pullNode(found.rec, found.pull);
      }
      return null;
    },
    __type: (parent, args) => {
      const name = String(args.name ?? '');
      if (FIELDS[name] === undefined && ENUMS[name] === undefined) return null;
      return {
        __type: '__Type',
        name,
        kind: TYPE_KIND[name] ?? 'OBJECT',
        fields: FIELDS[name] ?? [],
        enumValues: ENUMS[name] ?? [],
      };
    },
  },
  Mutation: {
    createIssue: (parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const rec = repoByGlobalId(ctx.deps, input.repositoryId);
      if (rec === null) throw new Error('Unknown repository id');
      if (typeof input.title !== 'string' || input.title === '') throw new Error('createIssue requires a title');
      const issue = createIssueRecord(rec, input.title, typeof input.body === 'string' ? input.body : '');
      return { __type: 'CreateIssuePayload', issue: issueNode(rec, issue) };
    },
    closeIssue: (parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(ctx.deps, input.issueId);
      if (found === null) throw new Error('Unknown issue id');
      found.issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: issueNode(found.rec, found.issue) };
    },
    createPullRequest: (parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const rec = repoByGlobalId(ctx.deps, input.repositoryId);
      if (rec === null) throw new Error('Unknown repository id');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (head === '' || base === '') throw new Error('createPullRequest requires headRefName and baseRefName');
      if (!rec.refs.has(`refs/heads/${head}`) || !rec.refs.has(`refs/heads/${base}`)) {
        throw new Error('Unknown head or base branch');
      }
      if (typeof input.title !== 'string' || input.title === '') throw new Error('createPullRequest requires a title');
      const pull = createPullRecord(rec, head, base, input.title, '');
      return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(rec, pull) };
    },
    mergePullRequest: (parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByGlobalId(ctx.deps, input.pullRequestId);
      if (found === null) throw new Error('Unknown pull request id');
      if (found.pull.state !== 'open') throw new Error('Pull request is already closed');
      const outcome = ctx.deps.merge(found.rec, found.pull);
      if (!outcome.ok) throw new Error(outcome.message);
      return { __type: 'MergePullRequestPayload', pullRequest: pullNode(found.rec, found.pull) };
    },
    addComment: (parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(ctx.deps, input.subjectId);
      if (found === null) throw new Error('Unknown subject id');
      if (typeof input.body !== 'string' || input.body === '') throw new Error('addComment requires a body');
      const comment = { id: ++found.rec.commentSeq, body: input.body, createdAt: FIXED_TIME };
      found.issue.comments.push(comment);
      return {
        __type: 'AddCommentPayload',
        commentEdge: {
          __type: 'IssueCommentEdge',
          node: { __type: 'IssueComment', id: commentGlobalId(found.rec, comment.id), body: comment.body },
          cursor: null,
        },
      };
    },
  },
  Repository: {
    id: (parent) => repoGlobalId(parent.rec as RepoRecord),
    databaseId: (parent) => (parent.rec as RepoRecord).id,
    name: (parent) => (parent.rec as RepoRecord).name,
    nameWithOwner: (parent) => {
      const rec = parent.rec as RepoRecord;
      return `${rec.ownerLogin}/${rec.name}`;
    },
    description: (parent) => (parent.rec as RepoRecord).description,
    owner: (parent) => userNode((parent.rec as RepoRecord).ownerLogin),
    defaultBranchRef: (parent) => {
      const rec = parent.rec as RepoRecord;
      return rec.refs.has(`refs/heads/${rec.defaultBranch}`) ? { __type: 'Ref', name: rec.defaultBranch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args) => {
      const rec = parent.rec as RepoRecord;
      const issue = rec.issues.get(Number(args.number));
      return issue === undefined ? null : issueNode(rec, issue);
    },
    issues: (parent, args) => issuesConnection(parent.rec as RepoRecord, args),
    pullRequests: (parent, args) => {
      const rec = parent.rec as RepoRecord;
      const open = [...rec.pulls.values()].filter((pull) => pull.state === 'open').sort((a, b) => b.seq - a.seq);
      const first = typeof args.first === 'number' ? args.first : undefined;
      const page = first !== undefined ? open.slice(0, first) : open;
      return {
        __type: 'PullRequestConnection',
        nodes: page.map((pull) => pullNode(rec, pull)),
        pageInfo: { __type: 'PageInfo', hasNextPage: first !== undefined ? open.length > first : false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: open.length,
      };
    },
    pullRequest: (parent, args) => {
      const rec = parent.rec as RepoRecord;
      const pull = rec.pulls.get(Number(args.number));
      return pull === undefined ? null : pullNode(rec, pull);
    },
  },
  Issue: {
    id: (parent) => issueGlobalId(parent.rec as RepoRecord, parent.issue as IssueRecord),
    number: (parent) => (parent.issue as IssueRecord).number,
    title: (parent) => (parent.issue as IssueRecord).title,
    body: (parent) => (parent.issue as IssueRecord).body,
    state: (parent) => ((parent.issue as IssueRecord).state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: () => FIXED_TIME,
    updatedAt: () => FIXED_TIME,
    author: () => userNode(VIEWER_LOGIN),
  },
  PullRequest: {
    id: (parent) => pullGlobalId(parent.rec as RepoRecord, parent.pull as PullRecord),
    number: (parent) => (parent.pull as PullRecord).number,
    title: (parent) => (parent.pull as PullRecord).title,
    body: (parent) => (parent.pull as PullRecord).body,
    state: (parent) => {
      const pull = parent.pull as PullRecord;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (parent) => (parent.pull as PullRecord).merged,
    headRefName: (parent) => (parent.pull as PullRecord).head,
    baseRefName: (parent) => (parent.pull as PullRecord).base,
    mergeable: (parent) => mergeableState(parent.rec as RepoRecord, parent.pull as PullRecord),
    files: (parent, args) => {
      const rec = parent.rec as RepoRecord;
      const pull = parent.pull as PullRecord;
      const paths = pullChangedPaths(rec, pull.headSha, pull.baseSha);
      const first = typeof args.first === 'number' ? args.first : undefined;
      const page = first !== undefined ? paths.slice(0, first) : paths;
      return {
        __type: 'PullRequestChangedFileConnection',
        nodes: page.map((path) => ({ __type: 'PullRequestChangedFile', path })),
        pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: paths.length,
      };
    },
    createdAt: () => FIXED_TIME,
    updatedAt: () => FIXED_TIME,
  },
  User: {
    login: (parent) => parent.login as string,
    id: () => 1000,
    name: () => null,
  },
  Ref: {
    name: (parent) => parent.name as string,
  },
  IssueConnection: {
    nodes: (parent) => parent.nodes as unknown[],
    edges: (parent) => (parent.nodes as Node[]).map((node) => ({ __type: 'IssueEdge', node, cursor: null })),
    pageInfo: (parent) => parent.pageInfo as Node,
    totalCount: (parent) => parent.totalCount as number,
  },
  PullRequestConnection: {
    nodes: (parent) => parent.nodes as unknown[],
    edges: (parent) => (parent.nodes as Node[]).map((node) => ({ __type: 'PullRequestEdge', node, cursor: null })),
    pageInfo: (parent) => parent.pageInfo as Node,
    totalCount: (parent) => parent.totalCount as number,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => parent.nodes as unknown[],
    edges: (parent) => (parent.nodes as Node[]).map((node) => ({ __type: 'PullRequestChangedFileEdge', node, cursor: null })),
    pageInfo: (parent) => parent.pageInfo as Node,
    totalCount: (parent) => parent.totalCount as number,
  },
  PullRequestChangedFile: {
    path: (parent) => parent.path as string,
  },
  IssueCommentEdge: {
    node: (parent) => parent.node as Node,
    cursor: (parent) => (parent.cursor as string | null) ?? null,
  },
  IssueComment: {
    id: (parent) => parent.id as string,
    body: (parent) => parent.body as string,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage as boolean,
    hasPreviousPage: (parent) => parent.hasPreviousPage as boolean,
    startCursor: (parent) => (parent.startCursor as string | null) ?? null,
    endCursor: (parent) => (parent.endCursor as string | null) ?? null,
  },
  __Type: {
    name: (parent) => parent.name as string,
    kind: (parent) => parent.kind as string,
    description: () => null,
    fields: (parent) => (parent.fields as string[]).map((name) => ({ __type: '__Field', name })),
    enumValues: (parent) => (parent.enumValues as string[]).map((name) => ({ __type: '__EnumValue', name })),
  },
  __Field: {
    name: (parent) => parent.name as string,
    description: () => null,
    args: () => [],
    type: () => null,
  },
  __EnumValue: {
    name: (parent) => parent.name as string,
    description: () => null,
  },
  CreateIssuePayload: {
    issue: (parent) => parent.issue as Node,
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (parent) => parent.issue as Node,
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest as Node,
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest as Node,
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (parent) => parent.commentEdge as Node,
    clientMutationId: () => null,
  },
};

// -------------------------------------------------------------------------------------------
// Executor: resolve argument values, walk selection sets, collect GraphQL errors.
// An unknown field is a 200 with an errors array naming it, never an HTTP error.
// -------------------------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
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
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function typeNameOf(value: unknown): string | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const type = (value as Node).__type;
    return typeof type === 'string' ? type : null;
  }
  return null;
}

function executeSelections(
  selections: SelectionNode[],
  parent: Node,
  parentType: string,
  ctx: ExecCtx,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) {
        Object.assign(out, executeSelections(fragment, parent, parentType, ctx, path));
      }
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === parentType) {
        Object.assign(out, executeSelections(selection.children, parent, parentType, ctx, path));
      }
      continue;
    }
    const field = selection;
    const key = field.alias ?? field.name;
    const fieldPath = [...path, key];
    if (field.name === '__typename') {
      out[key] = parentType;
      continue;
    }
    const known = FIELDS[parentType] ?? [];
    if (!known.includes(field.name)) {
      ctx.errors.push({
        message: `Cannot query field "${field.name}" on type "${parentType}".`,
        path: fieldPath,
      });
      out[key] = null;
      continue;
    }
    const resolver = RESOLVERS[parentType]?.[field.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `No resolver for field "${field.name}" on type "${parentType}".`, path: fieldPath });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
    let value: unknown;
    try {
      value = resolver(parent, args, ctx);
    } catch (err) {
      ctx.errors.push({
        message: err instanceof Error ? err.message : String(err),
        path: fieldPath,
      });
      out[key] = null;
      continue;
    }
    if (field.children === null || value === null || value === undefined) {
      out[key] = value ?? null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((entry, index) => {
        const type = typeNameOf(entry);
        if (type === null) return entry;
        return executeSelections(field.children as SelectionNode[], entry as Node, type, ctx, [...fieldPath, index]);
      });
      continue;
    }
    const childType = typeNameOf(value);
    if (childType === null) {
      out[key] = value;
      continue;
    }
    out[key] = executeSelections(field.children, value as Node, childType, ctx, fieldPath);
  }
  return out;
}

function executeOperation(
  operation: OperationNode,
  variables: Record<string, unknown>,
  deps: GraphqlDeps,
  fragments: Map<string, SelectionNode[]>,
): { data: Record<string, unknown> | null; errors: { message: string; path: (string | number)[] }[] } {
  const ctx: ExecCtx = { deps, variables, fragments, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: Node = { __type: rootType };
  const data = executeSelections(operation.children, root, rootType, ctx, []);
  return { data, errors: ctx.errors };
}

function executeBody(
  body: unknown,
  deps: GraphqlDeps,
): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with a query string' }] };
  }
  const query = (body as Record<string, unknown>).query;
  if (typeof query !== 'string' || query === '') {
    return { data: null, errors: [{ message: 'Request body must carry a query string' }] };
  }
  const variables = (body as Record<string, unknown>).variables;
  const variablesObj: Record<string, unknown> =
    variables !== null && typeof variables === 'object' && !Array.isArray(variables)
      ? (variables as Record<string, unknown>)
      : {};
  let doc: DocumentNode;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = (body as Record<string, unknown>).operationName;
  let operation: OperationNode | undefined;
  if (typeof operationName === 'string' && operationName !== '') {
    operation = doc.operations.find((op) => op.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}"` }] };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else {
    return { data: null, errors: [{ message: 'Multiple operations require an operationName' }] };
  }
  // Variable defaults fill in values the caller did not send.
  const mergedVariables: Record<string, unknown> = { ...variablesObj };
  for (const def of operation.variables) {
    if (mergedVariables[def.name] === undefined && def.defaultValue !== undefined) {
      mergedVariables[def.name] = resolveValue(def.defaultValue, variablesObj);
    }
  }
  const { data, errors } = executeOperation(operation, mergedVariables, deps, doc.fragments);
  const out: Record<string, unknown> = { data };
  if (errors.length > 0) out.errors = errors;
  return out;
}

/** Handle one POST /api/graphql body (a single operation, or a JSON array of them). */
export function createGraphqlHandler(deps: GraphqlDeps): (body: unknown) => unknown {
  return (body: unknown) => {
    if (Array.isArray(body)) return body.map((entry) => executeBody(entry, deps));
    return executeBody(body, deps);
  };
}
