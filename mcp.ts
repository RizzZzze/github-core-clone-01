// The Model Context Protocol endpoint at POST /mcp: JSON-RPC 2.0 over Streamable
// HTTP, modern era (2026-07-28) with server/discover, plus the legacy
// initialize handshake for clients that predate discover. One handler, no
// session state: every request is independent, so concurrent calls keep their
// own ids and their own objects.
//
// The six tools act on the same in-memory store as REST and GraphQL — a
// repository or issue created over MCP is the same object over REST, with the
// same stable id — and merge_pull_request calls the shared performMerge, so
// the merge is the same two-parent merge commit on every surface.
//
// Errors: a body that is not JSON is HTTP 400 with JSON-RPC -32700; an
// unknown method is -32601; an unknown tool is -32602; a tool called without
// its required arguments answers isError: true (never HTTP 500).

import { FIXED_TIME, RepoStore, VIEWER_LOGIN, repoJson, type IssueRecord, type PullRecord, type RepoRecord } from './store.ts';
import { performMerge } from './merge.ts';

export interface McpDeps {
  store: RepoStore;
}

export interface McpOutcome {
  status: number;
  /** null means an empty body (a 202 for a notification). */
  body: unknown | null;
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

/** The tool list, built once: two tools/list answers are byte-identical. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from one branch into another.',
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
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsList(): Record<string, unknown>[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function issueJson(rec: RepoRecord, issue: IssueRecord, origin: string): Record<string, unknown> {
  return {
    id: rec.id * 1_000_000 + issue.number,
    node_id: `I_${rec.id}_${issue.number}`,
    url: `${origin}/api/v3/repos/${rec.ownerLogin}/${rec.name}/issues/${issue.number}`,
    html_url: `${origin}/${rec.ownerLogin}/${rec.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: 'ededed', description: '' })),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: issue.state === 'closed' ? FIXED_TIME : null,
    comments: issue.comments.length,
  };
}

function pullJson(rec: RepoRecord, pull: PullRecord, origin: string): Record<string, unknown> {
  return {
    id: rec.id * 1_000_000 + pull.number,
    node_id: `PR_${rec.id}_${pull.number}`,
    url: `${origin}/api/v3/repos/${rec.ownerLogin}/${rec.name}/pulls/${pull.number}`,
    html_url: `${origin}/${rec.ownerLogin}/${rec.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { label: `${rec.ownerLogin}:${pull.head}`, ref: pull.head, sha: pull.headSha },
    base: { label: `${rec.ownerLogin}:${pull.base}`, ref: pull.base, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open',
  };
}

type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function toolError(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

function toolOk(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

export function createMcpHandler(deps: McpDeps): (raw: Buffer | null, origin: string) => McpOutcome {
  const { store } = deps;

  const lookupRepo = (args: Record<string, unknown>): RepoRecord | string => {
    if (args.owner !== VIEWER_LOGIN) return 'Repository not found';
    const rec = store.get(String(args.repo ?? ''));
    return rec === undefined ? 'Repository not found' : rec;
  };

  const runTool = (name: string, args: Record<string, unknown>, origin: string): ToolResult => {
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined) return { ok: false, message: `Unknown tool: ${name}` };
    for (const required of tool.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return { ok: false, message: `Missing required argument: ${required}` };
      }
    }
    switch (name) {
      case 'create_repo': {
        const rec = store.create({
          name: String(args.name),
          description: typeof args.description === 'string' ? args.description : null,
          isPrivate: args.private === true,
          defaultBranch: 'main',
        });
        if (rec === null) return { ok: false, message: `Repository '${String(args.name)}' already exists` };
        return { ok: true, value: repoJson(rec, origin) };
      }
      case 'get_repo': {
        const rec = lookupRepo(args);
        if (typeof rec === 'string') return { ok: false, message: rec };
        return { ok: true, value: repoJson(rec, origin) };
      }
      case 'create_issue': {
        const rec = lookupRepo(args);
        if (typeof rec === 'string') return { ok: false, message: rec };
        const number = ++rec.issueSeq;
        const issue: IssueRecord = {
          id: number, number, title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          state: 'open', labels: [], comments: [], seq: number,
        };
        rec.issues.set(number, issue);
        return { ok: true, value: issueJson(rec, issue, origin) };
      }
      case 'list_issues': {
        const rec = lookupRepo(args);
        if (typeof rec === 'string') return { ok: false, message: rec };
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = [...rec.issues.values()]
          .filter((issue) => state === 'all' || issue.state === state)
          .sort((a, b) => b.seq - a.seq)
          .map((issue) => issueJson(rec, issue, origin));
        return { ok: true, value: list };
      }
      case 'create_pull_request': {
        const rec = lookupRepo(args);
        if (typeof rec === 'string') return { ok: false, message: rec };
        const head = String(args.head);
        const base = String(args.base);
        const headSha = rec.refs.get(`refs/heads/${head}`);
        const baseSha = rec.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) {
          return { ok: false, message: 'Unknown head or base branch' };
        }
        const number = ++rec.pullSeq;
        const pull: PullRecord = {
          id: number, number, title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          state: 'open', head, base, headSha, baseSha,
          merged: false, mergedAt: null, mergeCommitSha: null, seq: number,
        };
        rec.pulls.set(number, pull);
        return { ok: true, value: pullJson(rec, pull, origin) };
      }
      case 'merge_pull_request': {
        const rec = lookupRepo(args);
        if (typeof rec === 'string') return { ok: false, message: rec };
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
        const pull = rec.pulls.get(number);
        if (pull === undefined) return { ok: false, message: 'Pull request not found' };
        if (pull.state !== 'open') return { ok: false, message: 'Pull request is already closed' };
        const outcome = performMerge(rec, pull);
        if (!outcome.ok) return { ok: false, message: outcome.message };
        return { ok: true, value: pullJson(rec, pull, origin) };
      }
      default:
        return { ok: false, message: `Unknown tool: ${name}` };
    }
  };

  return (raw: Buffer | null, origin: string): McpOutcome => {
    if (raw === null) {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
    }
    if (!isRecord(parsed)) {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
    }
    const method = parsed.method;
    const id = parsed.id;
    const isNotification = id === undefined || id === null;
    if (typeof method !== 'string' || method === '') {
      if (isNotification) return { status: 202, body: null };
      return { status: 400, body: { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } } };
    }
    if (isNotification) {
      // Notifications (notifications/initialized and friends) get no answer.
      return { status: 202, body: null };
    }
    const params = isRecord(parsed.params) ? (parsed.params as Record<string, unknown>) : {};
    const ok = (result: unknown): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
    const err = (code: number, message: string): McpOutcome => ({
      status: 200,
      body: { jsonrpc: '2.0', id, error: { code, message } },
    });
    switch (method) {
      case 'server/discover':
        return ok({
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      case 'initialize': {
        const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
        return ok({
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: toolsList() });
      case 'tools/call': {
        const toolName = typeof params.name === 'string' ? params.name : '';
        const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
        if (toolName === '') return err(-32602, 'tools/call requires a tool name');
        if (TOOLS.find((t) => t.name === toolName) === undefined) {
          return err(-32602, `Unknown tool: ${toolName}`);
        }
        const result = runTool(toolName, args, origin);
        if (!result.ok) return ok(toolError(result.message));
        return ok(toolOk(result.value));
      }
      default:
        return err(-32601, `Method not found: ${method}`);
    }
  };
}
