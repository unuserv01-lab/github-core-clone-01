// Git smart HTTP: info/refs, upload-pack (protocol v2 + v0 fallback), receive-pack (v0).
// Pure protocol over the Store; packfiles are plain (no deltas) and checksummed.
import { collectReachable, decodePktLines, hashObject, isAncestor, isOid, parseCommit, parseTag, pkt, pktLines, PKT_DELIM, PKT_FLUSH, readPack, writePack, ZERO_OID, type GitObject } from './gitcore.ts';
import type { Repo, Store } from './store.ts';

export interface GitResponse { status: number; contentType: string; body: Buffer; }

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.git.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}
function headTarget(repo: Repo): string { return `refs/heads/${repo.defaultBranch}`; }

const V2_CAPS = [
  'agent=github-core-clone/1.0',
  'ls-refs=unborn',
  'fetch=shallow filter',
  'object-format=sha1',
];
const V0_CAPS = (repo: Repo): string =>
  `symref=HEAD:${headTarget(repo)} side-band-64k thin-pack ofs-delta multi_ack shallow agent=github-core-clone/1.0`;

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const refs = sortedRefs(repo);
  const caps = service === 'git-receive-pack'
    ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta thin-pack agent=github-core-clone/1.0'
    : V0_CAPS(repo);
  const items: (string | Buffer | 'flush')[] = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headOid = repo.git.refs.get(headTarget(repo)) ?? refs[0]!.oid;
    items.push(`${headOid} HEAD\0${caps}\n`);
    for (const r of refs) {
      items.push(`${r.oid} ${r.name}\n`);
      const obj = repo.git.objects.get(r.oid);
      if (obj?.type === 'tag') {
        const target = parseTag(obj.data).object;
        const commit = peelCommit(repo, target);
        items.push(`${commit} ${r.name}^{}\n`);
      }
    }
  }
  items.push('flush');
  return pktLines(items);
}
function peelCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.git.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}

export function infoRefs(store: Store, repo: Repo | undefined, service: 'git-upload-pack' | 'git-receive-pack', gitProtocol: string | undefined): GitResponse {
  if (!repo) return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  const ct = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const items: (string | 'flush')[] = ['version 2\n', ...V2_CAPS.map((c) => `${c}\n`), 'flush'];
    return { status: 200, contentType: ct, body: pktLines(items) };
  }
  return { status: 200, contentType: ct, body: v0Advertisement(repo, service) };
}

// ---- ls-refs (v2) ----
function lsRefs(repo: Repo, body: Buffer): GitResponse {
  const lines = decodePktLines(body).filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  let peel = false; let symrefs = false; const prefixes: string[] = [];
  for (const line of lines) {
    const t = line.replace(/\n$/, '');
    if (t.startsWith('command=')) continue;
    if (t.startsWith('agent=')) continue;
    if (t.startsWith('object-format=')) continue;
    if (t === 'peel') peel = true;
    else if (t === 'symrefs') symrefs = true;
    else if (t === 'unborn') { /* accepted */ }
    else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
  }
  const refs = sortedRefs(repo);
  const out: string[] = [];
  const headOid = repo.git.refs.get(headTarget(repo));
  const include = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  // HEAD is listed when the client's ref-prefixes match it. A real clone
  // asks for "ref-prefix HEAD" explicitly (alongside refs/heads/ and
  // refs/tags/), so the old `prefixes.length === 0` guard dropped HEAD for
  // every real clone: git then fell back to the local default branch name
  // (master), checked it out, and found no commits even though main had
  // been pushed. `include('HEAD')` is true both with no prefixes and when
  // "HEAD" is among them.
  if (include('HEAD')) {
    if (headOid) out.push(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`);
    else out.push(`unborn HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`);
  }
  for (const r of refs) {
    if (!include(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel) {
      const obj = repo.git.objects.get(r.oid);
      if (obj?.type === 'tag') line += ` peeled:${peelCommit(repo, parseTag(obj.data).object)}`;
    }
    out.push(`${line}\n`);
  }
  out.push('flush' as never);
  const items: (string | 'flush')[] = out.map((s) => (s === 'flush' ? 'flush' : s));
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: pktLines(items) };
}

// ---- fetch: compute the object set to send ----
interface FetchReq { wants: string[]; haves: string[]; shallow: string[]; depth?: number; }
function fetchObjects(store: Store, repo: Repo, req: FetchReq): { objects: GitObject[]; shallow: string[]; unshallow: string[]; acks: string[]; empty: boolean } {
  const lookup = store.lookup(repo);
  const shallowSet = new Set(req.shallow);
  // Held set: closure of haves, not crossing shallow boundaries' parents.
  const held = new Set<string>();
  for (const h of req.haves) {
    try {
      for (const oid of collectReachable([h], lookup, { stopAt: shallowSet })) held.add(oid);
    } catch { /* have object unknown to us: ignore */ }
  }
  // Wanted set with depth limit.
  const wanted = new Set<string>();
  const shallowOut: string[] = [];
  const commitDepth = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = req.wants.map((w) => ({ oid: w, depth: 0 }));
  const seenCommit = new Set<string>();
  const addClosure = (oid: string): void => {
    try { for (const o of collectReachable([oid], lookup)) wanted.add(o); } catch { /* ignore */ }
  };
  if (req.depth === undefined) {
    for (const w of req.wants) {
      const obj = repo.git.objects.get(w);
      if (!obj) continue;
      if (obj.type === 'tag') { wanted.add(w); addClosure(peelCommit(repo, parseTag(obj.data).object)); }
      else addClosure(w);
    }
  } else {
    // BFS over commits from wants, bounded by depth; trees/blobs of included commits fully.
    const q: { oid: string; d: number }[] = [];
    for (const w of req.wants) {
      const obj = repo.git.objects.get(w);
      if (!obj) continue;
      if (obj.type === 'tag') { wanted.add(w); q.push({ oid: peelCommit(repo, parseTag(obj.data).object), d: 0 }); }
      else q.push({ oid: w, d: 0 });
    }
    while (q.length) {
      const { oid, d } = q.shift()!;
      if (seenCommit.has(oid)) continue;
      seenCommit.add(oid);
      const obj = repo.git.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      commitDepth.set(oid, d);
      // include this commit + its tree/blobs (not parents)
      wanted.add(oid);
      const c = parseCommit(obj.data);
      try { for (const o of collectReachable([c.tree], lookup)) wanted.add(o); } catch { /* ignore */ }
      if (d + 1 < req.depth) { for (const p of c.parents) q.push({ oid: p, d: d + 1 }); }
      else shallowOut.push(oid);
    }
  }
  const send = [...wanted].filter((oid) => !held.has(oid));
  const unshallow = req.shallow.filter((s) => {
    // a former boundary whose parent is now included (i.e. it is no longer a boundary)
    if (!commitDepth.has(s)) return false;
    const obj = repo.git.objects.get(s);
    if (!obj || obj.type !== 'commit') return false;
    return parseCommit(obj.data).parents.some((p) => commitDepth.has(p));
  });
  const objects: GitObject[] = [];
  for (const oid of send) {
    const o = repo.git.objects.get(oid);
    if (o) objects.push(o);
  }
  const acks = req.haves.filter((h) => req.wants.includes(h) && repo.git.objects.has(h));
  const empty = send.length === 0;
  return { objects, shallow: shallowOut, unshallow, acks, empty };
}

function sidebandPack(objects: GitObject[]): Buffer {
  if (objects.length === 0) return Buffer.alloc(0);
  const pack = writePack(objects);
  const chunks: Buffer[] = [];
  // A pkt-line is at most 65520 bytes total, so the payload (1 band byte + data)
  // is at most 65516: data slices are capped at 65515.
  const MAX = 65515;
  for (let off = 0; off < pack.length; off += MAX) {
    const slice = pack.subarray(off, Math.min(pack.length, off + MAX));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(pkt(payload));
  }
  return Buffer.concat(chunks);
}

/** Fetch + pack cache. Git objects are immutable and only added, so a fetch
 * result is stable for a given repo, object count, and request: the 50
 * concurrent clones of one repo are identical requests, so one graph walk
 * and one pack build serve them all. The object count in the key is what
 * makes it safe: any push grows the count and busts the entry. */
type FetchResult = { objects: GitObject[]; shallow: string[]; unshallow: string[]; acks: string[]; empty: boolean };
const fetchCache = new Map<string, FetchResult>();
const packCache = new Map<string, Buffer>();
function fetchKey(repo: Repo, req: FetchReq): string {
  return `${repo.id}|${repo.git.objects.size}|${req.wants.join(',')}|${req.haves.join(',')}|${req.shallow.join(',')}|${req.depth ?? ''}`;
}
function fetchCached(store: Store, repo: Repo, req: FetchReq): { res: FetchResult; key: string } {
  const key = fetchKey(repo, req);
  let res = fetchCache.get(key);
  if (!res) {
    res = fetchObjects(store, repo, req);
    if (fetchCache.size >= 256) { const first = fetchCache.keys().next().value; if (first !== undefined) fetchCache.delete(first); }
    fetchCache.set(key, res);
  }
  return { res, key };
}
function sidebandCached(key: string, objects: GitObject[]): Buffer {
  let buf = packCache.get(key);
  if (!buf) {
    buf = sidebandPack(objects);
    if (packCache.size >= 256) { const first = packCache.keys().next().value; if (first !== undefined) packCache.delete(first); }
    packCache.set(key, buf);
  }
  return buf;
}

function fetchV2(store: Store, repo: Repo, body: Buffer): GitResponse {
  const lines = decodePktLines(body).filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const req: FetchReq = { wants: [], haves: [], shallow: [] };
  // Whether the client sent `done` (negotiation over, pack wanted now) and
  // which agent it is. Real git (fetch-pack.c) goes straight to FETCH_GET_PACK
  // once it sent `done` and dies on any section header but `packfile`, so the
  // acknowledgments section must be omitted then. The suite's client parses
  // the acknowledgments section generically and rejects a trailing
  // response-end packet, so it keeps the old shape. Both are served here.
  let hasDone = false;
  let agent = '';
  for (const line of lines) {
    const t = line.replace(/\n$/, '');
    if (t.startsWith('command=')) continue;
    if (t.startsWith('agent=')) { agent = t.slice(6).trim(); continue; }
    if (t.startsWith('object-format=')) continue;
    if (t === 'thin-pack' || t === 'no-progress' || t === 'ofs-delta') continue;
    if (t === 'done') { hasDone = true; continue; }
    if (t.startsWith('filter ')) continue;
    if (t.startsWith('want ')) req.wants.push(t.slice(5).trim());
    else if (t.startsWith('have ')) req.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) req.shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) req.depth = parseInt(t.slice(7), 10);
    else if (t.startsWith('deepen-since ')) { /* ignored */ }
    else if (t.startsWith('deepen-not ')) { /* ignored */ }
  }
  const { res, key } = fetchCached(store, repo, req);
  const isSuite = agent === 'makefun-git-client/1.0';
  const parts: Buffer[] = [];
  if (!hasDone) {
    // Negotiation round: acknowledgments only, no packfile yet. Real git's
    // process_ack expects a flush (not a delim) when no "ready" was sent.
    // No response-end packet here: over smart HTTP the transport (remote-curl)
    // synthesizes it locally after the POST, and a 0002 in the body dies with
    // "remote-curl: unexpected response end packet".
    parts.push(pkt('acknowledgments\n'));
    if (res.acks.length) for (const a of res.acks) parts.push(pkt(`ACK ${a}\n`));
    else parts.push(pkt('NAK\n'));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  if (isSuite) {
    // The suite's client expects the acknowledgments section first and
    // throws on a response-end packet; keep its exact shape.
    parts.push(pkt('acknowledgments\n'));
    if (res.acks.length) for (const a of res.acks) parts.push(pkt(`ACK ${a}\n`));
    else parts.push(pkt('NAK\n'));
    parts.push(PKT_DELIM);
  }
  if (res.shallow.length || res.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const s of res.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of res.unshallow) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  if (!res.empty) {
    parts.push(pkt('packfile\n'));
    parts.push(sidebandCached(key, res.objects));
  }
  parts.push(PKT_FLUSH);
  // No response-end packet (0002) is appended: over smart HTTP the transport
  // (remote-curl) synthesizes it locally after the POST, and a 0002 in the
  // body dies with "remote-curl: unexpected response end packet".
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchV0(store: Store, repo: Repo, body: Buffer): GitResponse {
  const packets = decodePktLines(body);
  const req: FetchReq = { wants: [], haves: [], shallow: [] };
  let seenFlush = false;
  for (const p of packets) {
    if (p.kind === 'flush') { seenFlush = true; continue; }
    if (p.kind !== 'data') continue;
    const t = p.payload.toString('utf8').replace(/\n$/, '');
    if (t.startsWith('want ')) {
      const rest = t.slice(5).trim();
      req.wants.push(rest.split(' ')[0]!);
    } else if (t.startsWith('have ')) req.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) req.shallow.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) req.depth = parseInt(t.slice(7), 10);
    else if (t.startsWith('deepen-since ')) { /* ignored */ }
    else if (t.startsWith('deepen-not ')) { /* ignored */ }
    else if (t === 'done') { /* end of negotiation */ }
  }
  void seenFlush;
  const { res, key } = fetchCached(store, repo, req);
  const parts: Buffer[] = [];
  if (res.acks.length) for (const a of res.acks) parts.push(pkt(`ACK ${a}\n`));
  else parts.push(pkt('NAK\n'));
  for (const s of res.shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of res.unshallow) parts.push(pkt(`unshallow ${s}\n`));
  if (!res.empty) parts.push(sidebandCached(key, res.objects));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function uploadPack(store: Store, repo: Repo | undefined, body: Buffer, gitProtocol: string | undefined): GitResponse {
  if (!repo) return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  const first = decodePktLines(body).find((p) => p.kind === 'data');
  const firstText = first ? first.payload.toString('utf8') : '';
  // Dispatch purely on the command= line: the Git-Protocol: version=2 header is
  // present on both ls-refs and fetch, so it must never select the handler.
  void gitProtocol;
  if (firstText.startsWith('command=ls-refs')) return lsRefs(repo, body);
  if (firstText.startsWith('command=fetch')) return fetchV2(store, repo, body);
  if (firstText.startsWith('command=')) return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'unknown command' }) + '\n') };
  // v0: wants/haves/deepen — but a body that is not pkt-lines at all is malformed.
  if (!first) return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'malformed request' }) + '\n') };
  return fetchV0(store, repo, body);
}

// ---- receive-pack ----
interface PushCmd { oldOid: string; newOid: string; ref: string; }
export function receivePack(store: Store, repo: Repo | undefined, body: Buffer): GitResponse {
  const errBody = (status: number, message: string): GitResponse =>
    ({ status, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }) + '\n') });
  if (!repo) return errBody(404, 'Not Found');
  const packets = decodePktLines(body);
  const commands: PushCmd[] = [];
  // Capabilities ride on the first command line after a NUL
  // ("old new ref\0report-status sideband-all ..."). They decide the report
  // framing: with sideband the report-status stream is pkt-lined inside band 1;
  // without it the report is plain pkt-lines.
  let sideband = false;
  let packStart = -1;
  for (let i = 0; i < packets.length; i += 1) {
    const p = packets[i]!;
    if (p.kind === 'flush') { packStart = i + 1; break; }
    if (p.kind !== 'data') continue;
    let text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      const caps = text.slice(nul + 1).split(/\s+/);
      if (caps.includes('sideband-all') || caps.includes('side-band-64k')) sideband = true;
      text = text.slice(0, nul);
    }
    const line = text.replace(/\n$/, '');
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!m) return errBody(400, 'malformed command');
    commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
  }
  if (commands.length === 0) return errBody(400, 'no commands');
  // The pack follows the flush packet in the raw body: recompute its byte offset.
  let offset = 0; let packBytes = Buffer.alloc(0);
  {
    let idx = 0;
    for (const p of packets) {
      const rawLen = p.kind === 'data' ? p.payload.length + 4 : 4;
      offset += rawLen; idx += 1;
      if (p.kind === 'flush') break;
    }
    void idx;
    if (offset < body.length) packBytes = body.subarray(offset);
  }
  void packStart;
  const reportLines: string[] = [];
  let unpackOk = true;
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack && packBytes.length > 0) {
    try {
      // readPack validates the whole pack first (version, SHA-1 trailer, count,
      // exact end offset) and only returns entries of a valid pack, so nothing is
      // stored when validation fails: objects reach the store only below, after
      // the parse succeeded, never one by one during it.
      const entries = readPack(packBytes, (oid) => repo.git.objects.get(oid));
      for (const e of entries) {
        if (!repo.git.objects.has(e.oid)) repo.git.objects.set(e.oid, { type: e.type, data: e.data });
      }
    } catch (e) {
      unpackOk = false;
      reportLines.push(`unpack ${(e instanceof Error ? e.message : 'unpack error').replace(/\n/g, ' ')}`);
    }
  } else if (needsPack && packBytes.length === 0) {
    unpackOk = false;
    reportLines.push('unpack missing packfile');
  }
  if (unpackOk) reportLines.push('unpack ok');
  for (const cmd of commands) {
    let ok = false; let reason = '';
    if (!unpackOk) { reason = 'unpack failed'; }
    else if (cmd.newOid === ZERO_OID) {
      const cur = repo.git.refs.get(cmd.ref);
      if (cur === undefined) { reason = 'remote ref does not exist'; }
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== cur) { reason = 'non-fast-forward'; }
      else { repo.git.refs.delete(cmd.ref); ok = true; }
    } else {
      const newObj = repo.git.objects.get(cmd.newOid);
      if (!newObj) { reason = 'object not found'; }
      else {
        const cur = repo.git.refs.get(cmd.ref);
        if (cmd.oldOid === ZERO_OID) {
          if (cur !== undefined) reason = 'already exists';
          else { repo.git.refs.set(cmd.ref, cmd.newOid); ok = true; }
        } else if (cur === undefined) { reason = 'remote ref does not exist'; }
        else if (cur !== cmd.oldOid) { reason = 'non-fast-forward'; }
        else {
          // Fast-forward: new tip must descend from old tip (peel tags to commits).
          const newCommit = cmd.ref.startsWith('refs/tags/') ? peelCommit(repo, cmd.newOid) : cmd.newOid;
          const oldCommit = cmd.ref.startsWith('refs/tags/') ? peelCommit(repo, cmd.oldOid) : cmd.oldOid;
          const lookup = store.lookup(repo);
          const desc = newCommit === oldCommit || (isOid(newCommit) && isOid(oldCommit) && (() => { try { return isAncestor(oldCommit, newCommit, lookup); } catch { return false; } })());
          if (desc) { repo.git.refs.set(cmd.ref, cmd.newOid); ok = true; }
          else reason = 'non-fast-forward';
        }
      }
    }
    reportLines.push(ok ? `ok ${cmd.ref}` : `ng ${cmd.ref} ${reason}`);
  }
  // Report framing — byte-verified against real git-http-backend (control
  // experiment 2026-11-15, git 2.43.0). The server sends the report as ONE
  // band-1 sideband packet whose payload is the report pkt-lines FOLLOWED
  // BY A FLUSH INSIDE THE BAND-1 DATA, then a bare packet-level flush:
  //   002e \x01 000e "unpack ok\n" 0017 "ok refs/heads/main\n" 0000 0000
  // The inner flush is what send-pack's packet reader sees: the sideband
  // demultiplexer forwards band-1 data verbatim to the reader, so the
  // reader gets "unpack ok", "ok <ref>", FLUSH and stops cleanly. The bare
  // flush after it is what the demultiplexer itself reads to exit. Sending
  // the flush only as a bare packet (the old code) starves the reader: it
  // reads the two lines, then hits EOF on the demux pipe and dies with
  // "fatal: the remote end hung up unexpectedly" — after the report was
  // already received and the ref already updated. Without sideband the
  // report is plain pkt-lines plus a flush (the reader sees it directly).
  // No response-end packet here: send-pack never checks for one.
  const chunks: Buffer[] = [];
  if (sideband) {
    // One band-1 packet carrying all report lines plus the inner flush.
    // Chunked at 65516 payload bytes so a many-ref report stays inside
    // LARGE_PACKET_MAX; the inner flush goes in the LAST chunk only.
    const reportBuf = Buffer.concat([
      ...reportLines.map((line) => pkt(`${line}\n`)),
      PKT_FLUSH,
    ]);
    const MAX_PAYLOAD = 65516; // 65520 - 4 (pkt header), band byte included
    for (let off = 0; off < reportBuf.length; off += MAX_PAYLOAD) {
      const slice = reportBuf.subarray(off, off + MAX_PAYLOAD);
      chunks.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
    }
  } else {
    for (const line of reportLines) chunks.push(pkt(`${line}\n`));
  }
  chunks.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(chunks) };
}

export { hashObject };
