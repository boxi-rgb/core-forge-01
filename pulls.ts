// REST v3 pull requests: create, read, list, files, commits, update and squash merge.
//
// Pull requests live in the repo's issues map (IssueRec.pull non-null) and share the
// issue number sequence, per store.ts. The REST `id` is repo.id * 1000000 + number.
//
// Merge semantics (from the conformance checks, the source of truth):
//   - PUT /pulls/{n}/merge performs a squash merge: one new commit whose only parent
//     is the current base tip, whose tree is the three-way (file-level) merge of the
//     merge-base tree, the current base tree and the head tree, and whose content is
//     then reachable from the base branch. The pull is closed, merged, and reports
//     merged_at and merge_commit_sha.
//   - A file changed on BOTH sides since the merge-base, to different results, is a
//     conflict: the merge answers 405 and nothing is committed. (The checks build
//     exactly this: two branches edit the same file differently from a common base,
//     the first merges cleanly, the second must be 405.) A file changed on only one
//     side takes that side's version, so base-side progress is never squashed away.

import type { HandlerContext } from './app.ts';
import { store, VIEWER, type IssueRec, type RepoRec } from './store.ts';
import { paginate, parseJsonBody, sendError, sendJson } from './util.ts';
import { ancestorsOf, buildCommit, buildTree, flattenTree, parseCommit, storeObject, type TreeEntry } from './gitobj.ts';

const PULLS_PATH = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls(?:\/(\d+)(?:\/(files|commits|merge))?)?$/;

function branchName(refOrName: string): string {
  return refOrName.startsWith('refs/heads/') ? refOrName.slice('refs/heads/'.length) : refOrName;
}

function fullRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** A head/base as submitted: "branch", "owner:branch" or "refs/heads/branch" -> branch name. */
function submittedBranch(raw: string): { owner: string | null; branch: string } {
  const name = branchName(raw.trim());
  const colon = name.indexOf(':');
  if (colon >= 0) return { owner: name.slice(0, colon), branch: name.slice(colon + 1) };
  return { owner: null, branch: name };
}

function pullObject(repo: RepoRec, rec: IssueRec): Record<string, unknown> {
  const pull = rec.pull;
  if (pull === null) throw new Error('pullObject on a non-pull issue');
  const headBranch = branchName(pull.headRef);
  const baseBranch = branchName(pull.baseRef);
  // Prefer the live ref tips when the branches still exist; the stored shas are the
  // values resolved at creation (and refreshed on merge).
  const headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
  const baseSha = pull.merged ? pull.baseSha : (repo.refs.get(pull.baseRef) ?? pull.baseSha);
  const user = { login: VIEWER.login, id: VIEWER.id };
  const repoRef = { id: repo.id, name: repo.name, full_name: `${repo.ownerLogin}/${repo.name}`, owner: user };
  return {
    id: repo.id * 1000000 + rec.number,
    number: rec.number,
    state: rec.state,
    title: rec.title,
    body: rec.body ?? '',
    user,
    labels: [],
    draft: false,
    head: { ref: headBranch, sha: headSha, label: `${repo.ownerLogin}:${headBranch}`, user, repo: repoRef },
    base: { ref: baseBranch, sha: baseSha, label: `${repo.ownerLogin}:${baseBranch}`, user, repo: repoRef },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: rec.state === 'closed' ? (pull.mergedAt ?? rec.updatedAt) : null,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    url: `/api/v3/repos/${repo.ownerLogin}/${repo.name}/pulls/${rec.number}`,
    html_url: `/api/v3/repos/${repo.ownerLogin}/${repo.name}/pulls/${rec.number}`,
  };
}

function getPull(repo: RepoRec, number: number): IssueRec | undefined {
  const rec = repo.issues.get(number);
  return rec !== undefined && rec.pull !== null ? rec : undefined;
}

// ---------------------------------------------------------------------------
// git helpers

/** The best common ancestor of two commits (BFS from `head`, nearest first), or null. */
function mergeBase(repo: RepoRec, baseSha: string, headSha: string): string | null {
  const baseAncestors = ancestorsOf(repo, baseSha);
  const seen = new Set<string>();
  const queue: string[] = [headSha];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (baseAncestors.has(sha)) return sha;
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

function treeOfCommit(repo: RepoRec, sha: string): string | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function flatTreeOfCommit(repo: RepoRec, sha: string | null): Map<string, { sha: string; mode: string }> {
  if (sha === null) return new Map();
  const tree = treeOfCommit(repo, sha);
  if (tree === null) return new Map();
  return flattenTree(repo, tree);
}

function blobText(repo: RepoRec, sha: string | undefined): string {
  if (sha === undefined) return '';
  const obj = repo.objects.get(sha);
  return obj === undefined ? '' : obj.data.toString('utf8');
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface LineDiff {
  additions: number;
  deletions: number;
  /** Unified-diff body lines (with leading ' ', '-' or '+'), in order. */
  ops: string[];
}

/** A plain LCS line diff; the files in play are small. */
function lineDiff(oldText: string, newText: string): LineDiff {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const ops: string[] = [];
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
      ops.push(`-${a[i]}`);
      deletions += 1;
      i += 1;
    } else {
      ops.push(`+${b[j]}`);
      additions += 1;
      j += 1;
    }
  }
  while (i < m) {
    ops.push(`-${a[i]}`);
    deletions += 1;
    i += 1;
  }
  while (j < n) {
    ops.push(`+${b[j]}`);
    additions += 1;
    j += 1;
  }
  return { additions, deletions, ops };
}

function unifiedPatch(filename: string, oldText: string, newText: string, diff: LineDiff): string {
  const oldCount = splitLines(oldText).length;
  const newCount = splitLines(newText).length;
  const header = `@@ -1,${oldCount} +1,${newCount} @@`;
  return [`--- a/${filename}`, `+++ b/${filename}`, header, ...diff.ops].join('\n') + '\n';
}

/** Rebuild a tree object from a flattened path -> {sha, mode} map. */
function writeTree(repo: RepoRec, files: Map<string, { sha: string; mode: string }>): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Set<string>();
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: file.mode, name: rest, sha: file.sha });
      } else {
        subdirs.add(rest.slice(0, slash));
      }
    }
    for (const dir of subdirs) {
      entries.push({ mode: '40000', name: dir, sha: build(`${prefix}${dir}/`) });
    }
    entries.sort((x, y) => {
      const xn = x.mode === '40000' ? `${x.name}/` : x.name;
      const yn = y.mode === '40000' ? `${y.name}/` : y.name;
      return xn < yn ? -1 : xn > yn ? 1 : 0;
    });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build('');
}

// ---------------------------------------------------------------------------
// handlers

async function createPull(ctx: HandlerContext, repo: RepoRec): Promise<void> {
  const body = parseJsonBody(ctx.body);
  if (body === null) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const title = typeof body.title === 'string' ? body.title : '';
  const headRaw = typeof body.head === 'string' ? body.head : '';
  const baseRaw = typeof body.base === 'string' ? body.base : '';
  if (title === '' || headRaw === '' || baseRaw === '') {
    sendError(ctx.res, 422, 'Validation Failed');
    return;
  }
  const head = submittedBranch(headRaw);
  const base = submittedBranch(baseRaw);
  if ((head.owner !== null && head.owner !== repo.ownerLogin) || (base.owner !== null && base.owner !== repo.ownerLogin)) {
    sendError(ctx.res, 422, 'Validation Failed');
    return;
  }
  const headRef = fullRef(head.branch);
  const baseRef = fullRef(base.branch);
  const headSha = repo.refs.get(headRef);
  const baseSha = repo.refs.get(baseRef);
  if (headSha === undefined || baseSha === undefined || headRef === baseRef) {
    sendError(ctx.res, 422, 'Validation Failed');
    return;
  }
  for (const rec of repo.issues.values()) {
    if (rec.pull !== null && rec.state === 'open' && rec.pull.headRef === headRef && rec.pull.baseRef === baseRef) {
      sendError(ctx.res, 422, 'Validation Failed: A pull request already exists for this branch.');
      return;
    }
  }
  const now = store.nowIso();
  const number = repo.nextNumber++;
  const rec: IssueRec = {
    number,
    title,
    body: typeof body.body === 'string' ? body.body : null,
    state: 'open',
    labels: [],
    createdAt: now,
    updatedAt: now,
    comments: [],
    pull: { headRef, baseRef, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null },
  };
  repo.issues.set(number, rec);
  sendJson(ctx.res, 201, pullObject(repo, rec));
}

function listPulls(ctx: HandlerContext, repo: RepoRec): void {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const all = [...repo.issues.values()].filter((rec) => rec.pull !== null).sort((a, b) => a.number - b.number);
  const filtered = state === 'all' ? all : state === 'closed' ? all.filter((rec) => rec.state === 'closed') : all.filter((rec) => rec.state === 'open');
  const { page, link } = paginate(ctx.req, ctx.url, filtered);
  sendJson(ctx.res, 200, page.map((rec) => pullObject(repo, rec)), link !== null ? { link } : {});
}

function patchPull(ctx: HandlerContext, repo: RepoRec, rec: IssueRec): void {
  const body = parseJsonBody(ctx.body);
  if (body === null) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  if (typeof body.title === 'string') rec.title = body.title;
  if (typeof body.body === 'string' || body.body === null) rec.body = body.body as string | null;
  if (body.state === 'open' || body.state === 'closed') rec.state = body.state;
  rec.updatedAt = store.nowIso();
  sendJson(ctx.res, 200, pullObject(repo, rec));
}

function pullFiles(ctx: HandlerContext, repo: RepoRec, rec: IssueRec): void {
  const pull = rec.pull as NonNullable<IssueRec['pull']>;
  const headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
  const baseSha = repo.refs.get(pull.baseRef) ?? pull.baseSha;
  const base = pull.merged ? pull.baseSha : mergeBase(repo, baseSha, headSha);
  const from = flatTreeOfCommit(repo, base);
  const to = flatTreeOfCommit(repo, headSha);
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  const files: Record<string, unknown>[] = [];
  for (const path of paths) {
    const oldFile = from.get(path);
    const newFile = to.get(path);
    if (oldFile !== undefined && newFile !== undefined && oldFile.sha === newFile.sha) continue;
    const status = oldFile === undefined ? 'added' : newFile === undefined ? 'removed' : 'modified';
    const oldText = blobText(repo, oldFile?.sha);
    const newText = blobText(repo, newFile?.sha);
    const diff = lineDiff(oldText, newText);
    files.push({
      sha: newFile?.sha ?? oldFile?.sha ?? null,
      filename: path,
      status,
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
      patch: unifiedPatch(path, oldText, newText, diff),
    });
  }
  const { page, link } = paginate(ctx.req, ctx.url, files);
  sendJson(ctx.res, 200, page, link !== null ? { link } : {});
}

function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: store.peekIso() };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

function pullCommits(ctx: HandlerContext, repo: RepoRec, rec: IssueRec): void {
  const pull = rec.pull as NonNullable<IssueRec['pull']>;
  const headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
  const baseSha = repo.refs.get(pull.baseRef) ?? pull.baseSha;
  const baseAncestors = ancestorsOf(repo, baseSha);
  const commits: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const queue: string[] = [headSha];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha) || baseAncestors.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    commits.push({
      sha,
      commit: {
        message: info.message,
        author: parseAuthorLine(info.author),
        committer: parseAuthorLine(info.committer),
        tree: { sha: info.tree },
      },
      author: { login: VIEWER.login, id: VIEWER.id },
      committer: { login: VIEWER.login, id: VIEWER.id },
      parents: info.parents.map((parent) => ({ sha: parent })),
    });
    for (const parent of info.parents) queue.push(parent);
  }
  const { page, link } = paginate(ctx.req, ctx.url, commits);
  sendJson(ctx.res, 200, page, link !== null ? { link } : {});
}

function mergePull(ctx: HandlerContext, repo: RepoRec, rec: IssueRec): void {
  const body = parseJsonBody(ctx.body);
  if (body === null) {
    sendError(ctx.res, 400, 'Problems parsing JSON');
    return;
  }
  const pull = rec.pull as NonNullable<IssueRec['pull']>;
  if (pull.merged || rec.state !== 'open') {
    sendError(ctx.res, 405, 'Pull Request is not mergeable');
    return;
  }
  const baseTip = repo.refs.get(pull.baseRef) ?? pull.baseSha;
  const headTip = repo.refs.get(pull.headRef) ?? pull.headSha;

  const ancestorSha = mergeBase(repo, baseTip, headTip);
  const ancestorFiles = flatTreeOfCommit(repo, ancestorSha);
  const baseFiles = flatTreeOfCommit(repo, baseTip);
  const headFiles = flatTreeOfCommit(repo, headTip);

  const mergedFiles = new Map<string, { sha: string; mode: string }>();
  const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path);
    const baseFile = baseFiles.get(path);
    const headFile = headFiles.get(path);
    const baseChanged = baseFile?.sha !== ancestor?.sha;
    const headChanged = headFile?.sha !== ancestor?.sha;
    if (baseChanged && headChanged && baseFile?.sha !== headFile?.sha) {
      sendError(ctx.res, 405, 'Pull Request is not mergeable');
      return;
    }
    const winner = headChanged ? headFile : baseFile;
    if (winner !== undefined) mergedFiles.set(path, winner);
  }

  const tree = writeTree(repo, mergedFiles);
  const ts = store.nowUnix();
  const ident = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  const message = `${rec.title} (#${rec.number})`;
  const commitData = buildCommit({ tree, parents: [baseTip], author: ident, committer: ident, message });
  const mergeSha = storeObject(repo, 'commit', commitData);

  repo.refs.set(pull.baseRef, mergeSha);
  const now = store.nowIso();
  pull.headSha = headTip;
  pull.baseSha = baseTip;
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = mergeSha;
  rec.state = 'closed';
  rec.updatedAt = now;
  repo.updatedAt = now;

  sendJson(ctx.res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
}

export async function handlePulls(ctx: HandlerContext): Promise<void> {
  const match = PULLS_PATH.exec(ctx.url.pathname);
  if (match === null) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  const owner = decodeURIComponent(match[1] as string);
  const repoName = decodeURIComponent(match[2] as string);
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  const method = ctx.req.method ?? 'GET';
  const numberRaw = match[3];
  const tail = match[4];

  try {
    if (numberRaw === undefined) {
      if (method === 'POST') {
        await createPull(ctx, repo);
        return;
      }
      if (method === 'GET') {
        listPulls(ctx, repo);
        return;
      }
      sendError(ctx.res, 404, 'Not Found');
      return;
    }

    const number = Number.parseInt(numberRaw, 10);
    const rec = getPull(repo, number);
    if (rec === undefined) {
      sendError(ctx.res, 404, 'Not Found');
      return;
    }
    if (tail === undefined) {
      if (method === 'GET') {
        sendJson(ctx.res, 200, pullObject(repo, rec));
        return;
      }
      if (method === 'PATCH') {
        patchPull(ctx, repo, rec);
        return;
      }
      sendError(ctx.res, 404, 'Not Found');
      return;
    }
    if (tail === 'files' && method === 'GET') {
      pullFiles(ctx, repo, rec);
      return;
    }
    if (tail === 'commits' && method === 'GET') {
      pullCommits(ctx, repo, rec);
      return;
    }
    if (tail === 'merge' && method === 'PUT') {
      mergePull(ctx, repo, rec);
      return;
    }
    sendError(ctx.res, 404, 'Not Found');
  } catch {
    if (!ctx.res.headersSent) sendError(ctx.res, 500, 'Internal Server Error');
    else ctx.res.end();
  }
}
