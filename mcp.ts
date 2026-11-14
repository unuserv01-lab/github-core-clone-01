// MCP endpoint (JSON-RPC 2.0 Streamable HTTP), modern revision 2026-07-28 via
// server/discover, with the legacy initialize handshake as a fallback.
// Tools act on the same Store as REST, so ids are stable across surfaces.
import type { Store } from './store.ts';

const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

export interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown>; }
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo', description: 'Create a repository owned by the viewer.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, owner: { type: 'string', description: 'Owner login (defaults to the viewer)' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] },
  },
  {
    name: 'get_repo', description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue', description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues', description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request', description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request', description: 'Merge a pull request (squash) and close it.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

function toolByName(name: string): ToolDef | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = norm(name);
  for (const t of TOOLS) {
    const tn = norm(t.name);
    if (n === tn || n.endsWith(tn)) return t;
  }
  return undefined;
}
function repoFromArgs(store: Store, args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) { owner = owner || parts[0]!; repo = repo || parts[1]!; }
  }
  if (!owner) owner = store.viewer.login;
  if (!repo) return null;
  return { owner, repo };
}
function textResult(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}
function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function handleMcp(store: Store, rawBody: Buffer): { status: number; body: unknown } {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) throw new Error('not an object');
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = msg.id ?? null;
  const method = msg.method as string | undefined;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const ok = (result: unknown): { status: number; body: unknown } => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const rpcErr = (code: number, message: string): { status: number; body: unknown } => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === undefined) return rpcErr(-32600, 'Invalid Request: no method');
  if (method === 'server/discover') {
    return ok({
      protocolVersion: '2026-07-28',
      supportedVersions: REVISIONS,
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const p = params as Record<string, unknown>;
    const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion : '2026-07-28';
    const negotiated = REVISIONS.includes(requested) ? requested : '2026-07-28';
    return ok({ protocolVersion: negotiated, serverInfo: SERVER_INFO, capabilities: { tools: {} } });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: {} };
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = toolByName(name);
    if (!tool) return rpcErr(-32602, `Unknown tool: ${name}`);
    const required = ((tool.inputSchema.required as string[]) ?? []);
    const missing = required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
    if (missing.length) return rpcErr(-32602, `Missing required argument(s): ${missing.join(', ')}`);
    try {
      return ok(callTool(store, tool.name, args));
    } catch (e) {
      return ok(errorResult(e instanceof Error ? e.message : String(e)));
    }
  }
  return rpcErr(-32601, `Method not found: ${method}`);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const v = store.viewer;
  if (name === 'create_repo') {
    const repoName = String(args.name ?? '');
    const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
    if (!repo) throw new Error(`Repository "${repoName}" already exists`);
    return textResult(repoJson(store, repo));
  }
  const target = repoFromArgs(store, args);
  if (!target) throw new Error('owner and repo are required');
  const repo = store.repo(target.owner, target.repo);
  if (name === 'get_repo') {
    if (!repo) throw new Error(`Repository ${target.owner}/${target.repo} not found`);
    return textResult(repoJson(store, repo));
  }
  if (!repo) throw new Error(`Repository ${target.owner}/${target.repo} not found`);
  if (name === 'create_issue') {
    const created = store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
    if ('error' in created) throw new Error(created.error);
    return textResult(issueJson(store, repo, created));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => a.number - b.number);
    return textResult(list.map((i) => issueJson(store, repo, i)));
  }
  if (name === 'create_pull_request') {
    const pr = store.createPR(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', String(args.head ?? ''), String(args.base ?? ''));
    if ('error' in pr) throw new Error(pr.error);
    return textResult(prJson(store, repo, pr));
  }
  if (name === 'merge_pull_request') {
    const n = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
    const pr = repo.pulls.get(n);
    if (!pr) throw new Error(`Pull request #${n} not found`);
    if (store.prConflict(repo, pr)) throw new Error('merge conflict');
    const sha = store.mergePR(repo, pr);
    if (!sha) throw new Error('merge conflict');
    return textResult({ sha, merged: true, message: `Pull request #${n} merged`, number: n, pull_number: n });
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function repoJson(store: Store, repo: import('./store.ts').Repo): Record<string, unknown> {
  return {
    id: repo.id, node_id: store.repoGid(repo), name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.viewer.id, type: 'User' },
    private: repo.private, description: repo.description, default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`, url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt, updated_at: repo.updatedAt,
  };
}
export function issueJson(store: Store, repo: import('./store.ts').Repo, issue: import('./store.ts').Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: store.issueGid(repo, issue), number: issue.number, title: issue.title,
    body: issue.body, state: issue.state, labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    created_at: issue.createdAt, updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}
export function prJson(store: Store, repo: import('./store.ts').Repo, pr: import('./store.ts').PullRequest): Record<string, unknown> {
  return {
    id: pr.id, node_id: store.prGid(repo, pr), number: pr.number, title: pr.title, body: pr.body,
    state: pr.state, merged: pr.merged, merged_at: pr.mergedAt, merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    created_at: pr.createdAt, updated_at: pr.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
}
