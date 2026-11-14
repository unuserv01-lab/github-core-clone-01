// Pure git primitives: SHA-1 objects, pkt-lines, packfiles. No I/O, no clock, no randomness.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer; }

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  h.update(body);
  return h.digest('hex');
}

export function isOid(v: string): boolean { return /^[0-9a-f]{40}$/.test(v); }

export interface TreeEntry { mode: string; name: string; oid: string; }
export function parseTree(data: Uint8Array): TreeEntry[] {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < b.length) {
    const sp = b.indexOf(0x20, off);
    const nul = b.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > b.length) throw new Error('bad tree');
    out.push({ mode: b.subarray(off, sp).toString('ascii'), name: b.subarray(sp + 1, nul).toString('utf8'), oid: b.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}
function cmpTreeName(a: TreeEntry, b: TreeEntry): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(cmpTreeName);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }
export function parseCommit(data: Uint8Array): CommitView {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = b.indexOf('\n\n');
  const headEnd = blank < 0 ? b.length : blank;
  const message = blank < 0 ? '' : b.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of b.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
export function buildCommit(o: { tree: string; parents?: readonly string[]; message: string; author: string; committer?: string }): Buffer {
  const lines = [`tree ${o.tree}`];
  for (const p of o.parents ?? []) lines.push(`parent ${p}`);
  lines.push(`author ${o.author}`, `committer ${o.committer ?? o.author}`, '');
  return Buffer.from(`${lines.join('\n')}\n${o.message}`, 'utf8');
}
export interface TagView { object: string; type: GitObjectType; tag: string; tagger: string; message: string; }
export function parseTag(data: Uint8Array): TagView {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = b.indexOf('\n\n');
  const headEnd = blank < 0 ? b.length : blank;
  const headers = new Map<string, string>();
  for (const line of b.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return { object: headers.get('object') ?? '', type: (headers.get('type') ?? 'commit') as GitObjectType, tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '', message: blank < 0 ? '' : b.subarray(blank + 2).toString('utf8') };
}

// ---- pkt-line ----
export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pkt(it));
  }
  return Buffer.concat(parts);
}
/** Decode a whole buffer of pkt-lines; returns data payloads and control markers. */
export function decodePktLines(buf: Buffer): { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }[] {
  const out: { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// ---- packfile ----
function packObjHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>>= 4;
  if (size) first |= 0x80;
  bytes.push(first);
  while (size) { let b = size & 0x7f; size >>>= 7; if (size) b |= 0x80; bytes.push(b); }
  return Buffer.from(bytes);
}
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1]!.writeUInt32BE(2, 0);
  parts[2]!.writeUInt32BE(list.length, 0);
  for (const o of list) {
    parts.push(packObjHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const head = Buffer.concat(parts);
  const sum = createHash('sha1').update(head).digest();
  return Buffer.concat([head, sum]);
}
/** Inflate a zlib stream starting at off; returns data and the offset just past the stream. */
function inflateAt(buf: Buffer, off: number, expectedSize: number): { data: Buffer; next: number } {
  // Binary-search the smallest end that inflates to the expected size.
  let lo = off + 1; let hi = buf.length; let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const d = inflateSync(buf.subarray(off, mid));
      if (d.length === expectedSize) { found = mid; hi = mid - 1; } else { lo = mid + 1; }
    } catch { lo = mid + 1; }
  }
  if (found < 0) throw new Error('pack inflate failed');
  return { data: inflateSync(buf.subarray(off, found)), next: found };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVar = (): number => { let v = 0; let s = 0; for (;;) { const b = delta[off]!; off += 1; v |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break; } return v; };
  readVar(); const targetSize = readVar();
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off]!; off += 1;
    if (op & 0x80) {
      let cpOff = 0; let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOff |= delta[off]! << (8 * i); off += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize |= delta[off]! << (8 * i); off += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize)); total += cpSize;
    } else if (op) {
      out.push(delta.subarray(off, off + op)); total += op; off += op;
    } else throw new Error('bad delta opcode 0');
  }
  if (total !== targetSize) throw new Error('delta size mismatch');
  return Buffer.concat(out);
}
export interface PackEntry { type: GitObjectType; data: Buffer; oid: string; }
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackEntry[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const count = pack.readUInt32BE(8);
  let off = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const first = pack[off]!;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f; let shift = 4; off += 1;
    while (pack[off - 1]! & 0x80) { size |= (pack[off]! & 0x7f) << shift; shift += 7; off += 1; }
    if (typeCode === 6) { // OFS_DELTA
      let b = pack[off]!; off += 1; let baseOff = b & 0x7f;
      while (b & 0x80) { b = pack[off]!; off += 1; baseOff = ((baseOff + 1) << 7) | (b & 0x7f); }
      const baseEntry = byOffset.get(start - baseOff);
      if (!baseEntry) throw new Error('ofs delta base missing');
      const { data, next } = inflateAt(pack, off, size);
      const resolved = applyDelta(baseEntry.data, data);
      const entry: PackEntry = { type: baseEntry.type, data: resolved, oid: hashObject(baseEntry.type, resolved) };
      entries.push(entry); byOffset.set(start, entry); off = next;
    } else if (typeCode === 7) { // REF_DELTA
      const baseOid = pack.subarray(off, off + 20).toString('hex'); off += 20;
      const baseObj = resolveBase?.(baseOid) ?? entries.find((e) => e.oid === baseOid);
      if (!baseObj) throw new Error('ref delta base missing');
      const { data, next } = inflateAt(pack, off, size);
      const resolved = applyDelta(baseObj.data, data);
      const entry: PackEntry = { type: baseObj.type, data: resolved, oid: hashObject(baseObj.type, resolved) };
      entries.push(entry); byOffset.set(start, entry); off = next;
    } else {
      const type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`bad pack type ${typeCode}`);
      const { data, next } = inflateAt(pack, off, size);
      const entry: PackEntry = { type, data, oid: hashObject(type, data) };
      entries.push(entry); byOffset.set(start, entry); off = next;
    }
  }
  return entries;
}
export function packChecksumOk(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const expect = pack.subarray(pack.length - 20).toString('hex');
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex') === expect;
}

/** Objects reachable from roots (commit->tree+parents, tag->target, tree->entries). */
export function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined, opts: { stopAt?: Set<string> } = {}): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isOid(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      if (!opts.stopAt?.has(oid)) for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
  }
  return seen;
}
/** Peel a ref target to its commit (through annotated tags). */
export function peelToCommit(oid: string, lookup: (oid: string) => GitObject | undefined): string {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = lookup(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
  return cur;
}
/** True when ancestor is reachable from descendant (commit ancestry). */
export function isAncestor(ancestor: string, descendant: string, lookup: (oid: string) => GitObject | undefined): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}
/** Merge-base: nearest common commit ancestor of a and b (BFS by generation). */
export function mergeBase(a: string, b: string, lookup: (oid: string) => GitObject | undefined): string | null {
  const ancA = new Set<string>();
  const qa = [a];
  while (qa.length) {
    const oid = qa.pop()!;
    if (ancA.has(oid)) continue;
    ancA.add(oid);
    const obj = lookup(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) qa.push(p);
  }
  const qb = [b];
  const seenB = new Set<string>();
  while (qb.length) {
    const oid = qb.pop()!;
    if (ancA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const obj = lookup(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) qb.push(p);
  }
  return null;
}
