// The forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP, all in-memory
// over one shared Store. Every REST reply is application/json with X-GitHub-Request-Id.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { infoRefs, receivePack, uploadPack } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp, issueJson, prJson, repoJson } from './mcp.ts';
import { Store, type Issue, type Repo } from './store.ts';
import { hashObject, parseCommit } from './gitcore.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const store = new Store();

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': store.nextReqId(), ...headers, ...(status === 204 ? { 'content-length': '0' } : { 'content-length': String(Buffer.byteLength(text)) }) });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), 'x-github-request-id': store.nextReqId() });
  res.end(body);
}
function err(res: ServerResponse, status: number, message: string): void { sendJson(res, status, { message }); }

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/** Parse a JSON body; returns {ok:false} and sends 400 on malformed JSON. */
async function jsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    err(res, 400, 'Problems parsing JSON');
    return null;
  }
}
function authed(req: IncomingMessage): boolean {
  const token = store.token;
  if (!token) return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${token}`;
}
function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}
function dec(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }
function paginate<T>(items: T[], q: URLSearchParams, req: IncomingMessage, basePath: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, parseInt(q.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const next = `http://${host}${basePath}?per_page=${perPage}&page=${pageNum + 1}`;
    link = `<${next}>; rel="next"`;
  }
  return { page, link };
}
function baseUrlOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? 'localhost'}`;
}

// ---- contents helpers ----
function contentsCommit(storeRef: Store, repo: Repo, branch: string, path: string, contentB64: string, message: string, sha?: string): { status: number; body: Record<string, unknown> } {
  const tip = storeRef.refTip(repo, branch);
  const flat = tip ? storeRef.flattenTree(repo, parseCommit(repo.git.objects.get(tip)!.data).tree) : new Map<string, { oid: string; mode: string }>();
  const data = Buffer.from(contentB64, 'base64');
  const blobOid = storeRef.putObject(repo, 'blob', data);
  const existing = flat.get(path);
  if (sha !== undefined && existing && existing.oid !== sha) return { status: 409, body: { message: 'sha does not match' } };
  if (sha !== undefined && !existing) return { status: 409, body: { message: 'sha does not match' } };
  const isUpdate = existing !== undefined;
  flat.set(path, { oid: blobOid, mode: '100644' });
  const commitSha = storeRef.makeCommit(repo, branch, flat, message);
  return {
    status: isUpdate ? 200 : 201,
    body: {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitSha, message },
    },
  };
}
function contentsDelete(storeRef: Store, repo: Repo, branch: string, path: string, message: string): { status: number; body: Record<string, unknown> } {
  const tip = storeRef.refTip(repo, branch);
  if (!tip) return { status: 404, body: { message: 'Not Found' } };
  const flat = storeRef.flattenTree(repo, parseCommit(repo.git.objects.get(tip)!.data).tree);
  if (!flat.has(path)) return { status: 404, body: { message: 'Not Found' } };
  flat.delete(path);
  const commitSha = storeRef.makeCommit(repo, branch, flat, message);
  return { status: 200, body: { commit: { sha: commitSha, message } } };
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const q = queryOf(req);
      try {
        // ---- health probe (no auth) ----
        if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }

        // ---- git smart HTTP (no auth; the suite's git client sends none) ----
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
        if (gitMatch) {
          const owner = dec(gitMatch[1]!); const repoName = dec(gitMatch[2]!); const rest = gitMatch[3]!;
          const repo = owner === store.viewer.login ? store.repo(owner, repoName) : undefined;
          if (method === 'GET' && rest.startsWith('info/refs')) {
            const service = q.get('service') as 'git-upload-pack' | 'git-receive-pack' | null;
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { err(res, 400, 'unknown service'); return; }
            const r = infoRefs(store, repo, service, req.headers['git-protocol']);
            sendRaw(res, r.status, r.contentType, r.body);
            return;
          }
          if (method === 'POST' && rest === 'git-upload-pack') {
            const body = await readBody(req);
            const r = uploadPack(store, repo, body, req.headers['git-protocol']);
            sendRaw(res, r.status, r.contentType, r.body);
            return;
          }
          if (method === 'POST' && rest === 'git-receive-pack') {
            const body = await readBody(req);
            const r = receivePack(store, repo, body);
            sendRaw(res, r.status, r.contentType, r.body);
            return;
          }
          err(res, 404, 'Not Found');
          return;
        }

        // ---- GraphQL ----
        if (path === '/api/graphql') {
          if (method !== 'POST') { err(res, 404, 'Not Found'); return; }
          if (!authed(req)) { err(res, 401, 'Requires authentication'); return; }
          const raw = await readBody(req);
          let parsed: unknown;
          try { parsed = JSON.parse(raw.toString('utf8')); } catch { err(res, 400, 'Problems parsing JSON'); return; }
          const ops = Array.isArray(parsed) ? parsed : [parsed];
          const results = ops.map((op) => {
            const o = (op ?? {}) as Record<string, unknown>;
            const query = typeof o.query === 'string' ? o.query : '';
            const vars = (o.variables ?? {}) as Record<string, unknown>;
            return executeGraphQL(store, query, vars);
          });
          sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
          return;
        }

        // ---- MCP ----
        if (path === '/mcp') {
          if (method === 'DELETE') { sendJson(res, 200, {}); return; }
          if (method !== 'POST') { err(res, 404, 'Not Found'); return; }
          if (!authed(req)) { err(res, 401, 'Requires authentication'); return; }
          const raw = await readBody(req);
          const r = handleMcp(store, raw);
          sendJson(res, r.status, r.body, { 'content-type': JSON_TYPE });
          return;
        }

        // ---- REST v3 (auth required) ----
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          if (!authed(req)) { err(res, 401, 'Requires authentication'); return; }
          await handleRest(req, res, method, path, q);
          return;
        }

        err(res, 404, 'Not Found');
      } catch (e) {
        if (!res.headersSent) err(res, 500, e instanceof Error ? e.message : 'Internal Server Error');
        else res.end();
      }
    })();
  });
}

async function handleRest(req: IncomingMessage, res: ServerResponse, method: string, path: string, q: URLSearchParams): Promise<void> {
  const v = store.viewer;
  // API root
  if ((path === '/api/v3' || path === '/api/v3/')) {
    if (method !== 'GET') { err(res, 404, 'Not Found'); return; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', user_url: '/api/v3/users/{user}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (path === '/api/v3/meta' && method === 'GET') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_services_sha: '0000000000000000000000000000000000000000' });
    return;
  }
  if (path === '/api/v3/user' && method === 'GET') {
    sendJson(res, 200, { login: v.login, id: v.id, name: v.name, email: v.email, type: 'User' });
    return;
  }
  // /user/repos
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const { page, link } = paginate(store.repoList, q, req, '/api/v3/user/repos');
      sendJson(res, 200, page.map((r) => repoJson(store, r)), link ? { link } : {});
      return;
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) { err(res, 422, 'name is required'); return; }
      const repo = store.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      if (!repo) { err(res, 422, 'Repository already exists'); return; }
      sendJson(res, 201, repoJson(store, repo));
      return;
    }
    err(res, 404, 'Not Found');
    return;
  }

  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!repoMatch) { err(res, 404, 'Not Found'); return; }
  const owner = dec(repoMatch[1]!); const repoName = dec(repoMatch[2]!);
  const tail = repoMatch[3] ?? '';
  const repo = owner === v.login ? store.repo(owner, repoName) : undefined;

  // Repository itself
  if (tail === '') {
    if (method === 'GET') {
      if (!repo) { err(res, 404, 'Not Found'); return; }
      sendJson(res, 200, repoJson(store, repo));
      return;
    }
    if (method === 'PATCH') {
      if (!repo) { err(res, 404, 'Not Found'); return; }
      const body = await jsonBody(req, res);
      if (body === null) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string' && store.refTip(repo, body.default_branch)) repo.defaultBranch = body.default_branch;
      repo.updatedAt = store.ts();
      sendJson(res, 200, repoJson(store, repo));
      return;
    }
    if (method === 'DELETE') {
      if (!repo) { err(res, 404, 'Not Found'); return; }
      store.deleteRepo(repo);
      sendJson(res, 204, null);
      return;
    }
    err(res, 404, 'Not Found');
    return;
  }
  if (!repo) { err(res, 404, 'Not Found'); return; }

  const segs = tail.split('/').map(dec);
  // branches
  if (segs[0] === 'branches') {
    if (method === 'GET' && segs.length === 1) {
      const list = [...repo.git.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => {
        const name = r.slice('refs/heads/'.length);
        return { name, commit: { sha: repo.git.refs.get(r) }, protected: false };
      });
      sendJson(res, 200, list);
      return;
    }
    if (method === 'GET' && segs.length === 2) {
      const tip = store.refTip(repo, segs[1]!);
      if (!tip) { err(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { name: segs[1], commit: { sha: tip }, protected: false });
      return;
    }
    err(res, 404, 'Not Found');
    return;
  }
  // commits
  if (segs[0] === 'commits' && method === 'GET') {
    const ref = q.get('sha') ?? repo.defaultBranch;
    const list = store.listCommits(repo, ref).map((c) => {
      const aDate = commitDate(c.author);
      const cDate = commitDate(c.committer);
      return {
        sha: c.sha,
        commit: { message: c.message, author: { name: c.author.split(' <')[0], email: c.author.match(/<([^>]*)>/)?.[1] ?? '', date: aDate }, committer: { name: c.committer.split(' <')[0], email: c.committer.match(/<([^>]*)>/)?.[1] ?? '', date: cDate } },
        author: { login: v.login, id: v.id }, committer: { login: v.login, id: v.id },
      };
    });
    sendJson(res, 200, list);
    return;
  }
  // git refs
  if (segs[0] === 'git' && segs[1] === 'refs') {
    if (method === 'POST' && segs.length === 2) {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isOidStr(sha) || !repo.git.objects.has(sha)) { err(res, 422, 'Invalid ref or sha'); return; }
      repo.git.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } });
      return;
    }
    if (method === 'GET' && segs.length >= 3) {
      const ref = `refs/${segs.slice(2).join('/')}`;
      const tip = repo.git.refs.get(ref);
      if (!tip) { err(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { ref, object: { sha: tip, type: 'commit' } });
      return;
    }
    if (method === 'DELETE' && segs.length >= 3) {
      const ref = `refs/${segs.slice(2).join('/')}`;
      repo.git.refs.delete(ref);
      sendJson(res, 204, null);
      return;
    }
    err(res, 404, 'Not Found');
    return;
  }
  // contents
  if (segs[0] === 'contents') {
    const filePath = segs.slice(1).join('/');
    const branch = q.get('ref') ?? repo.defaultBranch;
    if (method === 'GET') {
      const tip = store.resolveRef(repo, branch);
      if (!tip) { err(res, 404, 'Not Found'); return; }
      const flat = store.flattenTree(repo, parseCommit(repo.git.objects.get(tip)!.data).tree);
      const file = flat.get(filePath);
      if (file) {
        const data = repo.git.objects.get(file.oid)!.data;
        sendJson(res, 200, { type: 'file', encoding: 'base64', content: data.toString('base64'), sha: file.oid, size: data.length, name: filePath.split('/').pop(), path: filePath });
        return;
      }
      // directory listing
      const prefix = filePath === '' ? '' : `${filePath}/`;
      const entries = new Map<string, { name: string; path: string; type: 'file' | 'dir'; sha: string }>();
      for (const [p, e] of flat) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (!rest) continue;
        const first = rest.split('/')[0]!;
        if (rest.includes('/')) {
          if (!entries.has(first)) entries.set(first, { name: first, path: `${prefix}${first}`, type: 'dir', sha: '' });
        } else {
          entries.set(first, { name: first, path: p, type: 'file', sha: e.oid });
        }
      }
      if (entries.size === 0) { err(res, 404, 'Not Found'); return; }
      const rootTree = parseCommit(repo.git.objects.get(tip)!.data).tree;
      const out = [...entries.values()].map((e) => ({ ...e, sha: e.type === 'dir' ? subtreeOid(repo, rootTree, e.path) : e.sha, size: 0, url: '' }));
      sendJson(res, 200, out);
      return;
    }
    if (method === 'PUT') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const content = typeof body.content === 'string' ? body.content : '';
      const message = typeof body.message === 'string' ? body.message : 'Update file';
      const useBranch = typeof body.branch === 'string' ? body.branch : branch;
      if (useBranch !== repo.defaultBranch && !store.refTip(repo, useBranch)) {
        const baseTip = store.refTip(repo, repo.defaultBranch);
        if (baseTip) repo.git.refs.set(`refs/heads/${useBranch}`, baseTip);
      }
      const r = contentsCommit(store, repo, useBranch, filePath, content, message, typeof body.sha === 'string' ? body.sha : undefined);
      sendJson(res, r.status, r.body);
      return;
    }
    if (method === 'DELETE') {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const message = typeof body.message === 'string' ? body.message : 'Delete file';
      const useBranch = typeof body.branch === 'string' ? body.branch : branch;
      const r = contentsDelete(store, repo, useBranch, filePath, message);
      sendJson(res, r.status, r.body);
      return;
    }
    err(res, 404, 'Not Found');
    return;
  }
  // labels
  if (segs[0] === 'labels') {
    if (method === 'POST' && segs.length === 1) {
      const body = await jsonBody(req, res);
      if (body === null) return;
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) { err(res, 422, 'name is required'); return; }
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      let label = repo.labels.get(name);
      if (!label) { label = { name, color }; repo.labels.set(name, label); }
      sendJson(res, 201, { id: label.name.length * 1000 + 1, name: label.name, color: label.color, description: '' });
      return;
    }
    if (method === 'GET' && segs.length === 1) { sendJson(res, 200, [...repo.labels.values()]); return; }
    err(res, 404, 'Not Found');
    return;
  }
  // issues
  if (segs[0] === 'issues') {
    if (segs.length === 1) {
      if (method === 'GET') {
        let list = [...repo.issues.values()];
        const state = q.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const sort = q.get('sort') ?? 'created';
        const dir = q.get('direction') ?? 'desc';
        if (sort === 'created') list.sort((a, b) => dir === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq);
        const { page, link } = paginate(list, q, req, `/api/v3/repos/${owner}/${repoName}/issues`);
        sendJson(res, 200, page.map((i) => issueJson(store, repo, i)), link ? { link } : {});
        return;
      }
      if (method === 'POST') {
        const body = await jsonBody(req, res);
        if (body === null) return;
        const title = typeof body.title === 'string' ? body.title : '';
        const b = typeof body.body === 'string' ? body.body : '';
        const labels = Array.isArray(body.labels) ? body.labels.map((l: unknown) => typeof l === 'string' ? l : (l as Record<string, unknown>).name).filter((x): x is string => typeof x === 'string') : [];
        const created = store.createIssue(repo, title, b, labels);
        if ('error' in created) { err(res, 422, created.error); return; }
        sendJson(res, 201, issueJson(store, repo, created));
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }
    const num = parseInt(segs[1]!, 10);
    const issue: Issue | undefined = repo.issues.get(num);
    if (segs.length === 2) {
      if (!issue) { err(res, 404, 'Not Found'); return; }
      if (method === 'GET') { sendJson(res, 200, issueJson(store, repo, issue)); return; }
      if (method === 'PATCH') {
        const body = await jsonBody(req, res);
        if (body === null) return;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        issue.updatedAt = store.ts();
        sendJson(res, 200, issueJson(store, repo, issue));
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }
    if (segs.length === 3 && segs[2] === 'comments') {
      if (!issue) { err(res, 404, 'Not Found'); return; }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: store.commentGid(repo, issue, c), body: c.body, user: { login: v.login, id: v.id }, created_at: c.createdAt, updated_at: c.updatedAt })));
        return;
      }
      if (method === 'POST') {
        const body = await jsonBody(req, res);
        if (body === null) return;
        const c = store.addComment(repo, issue, typeof body.body === 'string' ? body.body : '');
        sendJson(res, 201, { id: c.id, node_id: store.commentGid(repo, issue, c), body: c.body, user: { login: v.login, id: v.id }, created_at: c.createdAt, updated_at: c.updatedAt });
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }
    err(res, 404, 'Not Found');
    return;
  }
  // pulls
  if (segs[0] === 'pulls') {
    if (segs.length === 1) {
      if (method === 'GET') {
        let list = [...repo.pulls.values()];
        const state = q.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => a.number - b.number);
        const { page, link } = paginate(list, q, req, `/api/v3/repos/${owner}/${repoName}/pulls`);
        sendJson(res, 200, page.map((p) => prJson(store, repo, p)), link ? { link } : {});
        return;
      }
      if (method === 'POST') {
        const body = await jsonBody(req, res);
        if (body === null) return;
        const pr = store.createPR(repo, typeof body.title === 'string' ? body.title : '', typeof body.body === 'string' ? body.body : '', typeof body.head === 'string' ? body.head : '', typeof body.base === 'string' ? body.base : repo.defaultBranch);
        if ('error' in pr) { err(res, 422, pr.error); return; }
        sendJson(res, 201, prJson(store, repo, pr));
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }
    const num = parseInt(segs[1]!, 10);
    const pr = repo.pulls.get(num);
    if (segs.length === 2) {
      if (!pr) { err(res, 404, 'Not Found'); return; }
      if (method === 'GET') { sendJson(res, 200, prJson(store, repo, pr)); return; }
      err(res, 404, 'Not Found');
      return;
    }
    if (segs.length === 3 && segs[2] === 'files') {
      if (!pr) { err(res, 404, 'Not Found'); return; }
      if (method === 'GET') { sendJson(res, 200, store.prFiles(pr, repo)); return; }
      err(res, 404, 'Not Found');
      return;
    }
    if (segs.length === 3 && segs[2] === 'merge') {
      if (!pr) { err(res, 404, 'Not Found'); return; }
      if (method === 'PUT') {
        if (pr.merged) { sendJson(res, 200, { sha: pr.mergeCommitSha, merged: true, message: 'Pull request already merged' }); return; }
        if (store.prConflict(repo, pr)) { err(res, 405, 'Merge conflict'); return; }
        const sha = store.mergePR(repo, pr);
        if (!sha) { err(res, 405, 'Merge conflict'); return; }
        sendJson(res, 200, { sha, merged: true, message: `Pull request #${pr.number} successfully merged` });
        return;
      }
      err(res, 404, 'Not Found');
      return;
    }
    err(res, 404, 'Not Found');
    return;
  }

  err(res, 404, 'Not Found');
}

function isOidStr(s: string): boolean { return /^[0-9a-f]{40}$/.test(s); }
function commitDate(who: string): string {
  const m = / (\d+) [+-]\d{4}$/.exec(who);
  return m ? new Date(parseInt(m[1]!, 10) * 1000).toISOString() : new Date(0).toISOString();
}
function subtreeOid(repo: Repo, rootTree: string, dirPath: string): string {
  if (dirPath === '') return rootTree;
  let cur = rootTree;
  for (const seg of dirPath.split('/')) {
    const obj = repo.git.objects.get(cur);
    if (!obj || obj.type !== 'tree') return hashObject('tree', Buffer.alloc(0));
    const entry = parseTree(obj.data).find((e) => e.name === seg && e.mode === '40000');
    if (!entry) return hashObject('tree', Buffer.alloc(0));
    cur = entry.oid;
  }
  return cur;
}
void baseUrlOf;
