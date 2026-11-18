// git receive-pack (protocol v0): ref updates plus a pack, applied per ref (never all-or-
// nothing across refs), with report-status over side-band-64k when the client asked for both.
//
// Wire shape, per the conformance client (git-client.ts `push` / `parsePushReport`):
//   request  = *pkt-line("<old> SP <new> SP <ref>" [NUL capabilities]) flush pack?
//              A delete-only command list carries no pack at all; a create/update list
//              always carries one, possibly an empty (0-object) pack.
//   response = report-status as its own pkt-line stream ("unpack ok", then one
//              "ok <ref>" / "ng <ref> <reason>" per command, then flush), wrapped in
//              side-band-64k band-1 packets when side-band-64k was requested. Without
//              report-status the response is a bare flush and the client reports null.
// Refusals the checks pin down byte-exactly: a non-fast-forward update is
// "ng <ref> non-fast-forward" and leaves the ref untouched, while sibling commands in
// the same list still apply. Objects from the pack are stored before validation, so a
// refused ref's objects stay in the repository, exactly as in real git.

import type { HandlerContext } from './app.ts';
import { store, type RepoRec } from './store.ts';
import { nextRequestId, sendError } from './util.ts';
import { isAncestor, parsePack } from './gitobj.ts';

const ZERO_OID = '0'.repeat(40);
const OID_RE = /^[0-9a-f]{40}$/;
/** Payload ceiling of one pkt-line (65520 total) minus the band byte. */
const SIDEBAND_CHUNK = 65515;

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface RefOutcome {
  command: RefCommand;
  ok: boolean;
  reason: string;
}

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');

/** True when a capability token (`name` or `name=value`) was requested. */
function hasCapability(capabilities: readonly string[], name: string): boolean {
  return capabilities.some((token) => token === name || token.startsWith(`${name}=`));
}

/**
 * Split the request body into the command list, the first line's capabilities and the
 * trailing pack bytes. Returns null on a structurally malformed command list.
 */
function parseRequest(body: Buffer): { commands: RefCommand[]; capabilities: string[]; pack: Buffer } | null {
  const commands: RefCommand[] = [];
  let capabilities: string[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) return null;
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return null;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      return { commands, capabilities, pack: body.subarray(offset + 4) };
    }
    if (length < 4 || offset + length > body.length) return null;
    let payload = body.subarray(offset + 4, offset + length);
    offset += length;
    const nul = payload.indexOf(0);
    if (nul >= 0) {
      if (commands.length === 0) {
        // The capability list runs to the line's trailing LF; trim it or the last
        // token ("side-band-64k\n") never matches its bare name.
        capabilities = payload.subarray(nul + 1).toString('utf8').trim().split(' ').filter((token) => token.length > 0);
      }
      payload = payload.subarray(0, nul);
    }
    const line = payload.toString('utf8').replace(/\n$/, '');
    const firstSpace = line.indexOf(' ');
    const secondSpace = firstSpace < 0 ? -1 : line.indexOf(' ', firstSpace + 1);
    if (firstSpace < 0 || secondSpace < 0) return null;
    commands.push({
      oldOid: line.slice(0, firstSpace),
      newOid: line.slice(firstSpace + 1, secondSpace),
      ref: line.slice(secondSpace + 1),
    });
  }
}

/**
 * Resolve an object id to the commit it names, peeling annotated tags. Null when the
 * object is missing or is not (eventually) a commit. Tag parsing is inlined because
 * gitobj.ts exports no tag parser: a tag's first header line is "object <sha>".
 */
function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const headerEnd = object.data.indexOf('\n\n');
    const header = object.data.subarray(0, headerEnd < 0 ? object.data.length : headerEnd).toString('utf8');
    let target: string | null = null;
    for (const line of header.split('\n')) {
      if (line.startsWith('object ')) {
        target = line.slice('object '.length).trim();
        break;
      }
    }
    if (target === null || !OID_RE.test(target)) return null;
    current = target;
  }
  return null;
}

/** Validate one command against the live refs and apply it when it passes. */
function applyCommand(repo: RepoRec, command: RefCommand): RefOutcome {
  const { oldOid, newOid, ref } = command;
  const fail = (reason: string): RefOutcome => ({ command, ok: false, reason });
  if (!ref.startsWith('refs/') || ref.length > 200 || /[\s\u0000-\u001f]/.test(ref)) return fail('invalid ref');
  if (!OID_RE.test(oldOid) || !OID_RE.test(newOid)) return fail('invalid object');
  const current = repo.refs.get(ref) ?? ZERO_OID;

  if (newOid === ZERO_OID) {
    // Delete. delete-refs is part of the advertisement, so a delete that reaches this
    // handler is permitted; it still has to name the ref's current value.
    if (current === ZERO_OID) return fail('remote ref does not exist');
    if (oldOid !== current) return fail('stale info');
    repo.refs.delete(ref);
    return { command, ok: true, reason: '' };
  }

  const newCommit = peelToCommit(repo, newOid);
  if (newCommit === null) return fail('invalid object');

  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return fail('already exists');
    repo.refs.set(ref, newOid);
    return { command, ok: true, reason: '' };
  }

  if (current !== oldOid) return fail('stale info');
  if (newOid === oldOid) return { command, ok: true, reason: '' };

  const oldCommit = peelToCommit(repo, oldOid);
  if (oldCommit === null) return fail('non-fast-forward');
  if (newCommit !== oldCommit) {
    let fastForward = false;
    try {
      fastForward = isAncestor(repo, oldCommit, newCommit);
    } catch {
      fastForward = false;
    }
    if (!fastForward) return fail('non-fast-forward');
  }
  repo.refs.set(ref, newOid);
  return { command, ok: true, reason: '' };
}

/** The report-status stream: unpack line, one line per ref, flush. v2 adds option lines. */
function buildReport(outcomes: readonly RefOutcome[], unpackOk: boolean, version2: boolean): Buffer {
  const parts: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack error\n')];
  for (const outcome of outcomes) {
    const { command } = outcome;
    if (!unpackOk) {
      parts.push(pktLine(`ng ${command.ref} unpacker error\n`));
    } else if (outcome.ok) {
      parts.push(pktLine(`ok ${command.ref}\n`));
    } else {
      parts.push(pktLine(`ng ${command.ref} ${outcome.reason}\n`));
    }
    if (version2) {
      parts.push(pktLine(`option refname ${command.ref}\n`));
      parts.push(pktLine(`option old-oid ${command.oldOid}\n`));
      parts.push(pktLine(`option new-oid ${command.newOid}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Wrap a report stream in side-band-64k band-1 packets, terminated by a plain flush. */
function wrapSideband(inner: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < inner.length; offset += SIDEBAND_CHUNK) {
    const chunk = inner.subarray(offset, offset + SIDEBAND_CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export async function gitReceivePack(ctx: HandlerContext, owner: string, repoName: string): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }

  const parsed = parseRequest(ctx.body);
  if (parsed === null) {
    sendError(ctx.res, 400, 'Bad Request');
    return;
  }
  const { commands, capabilities, pack } = parsed;
  const wantReport = hasCapability(capabilities, 'report-status') || hasCapability(capabilities, 'report-status-v2');
  const version2 = hasCapability(capabilities, 'report-status-v2');
  const sideband = hasCapability(capabilities, 'side-band-64k');

  // Store the pack's objects first; they stay even for refs that are refused below.
  let unpackOk = true;
  if (pack.length > 0) {
    try {
      for (const object of parsePack(pack)) {
        repo.objects.set(object.sha, { type: object.type, data: object.data });
      }
    } catch {
      unpackOk = false;
    }
  }

  const outcomes = commands.map((command) => (unpackOk ? applyCommand(repo, command) : { command, ok: false, reason: 'unpacker error' }));

  let responseBody: Buffer;
  if (!wantReport) {
    responseBody = FLUSH;
  } else {
    const report = buildReport(outcomes, unpackOk, version2);
    responseBody = sideband ? wrapSideband(report) : report;
  }

  ctx.res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-result',
    'content-length': responseBody.length,
    'x-github-request-id': nextRequestId(),
  });
  ctx.res.end(responseBody);
}
