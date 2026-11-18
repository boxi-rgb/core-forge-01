// git smart HTTP: info/refs advertisements (upload-pack v2 + v0, receive-pack v0) and
// the upload-pack POST (protocol v2 ls-refs/fetch, v0 fallback).

import type { HandlerContext } from './app.ts';
import type { RepoRec } from './store.ts';
import { store } from './store.ts';
import { sendError } from './util.ts';
import {
  ancestorsOf,
  buildPack,
  commitsWithinDepth,
  parseCommit,
  parseTree,
  reachableObjects,
  type PackObject,
} from './gitobj.ts';

const ZERO_OID = '0'.repeat(40);
const AGENT = 'core-forge/1.0';

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

function parsePackets(body: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line header');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > body.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

function packetLines(packets: Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** Split sideband-carried pack bytes into band-1 pkt-lines (payload max 65516 incl. band byte). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  if (pack.length === 0) return parts;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return parts;
}

// -------------------------------------------------------------------------------------------
// refs / advertisement helpers
// -------------------------------------------------------------------------------------------

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Follow tag objects to the first non-tag object; null when the chain is broken. */
function peelTag(repo: RepoRec, sha: string): string | null {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type !== 'tag') return current;
    const blank = object.data.indexOf('\n\n');
    const head = object.data.subarray(0, blank < 0 ? object.data.length : blank).toString('utf8');
    const line = head.split('\n').find((entry) => entry.startsWith('object '));
    if (!line) return null;
    current = line.slice(7).trim();
  }
  return null;
}

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const target = headTarget(repo);
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress include-tag symref=HEAD:${target} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta symref=HEAD:${target} agent=${AGENT}`;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    lines.push(PKT_FLUSH);
    return Buffer.concat(lines);
  }
  const headSha = repo.refs.get(target);
  let first = true;
  const pushLine = (text: string): void => {
    if (first) {
      lines.push(pktLine(`${text}\0${caps}\n`));
      first = false;
    } else {
      lines.push(pktLine(`${text}\n`));
    }
  };
  if (headSha) pushLine(`${headSha} HEAD`);
  for (const [name, sha] of refs) {
    pushLine(`${sha} ${name}`);
    const object = repo.objects.get(sha);
    if (object?.type === 'tag') {
      const peeled = peelTag(repo, sha);
      if (peeled && peeled !== sha) pushLine(`${peeled} ${name}^{}`);
    }
  }
  if (first) {
    // Refs exist but none was emitted (cannot happen: refs.length > 0 emits at least one).
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

function v2Advertisement(): Buffer {
  const lines = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(lines);
}

export async function gitInfoRefs(ctx: HandlerContext, owner: string, repoName: string): Promise<void> {
  const service = ctx.url.searchParams.get('service');
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(ctx.res, 400, 'Bad Request');
    return;
  }
  const wantsV2 =
    service === 'git-upload-pack' && (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
  const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
  ctx.res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  ctx.res.end(body);
}

// -------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// -------------------------------------------------------------------------------------------

function lsRefsResponse(repo: RepoRec, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  if (matches('HEAD')) {
    const headSha = repo.refs.get(target);
    if (headSha) {
      parts.push(pktLine(`${headSha} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const [name, sha] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${sha} ${name}`;
    if (peel) {
      const object = repo.objects.get(sha);
      if (object?.type === 'tag') {
        const peeled = peelTag(repo, sha);
        if (peeled && peeled !== sha) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// fetch (protocol v2 + v0)
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  wantRefs: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  filter: string | null;
  done: boolean;
}

function commitTimestamp(repo: RepoRec, sha: string): number {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return 0;
  const committer = parseCommit(object.data).committer;
  const match = / (\d+) [+-]\d{4}$/.exec(committer);
  return match ? Number.parseInt(match[1]!, 10) : 0;
}

/** Tree-side closure (trees + blobs) of one tree object. */
function treeClosure(repo: RepoRec, treeSha: string, into: Set<string>): void {
  const queue = [treeSha];
  while (queue.length > 0) {
    const sha = queue.pop()!;
    if (into.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (!object || object.type !== 'tree') continue;
    into.add(sha);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '160000') continue;
      const child = repo.objects.get(entry.sha);
      if (child?.type === 'tree') queue.push(entry.sha);
      else if (child) into.add(entry.sha);
    }
  }
}

/**
 * Objects the client already holds, computed from its `have` tips. A commit the
 * client lists as a shallow boundary contributes itself and its trees, but its
 * parents are NOT walked: the client does not hold them.
 */
function haveClosure(repo: RepoRec, haves: string[], shallowBoundary: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...haves];
  while (queue.length > 0) {
    const sha = queue.pop()!;
    if (seen.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (!object) continue;
    seen.add(sha);
    if (object.type === 'commit') {
      treeClosure(repo, parseCommit(object.data).tree, seen);
      if (!shallowBoundary.has(sha)) {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      const peeled = peelTag(repo, sha);
      if (peeled) queue.push(peeled);
    } else if (object.type === 'tree') {
      treeClosure(repo, sha, seen);
    }
  }
  return seen;
}

interface FetchPlan {
  packObjects: PackObject[];
  shallowLines: string[];
  commonHaves: string[];
  wantedRefs: Array<{ oid: string; ref: string }>;
}

function planFetch(repo: RepoRec, args: FetchArgs): FetchPlan {
  const wants = [...args.wants];
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const ref of args.wantRefs) {
    const oid = repo.refs.get(ref);
    if (oid) {
      wants.push(oid);
      wantedRefs.push({ oid, ref });
    }
  }
  const shallowBoundary = new Set(args.shallow);

  // Excluded history (deepen-not).
  const notCommits = new Set<string>();
  for (const not of args.deepenNot) {
    const sha = repo.refs.get(not) ?? not;
    for (const ancestor of ancestorsOf(repo, sha)) notCommits.add(ancestor);
  }

  // Commit tips: peel tag wants down to commits for the history walk.
  const tips: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'commit') tips.push(want);
    else if (object.type === 'tag') {
      const peeled = peelTag(repo, want);
      if (peeled && repo.objects.get(peeled)?.type === 'commit') tips.push(peeled);
    }
  }

  let includedCommits: Set<string>;
  let boundary = new Set<string>();
  if (args.deepen !== null) {
    const result = commitsWithinDepth(repo, tips, args.deepen);
    includedCommits = result.included;
    boundary = result.boundary;
  } else if (args.deepenSince !== null) {
    includedCommits = new Set();
    const queue = [...tips];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const sha = queue.pop()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') continue;
      if (commitTimestamp(repo, sha) < args.deepenSince) continue;
      includedCommits.add(sha);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    for (const sha of includedCommits) {
      const parents = parseCommit(repo.objects.get(sha)!.data).parents;
      if (parents.some((parent) => !includedCommits.has(parent) && repo.objects.get(parent)?.type === 'commit')) {
        boundary.add(sha);
      }
    }
  } else {
    includedCommits = new Set();
    for (const tip of tips) for (const ancestor of ancestorsOf(repo, tip)) includedCommits.add(ancestor);
  }
  for (const sha of notCommits) {
    includedCommits.delete(sha);
    boundary.delete(sha);
  }

  // Included objects: the included commits with their trees, plus the full
  // closure of any non-commit wants (tags, trees, blobs).
  const included = new Set<string>();
  for (const sha of includedCommits) {
    included.add(sha);
    treeClosure(repo, parseCommit(repo.objects.get(sha)!.data).tree, included);
  }
  const omitBlobs = args.filter === 'blob:none';
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object || object.type === 'commit') continue;
    for (const sha of reachableObjects(repo, [want], new Set())) {
      // A tag's target commit outside the depth limit is not pulled in.
      if (repo.objects.get(sha)?.type === 'commit' && !includedCommits.has(sha)) continue;
      included.add(sha);
    }
  }
  if (omitBlobs) {
    for (const sha of [...included]) {
      if (repo.objects.get(sha)?.type === 'blob') included.delete(sha);
    }
  }

  const held = haveClosure(repo, args.haves, shallowBoundary);
  const packObjects: PackObject[] = [];
  for (const sha of included) {
    if (held.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (object) packObjects.push({ sha, type: object.type, data: object.data });
  }
  // Deterministic pack order: commits, then trees, then tags, then blobs, by sha.
  const rank = { commit: 0, tree: 1, tag: 2, blob: 3 } as const;
  packObjects.sort((a, b) => rank[a.type] - rank[b.type] || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));

  const shallowLines: string[] = [];
  if (args.deepen !== null || args.deepenSince !== null) {
    for (const sha of [...boundary].sort()) {
      if (!shallowBoundary.has(sha)) shallowLines.push(`shallow ${sha}`);
    }
    for (const sha of args.shallow) {
      if (includedCommits.has(sha) && !boundary.has(sha)) shallowLines.push(`unshallow ${sha}`);
    }
  }

  const commonHaves = args.haves.filter((have) => repo.objects.has(have));
  return { packObjects, shallowLines, commonHaves, wantedRefs };
}

function fetchV2Response(repo: RepoRec, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  if (plan.commonHaves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const have of plan.commonHaves) parts.push(pktLine(`ACK ${have}\n`));
  }
  if (args.done) parts.push(pktLine('ready\n'));
  parts.push(PKT_DELIM);
  if (!args.done) {
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  if (plan.shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_DELIM);
  }
  if (plan.wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const entry of plan.wantedRefs) parts.push(pktLine(`${entry.oid} ${entry.ref}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(buildPack(plan.packObjects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Response(repo: RepoRec, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
  if (plan.commonHaves.length === 0) parts.push(pktLine('NAK\n'));
  else parts.push(pktLine(`ACK ${plan.commonHaves[0]}\n`));
  parts.push(...sidebandPackets(buildPack(plan.packObjects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    wantRefs: [],
    haves: [],
    shallow: [],
    deepen: null,
    deepenSince: null,
    deepenNot: [],
    filter: null,
    done: false,
  };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]!);
    else if (line.startsWith('want-ref ')) args.wantRefs.push(line.slice(9).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number.parseInt(line.slice(13).trim(), 10);
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
    else if (line === 'done') args.done = true;
  }
  return args;
}

export async function gitUploadPack(ctx: HandlerContext, owner: string, repoName: string): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  let packets: Packet[];
  try {
    packets = parsePackets(ctx.body);
  } catch {
    sendError(ctx.res, 400, 'Bad Request');
    return;
  }
  const lines = packetLines(packets);
  const commandLine = lines.find((line) => line.startsWith('command='));
  const isV2 = commandLine !== undefined || (ctx.req.headers['git-protocol'] ?? '').includes('version=2');

  let body: Buffer;
  if (commandLine === 'command=ls-refs') {
    // Arguments are the lines after the delim packet.
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : packets;
    body = lsRefsResponse(repo, packetLines(argPackets));
  } else if (commandLine === 'command=fetch' || isV2) {
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : packets;
    body = fetchV2Response(repo, parseFetchArgs(packetLines(argPackets)));
  } else {
    // Protocol v0: want/have sections separated by flush packets; lines carry it all.
    const args = parseFetchArgs(lines);
    if (!args.done && args.wants.length === 0) {
      sendError(ctx.res, 400, 'Bad Request');
      return;
    }
    args.done = true;
    body = fetchV0Response(repo, args);
  }
  ctx.res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  ctx.res.end(body);
}
