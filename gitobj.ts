// The git object layer: hashing, the object store, commit/tree parsing and building,
// pack reading (with delta resolution) and writing (no deltas), tree flattening and
// rewriting for the contents API, and commit-graph walks (ancestry, shallow depth).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObjectType, RepoRec } from './store.ts';

export interface CommitInfo {
  tree: string;
  parents: string[];
  /** The full author line value, e.g. "ada iversen <adaiversen@example.invalid> 1760000000 +0000". */
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  /** Octal mode as written in the tree, e.g. "100644" or "40000" for a subtree. */
  mode: string;
  name: string;
  sha: string;
}

export interface PackObject {
  sha: string;
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data: Buffer.from(data) });
  return sha;
}

export function parseCommit(data: Buffer): CommitInfo {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  // Header lines may be folded (continuation lines start with a space); only the
  // modelled headers are single-line in practice, but unfold defensively.
  const lines: string[] = [];
  for (const raw of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (raw.startsWith(' ') && lines.length > 0) lines[lines.length - 1] += `\n${raw}`;
    else if (raw) lines.push(raw);
  }
  for (const line of lines) {
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(parts: { tree: string; parents: string[]; author: string; committer: string; message: string }): Buffer {
  const lines = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${parts.author}`, `committer ${parts.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${parts.message}`, 'utf8');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function isDirMode(mode: string): boolean {
  return (Number.parseInt(mode, 8) & 0o170000) === 0o040000;
}

/** git's tree sort: byte order of the name, directories compared as name + '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(isDirMode(a.mode) ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(isDirMode(b.mode) ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function flattenTree(repo: RepoRec, treeSha: string): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  const walk = (sha: string, prefix: string): void => {
    const object = repo.objects.get(sha);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isDirMode(entry.mode)) walk(entry.sha, path);
      else if (entry.mode !== '160000') out.set(path, { sha: entry.sha, mode: entry.mode });
    }
  };
  walk(treeSha, '');
  return out;
}

interface FileNode {
  files: Map<string, string>;
  dirs: Map<string, FileNode>;
}

export function writeTreeFromFiles(repo: RepoRec, files: Map<string, string>): string {
  const make = (): FileNode => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, blobSha] of files) {
    const segments = path.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1] as string, blobSha);
  }
  const build = (node: FileNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sha] of node.files) entries.push({ mode: '100644', name, sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/**
 * Set (blobSha != null) or delete (blobSha == null) one path in a tree, storing every
 * rewritten tree on the way. Returns the new root tree sha; an emptied root becomes
 * the empty tree. Subtrees left empty by a delete are removed.
 */
export function updatePathInTree(repo: RepoRec, treeSha: string | null, path: string, blobSha: string | null): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  // Returns the new tree sha, or null when the tree became empty.
  const update = (sha: string | null, depth: number): string | null => {
    const entries: TreeEntry[] =
      sha !== null && repo.objects.get(sha)?.type === 'tree' ? [...parseTree(repo.objects.get(sha)!.data)] : [];
    const name = segments[depth] as string;
    const index = entries.findIndex((entry) => entry.name === name);
    if (depth === segments.length - 1) {
      if (blobSha === null) {
        if (index >= 0) entries.splice(index, 1);
      } else if (index >= 0) {
        entries[index] = { mode: entries[index]!.mode === '40000' ? '100644' : entries[index]!.mode, name, sha: blobSha };
      } else {
        entries.push({ mode: '100644', name, sha: blobSha });
      }
    } else {
      const childSha = index >= 0 && entries[index]!.mode === '40000' ? entries[index]!.sha : null;
      const newChild = update(childSha, depth + 1);
      if (newChild === null) {
        if (index >= 0) entries.splice(index, 1);
      } else if (index >= 0) {
        entries[index] = { mode: '40000', name, sha: newChild };
      } else {
        entries.push({ mode: '40000', name, sha: newChild });
      }
    }
    if (entries.length === 0) return null;
    return storeObject(repo, 'tree', buildTree(entries));
  };
  if (segments.length === 0) return treeSha ?? storeObject(repo, 'tree', buildTree([]));
  return update(treeSha, 0) ?? storeObject(repo, 'tree', buildTree([]));
}

export function ancestorsOf(repo: RepoRec, sha: string): Set<string> {
  const seen = new Set<string>();
  const queue = [sha];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') continue;
    seen.add(current);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestorsOf(repo, descendant).has(ancestor);
}

/**
 * Commits reachable from `tips` within `depth` steps (a tip is depth 1, as in git's
 * shallow clone) and the boundary: included commits at exactly `depth` that still
 * have a parent in the repo, i.e. where history was cut.
 */
export function commitsWithinDepth(
  repo: RepoRec,
  tips: string[],
  depth: number,
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  if (depth <= 0) return { included, boundary };
  let frontier = [...new Set(tips)];
  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (included.has(sha)) continue;
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') continue;
      included.add(sha);
      const parents = parseCommit(object.data).parents;
      if (level === depth) {
        if (parents.some((parent) => repo.objects.get(parent)?.type === 'commit')) boundary.add(sha);
      } else {
        for (const parent of parents) if (!included.has(parent)) next.push(parent);
      }
    }
    frontier = next;
  }
  return { included, boundary };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

export function parsePack(buf: Buffer): PackObject[] {
  if (buf.length < 32) throw new Error('pack is too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  const resolvedByOid = new Map<string, RawEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry header is truncated');
    let byte = buf[offset]!;
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = buf[offset++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
      let b = buf[offset]!;
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        b = buf[offset++]!;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (!baseEntry) throw new Error(`ref-delta base ${entry.baseOid} is not in the pack (thin packs are not accepted here)`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  return raw.map((entry) => {
    const resolved = resolve(entry);
    return { sha: resolved.oid, type: resolved.type, data: resolved.data };
  });
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function buildPack(objects: PackObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Every object reachable from `roots` (commit → tree + parents, tag → target,
 * tree → entries except gitlinks), stopping at (and excluding) anything in
 * `exclude`. Missing roots are skipped.
 */
export function reachableObjects(repo: RepoRec, roots: Iterable<string>, exclude: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) queue.push(root);
  while (queue.length > 0) {
    const sha = queue.pop()!;
    if (seen.has(sha) || exclude.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (!object) continue;
    seen.add(sha);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      const blank = object.data.indexOf('\n\n');
      const head = object.data.subarray(0, blank < 0 ? object.data.length : blank).toString('utf8');
      for (const line of head.split('\n')) {
        if (line.startsWith('object ')) queue.push(line.slice(7).trim());
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.sha);
      }
    }
  }
  return seen;
}

export function collectClosure(repo: RepoRec, wants: string[], haves: Set<string>): PackObject[] {
  const excluded = reachableObjects(repo, haves, new Set());
  const included = reachableObjects(repo, wants, excluded);
  const out: PackObject[] = [];
  for (const sha of included) {
    const object = repo.objects.get(sha);
    if (object) out.push({ sha, type: object.type, data: object.data });
  }
  return out;
}

export { EMPTY_TREE_SHA };
