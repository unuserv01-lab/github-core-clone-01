// test-forge.ts — deterministic regression tests for the github-core-clone-01 entry.
// Runs the forge in-process (no model, no network beyond loopback) and exercises:
//  A. pack integrity (unit: readPack/writePack) and receivePack atomicity (real git CLI)
//  B. GraphQL: single registry introspection, resolvers, pagination, mutations, errors
//  C. git smart HTTP with the real git CLI (clone/fetch/push/branch/non-FF/delete/tag/delta)
//  D. MCP: initialize, tools/list, tools/call x6, error handling
//  E. REST smoke (repo + issue + PR creation used as fixtures)
// Usage: node --experimental-strip-types test-forge.ts   (or: npm test)
// Exits 0 only when every named test passes.
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MAKEFUN_SHOP_TOKEN = 'forge-test-token';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const V2_DIR = dirname(fileURLToPath(import.meta.url));
// The server runs as a separate process: git CLI calls below use execSync, which
// blocks this process's event loop, so an in-process server could never answer
// the git client's HTTP requests (that deadlock hung the first run).
const child = spawn('node', ['--experimental-strip-types', 'forge-server.ts'], {
  cwd: V2_DIR,
  env: { ...process.env, MAKEFUN_SHOP_TOKEN: 'forge-test-token' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const port = await new Promise<number>((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('forge server did not print PORT')), 15000);
  child.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    const m = /PORT (\d+)/.exec(buf);
    if (m) { clearTimeout(timer); resolve(parseInt(m[1]!, 10)); }
  });
  child.on('error', reject);
  child.on('exit', (code) => reject(new Error(`forge server exited early with code ${code}`)));
});
const gitcore = await import('./gitcore.ts');
const { readPack, writePack, packChecksumOk } = gitcore;

const TOKEN = 'forge-test-token';
let passed = 0; let failed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (e) { failed += 1; failures.push(name); console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}
function eq(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function ok(cond: boolean, what: string): void { if (!cond) throw new Error(what); }
function throws(fn: () => unknown, match: RegExp, what: string): void {
  try { fn(); } catch (e) { if (match.test(e instanceof Error ? e.message : String(e))) return; throw new Error(`${what}: wrong error: ${e instanceof Error ? e.message : String(e)}`); }
  throw new Error(`${what}: did not throw`);
}

const base = `http://127.0.0.1:${port}`;
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
async function req(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<[number, any]> {
  const r = await fetch(base + path, { method, headers: { ...H, ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text();
  try { return [r.status, JSON.parse(t)]; } catch { return [r.status, t]; }
}
async function gql(query: string, variables: Record<string, unknown> = {}): Promise<[number, any]> {
  return req('POST', '/api/graphql', { query, variables });
}
async function mcp(body: unknown, raw = false): Promise<[number, any]> {
  const r = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: raw ? String(body) : JSON.stringify(body),
  });
  const t = await r.text();
  try { return [r.status, JSON.parse(t)]; } catch { return [r.status, t]; }
}
async function mcpCall(tool: string, args: Record<string, unknown>): Promise<any> {
  const [s, b] = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
  ok(s === 200, `mcp ${tool} http ${s}`);
  return b;
}
function mcpText(b: any): any {
  const c = b?.result?.content?.[0];
  ok(c?.type === 'text', `mcp result has no text content: ${JSON.stringify(b)}`);
  return JSON.parse(c.text);
}

// ---------- fixtures: viewer, one repo, one issue, one PR ----------
const [, me] = await req('GET', '/api/v3/user');
const owner = me.login as string;
const [, repo] = await req('POST', '/api/v3/user/repos', { name: 'forge-test', description: 'forge regression repo' });
eq(repo.name, 'forge-test', 'repo created');
const b64 = (s: string) => Buffer.from(s).toString('base64');
const [, c1] = await req('PUT', `/api/v3/repos/${owner}/forge-test/contents/README.md`, { message: 'init', content: b64('hello forge\n') });
const [, br] = await req('POST', `/api/v3/repos/${owner}/forge-test/git/refs`, { ref: 'refs/heads/feature', sha: c1.commit.sha });
const [, issue1] = await req('POST', `/api/v3/repos/${owner}/forge-test/issues`, { title: 'First bug', body: 'first body' });
const [, issue2] = await req('POST', `/api/v3/repos/${owner}/forge-test/issues`, { title: 'Second bug', body: 'second body' });
const [, pr1] = await req('POST', `/api/v3/repos/${owner}/forge-test/pulls`, { title: 'PR one', body: 'pr body', head: 'feature', base: 'main' });
const prNum = pr1.number as number;
ok(prNum > 0, 'pr created');

// ---------- A. pack integrity (unit) ----------
const blob = (s: string) => ({ type: 'blob' as const, data: Buffer.from(s) });
const goodPack = writePack([blob('alpha\n'), blob('beta\nbeta\n')]);
await test('pack: valid pack round-trips', () => {
  const entries = readPack(goodPack);
  eq(entries.length, 2, 'entry count');
  eq(entries[0]!.data.toString(), 'alpha\n', 'first blob');
  ok(packChecksumOk(goodPack), 'trailer checksum ok');
});
await test('pack: corrupt SHA-1 trailer rejected', () => {
  const bad = Buffer.from(goodPack);
  bad[bad.length - 1] ^= 0xff; // flip a trailer byte
  throws(() => readPack(bad), /checksum/, 'corrupt trailer');
});
await test('pack: wrong version rejected', () => {
  const bad = Buffer.from(goodPack);
  bad.writeUInt32BE(9, 4);
  bad.subarray(bad.length - 20).set(createHash('sha1').update(bad.subarray(0, bad.length - 20)).digest());
  throws(() => readPack(bad), /version/, 'version 9 with valid checksum');
});
await test('pack: truncated pack rejected', () => {
  throws(() => readPack(goodPack.subarray(0, goodPack.length - 5)), /checksum|truncated|too small/, 'truncated');
});
await test('pack: trailing bytes rejected', () => {
  const bad = Buffer.concat([goodPack, Buffer.from('xyz')]);
  throws(() => readPack(bad), /checksum|trailing/, 'trailing bytes');
});
await test('pack: declared count above bound rejected', () => {
  const bad = Buffer.from(goodPack);
  bad.writeUInt32BE(100_001, 8);
  bad.subarray(bad.length - 20).set(createHash('sha1').update(bad.subarray(0, bad.length - 20)).digest());
  throws(() => readPack(bad), /too many objects/, 'count 100001');
});
await test('pack: too-small buffer rejected', () => {
  throws(() => readPack(Buffer.alloc(10)), /too small|bad pack header/, '10 bytes');
});

// ---------- B. GraphQL ----------
await test('graphql: repository fields (rules list)', async () => {
  const [, b] = await gql(`query { repository(owner: "${owner}", name: "forge-test") { id databaseId name nameWithOwner viewerPermission hasIssuesEnabled } }`);
  ok(b.data?.repository?.name === 'forge-test', `repository name: ${JSON.stringify(b)}`);
  eq(b.data.repository.viewerPermission, 'ADMIN', 'viewer permission');
});
await test('graphql: introspection is exactly the rules lists', async () => {
  const want: Record<string, string[]> = {
    Issue: ['id', 'number', 'title', 'state', 'body'],
    PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
    Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  };
  for (const [t, fields] of Object.entries(want)) {
    const [, b] = await gql(`query { __type(name: "${t}") { fields { name } } }`);
    // Order is the registry's own; the rules list the same set.
    eq([...b.data.__type.fields.map((f: any) => f.name)].sort(), [...fields].sort(), `__type ${t}`);
  }
  const [, s] = await gql('query { __type(name: "SearchType") { enumValues { name } } }');
  ok(s.data.__type.enumValues.map((e: any) => e.name).includes('ISSUE'), 'SearchType includes ISSUE');
});
await test('graphql: PR title/body served (not rejected)', async () => {
  const [, b] = await gql(`query { repository(owner: "${owner}", name: "forge-test") { pullRequest(number: ${prNum}) { title body state merged } } }`);
  eq(b.data.repository.pullRequest.title, 'PR one', 'pr title');
  eq(b.data.repository.pullRequest.body, 'pr body', 'pr body');
});
await test('graphql: advertised fields return real values, not null', async () => {
  const [, b] = await gql(`query { repository(owner: "${owner}", name: "forge-test") { description isPrivate url createdAt updatedAt issue(number: 1) { createdAt updatedAt url author { login } labels { nodes { name } } } pullRequest(number: ${prNum}) { createdAt url author { login } mergeCommit { oid } mergedAt } } }`);
  const r = b.data.repository;
  eq(r.description, 'forge regression repo', 'repo description');
  eq(r.isPrivate, false, 'repo isPrivate');
  ok(typeof r.url === 'string' && r.url.includes('forge-test'), 'repo url');
  ok(typeof r.createdAt === 'string' && r.createdAt.length > 0, 'repo createdAt');
  ok(typeof r.issue.createdAt === 'string' && r.issue.createdAt.length > 0, 'issue createdAt');
  eq(r.issue.author.login, owner, 'issue author');
  eq(r.pullRequest.createdAt.length > 0, true, 'pr createdAt');
  eq(r.pullRequest.author.login, owner, 'pr author');
  eq(r.pullRequest.mergeCommit, null, 'unmerged pr mergeCommit is null');
});
await test('graphql: issues pagination default order pages to the end', async () => {
  const q = (first: number, after: string | null) => gql(`query { repository(owner: "${owner}", name: "forge-test") { issues(first: ${first}${after ? `, after: "${after}"` : ''}) { nodes { number } pageInfo { hasNextPage endCursor } } } }`);
  const [, p1] = await q(1, null);
  eq(p1.data.repository.issues.nodes.map((n: any) => n.number), [1], 'page 1');
  ok(p1.data.repository.issues.pageInfo.hasNextPage === true, 'page 1 hasNext');
  const cur = p1.data.repository.issues.pageInfo.endCursor as string;
  const [, p2] = await q(1, cur);
  eq(p2.data.repository.issues.nodes.map((n: any) => n.number), [2], 'page 2');
  eq(p2.data.repository.issues.pageInfo.hasNextPage, false, 'page 2 no next');
});
await test('graphql: issues pagination honours orderBy DESC with after', async () => {
  // create three more issues so DESC paging has 5 to walk
  for (const t of ['Third bug', 'Fourth bug', 'Fifth bug']) {
    await req('POST', `/api/v3/repos/${owner}/forge-test/issues`, { title: t, body: 'b' });
  }
  // The mutation test above already created one more issue, so derive the
  // expected numbers from the live list instead of assuming a fixed count.
  const [, all] = await req('GET', `/api/v3/repos/${owner}/forge-test/issues?per_page=100`);
  const nums = (all as any[]).map((i: any) => i.number).sort((a: number, b: number) => b - a);
  const q = (first: number, after: string | null) => gql(`query { repository(owner: "${owner}", name: "forge-test") { issues(first: ${first}, orderBy: { field: CREATED_AT, direction: DESC }${after ? `, after: "${after}"` : ''}) { nodes { number } pageInfo { hasNextPage endCursor } } } }`);
  const [, p1] = await q(2, null);
  eq(p1.data.repository.issues.nodes.map((n: any) => n.number), nums.slice(0, 2), 'DESC page 1');
  const [, p2] = await q(2, p1.data.repository.issues.pageInfo.endCursor);
  eq(p2.data.repository.issues.nodes.map((n: any) => n.number), nums.slice(2, 4), 'DESC page 2');
  const [, p3] = await q(2, p2.data.repository.issues.pageInfo.endCursor);
  eq(p3.data.repository.issues.nodes.map((n: any) => n.number), nums.slice(4), 'DESC page 3');
  eq(p3.data.repository.issues.pageInfo.hasNextPage, false, 'DESC page 3 no next');
});
await test('graphql: create issue / create PR / merge PR mutations', async () => {
  const [, rg] = await gql(`query { repository(owner: "${owner}", name: "forge-test") { id pullRequest(number: ${prNum}) { id } } }`);
  const repoGid = rg.data.repository.id as string;
  const [, c] = await gql(`mutation { createIssue(input: { repositoryId: "${repoGid}", title: "GQL bug", body: "gql body" }) { issue { number title } } }`);
  ok(typeof c.data?.createIssue?.issue?.number === 'number', `createIssue: ${JSON.stringify(c)}`);
  const [, p] = await gql(`mutation { createPullRequest(input: { repositoryId: "${repoGid}", title: "GQL PR", headRefName: "feature", baseRefName: "main" }) { pullRequest { id number title } } }`);
  const n = p.data?.createPullRequest?.pullRequest?.number as number;
  const prGid = p.data?.createPullRequest?.pullRequest?.id as string;
  ok(typeof n === 'number', `createPullRequest: ${JSON.stringify(p)}`);
  const [, m] = await gql(`mutation { mergePullRequest(input: { pullRequestId: "${prGid}" }) { pullRequest { merged state } } }`);
  eq(m.data?.mergePullRequest?.pullRequest?.merged, true, 'merged via gql');
  const [, after] = await gql(`query { repository(owner: "${owner}", name: "forge-test") { pullRequest(number: ${n}) { mergedAt mergeCommit { oid } } } }`);
  ok(typeof after.data.repository.pullRequest.mergedAt === 'string', 'mergedAt set after merge');
  ok(typeof after.data.repository.pullRequest.mergeCommit?.oid === 'string', 'mergeCommit set after merge');
});
await test('graphql: unknown field errors, unknown repo is null', async () => {
  const [, b] = await gql(`query { repository(owner: "${owner}", name: "forge-test") { nosuchfield } }`);
  ok(Array.isArray(b.errors) && b.errors.length > 0, 'unknown field errors');
  const [, u] = await gql(`query { repository(owner: "${owner}", name: "no-such-repo") { id } }`);
  eq(u.data.repository, null, 'unknown repo null');
});
await test('graphql: two operations in one body both answered', async () => {
  const [s, b] = await req('POST', '/api/graphql', [
    { query: 'query { viewer { login } }' },
    { query: 'query { __type(name: "Issue") { fields { name } } }' },
  ]);
  eq(s, 200, 'batched http 200');
  ok(Array.isArray(b) && b.length === 2, `batched array of 2: ${JSON.stringify(b)}`);
  eq(b[0].data.viewer.login, owner, 'batched first: viewer login');
  ok(b[1].data.__type.fields.length >= 5, 'batched second: Issue fields');
});

// ---------- D. MCP ----------
await test('mcp: initialize', async () => {
  const [s, b] = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'forge-test', version: '1' } } });
  eq(s, 200, 'initialize http');
  ok(typeof b.result?.protocolVersion === 'string', `protocolVersion: ${JSON.stringify(b)}`);
  ok(typeof b.result?.serverInfo?.name === 'string', 'serverInfo name');
});
await test('mcp: tools/list is deterministic (byte-identical twice)', async () => {
  const [s1, b1] = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const [, b2] = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  eq(s1, 200, 'tools/list http 1');
  // The echoed request id differs by design; the result must be identical.
  eq(JSON.stringify(b1.result), JSON.stringify(b2.result), 'tools/list identical');
  eq(b1.result.tools.map((t: any) => t.name), ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'], 'six tools');
});
await test('mcp: all six tools call through', async () => {
  const created = await mcpCall('create_repo', { name: 'mcp-repo', description: 'via mcp' });
  ok(mcpText(created).name === 'mcp-repo', `create_repo: ${JSON.stringify(created)}`);
  const got = await mcpCall('get_repo', { owner, repo: 'mcp-repo' });
  eq(mcpText(got).name, 'mcp-repo', 'get_repo');
  const iss = await mcpCall('create_issue', { owner, repo: 'mcp-repo', title: 'MCP bug', body: 'mcp body' });
  ok(typeof mcpText(iss).number === 'number', `create_issue: ${JSON.stringify(iss)}`);
  const list = await mcpCall('list_issues', { owner, repo: 'mcp-repo' });
  ok(Array.isArray(mcpText(list)) && mcpText(list).length >= 1, 'list_issues');
  // branch + PR via REST, merge via MCP
  const [, cc] = await req('PUT', `/api/v3/repos/${owner}/mcp-repo/contents/README.md`, { message: 'init', content: b64('mcp hello\n') });
  await req('POST', `/api/v3/repos/${owner}/mcp-repo/git/refs`, { ref: 'refs/heads/feat', sha: cc.commit.sha });
  const pr = await mcpCall('create_pull_request', { owner, repo: 'mcp-repo', title: 'MCP PR', head: 'feat', base: 'main' });
  const prN = mcpText(pr).number as number;
  ok(typeof prN === 'number', `create_pull_request: ${JSON.stringify(pr)}`);
  const merged = await mcpCall('merge_pull_request', { owner, repo: 'mcp-repo', pull_number: prN });
  ok(mcpText(merged).merged === true, `merge_pull_request: ${JSON.stringify(merged)}`);
});
await test('mcp: unknown tool / missing argument / parse error / no auth', async () => {
  const [, u] = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  ok(u.error?.code === -32602 || u.error?.code === -32601, `unknown tool code: ${JSON.stringify(u)}`);
  const [, miss] = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_issue', arguments: { owner } } });
  ok(miss.error?.code === -32602 || miss.result?.isError === true, `missing arg: ${JSON.stringify(miss)}`);
  const [ps, pb] = await mcp('{not json', true);
  eq(ps, 400, 'parse error http 400');
  ok(pb.error?.code === -32700, `parse error code: ${JSON.stringify(pb)}`);
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  eq(r.status, 401, 'mcp without token is 401');
});

// ---------- E. REST: cached single-issue body ----------
await test('rest: single-issue GET is cached but PATCH invalidates it', async () => {
  const num = issue1.number as number;
  const [s1, b1] = await req('GET', `/api/v3/repos/${owner}/forge-test/issues/${num}`);
  eq(s1, 200, 'first GET status');
  eq(b1.title, 'First bug', 'first GET title');
  const [s2, b2] = await req('GET', `/api/v3/repos/${owner}/forge-test/issues/${num}`);
  eq(s2, 200, 'second GET status');
  eq(JSON.stringify(b2), JSON.stringify(b1), 'cached GET is identical');
  const [s3, b3] = await req('PATCH', `/api/v3/repos/${owner}/forge-test/issues/${num}`, { title: 'First bug (fixed)', state: 'closed' });
  eq(s3, 200, 'PATCH status');
  eq(b3.title, 'First bug (fixed)', 'PATCH response title');
  const [, b4] = await req('GET', `/api/v3/repos/${owner}/forge-test/issues/${num}`);
  eq(b4.title, 'First bug (fixed)', 'GET after PATCH shows new title');
  eq(b4.state, 'closed', 'GET after PATCH shows new state');
  await req('PATCH', `/api/v3/repos/${owner}/forge-test/issues/${num}`, { title: 'First bug', state: 'open' });
});

// ---------- C. git smart HTTP with the real git CLI ----------
const gitHome = mkdtempSync(join(tmpdir(), 'forge-git-'));
const gitEnv = { ...process.env, HOME: gitHome, GIT_AUTHOR_NAME: 'Forge Test', GIT_AUTHOR_EMAIL: 'forge@test.invalid', GIT_COMMITTER_NAME: 'Forge Test', GIT_COMMITTER_EMAIL: 'forge@test.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd: string, args: string) => execSync(`git ${args}`, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const work = mkdtempSync(join(tmpdir(), 'forge-work-'));
const cloneDir = join(work, 'clone1');
const remote = `${base}/${owner}/forge-test.git`;
await test('git: clone empty repo, push first commit, clone again', async () => {
  const [, emptyRepo] = await req('POST', '/api/v3/user/repos', { name: 'git-empty', description: 'empty' });
  const emptyUrl = `${base}/${owner}/git-empty.git`;
  const e1 = mkdtempSync(join(tmpdir(), 'forge-empty-'));
  git(e1, `clone ${emptyUrl} c`);
  ok(git(join(e1, 'c'), 'status').includes('No commits yet'), 'empty clone has no commits');
  const c1dir = mkdtempSync(join(tmpdir(), 'forge-c1-'));
  git(c1dir, `clone ${emptyUrl} c`);
  writeFileSync(join(c1dir, 'c', 'hello.txt'), 'hello git\n');
  git(join(c1dir, 'c'), 'add hello.txt');
  git(join(c1dir, 'c'), 'commit -m "first commit"');
  git(join(c1dir, 'c'), 'push origin HEAD:main');
  const c2dir = mkdtempSync(join(tmpdir(), 'forge-c2-'));
  git(c2dir, `clone ${emptyUrl} c`);
  const ls = git(join(c2dir, 'c'), 'log --oneline');
  ok(ls.includes('first commit'), 'second clone sees the pushed commit');
  const file = git(join(c2dir, 'c'), 'show HEAD:hello.txt');
  eq(file.trim(), 'hello git', 'blob content round-trips');
});
await test('git: fetch, new branch, fast-forward push, non-fast-forward rejection', async () => {
  git(work, `clone ${remote} clone1`);
  const d = cloneDir;
  git(d, 'fetch origin');
  git(d, 'checkout -b feature2');
  writeFileSync(join(d, 'feature.txt'), 'feature work\n');
  git(d, 'add feature.txt');
  git(d, 'commit -m "feature work"');
  git(d, 'push origin feature2');
  // fast-forward: advance main locally, push
  git(d, 'checkout main');
  writeFileSync(join(d, 'main.txt'), 'main advance\n');
  git(d, 'add main.txt');
  git(d, 'commit -m "main advance"');
  git(d, 'push origin main');
  // non-fast-forward: reset main back one commit, push (must be rejected)
  git(d, 'reset --hard HEAD~1');
  let rejected = false;
  try { git(d, 'push origin main'); } catch (e) { rejected = /non-fast-forward|rejected|failed to push/i.test(String((e as any).stderr ?? e)); }
  ok(rejected, 'non-fast-forward push rejected');
  git(d, 'reset --hard origin/main');
});
await test('git: 30 sequential pushes on one chain all fast-forward', async () => {
  // Own repo: the shared forge-test repo (and cloneDir's main) must stay in sync
  // for the delta/atomicity tests that follow.
  await req('POST', '/api/v3/user/repos', { name: 'forge-chain', description: 'chain' });
  const chainRemote = `${base}/${owner}/forge-chain.git`;
  const d2 = mkdtempSync(join(work, 'forge-chain-'));
  git(d2, `clone ${chainRemote} chain`);
  const cdir = join(d2, 'chain');
  writeFileSync(join(cdir, 'chain.txt'), 'change 0\n');
  git(cdir, 'add chain.txt');
  git(cdir, 'commit -m "chain 0"');
  git(cdir, 'push origin HEAD:main');
  for (let i = 1; i < 30; i += 1) {
    writeFileSync(join(cdir, 'chain.txt'), `change ${i}\n`);
    git(cdir, 'add chain.txt');
    git(cdir, `commit -m "chain ${i}"`);
    git(cdir, 'push origin main');
  }
  const log = git(cdir, 'log --oneline');
  const count = log.trim().split('\n').filter((l) => l.includes('chain ')).length;
  eq(count, 30, '30 chain commits present');
  // A non-fast-forward push on the deep chain is still rejected.
  git(cdir, 'reset --hard HEAD~1');
  let rejected = false;
  try { git(cdir, 'push origin main'); } catch (e) { rejected = /non-fast-forward|rejected|failed to push/i.test(String((e as any).stderr ?? e)); }
  ok(rejected, 'non-fast-forward on deep chain rejected');
});
await test('git: delete ref, annotated tag push, sideband report', async () => {
  const d = cloneDir;
  git(d, 'push origin :feature2');
  const ls = git(d, 'ls-remote --heads origin');
  ok(!ls.includes('feature2'), 'feature2 deleted');
  git(d, 'tag -a v1.0 -m "version one"');
  git(d, 'push origin v1.0');
  const tags = git(d, 'ls-remote --tags origin');
  ok(tags.includes('refs/tags/v1.0'), 'annotated tag pushed');
  const clone3 = mkdtempSync(join(tmpdir(), 'forge-c3-'));
  git(clone3, `clone ${remote} c`);
  const tagMsg = git(join(clone3, 'c'), 'tag -l -n1 v1.0');
  ok(tagMsg.includes('version one'), 'annotated tag message survives clone');
});
await test('git: delta packfile push round-trips (20 KB repeated file)', async () => {
  const d = cloneDir;
  const big = ('lorem ipsum dolor sit amet '.repeat(800)).slice(0, 20000);
  writeFileSync(join(d, 'big.txt'), big);
  git(d, 'add big.txt');
  git(d, 'commit -m "add big file"');
  git(d, 'push origin main');
  const clone4 = mkdtempSync(join(tmpdir(), 'forge-c4-'));
  git(clone4, `clone ${remote} c`);
  const got = git(join(clone4, 'c'), 'show HEAD:big.txt');
  eq(got.length, big.length, 'delta-packed blob size');
  eq(got, big, 'delta-packed blob content');
});
await test('git: corrupt pack push stores nothing (atomicity)', async () => {
  // Build a valid pack with git, corrupt its trailer, and hand-craft a
  // receive-pack request carrying it. The push must fail and the repo must be
  // unchanged afterwards (the same valid push then succeeds).
  const d = cloneDir;
  writeFileSync(join(d, 'atomic.txt'), 'atomic content\n');
  git(d, 'add atomic.txt');
  git(d, 'commit -m "atomic commit"');
  const sha = git(d, 'rev-parse HEAD').trim();
  // Capture the exact pack git would send via a bundle (a bundle IS a pack + refs).
  const packDir = mkdtempSync(join(tmpdir(), 'forge-pack-'));
  const bundle = join(packDir, 'x.bundle');
  git(d, `bundle create ${bundle} HEAD`);
  const bundleBuf = readFileSync(bundle);
  // Find the PACK magic inside the bundle and take the pack from there.
  const packStart = bundleBuf.indexOf(Buffer.from('PACK'));
  ok(packStart > 0, 'bundle contains a pack');
  const pack = bundleBuf.subarray(packStart);
  ok(packChecksumOk(pack), 'bundle pack checksum valid before corruption');
  const corrupt = Buffer.from(pack);
  corrupt[corrupt.length - 1] ^= 0xff; // break the SHA-1 trailer
  // Hand-built receive-pack body: pkt-lines for the command, flush, then the pack.
  const pkt = (s: string) => { const line = `${s}\n`; return Buffer.from(`${line.length.toString(16).padStart(4, '0')}${line}`); };
  const zero = '0000000000000000000000000000000000000000';
  const oldMain = git(d, 'rev-parse origin/main').trim();
  const body = Buffer.concat([
    pkt(`${oldMain} ${sha} refs/heads/main`),
    Buffer.from('0000'),
    corrupt,
  ]);
  const res = await fetch(`${base}/${owner}/forge-test.git/git-receive-pack`, { method: 'POST', headers: { 'content-type': 'application/x-git-receive-pack-request' }, body });
  const resText = await res.text();
  ok(/ng refs\/heads\/main|unpack/.test(resText), `corrupt push refused: ${resText.slice(0, 200)}`);
  // The ref must NOT have advanced, and the valid push must still succeed.
  const [, branches] = await req('GET', `/api/v3/repos/${owner}/forge-test/branches`);
  const main = (branches as any[]).find((b: any) => b.name === 'main');
  ok(main?.commit?.sha === oldMain, `main still at ${oldMain} after corrupt push`);
  git(d, 'push origin main');
  const [, branches2] = await req('GET', `/api/v3/repos/${owner}/forge-test/branches`);
  const main2 = (branches2 as any[]).find((b: any) => b.name === 'main');
  eq(main2?.commit?.sha, sha, 'valid push after corrupt push succeeds');
});

// ---------- summary ----------
console.log(`\ntest-forge: ${passed} passed, ${failed} failed${failures.length ? ` — failed: ${failures.join(', ')}` : ''}`);
child.kill();
rmSync(gitHome, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
