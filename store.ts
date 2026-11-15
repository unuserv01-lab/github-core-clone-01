// The forge's in-memory store: repositories, git objects/refs, issues, pull requests.
// Determinism: timestamps come from MAKEFUN_TRIAL_NOW plus a per-mutation sequence counter;
// ids are sequential counters; nothing here reads a wall clock or Math.random.
import { buildCommit, buildTree, collectReachable, hashObject, isAncestor, isOid, mergeBase, parseCommit, parseTag, parseTree, peelToCommit, type GitObject, type GitObjectType, type TreeEntry, ZERO_OID } from './gitcore.ts';

// ---- the scenario viewer, recomputed from the contest's fixed seed (wire.ts buildScenario) ----
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64 = 0xffffffffffffffffn;
function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) { h ^= BigInt(text.charCodeAt(i)); h = (h * 0x100000001b3n) & U64; }
  return h;
}
function mix64(v: bigint): bigint {
  let z = (v + 0x9e3779b97f4a7c15n) & U64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return (z ^ (z >> 31n)) & U64;
}
class Rng {
  #s: bigint;
  constructor(seed: bigint) { const m = seed & U64; this.#s = m === 0n ? SCENARIO_SEED : m; }
  nextU64(): bigint {
    let x = this.#s;
    x = (x ^ (x >> 12n)) & U64; x = (x ^ (x << 25n)) & U64; x = (x ^ (x >> 27n)) & U64;
    this.#s = x;
    return (x * 0x2545f4914f6cdd1dn) & U64;
  }
  nextU32(): number { return Number(this.nextU64() >> 32n); }
  nextInt(max: number): number {
    if (max === 1) return 0;
    const range = 4294967296; const limit = range - (range % max);
    for (;;) { const v = this.nextU32(); if (v < limit) return v % max; }
  }
  pick<T>(items: readonly T[]): T { return items[this.nextInt(items.length)]!; }
}
const FIRST_NAMES = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'] as const;
const LAST_NAMES = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'] as const;
export interface Viewer { id: number; login: string; name: string; email: string; }
export function scenarioViewer(): Viewer {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  let first: Viewer | null = null;
  for (let i = 0; i < 12; i += 1) {
    const f = rng.pick(FIRST_NAMES); const l = rng.pick(LAST_NAMES);
    const base = `${f}${l}`.replace(/[^a-z0-9-]/g, '');
    let login = base; let suffix = 2;
    while (used.has(login)) { login = `${base}-${suffix}`; suffix += 1; }
    used.add(login);
    const u: Viewer = { id: 1000 + i, login, name: `${f} ${l}`, email: `${login}@example.invalid` };
    if (i === 0) first = u;
  }
  return first!;
}

// ---- types ----
export interface Label { name: string; color: string; }
export interface IssueComment { id: number; body: string; user: Viewer; createdAt: string; updatedAt: string; }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; comments: IssueComment[]; createdAt: string; updatedAt: string; createdSeq: number;
  /** Cached exact response bytes (JSON + '\n') of issueJson; cleared on any mutation. */
  jsonCache?: Buffer;
}
export interface PullRequest {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  createdAt: string; updatedAt: string; createdSeq: number;
}
export interface Repo {
  id: number; name: string; owner: string; description: string; private: boolean;
  defaultBranch: string; createdAt: string; updatedAt: string; createdSeq: number;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  git: { objects: Map<string, GitObject>; refs: Map<string, string> };
}
export function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}
function b64(s: string): string { return Buffer.from(s, 'utf8').toString('base64'); }

export class Store {
  readonly viewer: Viewer = scenarioViewer();
  readonly token: string;
  readonly trialNowMs: number;
  private seq = 0;
  private reqSeq = 0;
  private repoSeq = 5000;
  private issueIdSeq = 10000;
  private commentIdSeq = 20000;
  readonly repos = new Map<string, Repo>();
  readonly repoList: Repo[] = [];

  constructor() {
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    const now = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = now ? Date.parse(now) : NaN;
    this.trialNowMs = Number.isFinite(parsed) ? parsed : 1735689600000;
  }
  /** Next deterministic timestamp (trial now + seq seconds). */
  ts(): string {
    this.seq += 1;
    return new Date(this.trialNowMs + this.seq * 1000).toISOString();
  }
  nextReqId(): string { this.reqSeq += 1; return `req-${this.reqSeq}`; }
  identity(): string { return `${this.viewer.name} <${this.viewer.email}>`; }
  epochSec(): number { return Math.floor(this.trialNowMs / 1000) + this.seq; }

  key(owner: string, name: string): string { return `${owner}/${name}`; }
  repo(owner: string, name: string): Repo | undefined { return this.repos.get(this.key(owner, name)); }
  createRepo(name: string, priv: boolean, description: string): Repo | null {
    if (this.repo(this.viewer.login, name)) return null;
    const t = this.ts();
    const repo: Repo = {
      id: this.repoSeq++, name, owner: this.viewer.login, description, private: priv,
      defaultBranch: 'main', createdAt: t, updatedAt: t, createdSeq: this.seq,
      labels: new Map(), issues: new Map(), pulls: new Map(), nextNumber: 1,
      git: { objects: new Map(), refs: new Map() },
    };
    this.repos.set(this.key(repo.owner, name), repo);
    this.repoList.push(repo);
    return repo;
  }
  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
    const i = this.repoList.indexOf(repo);
    if (i >= 0) this.repoList.splice(i, 1);
  }

  // ---- git object helpers on a repo ----
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.git.objects.has(oid)) repo.git.objects.set(oid, { type, data });
    return oid;
  }
  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.git.objects.get(oid);
  }
  refTip(repo: Repo, branch: string): string | undefined { return repo.git.refs.get(`refs/heads/${branch}`); }
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.git.refs.has(ref)) return repo.git.refs.get(ref);
    const asBranch = repo.git.refs.get(`refs/heads/${ref}`);
    if (asBranch) return asBranch;
    if (isOid(ref) && repo.git.objects.has(ref)) return ref;
    return undefined;
  }
  /** Flatten a commit's tree to path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const obj = repo.git.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') this.flattenTree(repo, e.oid, p, out);
      else out.set(p, { oid: e.oid, mode: e.mode });
    }
    return out;
  }
  /** Rebuild nested trees from a flat file map; returns the root tree oid. */
  rebuildTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node>; }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i += 1) {
        const s = segs[i]!;
        if (!node.dirs.has(s)) node.dirs.set(s, make());
        node = node.dirs.get(s)!;
      }
      node.files.set(segs[segs.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }
  /** Create a commit on branch (tip may be undefined for unborn) from a flat file map. */
  makeCommit(repo: Repo, branch: string, files: Map<string, { oid: string; mode: string }>, message: string): string {
    const treeOid = this.rebuildTree(repo, files);
    const tip = this.refTip(repo, branch);
    const stamp = `${this.epochSec()} +0000`;
    const who = `${this.identity()} ${stamp}`;
    const data = buildCommit({ tree: treeOid, parents: tip ? [tip] : [], message: message.endsWith('\n') ? message : `${message}\n`, author: who, committer: who });
    const oid = this.putObject(repo, 'commit', data);
    repo.git.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }
  /** Commit info for GET /commits. */
  listCommits(repo: Repo, ref: string): { sha: string; message: string; author: string; committer: string }[] {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return [];
    const out: { sha: string; message: string; author: string; committer: string }[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.git.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      out.push({ sha: oid, message: c.message.replace(/\n$/, ''), author: c.author, committer: c.committer });
      for (const p of c.parents) queue.push(p);
    }
    return out;
  }
  /** Diff two trees (flat maps): paths with status and line counts. */
  diffTrees(repo: Repo, baseTree: string, headTree: string): { path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }[] {
    const base = baseTree ? this.flattenTree(repo, baseTree) : new Map();
    const head = headTree ? this.flattenTree(repo, headTree) : new Map();
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: { path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }[] = [];
    const linesOf = (oid: string): number => {
      const o = repo.git.objects.get(oid);
      if (!o) return 0;
      const s = o.data.toString('utf8');
      return s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
    };
    for (const p of [...paths].sort()) {
      const b = base.get(p); const h = head.get(p);
      if (b && !h) out.push({ path: p, status: 'removed', additions: 0, deletions: linesOf(b.oid) });
      else if (!b && h) out.push({ path: p, status: 'added', additions: linesOf(h.oid), deletions: 0 });
      else if (b && h && b.oid !== h.oid) out.push({ path: p, status: 'modified', additions: linesOf(h.oid), deletions: linesOf(b.oid) });
    }
    return out;
  }
  prFiles(pr: PullRequest, repo: Repo): { path: string; status: string; additions: number; deletions: number }[] {
    const headObj = repo.git.objects.get(pr.headSha);
    const baseObj = repo.git.objects.get(pr.baseSha);
    if (!headObj || !baseObj) return [];
    const headTree = parseCommit(headObj.data).tree;
    const baseTree = parseCommit(baseObj.data).tree;
    return this.diffTrees(repo, baseTree, headTree).map((d) => ({ filename: d.path, status: d.status, additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions }));
  }
  /** Whether a PR can merge cleanly (no path changed differently on both sides since merge-base). */
  prConflict(repo: Repo, pr: PullRequest): boolean {
    const base = mergeBase(pr.baseSha, pr.headSha, this.lookup(repo));
    if (base === null) return true;
    const baseObj = repo.git.objects.get(base);
    const headObj = repo.git.objects.get(pr.headSha);
    const tipOid = this.refTip(repo, pr.baseRef);
    const tipObj = tipOid ? repo.git.objects.get(tipOid) : undefined;
    if (!baseObj || !headObj || !tipObj) return true;
    const baseTree = parseCommit(baseObj.data).tree;
    const headDiff = this.diffTrees(repo, baseTree, parseCommit(headObj.data).tree);
    const tipDiff = this.diffTrees(repo, baseTree, parseCommit(tipObj.data).tree);
    const tipMap = new Map(tipDiff.map((d) => [d.path, d]));
    const headMap = new Map<string, { oid: string; mode: string }>();
    const headFlat = this.flattenTree(repo, parseCommit(headObj.data).tree);
    const tipFlat = this.flattenTree(repo, parseCommit(tipObj.data).tree);
    const baseFlat = this.flattenTree(repo, baseTree);
    for (const d of headDiff) {
      const t = tipMap.get(d.path);
      if (!t) continue;
      const hEntry = headFlat.get(d.path);
      const tEntry = tipFlat.get(d.path);
      const bEntry = baseFlat.get(d.path);
      const hOid = hEntry?.oid ?? null; const tOid = tEntry?.oid ?? null; const bOid = bEntry?.oid ?? null;
      if (hOid !== tOid && hOid !== bOid && tOid !== bOid) return true;
      if ((hOid === null) !== (tOid === null)) return true;
    }
    void headMap;
    return false;
  }
  /** Squash-merge a PR onto its base branch; returns the merge commit oid or null on conflict. */
  mergePR(repo: Repo, pr: PullRequest): string | null {
    if (pr.merged) return pr.mergeCommitSha;
    if (this.prConflict(repo, pr)) return null;
    const base = mergeBase(pr.baseSha, pr.headSha, this.lookup(repo));
    const tipOid = this.refTip(repo, pr.baseRef);
    if (!base || !tipOid) return null;
    const baseObj = repo.git.objects.get(base)!;
    const headObj = repo.git.objects.get(pr.headSha)!;
    const tipObj = repo.git.objects.get(tipOid)!;
    const baseTree = parseCommit(baseObj.data).tree;
    const headTree = parseCommit(headObj.data).tree;
    const tipTree = parseCommit(tipObj.data).tree;
    const merged = this.flattenTree(repo, tipTree);
    const headDiff = this.diffTrees(repo, baseTree, headTree);
    const headFlat = this.flattenTree(repo, headTree);
    for (const d of headDiff) {
      if (d.status === 'removed') merged.delete(d.path);
      else { const e = headFlat.get(d.path)!; merged.set(d.path, e); }
    }
    const treeOid = this.rebuildTree(repo, merged);
    const stamp = `${this.epochSec()} +0000`;
    const who = `${this.identity()} ${stamp}`;
    const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}\n\n${pr.title}\n`;
    const data = buildCommit({ tree: treeOid, parents: [tipOid], message, author: who, committer: who });
    const oid = this.putObject(repo, 'commit', data);
    repo.git.refs.set(`refs/heads/${pr.baseRef}`, oid);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergeCommitSha = oid;
    pr.mergedAt = this.ts();
    pr.updatedAt = pr.mergedAt;
    return oid;
  }

  // ---- issues / PRs ----
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
    for (const name of labels) if (!repo.labels.has(name)) return { error: `Label "${name}" does not exist` };
    const t = this.ts();
    const issue: Issue = {
      id: this.issueIdSeq++, number: repo.nextNumber++, title, body: body ?? '', state: 'open',
      labels: labels.map((n) => repo.labels.get(n)!), comments: [], createdAt: t, updatedAt: t, createdSeq: this.seq,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }
  createPR(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headSha = this.refTip(repo, head);
    const baseSha = this.refTip(repo, base);
    if (!headSha) return { error: `head branch ${head} does not exist` };
    if (!baseSha) return { error: `base branch ${base} does not exist` };
    const t = this.ts();
    const pr: PullRequest = {
      id: this.issueIdSeq++, number: repo.nextNumber++, title, body: body ?? '', state: 'open',
      merged: false, mergedAt: null, mergeCommitSha: null,
      headRef: head, baseRef: base, headSha, baseSha, createdAt: t, updatedAt: t, createdSeq: this.seq,
    };
    repo.pulls.set(pr.number, pr);
    return pr;
  }
  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const t = this.ts();
    const c: IssueComment = { id: this.commentIdSeq++, body, user: this.viewer, createdAt: t, updatedAt: t };
    issue.comments.push(c);
    return c;
  }
  peel(repo: Repo, oid: string): string { return peelToCommit(oid, this.lookup(repo)); }
  isAncestor(repo: Repo, anc: string, desc: string): boolean { return isAncestor(anc, desc, this.lookup(repo)); }
  reachable(repo: Repo, roots: Iterable<string>, stopAt?: Set<string>): Set<string> {
    return collectReachable(roots, this.lookup(repo), stopAt ? { stopAt } : {});
  }
  b64(s: string): string { return b64(s); }
  repoGid(repo: Repo): string { return gid('Repository', repo.id); }
  issueGid(repo: Repo, issue: Issue): string { return gid('Issue', repo.id, issue.number); }
  prGid(repo: Repo, pr: PullRequest): string { return gid('PullRequest', repo.id, pr.number); }
  commentGid(repo: Repo, issue: Issue, c: IssueComment): string { return gid('IssueComment', repo.id, issue.number, c.id); }
  decodeGid(id: string): { kind: string; parts: string[] } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const [kind, ...parts] = text.split(':');
      if (!kind || parts.length === 0) return null;
      return { kind, parts };
    } catch { return null; }
  }
}
export { ZERO_OID };
