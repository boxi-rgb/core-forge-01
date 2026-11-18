// The MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP (revision 2026-07-28
// server/discover, or the initialize handshake), six tools over the shared store.

import type { HandlerContext } from './app.ts';
import { store, VIEWER, type IssueRec, type RepoRec } from './store.ts';
import { sendJson } from './util.ts';
import { buildCommit, parseCommit, storeObject } from './gitobj.ts';

const SERVER_INFO = { name: 'core-forge', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const REVISION_RE = /^\d{4}-\d{2}-\d{2}$/;

// Tool definitions are built exactly once, with a fixed key order, so two
// tools/list answers serialize byte for byte identically.
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The contents of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The name of the branch where your changes are implemented.' },
        base: { type: 'string', description: 'The name of the branch you want the changes pulled into.' },
        body: { type: 'string', description: 'The contents of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

const TOOL_NAMES = new Set<string>(TOOLS.map((t) => t.name));
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

// ---------------------------------------------------------------- helpers

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strArg(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function numArg(args: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}

/** Resolve owner/repo from the argument spellings the client may send (incl. full_name). */
function ownerRepo(args: Record<string, unknown>): { owner: string | null; repo: string | null } {
  let owner = strArg(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login');
  let repo = strArg(args, 'repo', 'repository', 'repository_name', 'repo_name');
  const full = strArg(args, 'full_name', 'repo_full_name', 'repository_full_name', 'fullName');
  const combined = repo ?? full;
  if (combined !== null && combined.includes('/')) {
    const idx = combined.indexOf('/');
    if (owner === null) owner = combined.slice(0, idx);
    repo = combined.slice(idx + 1);
  } else if (repo === null && full !== null) {
    repo = full;
  }
  return { owner, repo };
}

/** Normalize the semantic arguments for a tool into the canonical names used below. */
function normalizedArgs(tool: string, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if (tool === 'create_repo') {
    const name = strArg(raw, 'name', 'repo', 'repository', 'repository_name', 'repo_name');
    if (name !== null) out.name = name.includes('/') ? name.split('/').pop()! : name;
    const desc = strArg(raw, 'description', 'about', 'summary');
    if (desc !== null) out.description = desc;
    if (typeof raw.private === 'boolean') out.private = raw.private;
    else if (typeof raw.is_private === 'boolean') out.private = raw.is_private;
    return out;
  }
  const { owner, repo } = ownerRepo(raw);
  if (owner !== null) out.owner = owner;
  if (repo !== null) out.repo = repo;
  if (tool === 'merge_pull_request') {
    const n = numArg(raw, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number');
    if (n !== null) out.pull_number = n;
  }
  return out;
}

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.ownerLogin}/${repo.name}`,
    owner: { login: repo.ownerLogin, id: VIEWER.id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function shortRef(full: string): string {
  return full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : full;
}
function fullRef(ref: string): string {
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
}

function issueJson(repo: RepoRec, rec: IssueRec): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: rec.number,
    number: rec.number,
    title: rec.title,
    body: rec.body,
    state: rec.state,
    labels: rec.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000', description: label?.description ?? null };
    }),
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    comments: rec.comments.length,
  };
  if (rec.pull !== null) {
    base.pull_request = { merged_at: rec.pull.mergedAt };
    base.head = { ref: shortRef(rec.pull.headRef), sha: rec.pull.headSha, label: `${repo.ownerLogin}:${shortRef(rec.pull.headRef)}` };
    base.base = { ref: shortRef(rec.pull.baseRef), sha: rec.pull.baseSha, label: `${repo.ownerLogin}:${shortRef(rec.pull.baseRef)}` };
    base.merged = rec.pull.merged;
    base.merged_at = rec.pull.mergedAt;
    base.merge_commit_sha = rec.pull.mergeCommitSha;
  }
  return base;
}

type ToolOutcome =
  | { kind: 'ok'; payload: unknown; textPayload?: unknown }
  | { kind: 'toolError'; message: string }
  | { kind: 'invalid'; message: string };

function ok(payload: unknown, textPayload?: unknown): ToolOutcome {
  return { kind: 'ok', payload, textPayload };
}
function toolError(message: string): ToolOutcome {
  return { kind: 'toolError', message };
}

// ---------------------------------------------------------------- tools

function runTool(tool: string, rawArgs: Record<string, unknown>): ToolOutcome {
  const args = normalizedArgs(tool, rawArgs);
  // Required-argument validation (canonical names after normalization).
  for (const req of REQUIRED[tool] ?? []) {
    const v = args[req];
    if (v === undefined || v === null || (typeof v === 'string' && v === '')) {
      return { kind: 'invalid', message: `Missing required argument: ${req}` };
    }
  }

  switch (tool) {
    case 'create_repo': {
      const name = String(args.name);
      if (store.getRepo(VIEWER.login, name) !== undefined) return toolError(`Repository ${VIEWER.login}/${name} already exists`);
      const repo = store.createRepo(name, {
        description: typeof args.description === 'string' ? args.description : undefined,
        isPrivate: typeof args.private === 'boolean' ? args.private : undefined,
      });
      return ok(repoJson(repo));
    }
    case 'get_repo': {
      const { owner, repo: repoName } = ownerRepo(args);
      const repo = owner !== null && repoName !== null ? store.getRepo(owner, repoName) : undefined;
      if (repo === undefined) return toolError('Repository not found');
      return ok(repoJson(repo));
    }
    case 'create_issue': {
      const { owner, repo: repoName } = ownerRepo(args);
      const repo = owner !== null && repoName !== null ? store.getRepo(owner, repoName) : undefined;
      if (repo === undefined) return toolError('Repository not found');
      const now = store.nowIso();
      const rec: IssueRec = {
        number: repo.nextNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open',
        labels: [],
        createdAt: now,
        updatedAt: now,
        comments: [],
        pull: null,
      };
      repo.issues.set(rec.number, rec);
      return ok(issueJson(repo, rec));
    }
    case 'list_issues': {
      const { owner, repo: repoName } = ownerRepo(args);
      const repo = owner !== null && repoName !== null ? store.getRepo(owner, repoName) : undefined;
      if (repo === undefined) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const all = [...repo.issues.values()]
        .filter((rec) => rec.pull === null)
        .sort((a, b) => a.number - b.number);
      const filtered = state === 'all' ? all : all.filter((rec) => rec.state === state);
      const list = filtered.map((rec) => issueJson(repo, rec));
      return ok({ issues: list }, list);
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = ownerRepo(args);
      const repo = owner !== null && repoName !== null ? store.getRepo(owner, repoName) : undefined;
      if (repo === undefined) return toolError('Repository not found');
      const headRef = fullRef(String(args.head));
      const baseRef = fullRef(String(args.base));
      const headSha = repo.refs.get(headRef);
      const baseSha = repo.refs.get(baseRef);
      if (headSha === undefined) return toolError(`Head branch not found: ${String(args.head)}`);
      if (baseSha === undefined) return toolError(`Base branch not found: ${String(args.base)}`);
      const now = store.nowIso();
      const rec: IssueRec = {
        number: repo.nextNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open',
        labels: [],
        createdAt: now,
        updatedAt: now,
        comments: [],
        pull: { headRef, baseRef, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null },
      };
      repo.issues.set(rec.number, rec);
      return ok(issueJson(repo, rec));
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = ownerRepo(args);
      const repo = owner !== null && repoName !== null ? store.getRepo(owner, repoName) : undefined;
      if (repo === undefined) return toolError('Repository not found');
      const number = numArg(args, 'pull_number');
      if (number === null) return { kind: 'invalid', message: 'Missing required argument: pull_number' };
      const rec = repo.issues.get(number);
      if (rec === undefined || rec.pull === null) return toolError('Pull request not found');
      if (rec.pull.merged) {
        return ok({ sha: rec.pull.mergeCommitSha ?? rec.pull.headSha, merged: true, message: 'Pull Request successfully merged' });
      }
      // Squash merge: one new commit on the base whose tree is the head tree and whose
      // only parent is the old base; fall back to advancing the base to the head sha
      // when the git object layer cannot build that commit.
      const headSha = repo.refs.get(rec.pull.headRef) ?? rec.pull.headSha;
      const baseSha = repo.refs.get(rec.pull.baseRef) ?? rec.pull.baseSha;
      let mergeSha = headSha;
      try {
        const headObj = repo.objects.get(headSha);
        const baseObj = repo.objects.get(baseSha);
        if (headObj !== undefined && baseObj !== undefined && headObj.type === 'commit' && baseObj.type === 'commit') {
          const headCommit = parseCommit(headObj.data);
          const stamp = store.nowUnix();
          const line = `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`;
          const data = buildCommit({
            tree: headCommit.tree,
            parents: [baseSha],
            author: line,
            committer: line,
            message: `${rec.title} (#${rec.number})\n`,
          });
          mergeSha = storeObject(repo, 'commit', data);
        }
      } catch {
        mergeSha = headSha;
      }
      const mergedAt = store.nowIso();
      rec.pull.merged = true;
      rec.pull.mergedAt = mergedAt;
      rec.pull.mergeCommitSha = mergeSha;
      rec.pull.headSha = headSha;
      rec.pull.baseSha = baseSha;
      rec.state = 'closed';
      rec.updatedAt = mergedAt;
      repo.refs.set(rec.pull.baseRef, mergeSha);
      return ok({ sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
    }
    default:
      return { kind: 'invalid', message: `Unknown tool: ${tool}` };
  }
}

// ---------------------------------------------------------------- JSON-RPC

interface RpcReply {
  status: number;
  payload: Record<string, unknown> | null; // null -> empty body (notifications)
}

function rpcResult(id: unknown, result: unknown): RpcReply {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}
function rpcError(id: unknown, status: number, code: number, message: string): RpcReply {
  return { status, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function handleOne(msg: Record<string, unknown>): RpcReply {
  const id = msg.id;
  const isNotification = id === undefined;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = isRecord(msg.params) ? msg.params : {};

  if (method.startsWith('notifications/')) {
    return { status: 202, payload: null };
  }

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' && REVISION_RE.test(params.protocolVersion)
        ? params.protocolVersion
        : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!TOOL_NAMES.has(name)) {
        return rpcError(id, 200, -32602, `Unknown tool: ${name === '' ? '(missing name)' : name}`);
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      let outcome: ToolOutcome;
      try {
        outcome = runTool(name, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
      }
      if (outcome.kind === 'invalid') return rpcError(id, 200, -32602, outcome.message);
      if (outcome.kind === 'toolError') {
        return rpcResult(id, { content: [{ type: 'text', text: outcome.message }], isError: true });
      }
      const text = JSON.stringify(outcome.textPayload ?? outcome.payload);
      const result: Record<string, unknown> = { content: [{ type: 'text', text }] };
      if (isRecord(outcome.payload)) result.structuredContent = outcome.payload;
      return rpcResult(id, result);
    }
    default: {
      if (isNotification) return { status: 202, payload: null };
      return rpcError(id, 200, -32601, `Method not found: ${method}`);
    }
  }
}

export async function handleMcp(ctx: HandlerContext): Promise<void> {
  const { req, res, body } = ctx;

  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET') {
    // No standalone SSE stream is offered.
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found: GET stream not supported' } });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  // Batch (not used by the conformance client, but cheap to answer correctly).
  if (Array.isArray(parsed)) {
    const replies: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      const reply = handleOne(entry);
      if (reply.payload !== null) replies.push(reply.payload);
    }
    if (replies.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, replies as unknown as Record<string, unknown>);
    return;
  }

  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: isRecord(parsed) ? (parsed.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }

  const reply = handleOne(parsed);
  if (reply.payload === null) {
    res.writeHead(reply.status);
    res.end();
    return;
  }
  sendJson(res, reply.status, reply.payload);
}
