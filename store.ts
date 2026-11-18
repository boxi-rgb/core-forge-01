// The shared in-memory store: one Store holds every repository with its git objects, refs,
// issues, pull requests, labels and comments. REST, GraphQL, MCP and the git smart-HTTP
// handlers all read and write this one store, so an object created on one surface is the
// same object on every other.
//
// Determinism: the trial replays each run and compares the suite's export byte for byte,
// so nothing here reads the wall clock or a random source. Timestamps come from a logical
// clock seeded by MAKEFUN_TRIAL_NOW (the instance's opening time) and advanced one second
// per issued timestamp: the same request sequence always produces the same bytes.

/** The one user the trial's bearer token names (the suite's seeded viewer). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The version string GET /api/v3/meta reports. */
export const INSTALLED_VERSION = 'core-forge 1.0.0';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObjectRec {
  readonly type: GitObjectType;
  /** The object's raw content (for a commit/tree, the unencoded bytes; no zlib, no header). */
  readonly data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  /** Full ref of the head branch, e.g. refs/heads/feature. */
  headRef: string;
  /** Full ref of the base branch. */
  baseRef: string;
  /** The head commit sha resolved when the pull was opened (refreshed on merge). */
  headSha: string;
  /** The base commit sha resolved when the pull was opened (refreshed on merge). */
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  /** Label names, in the order they were attached. */
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: CommentRec[];
  /** Non-null when this number is a pull request (GitHub numbers issues and pulls together). */
  pull: PullRec | null;
}

export interface RepoRec {
  id: number;
  name: string;
  ownerLogin: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** sha hex -> object. */
  objects: Map<string, GitObjectRec>;
  /** Full ref name (refs/heads/main) -> commit sha hex. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  /** Issue/PR number -> record. */
  issues: Map<number, IssueRec>;
  /** The next issue/PR number to hand out (one sequence for both, as on GitHub). */
  nextNumber: number;
}

const DEFAULT_CLOCK_BASE = '2026-11-14T06:30:00.000Z';

export class Store {
  /** fullName (owner/name) -> repository. */
  readonly repos = new Map<string, RepoRec>();
  private nextRepoId = 1;
  private nextCommentId = 1;
  private clockBaseMs: number;
  private clockTick = 0;

  constructor() {
    const trialNow = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = Date.parse(trialNow);
    this.clockBaseMs = Number.isFinite(parsed) ? parsed : Date.parse(DEFAULT_CLOCK_BASE);
  }

  /** The next logical timestamp as an ISO string; advances the clock by one second. */
  nowIso(): string {
    const ms = this.clockBaseMs + this.clockTick * 1000;
    this.clockTick += 1;
    return new Date(ms).toISOString();
  }

  /** The next logical timestamp as unix seconds (for git author/committer lines). */
  nowUnix(): number {
    return Math.floor(this.clockBaseMs / 1000) + this.clockTick++;
  }

  /** The current logical time without advancing it. */
  peekIso(): string {
    return new Date(this.clockBaseMs + this.clockTick * 1000).toISOString();
  }

  createRepo(name: string, opts: { description?: string; isPrivate?: boolean; defaultBranch?: string } = {}): RepoRec {
    const now = this.nowIso();
    const repo: RepoRec = {
      id: this.nextRepoId++,
      name,
      ownerLogin: VIEWER.login,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextNumber: 1,
    };
    this.repos.set(`${repo.ownerLogin}/${name}`, repo);
    return repo;
  }

  /** A repository only exists for its owner: any other owner segment is a 404. */
  getRepo(owner: string, name: string): RepoRec | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  allocCommentId(): number {
    return this.nextCommentId++;
  }
}

/** The process-wide store the handlers share. */
export const store = new Store();
