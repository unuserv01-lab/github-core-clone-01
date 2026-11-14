// Minimal GraphQL v4 executor for the documents gh / github-mcp-server send.
// Parses one operation document (query/mutation, variables, aliases, inline fragments,
// inline enums/lists/objects) and executes it against the Store. Unknown fields are
// reported as GraphQL errors with HTTP 200.
import type { Issue, PullRequest, Repo, Store } from './store.ts';

type Value = unknown;
interface FieldNode {
  alias: string | null; name: string; args: Record<string, Value>; children: FieldNode[] | null;
}
interface Operation { kind: 'query' | 'mutation'; name: string | null; varDefs: Record<string, string>; fields: FieldNode[]; }

const KNOWN: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['login', 'id'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  __Type: ['fields', 'enumValues', 'name'],
  __Field: ['name'],
  __EnumValue: ['name'],
  Node: ['id'],
};
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'url', 'author', 'mergeCommit', 'mergedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt'],
  SearchType: [],
};
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'];

// ---- lexer/parser ----
function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c) || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '"') {
      let j = i + 1; let s = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; } else { s += src[j]; j += 1; } }
      tokens.push(JSON.stringify(s)); i = j + 1; continue;
    }
    if ('{}():![]=...'.includes(c)) {
      if (src.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
      tokens.push(c); i += 1; continue;
    }
    if (c === '$') { let j = i + 1; while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1; tokens.push(src.slice(i, j)); i = j; continue; }
    if (/[A-Za-z0-9_.-]/.test(c)) { let j = i; while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j]!)) j += 1; tokens.push(src.slice(i, j)); i = j; continue; }
    i += 1;
  }
  return tokens;
}
class Parser {
  toks: string[]; pos = 0;
  constructor(src: string) { this.toks = tokenize(src); }
  peek(): string { return this.toks[this.pos] ?? ''; }
  next(): string { return this.toks[this.pos++] ?? ''; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`expected ${t}`); }
  parseValue(vars: Record<string, Value>): Value {
    const t = this.next();
    if (t.startsWith('$')) return vars[t.slice(1)];
    if (t === '{') {
      const obj: Record<string, Value> = {};
      while (this.peek() !== '}') { const k = this.next(); this.expect(':'); obj[k] = this.parseValue(vars); }
      this.expect('}');
      return obj;
    }
    if (t === '[') {
      const arr: Value[] = [];
      while (this.peek() !== ']') arr.push(this.parseValue(vars));
      this.expect(']');
      return arr;
    }
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    const n = Number(t);
    if (t !== '' && !Number.isNaN(n)) return n;
    return t; // enum as string
  }
  parseArgs(vars: Record<string, Value>): Record<string, Value> {
    const args: Record<string, Value> = {};
    this.expect('(');
    while (this.peek() !== ')') { const k = this.next(); this.expect(':'); args[k] = this.parseValue(vars); }
    this.expect(')');
    return args;
  }
  parseFields(vars: Record<string, Value>, inlineType: string | null = null): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') { this.next(); this.next(); }
        const children = this.parseFields(vars);
        for (const c of children) fields.push(c);
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      let args: Record<string, Value> = {};
      if (this.peek() === '(') args = this.parseArgs(vars);
      let children: FieldNode[] | null = null;
      if (this.peek() === '{') children = this.parseFields(vars);
      void inlineType;
      fields.push({ alias, name, args, children });
    }
    this.expect('}');
    return fields;
  }
  parseOperation(vars: Record<string, Value>): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t === 'query' || t === 'mutation') { kind = this.next() as 'query' | 'mutation'; if (this.peek() !== '(' && this.peek() !== '{') name = this.next(); }
    const varDefs: Record<string, string> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const v = this.next();
        this.expect(':');
        // type: read tokens until , or ) at depth 0 (types may be [X!]! etc.)
        let type = '';
        let depth = 0;
        while (true) {
          const tk = this.peek();
          if (tk === ')' && depth === 0) break;
          if (tk === ',' && depth === 0) break;
          if (tk === '=') break;
          if (tk === '[') depth += 1;
          if (tk === ']') depth -= 1;
          type += this.next();
        }
        varDefs[v.slice(1)] = type;
        if (this.peek() === '=') { this.next(); this.parseValue(vars); }
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    const fields = this.parseFields(vars);
    return { kind, name, varDefs, fields };
  }
}

export interface GqlResult { data: Record<string, unknown> | null; errors: { message: string }[]; }
function err(msg: string): GqlResult { return { data: null, errors: [{ message: msg }] }; }

function cursorOf(n: number): string { return Buffer.from(`cursor:${n}`).toString('base64'); }
function cursorNum(c: string): number | null {
  try { const t = Buffer.from(c, 'base64').toString('utf8'); const m = /^cursor:(\d+)$/.exec(t); return m ? parseInt(m[1], 10) : null; } catch { return null; }
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, Value>): GqlResult {
  let op: Operation;
  try {
    const parser = new Parser(query);
    op = parser.parseOperation(variables);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'parse error');
  }
  const errors: { message: string }[] = [];
  const data: Record<string, unknown> = {};
  for (const field of op.fields) {
    const key = field.alias ?? field.name;
    try {
      data[key] = execRoot(store, op, field, errors);
    } catch (e) {
      errors.push({ message: e instanceof Error ? e.message : String(e) });
      data[key] = null;
    }
  }
  if (errors.length) return { data, errors };
  return { data, errors: [] };
}

function checkFields(typeName: string, fields: FieldNode[] | null, errors: { message: string }[]): void {
  if (!fields) return;
  const known = KNOWN[typeName] ?? [];
  for (const f of fields) {
    if (!known.includes(f.name)) errors.push({ message: `Cannot query field "${f.name}" on type "${typeName}".` });
  }
}

function issueNode(store: Store, repo: Repo, issue: Issue, fields: FieldNode[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) {
    switch (f.name) {
      case 'id': out.id = store.issueGid(repo, issue); break;
      case 'number': out.number = issue.number; break;
      case 'title': out.title = issue.title; break;
      case 'state': out.state = issue.state.toUpperCase(); break;
      case 'body': out.body = issue.body; break;
      default: out[f.name] = null;
    }
  }
  return out;
}
function prNode(store: Store, repo: Repo, pr: PullRequest, fields: FieldNode[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) {
    switch (f.name) {
      case 'id': out.id = store.prGid(repo, pr); break;
      case 'number': out.number = pr.number; break;
      case 'title': out.title = pr.title; break;
      case 'state': out.state = pr.merged ? 'MERGED' : pr.state.toUpperCase(); break;
      case 'merged': out.merged = pr.merged; break;
      case 'headRefName': out.headRefName = pr.headRef; break;
      case 'baseRefName': out.baseRefName = pr.baseRef; break;
      case 'mergeable': out.mergeable = store.prConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE'; break;
      case 'files': {
        const files = store.prFiles(pr, repo);
        const first = typeof f.args.first === 'number' ? f.args.first : files.length;
        // The requested node fields live under the `nodes` child of `files`,
        // not directly under `files` itself.
        const nodesField = (f.children ?? []).find((c) => c.name === 'nodes');
        out.files = { nodes: files.slice(0, first).map((x) => pickFields({ path: x.filename }, nodesField?.children ?? null)) };
        break;
      }
      case 'body': out.body = pr.body; break;
      default: out[f.name] = null;
    }
  }
  return out;
}
function pickFields(obj: Record<string, unknown>, fields: FieldNode[] | null): Record<string, unknown> {
  if (!fields) return obj;
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.name] = obj[f.name] ?? null;
  return out;
}

function repoNode(store: Store, repo: Repo, fields: FieldNode[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) {
    switch (f.name) {
      case 'id': out.id = store.repoGid(repo); break;
      case 'databaseId': out.databaseId = repo.id; break;
      case 'name': out.name = repo.name; break;
      case 'nameWithOwner': out.nameWithOwner = `${repo.owner}/${repo.name}`; break;
      case 'owner': out.owner = pickFields({ login: repo.owner }, f.children); break;
      case 'defaultBranchRef': {
        const tip = store.refTip(repo, repo.defaultBranch);
        out.defaultBranchRef = tip ? pickFields({ name: repo.defaultBranch }, f.children) : null;
        break;
      }
      case 'viewerPermission': out.viewerPermission = 'ADMIN'; break;
      case 'hasIssuesEnabled': out.hasIssuesEnabled = true; break;
      case 'issue': {
        const n = f.args.number as number;
        const issue = repo.issues.get(n);
        out.issue = issue ? issueNode(store, repo, issue, f.children) : null;
        break;
      }
      case 'issues': {
        let list = [...repo.issues.values()].sort((a, b) => a.number - b.number);
        const states = f.args.states as string[] | undefined;
        if (states) list = list.filter((i) => states.includes(i.state.toUpperCase()));
        const orderBy = f.args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy?.field === 'CREATED_AT') {
          list.sort((a, b) => orderBy.direction === 'DESC' ? b.number - a.number : a.number - b.number);
        }
        const after = typeof f.args.after === 'string' ? cursorNum(f.args.after) : null;
        if (after !== null) {
          // Pagination cursors are in creation (ascending) order.
          list = [...repo.issues.values()].sort((a, b) => a.number - b.number).filter((i) => i.number > after);
          if (states) list = list.filter((i) => states.includes(i.state.toUpperCase()));
        }
        const first = typeof f.args.first === 'number' ? f.args.first : list.length;
        const page = list.slice(0, first);
        const hasNext = list.length > first;
        const endCursor = page.length ? cursorOf(page[page.length - 1]!.number) : null;
        const nodes: Record<string, unknown>[] = [];
        for (const issue of page) nodes.push(issueNode(store, repo, issue, f.children?.find((c) => c.name === 'nodes')?.children ?? f.children));
        // children of issues are {nodes, pageInfo}; nodes' children live under the nodes field.
        const nodesField = f.children?.find((c) => c.name === 'nodes');
        const pageInfoField = f.children?.find((c) => c.name === 'pageInfo');
        const nodes2 = page.map((issue) => issueNode(store, repo, issue, nodesField?.children ?? null));
        const conn: Record<string, unknown> = {};
        if (nodesField) conn.nodes = nodes2;
        if (pageInfoField) conn.pageInfo = pickFields({ hasNextPage: hasNext, endCursor }, pageInfoField.children);
        if (!nodesField && !pageInfoField) { conn.nodes = nodes2; conn.pageInfo = { hasNextPage: hasNext, endCursor }; }
        void nodes;
        out.issues = conn;
        break;
      }
      case 'pullRequests': {
        const list = [...repo.pulls.values()].filter((p) => p.state === 'open').sort((a, b) => a.number - b.number);
        const first = typeof f.args.first === 'number' ? f.args.first : list.length;
        const nodesField = f.children?.find((c) => c.name === 'nodes');
        const nodes = list.slice(0, first).map((pr) => prNode(store, repo, pr, nodesField?.children ?? null));
        out.pullRequests = { nodes };
        break;
      }
      case 'pullRequest': {
        const n = f.args.number as number;
        const pr = repo.pulls.get(n);
        out.pullRequest = pr ? prNode(store, repo, pr, f.children) : null;
        break;
      }
      default: out[f.name] = null;
    }
  }
  return out;
}

function execRoot(store: Store, op: Operation, field: FieldNode, errors: { message: string }[]): unknown {
  if (op.kind === 'query') {
    checkFields('Query', [field], errors);
    if (field.name === 'viewer') {
      checkFields('User', field.children, errors);
      return pickFields({ login: store.viewer.login, id: store.viewer.id }, field.children);
    }
    if (field.name === 'repository') {
      const owner = field.args.owner as string;
      const name = field.args.name as string;
      const repo = owner === store.viewer.login ? store.repo(owner, name) : undefined;
      if (!repo) return null;
      checkFields('Repository', field.children, errors);
      return repoNode(store, repo, field.children);
    }
    if (field.name === 'node') {
      const id = field.args.id as string;
      const dec = store.decodeGid(id);
      if (!dec) return null;
      if (dec.kind === 'Repository') {
        const repoId = parseInt(dec.parts[0]!, 10);
        const repo = store.repoList.find((r) => r.id === repoId);
        if (!repo) return null;
        const out: Record<string, unknown> = { id: store.repoGid(repo) };
        for (const f of field.children ?? []) {
          if (f.name === 'name') out.name = repo.name;
          else if (f.name === 'nameWithOwner') out.nameWithOwner = `${repo.owner}/${repo.name}`;
          else if (f.name === 'id') out.id = store.repoGid(repo);
          else out[f.name] = null;
        }
        return out;
      }
      return null;
    }
    if (field.name === '__type') {
      const typeName = field.args.name as string;
      const out: Record<string, unknown> = {};
      for (const f of field.children ?? []) {
        if (f.name === 'fields') out.fields = (TYPE_FIELDS[typeName] ?? []).map((n) => ({ name: n }));
        else if (f.name === 'enumValues') out.enumValues = (typeName === 'SearchType' ? SEARCH_ENUM : []).map((n) => ({ name: n }));
        else if (f.name === 'name') out.name = typeName;
      }
      return out;
    }
    return null;
  }
  // mutations
  checkFields('Mutation', [field], errors);
  const input = (field.args.input ?? {}) as Record<string, Value>;
  if (field.name === 'createIssue') {
    const dec = store.decodeGid(String(input.repositoryId ?? ''));
    const repo = dec?.kind === 'Repository' ? store.repoList.find((r) => r.id === parseInt(dec.parts[0]!, 10)) : undefined;
    if (!repo) throw new Error('repository not found');
    const created = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    if ('error' in created) throw new Error(created.error);
    const issueField = field.children?.find((c) => c.name === 'issue');
    return { issue: issueNode(store, repo, created, issueField?.children ?? null) };
  }
  if (field.name === 'closeIssue') {
    const dec = store.decodeGid(String(input.issueId ?? ''));
    if (dec?.kind !== 'Issue') throw new Error('issue not found');
    const repo = store.repoList.find((r) => r.id === parseInt(dec.parts[0]!, 10));
    const issue = repo?.issues.get(parseInt(dec.parts[1]!, 10));
    if (!repo || !issue) throw new Error('issue not found');
    issue.state = 'closed';
    issue.updatedAt = store.ts();
    const issueField = field.children?.find((c) => c.name === 'issue');
    return { issue: issueNode(store, repo, issue, issueField?.children ?? null) };
  }
  if (field.name === 'createPullRequest') {
    const dec = store.decodeGid(String(input.repositoryId ?? ''));
    const repo = dec?.kind === 'Repository' ? store.repoList.find((r) => r.id === parseInt(dec.parts[0]!, 10)) : undefined;
    if (!repo) throw new Error('repository not found');
    const pr = store.createPR(repo, String(input.title ?? ''), String((input as Record<string, Value>).body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if ('error' in pr) throw new Error(pr.error);
    const prField = field.children?.find((c) => c.name === 'pullRequest');
    return { pullRequest: prNode(store, repo, pr, prField?.children ?? null) };
  }
  if (field.name === 'mergePullRequest') {
    const dec = store.decodeGid(String(input.pullRequestId ?? ''));
    if (dec?.kind !== 'PullRequest') throw new Error('pull request not found');
    const repo = store.repoList.find((r) => r.id === parseInt(dec.parts[0]!, 10));
    const pr = repo?.pulls.get(parseInt(dec.parts[1]!, 10));
    if (!repo || !pr) throw new Error('pull request not found');
    if (store.prConflict(repo, pr)) throw new Error('merge conflict');
    store.mergePR(repo, pr);
    const prField = field.children?.find((c) => c.name === 'pullRequest');
    return { pullRequest: prNode(store, repo, pr, prField?.children ?? null) };
  }
  if (field.name === 'addComment') {
    const dec = store.decodeGid(String(input.subjectId ?? ''));
    if (dec?.kind !== 'Issue') throw new Error('issue not found');
    const repo = store.repoList.find((r) => r.id === parseInt(dec.parts[0]!, 10));
    const issue = repo?.issues.get(parseInt(dec.parts[1]!, 10));
    if (!repo || !issue) throw new Error('issue not found');
    const comment = store.addComment(repo, issue, String(input.body ?? ''));
    return { commentEdge: { node: { id: store.commentGid(repo, issue, comment), body: comment.body } } };
  }
  return null;
}
