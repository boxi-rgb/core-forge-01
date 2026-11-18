// REST v3: the API root, meta, repositories, contents, git refs, branches, commits,
// labels, issues and comments. Pull requests live in pulls.ts.

import type { HandlerContext } from './app.ts';
import { INSTALLED_VERSION, store, VIEWER, type IssueRec, type RepoRec } from './store.ts';
import { intParam, paginate, parseJsonBody, sendError, sendJson } from './util.ts';
import { flattenTree, parseCommit, parseTree, storeObject, updatePathInTree } from './gitobj.ts';

// -------------------------------------------------------------------------------------------
// Serializers

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', site_admin: false };
}

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.ownerLogin}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const rec = repo.labels.get(name);
  return {
    id: 0,
    node_id: '',
    name,
    color: rec?.color ?? 'ededed',
    description: rec?.description ?? null,
    default: false,
  };
}

function issueJson(repo: RepoRec, rec: IssueRec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: repo.id * 1_000_000 + rec.number,
    node_id: `I_${repo.id}_${rec.number}`,
    number: rec.number,
    title: rec.title,
    body: rec.body ?? '',
    state: rec.state,
    labels: rec.labels.map((name) => labelJson(repo, name)),
    comments: rec.comments.length,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    closed_at: rec.state === 'closed' ? rec.updatedAt : null,
    user: userJson(),
    author_association: 'OWNER',
  };
  if (rec.pull !== null) {
    out.pull_request = {
      url: '',
      html_url: '',
      diff_url: '',
      patch_url: '',
      merged_at: rec.pull.mergedAt,
    };
  }
  return out;
}

function commentJson(rec: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: rec.id,
    node_id: `C_${rec.id}`,
    body: rec.body,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    user: userJson(),
    author_association: 'OWNER',
  };
}

// -------------------------------------------------------------------------------------------
// Git helpers

/** Resolve a branch name, a full ref, or a commit sha to a commit sha. */
function resolveCommit(repo: RepoRec, ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  const byRef = repo.refs.get(ref);
  if (byRef !== undefined) return byRef;
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  // A short sha is not expected from the suite, but accept an unambiguous prefix.
  if (/^[0-9a-f]{4,39}$/i.test(ref)) {
    const matches = [...repo.objects.entries()].filter(([sha, o]) => o.type === 'commit' && sha.startsWith(ref.toLowerCase()));
    if (matches.length === 1) return (matches[0] as [string, unknown])[0];
  }
  return null;
}

function commitInfo(repo: RepoRec, sha: string) {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  try {
    return parseCommit(obj.data);
  } catch {
    return null;
  }
}

interface Ident {
  name: string;
  email: string;
  date: string;
}

function parseIdent(line: string): Ident {
  const m = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (m === null) return { name: line, email: '', date: new Date(0).toISOString() };
  const unix = Number.parseInt(m[3] as string, 10);
  return { name: m[1] as string, email: m[2] as string, date: new Date(unix * 1000).toISOString() };
}

function commitJson(repo: RepoRec, sha: string): Record<string, unknown> | null {
  const info = commitInfo(repo, sha);
  if (info === null) return null;
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message: info.message,
      tree: { sha: info.tree },
      author: parseIdent(info.author),
      committer: parseIdent(info.committer),
      comment_count: 0,
    },
    author: userJson(),
    committer: userJson(),
    parents: info.parents.map((p) => ({ sha: p })),
  };
}

/** Walk the tree at `treeSha` following `parts`; returns the entry found, or null. */
function walkTree(repo: RepoRec, treeSha: string, parts: string[]): { sha: string; mode: string } | null {
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    let entries;
    try {
      entries = parseTree(obj.data);
    } catch {
      return null;
    }
    const entry = entries.find((e) => e.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return { sha: entry.sha, mode: entry.mode };
    current = entry.sha;
  }
  return null;
}

/** The blob sha at `path` in the tree, or null when absent / a directory. */
function blobShaAt(repo: RepoRec, treeSha: string | null, path: string): string | null {
  if (treeSha === null) return null;
  // flattenTree is the fast path; fall back to a manual walk if it disagrees.
  try {
    const flat = flattenTree(repo, treeSha);
    const hit = flat.get(path);
    if (hit !== undefined) return hit.sha;
  } catch {
    /* fall through to the walk */
  }
  const found = walkTree(repo, treeSha, path.split('/'));
  if (found === null) return null;
  return found.mode === '40000' || found.mode === '040000' ? null : found.sha;
}

function treeShaOfCommit(repo: RepoRec, commitSha: string | null): string | null {
  if (commitSha === null) return null;
  const info = commitInfo(repo, commitSha);
  return info?.tree ?? null;
}

/** Build and store one commit object (standard git format) and return its sha. */
function makeCommit(repo: RepoRec, opts: { tree: string; parents: string[]; message: string }): string {
  const ts = store.nowUnix();
  const ident = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  const lines = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', opts.message);
  return storeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

// -------------------------------------------------------------------------------------------
// Main handler

export async function handleRest(ctx: HandlerContext): Promise<void> {
  const { req, res, url } = ctx;
  const method = (req.method ?? 'GET').toUpperCase();
  const rest = url.pathname.slice('/api/v3'.length); // '' or '/...'

  // Parse a JSON body once for the methods that carry one; malformed JSON is a 400.
  let body: Record<string, unknown> = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const parsed = parseJsonBody(ctx.body);
    if (parsed === null) {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    body = parsed;
  }

  const sendPaginated = (items: unknown[]): void => {
    const { page, link } = paginate(req, url, items);
    sendJson(res, 200, page, link !== null ? { link } : {});
  };

  // --- API root / meta / viewer -------------------------------------------------------------
  if (rest === '' || rest === '/') {
    if (method !== 'GET') return notFound(ctx);
    const base = `${url.origin}/api/v3`;
    sendJson(
      res,
      200,
      {
        current_user_url: `${base}/user`,
        current_user_repositories_url: `${base}/user/repos`,
        repository_url: `${base}/repos/{owner}/{repo}`,
        issue_search_url: `${base}/search/issues?q={query}{&page,per_page,sort,order}`,
        label_search_url: `${base}/search/labels?q={query}`,
        emojis_url: `${base}/emojis`,
        meta_url: `${base}/meta`,
      },
      { 'x-oauth-scopes': 'repo, user' },
    );
    return;
  }
  if (rest === '/meta') {
    if (method !== 'GET') return notFound(ctx);
    sendJson(res, 200, {
      verifiable_password_authentication: true,
      installed_version: INSTALLED_VERSION,
    });
    return;
  }
  if (rest === '/user') {
    if (method !== 'GET') return notFound(ctx);
    sendJson(res, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: `U_${VIEWER.id}`,
      type: 'User',
      site_admin: false,
      name: VIEWER.name,
      email: VIEWER.email,
      public_repos: store.listRepos().length,
      created_at: store.peekIso(),
      updated_at: store.peekIso(),
    });
    return;
  }
  if (rest === '/user/repos') {
    if (method === 'GET') {
      sendPaginated(store.listRepos().map(repoJson));
      return;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendError(res, 422, 'Repository creation failed: name is required');
        return;
      }
      if (store.getRepo(VIEWER.login, name) !== undefined) {
        sendError(res, 422, 'Repository creation failed: name already exists on this account');
        return;
      }
      const repo = store.createRepo(name, {
        description: typeof body.description === 'string' ? body.description : undefined,
        isPrivate: typeof body.private === 'boolean' ? body.private : undefined,
        defaultBranch: typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : undefined,
      });
      sendJson(res, 201, repoJson(repo));
      return;
    }
    return notFound(ctx);
  }

  // --- /repos/{owner}/{repo}/... ------------------------------------------------------------
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(rest);
  if (repoMatch === null) return notFound(ctx);
  const owner = decodeURIComponent(repoMatch[1] as string);
  const repoName = decodeURIComponent(repoMatch[2] as string);
  const tail = repoMatch[3] ?? '';
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }

  if (tail === '' || tail === '/') {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        if (store.getRepo(VIEWER.login, body.name) !== undefined) {
          sendError(res, 422, 'Repository rename failed: name already exists on this account');
          return;
        }
        store.repos.delete(`${repo.ownerLogin}/${repo.name}`);
        repo.name = body.name;
        store.repos.set(`${repo.ownerLogin}/${repo.name}`, repo);
      }
      repo.updatedAt = store.nowIso();
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      sendJson(res, 204, undefined);
      return;
    }
    return notFound(ctx);
  }

  // --- git refs -----------------------------------------------------------------------------
  if (tail === '/git/refs' || tail.startsWith('/git/refs/')) {
    const sub = tail === '/git/refs' ? '' : decodeURIComponent(tail.slice('/git/refs/'.length));
    if (method === 'POST' && sub === '') {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (ref === '' || sha === '') {
        sendError(res, 422, 'Invalid request: ref and sha are required');
        return;
      }
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') {
        sendError(res, 422, `Object does not exist: ${sha}`);
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, `Reference already exists: ${ref}`);
        return;
      }
      repo.refs.set(ref, sha);
      repo.updatedAt = store.nowIso();
      sendJson(res, 201, { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } });
      return;
    }
    if (method === 'GET' && sub === '') {
      const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } }));
      sendPaginated(all);
      return;
    }
    if (sub !== '') {
      const fullRef = sub.startsWith('refs/') ? sub : `refs/${sub}`;
      if (method === 'GET') {
        const sha = repo.refs.get(fullRef);
        if (sha === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { ref: fullRef, node_id: `REF_${fullRef}`, object: { sha, type: 'commit' } });
        return;
      }
      if (method === 'DELETE') {
        if (!repo.refs.delete(fullRef)) {
          sendError(res, 422, `Reference does not exist: ${fullRef}`);
          return;
        }
        sendJson(res, 204, undefined);
        return;
      }
      if (method === 'PATCH') {
        const sha = typeof body.sha === 'string' ? body.sha : '';
        const obj = repo.objects.get(sha);
        if (obj === undefined || obj.type !== 'commit') {
          sendError(res, 422, `Object does not exist: ${sha}`);
          return;
        }
        if (!repo.refs.has(fullRef) && body.force !== true) {
          // GitHub creates on PATCH only with force semantics; keep it simple: create it.
        }
        repo.refs.set(fullRef, sha);
        sendJson(res, 200, { ref: fullRef, node_id: `REF_${fullRef}`, object: { sha, type: 'commit' } });
        return;
      }
    }
    return notFound(ctx);
  }

  // --- branches -----------------------------------------------------------------------------
  if (tail === '/branches' || tail.startsWith('/branches/')) {
    if (tail === '/branches') {
      if (method !== 'GET') return notFound(ctx);
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, url: '' },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      sendPaginated(branches);
      return;
    }
    const branchName = decodeURIComponent(tail.slice('/branches/'.length));
    if (method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${branchName}`);
      if (sha === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const commit = commitJson(repo, sha);
      sendJson(res, 200, { name: branchName, commit: commit ?? { sha }, protected: false, _links: {} });
      return;
    }
    return notFound(ctx);
  }

  // --- commits ------------------------------------------------------------------------------
  if (tail === '/commits' || tail.startsWith('/commits/')) {
    if (tail !== '/commits') {
      // GET a single commit by sha.
      if (method !== 'GET') return notFound(ctx);
      const sha = decodeURIComponent(tail.slice('/commits/'.length));
      const commit = commitJson(repo, sha);
      if (commit === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, commit);
      return;
    }
    if (method !== 'GET') return notFound(ctx);
    const startSha = resolveCommit(repo, url.searchParams.get('sha'));
    if (startSha === null) {
      // Unborn repository (or unknown ref): GitHub answers 409 for an empty repo, but an
      // empty list is the safer read for a fresh repo; an unknown explicit ref is a 404.
      if (url.searchParams.get('sha') !== null && repo.refs.size > 0) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendPaginated([]);
      return;
    }
    // DFS pre-order from the tip: newest first for linear history, topological for merges.
    const ordered: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [startSha];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      ordered.push(sha);
      const info = commitInfo(repo, sha);
      if (info !== null) {
        // Push parents reversed so the first parent is visited first.
        for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i] as string);
      }
    }
    const pathFilter = url.searchParams.get('path');
    let shas = ordered;
    if (pathFilter !== null && pathFilter !== '') {
      shas = ordered.filter((sha) => {
        const info = commitInfo(repo, sha);
        if (info === null) return false;
        return blobShaAt(repo, info.tree, pathFilter) !== null;
      });
    }
    const items = shas.map((sha) => commitJson(repo, sha)).filter((c) => c !== null);
    sendPaginated(items);
    return;
  }

  // --- contents -----------------------------------------------------------------------------
  if (tail === '/contents' || tail.startsWith('/contents/')) {
    const filePath = tail === '/contents' ? '' : tail.slice('/contents/'.length).split('/').map(decodeURIComponent).join('/');

    if (method === 'GET') {
      const refParam = url.searchParams.get('ref');
      const commitSha = resolveCommit(repo, refParam);
      if (commitSha === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const treeSha = treeShaOfCommit(repo, commitSha);
      if (treeSha === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (filePath === '') {
        sendJson(res, 200, listTreeEntries(repo, treeSha, ''));
        return;
      }
      const found = walkTree(repo, treeSha, filePath.split('/'));
      if (found === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (found.mode === '40000' || found.mode === '040000') {
        sendJson(res, 200, listTreeEntries(repo, found.sha, filePath));
        return;
      }
      const blob = repo.objects.get(found.sha);
      if (blob === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: basename(filePath),
        path: filePath,
        sha: found.sha,
        content: blob.data.toString('base64'),
        _links: {},
      });
      return;
    }

    if (method === 'PUT') {
      if (filePath === '') return notFound(ctx);
      const message = typeof body.message === 'string' ? body.message : '';
      const contentB64 = typeof body.content === 'string' ? body.content : null;
      if (contentB64 === null) {
        sendError(res, 422, 'Invalid request: content is required');
        return;
      }
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const fullRef = `refs/heads/${branch}`;
      const tipSha = repo.refs.get(fullRef) ?? null;
      const oldTreeSha = treeShaOfCommit(repo, tipSha);
      const existingSha = blobShaAt(repo, oldTreeSha, filePath);
      const givenSha = typeof body.sha === 'string' ? body.sha : null;
      if (existingSha !== null) {
        if (givenSha === null || givenSha.toLowerCase() !== existingSha.toLowerCase()) {
          sendError(res, 409, `${filePath} does not match ${givenSha ?? ''}`);
          return;
        }
      }
      const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      const blobSha = storeObject(repo, 'blob', data);
      const newTree = updatePathInTree(repo, oldTreeSha, filePath, blobSha);
      const commitSha = makeCommit(repo, {
        tree: newTree,
        parents: tipSha !== null ? [tipSha] : [],
        message,
      });
      repo.refs.set(fullRef, commitSha);
      repo.updatedAt = store.nowIso();
      sendJson(res, existingSha !== null ? 200 : 201, {
        content: {
          type: 'file',
          size: data.length,
          name: basename(filePath),
          path: filePath,
          sha: blobSha,
          encoding: 'base64',
        },
        commit: { sha: commitSha, message },
      });
      return;
    }

    if (method === 'DELETE') {
      if (filePath === '') return notFound(ctx);
      const message = typeof body.message === 'string' ? body.message : '';
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const fullRef = `refs/heads/${branch}`;
      const tipSha = repo.refs.get(fullRef) ?? null;
      const oldTreeSha = treeShaOfCommit(repo, tipSha);
      const existingSha = blobShaAt(repo, oldTreeSha, filePath);
      if (existingSha === null) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const givenSha = typeof body.sha === 'string' ? body.sha : null;
      if (givenSha === null || givenSha.toLowerCase() !== existingSha.toLowerCase()) {
        sendError(res, 409, `${filePath} does not match ${givenSha ?? ''}`);
        return;
      }
      const newTree = updatePathInTree(repo, oldTreeSha, filePath, null);
      const commitSha = makeCommit(repo, {
        tree: newTree,
        parents: tipSha !== null ? [tipSha] : [],
        message,
      });
      repo.refs.set(fullRef, commitSha);
      repo.updatedAt = store.nowIso();
      sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
      return;
    }
    return notFound(ctx);
  }

  // --- labels -------------------------------------------------------------------------------
  if (tail === '/labels' || tail.startsWith('/labels/')) {
    if (tail === '/labels') {
      if (method === 'GET') {
        sendPaginated([...repo.labels.keys()].map((name) => labelJson(repo, name)));
        return;
      }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') {
          sendError(res, 422, 'Validation Failed: name is required');
          return;
        }
        if (repo.labels.has(name)) {
          sendError(res, 422, 'Validation Failed: name already exists');
          return;
        }
        const colorRaw = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        repo.labels.set(name, {
          name,
          color: colorRaw,
          description: typeof body.description === 'string' ? body.description : null,
        });
        sendJson(res, 201, labelJson(repo, name));
        return;
      }
      return notFound(ctx);
    }
    const labelName = decodeURIComponent(tail.slice('/labels/'.length));
    const rec = repo.labels.get(labelName);
    if (rec === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, labelJson(repo, labelName));
      return;
    }
    if (method === 'PATCH') {
      const newName = typeof body.new_name === 'string' && body.new_name !== '' ? body.new_name : labelName;
      if (typeof body.color === 'string') rec.color = body.color.replace(/^#/, '');
      if (typeof body.description === 'string') rec.description = body.description;
      if (newName !== labelName) {
        repo.labels.delete(labelName);
        rec.name = newName;
        repo.labels.set(newName, rec);
        for (const issue of repo.issues.values()) {
          issue.labels = issue.labels.map((l) => (l === labelName ? newName : l));
        }
      }
      sendJson(res, 200, labelJson(repo, newName));
      return;
    }
    if (method === 'DELETE') {
      repo.labels.delete(labelName);
      sendJson(res, 204, undefined);
      return;
    }
    return notFound(ctx);
  }

  // --- issues & comments ----------------------------------------------------------------------
  if (tail === '/issues' || tail.startsWith('/issues/')) {
    if (tail === '/issues') {
      if (method === 'GET') {
        const stateParam = url.searchParams.get('state') ?? 'open';
        let list = [...repo.issues.values()];
        if (stateParam === 'open') list = list.filter((i) => i.state === 'open');
        else if (stateParam === 'closed') list = list.filter((i) => i.state === 'closed');
        else if (stateParam !== 'all') {
          sendError(res, 422, `Invalid state: ${stateParam}`);
          return;
        }
        const labelsParam = url.searchParams.get('labels');
        if (labelsParam !== null && labelsParam !== '') {
          const wanted = labelsParam.split(',').map((s) => s.trim()).filter((s) => s !== '');
          list = list.filter((i) => wanted.every((w) => i.labels.includes(w)));
        }
        const direction = url.searchParams.get('direction') ?? 'desc';
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        sendPaginated(list.map((i) => issueJson(repo, i)));
        return;
      }
      if (method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') {
          sendError(res, 422, 'Validation Failed: title is required');
          return;
        }
        const labelNames = parseLabelInput(body.labels);
        if (labelNames === null) {
          sendError(res, 422, 'Validation Failed: labels must be an array');
          return;
        }
        for (const name of labelNames) {
          if (!repo.labels.has(name)) {
            sendError(res, 422, `Validation Failed: label ${name} does not exist`);
            return;
          }
        }
        const now = store.nowIso();
        const rec: IssueRec = {
          number: repo.nextNumber++,
          title,
          body: typeof body.body === 'string' ? body.body : null,
          state: 'open',
          labels: labelNames,
          createdAt: now,
          updatedAt: now,
          comments: [],
          pull: null,
        };
        repo.issues.set(rec.number, rec);
        repo.updatedAt = store.nowIso();
        sendJson(res, 201, issueJson(repo, rec));
        return;
      }
      return notFound(ctx);
    }

    const issueMatch = /^\/issues\/(\d+)(\/.*)?$/.exec(tail);
    if (issueMatch === null) return notFound(ctx);
    const number = Number.parseInt(issueMatch[1] as string, 10);
    const sub = issueMatch[2] ?? '';
    const rec = repo.issues.get(number);
    if (rec === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }

    if (sub === '' || sub === '/') {
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, rec));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.title === 'string') rec.title = body.title;
        if (typeof body.body === 'string' || body.body === null) rec.body = body.body as string | null;
        if (body.labels !== undefined) {
          const labelNames = parseLabelInput(body.labels);
          if (labelNames === null) {
            sendError(res, 422, 'Validation Failed: labels must be an array');
            return;
          }
          for (const name of labelNames) {
            if (!repo.labels.has(name)) {
              sendError(res, 422, `Validation Failed: label ${name} does not exist`);
              return;
            }
          }
          rec.labels = labelNames;
        }
        if (typeof body.state === 'string') {
          if (body.state !== 'open' && body.state !== 'closed') {
            sendError(res, 422, `Invalid state: ${body.state}`);
            return;
          }
          rec.state = body.state;
        }
        rec.updatedAt = store.nowIso();
        sendJson(res, 200, issueJson(repo, rec));
        return;
      }
      return notFound(ctx);
    }

    if (sub === '/comments' || sub.startsWith('/comments/')) {
      if (sub === '/comments') {
        if (method === 'GET') {
          const sorted = [...rec.comments].sort((a, b) => a.id - b.id);
          const direction = url.searchParams.get('direction');
          if (direction === 'desc') sorted.reverse();
          sendPaginated(sorted.map(commentJson));
          return;
        }
        if (method === 'POST') {
          const text = typeof body.body === 'string' ? body.body : '';
          if (text === '') {
            sendError(res, 422, 'Validation Failed: body is required');
            return;
          }
          const now = store.nowIso();
          const comment = { id: store.allocCommentId(), body: text, createdAt: now, updatedAt: now };
          rec.comments.push(comment);
          rec.updatedAt = store.nowIso();
          sendJson(res, 201, commentJson(comment));
          return;
        }
        return notFound(ctx);
      }
      const commentMatch = /^\/comments\/(\d+)$/.exec(sub);
      if (commentMatch !== null) {
        const commentId = Number.parseInt(commentMatch[1] as string, 10);
        const comment = rec.comments.find((c) => c.id === commentId);
        if (comment === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, commentJson(comment));
          return;
        }
        if (method === 'PATCH') {
          if (typeof body.body === 'string') comment.body = body.body;
          comment.updatedAt = store.nowIso();
          sendJson(res, 200, commentJson(comment));
          return;
        }
        if (method === 'DELETE') {
          rec.comments = rec.comments.filter((c) => c.id !== commentId);
          sendJson(res, 204, undefined);
          return;
        }
      }
      return notFound(ctx);
    }

    if (sub === '/labels' && method === 'GET') {
      sendJson(res, 200, rec.labels.map((name) => labelJson(repo, name)));
      return;
    }
    return notFound(ctx);
  }

  return notFound(ctx);
}

function notFound(ctx: HandlerContext): void {
  sendError(ctx.res, 404, 'Not Found');
}

/** The entries of one tree as a contents directory listing. */
function listTreeEntries(repo: RepoRec, treeSha: string, prefix: string): Record<string, unknown>[] {
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return [];
  let entries;
  try {
    entries = parseTree(obj.data);
  } catch {
    return [];
  }
  return entries.map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const child = repo.objects.get(entry.sha);
    return {
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.sha,
      size: isDir ? 0 : (child?.data.length ?? 0),
      type: isDir ? 'dir' : 'file',
      _links: {},
    };
  });
}

/** Labels arrive as string[] or {name}[]; null when the value is neither. */
function parseLabelInput(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string') {
      out.push((item as { name: string }).name);
    } else return null;
  }
  return out;
}

// Referenced for potential single-commit author filtering; keeps intParam part of the surface.
void intParam;
