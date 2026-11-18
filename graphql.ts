// GraphQL v4 at /api/graphql: a small dedicated executor for the documents gh and
// github-mcp-server send (see the conformance kit's checks-graphql.ts), plus __type
// introspection. Not a general GraphQL engine: it parses the query language those
// documents use (operations, aliases, variables, inline enum lists and input objects,
// inline fragments, fragment definitions) and resolves them against the shared store,
// so an object created over REST or git reads back identically here.
//
// Global (node) ids are opaque and stable: base64 of "<prefix>:<Type><key>", in the
// shape of GitHub's legacy node ids. An issue/PR key is its REST databaseId
// (repo.id * 1000000 + number); a repository key is its repo.id.

import { createHash } from 'node:crypto';
import type { HandlerContext } from './app.ts';
import { store, VIEWER, type IssueRec, type RepoRec, type CommentRec } from './store.ts';
import { sendJson } from './util.ts';

// ---------------------------------------------------------------------------------------------------------
// Global ids
// ---------------------------------------------------------------------------------------------------------

const ID_PREFIX: Readonly<Record<string, string>> = {
  Repository: '010',
  User: '04',
  Label: '05',
  IssueComment: '06',
  Issue: '07',
  PullRequest: '09',
};

export function globalId(type: string, key: number): string {
  const prefix = ID_PREFIX[type] ?? '00';
  return Buffer.from(`${prefix}:${type}${key}`, 'utf8').toString('base64');
}

/** Decode a global id into its type and numeric key; null when it is not one of ours. */
export function decodeGlobalId(id: unknown): { type: string; key: number } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^\d+:([A-Za-z]+)(\d+)$/.exec(text);
  if (match === null) return null;
  return { type: match[1] as string, key: Number.parseInt(match[2] as string, 10) };
}

/** The REST databaseId of an issue or pull request (store.ts's derivation). */
function issueDatabaseId(repo: RepoRec, issue: IssueRec): number {
  return repo.id * 1_000_000 + issue.number;
}

/** Find the (repo, issue) a global issue/PR databaseId names. */
function findByDatabaseId(key: number): { repo: RepoRec; issue: IssueRec } | null {
  const repoId = Math.floor(key / 1_000_000);
  const number = key % 1_000_000;
  for (const repo of store.listRepos()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.get(number);
    return issue === undefined ? null : { repo, issue };
  }
  return null;
}

function findRepoById(id: number): RepoRec | null {
  for (const repo of store.listRepos()) if (repo.id === id) return repo;
  return null;
}

/** Resolve a repositoryId input (a global id, or a bare numeric id) to a repository. */
function repoFromIdInput(value: unknown): RepoRec | null {
  const decoded = decodeGlobalId(value);
  if (decoded !== null && decoded.type === 'Repository') return findRepoById(decoded.key);
  if (typeof value === 'number' && Number.isInteger(value)) return findRepoById(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return findRepoById(Number.parseInt(value, 10));
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Schema: the field/type surface introspection reports and field validation uses.
// ---------------------------------------------------------------------------------------------------------

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'Base64String']);

const ENUMS: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeStateStatus: ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'],
  StatusState: ['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS'],
  CommentAuthorAssociation: ['COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUER', 'MEMBER', 'NONE', 'OWNER'],
  PullRequestReviewState: ['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'],
  FileChangeType: ['ADDED', 'COPIED', 'DELETED', 'MODIFIED', 'RENAMED'],
};

const CONNECTION_TYPES = [
  'IssueConnection',
  'PullRequestConnection',
  'LabelConnection',
  'IssueCommentConnection',
  'PullRequestChangedFileConnection',
  'PullRequestCommitConnection',
  'SearchResultItemConnection',
] as const;

const TYPE_FIELDS: Record<string, Record<string, string>> = {
  Query: {
    viewer: 'User!',
    repository: 'Repository',
    node: 'Node',
    nodes: '[Node]!',
    rateLimit: 'RateLimit',
    search: 'SearchResultItemConnection!',
    __type: '__Type',
    __schema: '__Schema',
  },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    reopenIssue: 'ReopenIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: {
    id: 'ID!',
    databaseId: 'Int',
    login: 'String!',
    name: 'String',
    email: 'String',
    url: 'URI!',
    avatarUrl: 'URI!',
    isViewer: 'Boolean!',
    createdAt: 'DateTime!',
    updatedAt: 'DateTime!',
  },
  Repository: {
    id: 'ID!',
    databaseId: 'Int',
    name: 'String!',
    nameWithOwner: 'String!',
    owner: 'RepositoryOwner!',
    description: 'String',
    isPrivate: 'Boolean!',
    isFork: 'Boolean!',
    url: 'URI!',
    createdAt: 'DateTime!',
    updatedAt: 'DateTime!',
    defaultBranchRef: 'Ref',
    viewerPermission: 'RepositoryPermission',
    hasIssuesEnabled: 'Boolean!',
    hasProjectsEnabled: 'Boolean!',
    hasWikiEnabled: 'Boolean!',
    issue: 'Issue',
    issues: 'IssueConnection!',
    pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection!',
    label: 'Label',
    labels: 'LabelConnection!',
    stargazerCount: 'Int!',
    forkCount: 'Int!',
    primaryLanguage: 'Language',
    licenseInfo: 'License',
    isArchived: 'Boolean!',
    isDisabled: 'Boolean!',
    isLocked: 'Boolean!',
    isMirror: 'Boolean!',
    isTemplate: 'Boolean!',
    isEmpty: 'Boolean!',
    pushedAt: 'DateTime',
    diskUsage: 'Int',
    parent: 'Repository',
    defaultBranch: 'String',
  },
  Issue: {
    id: 'ID!',
    databaseId: 'Int',
    number: 'Int!',
    title: 'String!',
    state: 'IssueState!',
    body: 'String',
    bodyText: 'String!',
    bodyHTML: 'String!',
    url: 'URI!',
    createdAt: 'DateTime!',
    updatedAt: 'DateTime!',
    closedAt: 'DateTime',
    closed: 'Boolean!',
    locked: 'Boolean!',
    activeLockReason: 'String',
    author: 'Actor',
    editor: 'Actor',
    repository: 'Repository!',
    labels: 'LabelConnection!',
    comments: 'IssueCommentConnection!',
    assignees: 'UserConnection!',
    participants: 'UserConnection!',
    milestone: 'Milestone',
    reactionGroups: '[ReactionGroup!]',
    viewerCanReact: 'Boolean!',
    viewerCanSubscribe: 'Boolean!',
    viewerSubscription: 'String',
  },
  PullRequest: {
    id: 'ID!',
    databaseId: 'Int',
    number: 'Int!',
    title: 'String!',
    state: 'PullRequestState!',
    body: 'String',
    bodyText: 'String!',
    url: 'URI!',
    createdAt: 'DateTime!',
    updatedAt: 'DateTime!',
    closedAt: 'DateTime',
    closed: 'Boolean!',
    locked: 'Boolean!',
    author: 'Actor',
    repository: 'Repository!',
    merged: 'Boolean!',
    mergedAt: 'DateTime',
    mergedBy: 'Actor',
    mergeable: 'MergeableState!',
    mergeStateStatus: 'MergeStateStatus!',
    headRefName: 'String!',
    baseRefName: 'String!',
    headRefOid: 'GitObjectID!',
    baseRefOid: 'GitObjectID!',
    headRef: 'Ref',
    baseRef: 'Ref',
    headRepository: 'Repository',
    headRepositoryOwner: 'RepositoryOwner',
    isCrossRepository: 'Boolean!',
    isDraft: 'Boolean!',
    files: 'PullRequestChangedFileConnection!',
    additions: 'Int!',
    deletions: 'Int!',
    changedFiles: 'Int!',
    commits: 'PullRequestCommitConnection!',
    comments: 'IssueCommentConnection!',
    labels: 'LabelConnection!',
    mergeCommit: 'Commit',
    potentialMergeCommit: 'Commit',
    viewerCanUpdate: 'Boolean!',
    viewerCanSubscribe: 'Boolean!',
    reviewDecision: 'String',
    latestReviews: 'PullRequestReviewConnection',
  },
  PullRequestChangedFile: {
    path: 'String!',
    additions: 'Int!',
    deletions: 'Int!',
    changeType: 'FileChangeType!',
    viewerViewedState: 'String!',
  },
  Label: {
    id: 'ID!',
    name: 'String!',
    color: 'String!',
    description: 'String',
    url: 'URI!',
    isDefault: 'Boolean!',
    createdAt: 'DateTime!',
    updatedAt: 'DateTime!',
  },
  IssueComment: {
    id: 'ID!',
    databaseId: 'Int',
    body: 'String!',
    bodyText: 'String!',
    url: 'URI!',
    createdAt: 'DateTime!',
    updatedAt: 'DateTime!',
    author: 'Actor',
    editor: 'Actor',
    issue: 'Issue!',
    repository: 'Repository!',
    viewerCanUpdate: 'Boolean!',
    viewerCanDelete: 'Boolean!',
  },
  Ref: {
    id: 'ID!',
    name: 'String!',
    prefix: 'String!',
    target: 'GitObject',
    repository: 'Repository!',
    associatedPullRequests: 'PullRequestConnection!',
  },
  Commit: {
    id: 'ID!',
    oid: 'GitObjectID!',
    abbreviatedOid: 'String!',
    message: 'String!',
    messageHeadline: 'String!',
    committedDate: 'DateTime!',
    authoredDate: 'DateTime!',
    author: 'GitActor',
    committer: 'GitActor',
    tree: 'Tree!',
    parents: 'CommitConnection!',
    url: 'URI!',
    history: 'CommitHistoryConnection!',
    repository: 'Repository!',
  },
  Tree: {
    id: 'ID!',
    oid: 'GitObjectID!',
    abbreviatedOid: 'String!',
    entries: '[TreeEntry!]!',
    repository: 'Repository!',
  },
  TreeEntry: {
    name: 'String!',
    path: 'String',
    mode: 'Int!',
    type: 'String!',
    object: 'GitObject',
  },
  GitActor: {
    name: 'String!',
    email: 'String!',
    date: 'DateTime!',
    user: 'User',
    avatarUrl: 'URI!',
  },
  PageInfo: {
    hasNextPage: 'Boolean!',
    hasPreviousPage: 'Boolean!',
    startCursor: 'String',
    endCursor: 'String',
  },
  RateLimit: {
    limit: 'Int!',
    cost: 'Int!',
    remaining: 'Int!',
    used: 'Int!',
    resetAt: 'DateTime!',
    nodeCount: 'Int!',
  },
  CreateIssuePayload: { clientMutationId: 'String', issue: 'Issue' },
  CloseIssuePayload: { clientMutationId: 'String', issue: 'Issue' },
  ReopenIssuePayload: { clientMutationId: 'String', issue: 'Issue' },
  CreatePullRequestPayload: { clientMutationId: 'String', pullRequest: 'PullRequest' },
  MergePullRequestPayload: { clientMutationId: 'String', pullRequest: 'PullRequest' },
  AddCommentPayload: { clientMutationId: 'String', commentEdge: 'IssueCommentEdge', subject: 'Node' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String!' },
  Node: { id: 'ID!' },
  Actor: { login: 'String!', url: 'URI!', avatarUrl: 'URI!' },
  RepositoryOwner: { id: 'ID!', login: 'String!', url: 'URI!', avatarUrl: 'URI!', repositories: 'RepositoryConnection!' },
  Language: { id: 'ID!', name: 'String!', color: 'String' },
  License: { id: 'ID!', name: 'String!', nickname: 'String', spdxId: 'String', url: 'URI' },
  Milestone: { id: 'ID!', number: 'Int!', title: 'String!', state: 'String!', description: 'String', url: 'URI!', createdAt: 'DateTime!', updatedAt: 'DateTime!' },
  __Type: {
    kind: 'String!',
    name: 'String',
    description: 'String',
    fields: '[__Field!]',
    enumValues: '[__EnumValue!]',
    inputFields: '[__InputValue!]',
    possibleTypes: '[__Type!]',
    ofType: '__Type',
    specifiedByURL: 'String',
  },
  __Field: {
    name: 'String!',
    description: 'String',
    args: '[__InputValue!]!',
    type: '__Type!',
    isDeprecated: 'Boolean!',
    deprecationReason: 'String',
  },
  __EnumValue: {
    name: 'String!',
    description: 'String',
    isDeprecated: 'Boolean!',
    deprecationReason: 'String',
  },
  __InputValue: {
    name: 'String!',
    description: 'String',
    type: '__Type!',
    defaultValue: 'String',
    isDeprecated: 'Boolean!',
    deprecationReason: 'String',
  },
  __Schema: {
    types: '[__Type!]!',
    queryType: '__Type!',
    mutationType: '__Type',
    subscriptionType: '__Type',
    directives: '[__Directive!]!',
  },
  __Directive: {
    name: 'String!',
    description: 'String',
    locations: '[String!]!',
    args: '[__InputValue!]!',
    isRepeatable: 'Boolean!',
  },
};

// Connection and edge types share one shape; register them uniformly.
for (const connection of CONNECTION_TYPES) {
  const itemType =
    connection === 'IssueConnection'
      ? 'Issue'
      : connection === 'PullRequestConnection'
        ? 'PullRequest'
        : connection === 'LabelConnection'
          ? 'Label'
          : connection === 'IssueCommentConnection'
            ? 'IssueComment'
            : connection === 'PullRequestChangedFileConnection'
              ? 'PullRequestChangedFile'
              : connection === 'PullRequestCommitConnection'
                ? 'PullRequestCommit'
                : 'SearchResultItem';
  TYPE_FIELDS[connection] = {
    nodes: `[${itemType}]`,
    edges: `[${connection.replace(/Connection$/, 'Edge')}]`,
    pageInfo: 'PageInfo!',
    totalCount: 'Int!',
  };
  if (connection === 'SearchResultItemConnection') {
    TYPE_FIELDS[connection] = {
      ...TYPE_FIELDS[connection],
      issueCount: 'Int!',
      repositoryCount: 'Int!',
      userCount: 'Int!',
      discussionCount: 'Int!',
      codeCount: 'Int!',
    };
  }
  const edge = connection.replace(/Connection$/, 'Edge');
  const itemTypeForEdge = TYPE_FIELDS[connection]?.nodes?.replace(/[[\]!]/g, '') ?? 'Node';
  TYPE_FIELDS[edge] = { node: itemTypeForEdge, cursor: 'String!' };
}
TYPE_FIELDS['PullRequestCommit'] = { id: 'ID!', commit: 'Commit!', url: 'URI!', pullRequest: 'PullRequest!' };
TYPE_FIELDS['SearchResultItem'] = { id: 'ID!' };
TYPE_FIELDS['UserConnection'] = { nodes: '[User]', edges: '[UserEdge]', pageInfo: 'PageInfo!', totalCount: 'Int!' };
TYPE_FIELDS['UserEdge'] = { node: 'User', cursor: 'String!' };
TYPE_FIELDS['RepositoryConnection'] = { nodes: '[Repository]', edges: '[RepositoryEdge]', pageInfo: 'PageInfo!', totalCount: 'Int!' };
TYPE_FIELDS['RepositoryEdge'] = { node: 'Repository', cursor: 'String!' };
TYPE_FIELDS['CommitConnection'] = { nodes: '[Commit]', edges: '[CommitEdge]', pageInfo: 'PageInfo!', totalCount: 'Int!' };
TYPE_FIELDS['CommitEdge'] = { node: 'Commit', cursor: 'String!' };
TYPE_FIELDS['CommitHistoryConnection'] = TYPE_FIELDS['CommitConnection'] as Record<string, string>;

const INPUT_TYPES = new Set([
  'CreateIssueInput',
  'CloseIssueInput',
  'ReopenIssueInput',
  'CreatePullRequestInput',
  'MergePullRequestInput',
  'AddCommentInput',
  'IssueOrder',
]);

function typeKind(name: string): string {
  if (SCALARS.has(name)) return 'SCALAR';
  if (name in ENUMS) return 'ENUM';
  if (INPUT_TYPES.has(name) || name.endsWith('Input') || name === 'IssueOrder') return 'INPUT_OBJECT';
  if (name === 'Node' || name === 'Actor' || name === 'RepositoryOwner' || name === 'GitObject') return 'INTERFACE';
  return 'OBJECT';
}

function allTypeNames(): string[] {
  const names = new Set<string>([...Object.keys(TYPE_FIELDS), ...Object.keys(ENUMS), ...SCALARS, ...INPUT_TYPES, 'GitObject']);
  return [...names].sort();
}

// ---------------------------------------------------------------------------------------------------------
// Parser: the subset of the GraphQL language the suite's documents use.
// ---------------------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selectionSet: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefaults: Record<string, ValueNode>;
  selectionSet: SelectionNode[];
}
interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}
interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] ?? '';
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in the document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  private atPunct(value: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === value;
  }
  private eatPunct(value: string): boolean {
    if (this.atPunct(value)) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) throw new Error(`expected "${value}", found "${this.peek().value}"`);
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, found "${t.value}"`);
    return t.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({ operation: 'query', name: null, variableDefaults: {}, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefaults: Record<string, ValueNode> = {};
        if (this.atPunct('(')) this.parseVariableDefinitions(variableDefaults);
        this.skipDirectives();
        const selectionSet = this.parseSelectionSet();
        operations.push({ operation: keyword, name, variableDefaults, selectionSet });
      } else if (keyword === 'fragment') {
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selectionSet = this.parseSelectionSet();
        fragments.set(name, { typeCondition, selectionSet });
      } else {
        throw new Error(`unsupported definition "${keyword}"`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(defaults: Record<string, ValueNode>): void {
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseTypeRef();
      if (this.eatPunct('=')) defaults[name] = this.parseValue();
      this.skipDirectives();
    }
    this.expectPunct(')');
  }

  private parseTypeRef(): void {
    if (this.eatPunct('[')) {
      this.parseTypeRef();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.eatPunct('!');
  }

  private skipDirectives(): void {
    while (this.eatPunct('@')) {
      this.expectName();
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.peek();
    if (this.eatPunct('$')) return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'string') {
      this.next();
      return { kind: 'string', value: t.value };
    }
    if (t.kind === 'int') {
      this.next();
      return { kind: 'int', value: Number.parseInt(t.value, 10) };
    }
    if (t.kind === 'float') {
      this.next();
      return { kind: 'float', value: Number.parseFloat(t.value) };
    }
    if (this.eatPunct('[')) {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (this.eatPunct('{')) {
      const fields: Record<string, ValueNode> = {};
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected token "${t.value}" where a value was expected`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.eatPunct('...')) {
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.eatPunct(':')) {
        alias = first;
        name = this.expectName();
      }
      const args = this.atPunct('(') ? this.parseArguments() : {};
      this.skipDirectives();
      const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', name, alias, args, selectionSet });
    }
    this.expectPunct('}');
    return selections;
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Object wrappers: the values the executor resolves fields against.
// ---------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown> & { __typename: string };

function obj(typename: string, props: Record<string, unknown> = {}): Obj {
  return { __typename: typename, ...props };
}

function viewerObj(): Obj {
  return obj('User', {
    id: globalId('User', VIEWER.id),
    databaseId: VIEWER.id,
    login: VIEWER.login,
    name: VIEWER.name,
    email: VIEWER.email,
    url: '',
    avatarUrl: '',
    isViewer: true,
    createdAt: store.peekIso(),
    updatedAt: store.peekIso(),
  });
}

function repoObj(repo: RepoRec): Obj {
  return obj('Repository', {
    _repo: repo,
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.ownerLogin}/${repo.name}`,
    description: repo.description === '' ? null : repo.description,
    isPrivate: repo.isPrivate,
    isFork: false,
    url: '',
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasProjectsEnabled: true,
    hasWikiEnabled: true,
    stargazerCount: 0,
    forkCount: 0,
    primaryLanguage: null,
    licenseInfo: null,
    isArchived: false,
    isDisabled: false,
    isLocked: false,
    isMirror: false,
    isTemplate: false,
    isEmpty: repo.refs.size === 0,
    pushedAt: null,
    diskUsage: 0,
    parent: null,
    defaultBranch: repo.defaultBranch,
  });
}

function issueState(issue: IssueRec): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function issueObj(repo: RepoRec, issue: IssueRec): Obj {
  return obj('Issue', {
    _repo: repo,
    _issue: issue,
    id: globalId('Issue', issueDatabaseId(repo, issue)),
    databaseId: issueDatabaseId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issueState(issue),
    body: issue.body,
    bodyText: issue.body ?? '',
    bodyHTML: issue.body ?? '',
    url: '',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.state === 'closed' ? issue.updatedAt : null,
    closed: issue.state === 'closed',
    locked: false,
    activeLockReason: null,
    milestone: null,
    reactionGroups: [],
    viewerCanReact: true,
    viewerCanSubscribe: true,
    viewerSubscription: null,
  });
}

function pullState(issue: IssueRec): string {
  if (issue.pull !== null && issue.pull.merged) return 'MERGED';
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function shortRef(fullRef: string): string {
  return fullRef.startsWith('refs/heads/') ? fullRef.slice('refs/heads/'.length) : fullRef;
}

function prObj(repo: RepoRec, issue: IssueRec): Obj {
  const pull = issue.pull as NonNullable<IssueRec['pull']>;
  const diff = changedFiles(repo, issue);
  return obj('PullRequest', {
    _repo: repo,
    _issue: issue,
    id: globalId('PullRequest', issueDatabaseId(repo, issue)),
    databaseId: issueDatabaseId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: pullState(issue),
    body: issue.body,
    bodyText: issue.body ?? '',
    url: '',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.state === 'closed' ? issue.updatedAt : null,
    closed: issue.state === 'closed',
    locked: false,
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    mergeable: pull.merged ? 'UNKNOWN' : issue.state === 'closed' ? 'UNKNOWN' : 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefName: shortRef(pull.headRef),
    baseRefName: shortRef(pull.baseRef),
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    isCrossRepository: false,
    isDraft: false,
    additions: diff.reduce((sum, f) => sum + f.additions, 0),
    deletions: diff.reduce((sum, f) => sum + f.deletions, 0),
    changedFiles: diff.length,
    reviewDecision: null,
    viewerCanUpdate: true,
    viewerCanSubscribe: true,
  });
}

function commentObj(repo: RepoRec, issue: IssueRec, comment: CommentRec): Obj {
  return obj('IssueComment', {
    _repo: repo,
    _issue: issue,
    _comment: comment,
    id: globalId('IssueComment', comment.id),
    databaseId: comment.id,
    body: comment.body,
    bodyText: comment.body,
    url: '',
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    viewerCanUpdate: true,
    viewerCanDelete: true,
  });
}

function labelObj(repo: RepoRec, name: string): Obj {
  const label = repo.labels.get(name);
  return obj('Label', {
    id: globalId('Label', repo.id * 1_000_000 + [...repo.labels.keys()].indexOf(name) + 1),
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    url: '',
    isDefault: false,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  });
}

function commitObj(repo: RepoRec, sha: string): Obj {
  const record = repo.objects.get(sha);
  let message = '';
  let date = repo.updatedAt;
  if (record !== undefined && record.type === 'commit') {
    const parsed = parseCommitData(record.data);
    message = parsed.message;
    const match = / (\d{10}) [+-]\d{4}/.exec(parsed.author);
    if (match !== null) date = new Date(Number.parseInt(match[1] as string, 10) * 1000).toISOString();
  }
  return obj('Commit', {
    _repo: repo,
    _sha: sha,
    id: sha,
    oid: sha,
    abbreviatedOid: sha.slice(0, 7),
    message,
    messageHeadline: message.split('\n')[0] ?? '',
    committedDate: date,
    authoredDate: date,
    url: '',
  });
}

function refObj(repo: RepoRec, branch: string): Obj {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  return obj('Ref', {
    _repo: repo,
    _branch: branch,
    _sha: sha ?? null,
    id: `refs/heads/${branch}`,
    name: branch,
    prefix: 'refs/heads/',
  });
}

// ---------------------------------------------------------------------------------------------------------
// Git object reading (raw objects from the store) for PR file diffs and merges.
// ---------------------------------------------------------------------------------------------------------

interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommitData(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Flatten a tree into path -> {sha, mode}, recursively. */
function flattenTreeSha(repo: RepoRec, treeSha: string, prefix: string, out: Map<string, { sha: string; mode: string }>): void {
  const record = repo.objects.get(treeSha);
  if (record === undefined || record.type !== 'tree') return;
  const data = record.data;
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const mode = data.toString('utf8', i, space);
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    i = nul + 21;
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (mode === '40000') flattenTreeSha(repo, sha, path, out);
    else out.set(path, { sha, mode });
  }
}

function treeOfCommit(repo: RepoRec, sha: string | null): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  if (sha === null || sha === '') return out;
  const record = repo.objects.get(sha);
  if (record === undefined || record.type !== 'commit') return out;
  flattenTreeSha(repo, parseCommitData(record.data).tree, '', out);
  return out;
}

function blobLines(repo: RepoRec, sha: string | undefined): string[] {
  if (sha === undefined) return [];
  const record = repo.objects.get(sha);
  if (record === undefined || record.type !== 'blob') return [];
  const text = record.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level +/- counts via an LCS over the two versions (files here are small). */
function lineDiff(repo: RepoRec, oldSha: string | undefined, newSha: string | undefined): { additions: number; deletions: number } {
  const oldLines = blobLines(repo, oldSha);
  const newLines = blobLines(repo, newSha);
  const m = oldLines.length;
  const n = newLines.length;
  if (m * n > 4_000_000) return { additions: n, deletions: m };
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0) as number[];
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] =
        oldLines[i] === newLines[j]
          ? (dp[(i + 1) * (n + 1) + (j + 1)] as number) + 1
          : Math.max(dp[(i + 1) * (n + 1) + j] as number, dp[i * (n + 1) + (j + 1)] as number);
    }
  }
  const lcs = dp[0] as number;
  return { additions: n - lcs, deletions: m - lcs };
}

interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}

/** The files a pull request changes: its head tree against its base tree. */
function changedFiles(repo: RepoRec, issue: IssueRec): ChangedFile[] {
  if (issue.pull === null) return [];
  const base = treeOfCommit(repo, issue.pull.baseSha);
  const head = treeOfCommit(repo, issue.pull.headSha);
  const files: ChangedFile[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before?.sha === after?.sha) continue;
    const { additions, deletions } = lineDiff(repo, before?.sha, after?.sha);
    files.push({
      path,
      additions,
      deletions,
      changeType: before === undefined ? 'ADDED' : after === undefined ? 'DELETED' : 'MODIFIED',
    });
  }
  return files;
}

function hashAndStore(repo: RepoRec, type: 'commit' | 'tree' | 'blob', data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  const sha = createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

// ---------------------------------------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------------------------------------

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1] as string, 10);
  } catch {
    return -1;
  }
}

interface Page {
  items: Obj[];
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
  cursors: string[];
}

function paginateItems(items: Obj[], args: Record<string, unknown>): Page {
  const total = items.length;
  let start = 0;
  const after = args['after'];
  if (typeof after === 'string' && after !== '') {
    const idx = indexFromCursor(after);
    if (idx >= 0) start = idx + 1;
  }
  const first = typeof args['first'] === 'number' && Number.isFinite(args['first']) ? Math.max(0, Math.floor(args['first'])) : total;
  const slice = items.slice(start, start + first);
  const cursors = slice.map((_, i) => cursorFor(start + i));
  return {
    items: slice,
    total,
    hasNextPage: start + slice.length < total,
    hasPreviousPage: start > 0,
    startCursor: cursors[0] ?? null,
    endCursor: cursors[cursors.length - 1] ?? null,
    cursors,
  };
}

function connectionObj(typename: string, page: Page, extra: Record<string, unknown> = {}): Obj {
  const edgeType = typename.replace(/Connection$/, 'Edge');
  const edges = page.items.map((node, i) => obj(edgeType, { node, cursor: page.cursors[i] as string }));
  return obj(typename, {
    _page: page,
    _edges: edges,
    nodes: page.items,
    totalCount: page.total,
    ...extra,
  });
}

function pageInfoObj(page: Page): Obj {
  return obj('PageInfo', {
    hasNextPage: page.hasNextPage,
    hasPreviousPage: page.hasPreviousPage,
    startCursor: page.startCursor,
    endCursor: page.endCursor,
  });
}

type OrderSpec = { field: string; direction: string };

function sortIssues(list: IssueRec[], order: OrderSpec | null): IssueRec[] {
  const spec = order ?? { field: 'CREATED_AT', direction: 'DESC' };
  const dir = spec.direction === 'ASC' ? 1 : -1;
  const keyOf = (issue: IssueRec): string | number => {
    if (spec.field === 'UPDATED_AT') return issue.updatedAt;
    if (spec.field === 'COMMENTS') return issue.comments.length;
    return issue.createdAt;
  };
  return [...list].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return (a.number - b.number) * dir;
  });
}

function issuesConnection(repo: RepoRec, args: Record<string, unknown>, pullsOnly: boolean): Obj {
  let list = [...repo.issues.values()].filter((issue) => (pullsOnly ? issue.pull !== null : issue.pull === null));
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((issue) => wanted.has(pullsOnly ? pullState(issue) : issueState(issue)));
  }
  const orderBy = args['orderBy'];
  let order: OrderSpec | null = null;
  if (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
    const record = orderBy as Record<string, unknown>;
    order = {
      field: typeof record['field'] === 'string' ? (record['field'] as string) : 'CREATED_AT',
      direction: typeof record['direction'] === 'string' ? (record['direction'] as string) : 'DESC',
    };
  }
  const sorted = sortIssues(list, order);
  const items = sorted.map((issue) => (pullsOnly ? prObj(repo, issue) : issueObj(repo, issue)));
  const page = paginateItems(items, args);
  return connectionObj(pullsOnly ? 'PullRequestConnection' : 'IssueConnection', page);
}

// ---------------------------------------------------------------------------------------------------------
// Introspection objects
// ---------------------------------------------------------------------------------------------------------

TYPE_FIELDS['Blob'] = { id: 'ID!', oid: 'GitObjectID!', abbreviatedOid: 'String!', isTruncated: 'Boolean!', byteSize: 'Int!' };
TYPE_FIELDS['GitObject'] = { id: 'ID!', oid: 'GitObjectID!', abbreviatedOid: 'String!' };

function typeRefObj(ref: string): Obj {
  const trimmed = ref.trim();
  if (trimmed.endsWith('!')) {
    return obj('__Type', { _kind: 'NON_NULL', _name: null, _ofType: typeRefObj(trimmed.slice(0, -1)) });
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return obj('__Type', { _kind: 'LIST', _name: null, _ofType: typeRefObj(trimmed.slice(1, -1)) });
  }
  return obj('__Type', { _kind: typeKind(trimmed), _name: trimmed, _ofType: null });
}

function namedTypeObj(name: string): Obj {
  return obj('__Type', { _kind: typeKind(name), _name: name, _ofType: null });
}

function fieldObj(name: string, typeRef: string): Obj {
  return obj('__Field', { _typeRef: typeRef, name, description: null, isDeprecated: false, deprecationReason: null });
}

function enumValueObj(name: string): Obj {
  return obj('__EnumValue', { name, description: null, isDeprecated: false, deprecationReason: null });
}

function schemaObj(): Obj {
  return obj('__Schema', {});
}

// ---------------------------------------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------------------------------------

interface ExecState {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
}

class GqlFieldError extends Error {}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function repoOf(source: Obj): RepoRec {
  return source['_repo'] as RepoRec;
}
function issueOf(source: Obj): IssueRec {
  return source['_issue'] as IssueRec;
}

function gitActorObj(line: string): Obj {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  const name = match?.[1] ?? '';
  const email = match?.[2] ?? '';
  const date = match !== null ? new Date(Number.parseInt(match[3] as string, 10) * 1000).toISOString() : store.peekIso();
  return obj('GitActor', { _email: email, name, email, date, avatarUrl: '' });
}

function commentsConnection(repo: RepoRec, issue: IssueRec, args: Record<string, unknown>): Obj {
  const items = [...issue.comments]
    .sort((a, b) => a.id - b.id)
    .map((comment) => commentObj(repo, issue, comment));
  return connectionObj('IssueCommentConnection', paginateItems(items, args));
}

function labelsConnection(repo: RepoRec, issue: IssueRec | null, args: Record<string, unknown>): Obj {
  const names = issue !== null ? issue.labels : [...repo.labels.keys()];
  const items = names.map((name) => labelObj(repo, name));
  return connectionObj('LabelConnection', paginateItems(items, args));
}

function resolveMutation(field: string, args: Record<string, unknown>): Obj {
  const input = asRecord(args['input']);
  const clientMutationId = typeof input['clientMutationId'] === 'string' ? (input['clientMutationId'] as string) : null;
  switch (field) {
    case 'createIssue': {
      const repo = repoFromIdInput(input['repositoryId']);
      if (repo === null) throw new GqlFieldError('createIssue: the repositoryId does not name a repository');
      const title = input['title'];
      if (typeof title !== 'string' || title === '') throw new GqlFieldError('createIssue: a title is required');
      const now = store.nowIso();
      const issue: IssueRec = {
        number: repo.nextNumber++,
        title,
        body: typeof input['body'] === 'string' ? (input['body'] as string) : null,
        state: 'open',
        labels: Array.isArray(input['labelIds']) ? [] : [],
        createdAt: now,
        updatedAt: now,
        comments: [],
        pull: null,
      };
      if (Array.isArray(input['labelNames'])) {
        for (const name of input['labelNames'] as unknown[]) if (typeof name === 'string') issue.labels.push(name);
      }
      repo.issues.set(issue.number, issue);
      return obj('CreateIssuePayload', { clientMutationId, issue: issueObj(repo, issue) });
    }
    case 'closeIssue':
    case 'reopenIssue': {
      const decoded = decodeGlobalId(input['issueId']);
      const found = decoded !== null ? findByDatabaseId(decoded.key) : null;
      if (found === null) throw new GqlFieldError(`${field}: the issueId does not name an issue`);
      found.issue.state = field === 'closeIssue' ? 'closed' : 'open';
      found.issue.updatedAt = store.nowIso();
      const payloadType = field === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload';
      return obj(payloadType, { clientMutationId, issue: issueObj(found.repo, found.issue) });
    }
    case 'createPullRequest': {
      const repo = repoFromIdInput(input['repositoryId']);
      if (repo === null) throw new GqlFieldError('createPullRequest: the repositoryId does not name a repository');
      const headName = String(input['headRefName'] ?? '');
      const baseName = String(input['baseRefName'] ?? '');
      const headFull = headName.startsWith('refs/') ? headName : `refs/heads/${headName}`;
      const baseFull = baseName.startsWith('refs/') ? baseName : `refs/heads/${baseName}`;
      const headSha = repo.refs.get(headFull);
      if (headSha === undefined) throw new GqlFieldError(`createPullRequest: the head ref ${headName} does not exist`);
      const baseSha = repo.refs.get(baseFull);
      if (baseSha === undefined) throw new GqlFieldError(`createPullRequest: the base ref ${baseName} does not exist`);
      for (const existing of repo.issues.values()) {
        if (existing.pull !== null && existing.pull.headRef === headFull && existing.pull.baseRef === baseFull && existing.state === 'open') {
          return obj('CreatePullRequestPayload', { clientMutationId, pullRequest: prObj(repo, existing) });
        }
      }
      const title = input['title'];
      if (typeof title !== 'string' || title === '') throw new GqlFieldError('createPullRequest: a title is required');
      const now = store.nowIso();
      const issue: IssueRec = {
        number: repo.nextNumber++,
        title,
        body: typeof input['body'] === 'string' ? (input['body'] as string) : null,
        state: 'open',
        labels: [],
        createdAt: now,
        updatedAt: now,
        comments: [],
        pull: { headRef: headFull, baseRef: baseFull, headSha, baseSha, merged: false, mergedAt: null, mergeCommitSha: null },
      };
      repo.issues.set(issue.number, issue);
      return obj('CreatePullRequestPayload', { clientMutationId, pullRequest: prObj(repo, issue) });
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(input['pullRequestId']);
      const found = decoded !== null ? findByDatabaseId(decoded.key) : null;
      if (found === null || found.issue.pull === null) {
        throw new GqlFieldError('mergePullRequest: the pullRequestId does not name a pull request');
      }
      const { repo, issue } = found;
      const pull = issue.pull;
      if (!pull.merged) {
        const baseSha = repo.refs.get(pull.baseRef) ?? pull.baseSha;
        const headRecord = repo.objects.get(pull.headSha);
        let mergeCommitSha: string | null = null;
        if (headRecord !== undefined && headRecord.type === 'commit') {
          const headTree = parseCommitData(headRecord.data).tree;
          const ts = store.nowUnix();
          const actor = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
          const commitText =
            `tree ${headTree}\nparent ${baseSha}\nauthor ${actor}\ncommitter ${actor}\n\n` +
            `${issue.title} (#${issue.number})\n`;
          mergeCommitSha = hashAndStore(repo, 'commit', Buffer.from(commitText, 'utf8'));
          repo.refs.set(pull.baseRef, mergeCommitSha);
        }
        pull.merged = true;
        pull.mergedAt = store.nowIso();
        pull.mergeCommitSha = mergeCommitSha;
        issue.state = 'closed';
        issue.updatedAt = pull.mergedAt;
      }
      return obj('MergePullRequestPayload', { clientMutationId, pullRequest: prObj(repo, issue) });
    }
    case 'addComment': {
      const decoded = decodeGlobalId(input['subjectId']);
      const found = decoded !== null ? findByDatabaseId(decoded.key) : null;
      if (found === null) throw new GqlFieldError('addComment: the subjectId does not name an issue or pull request');
      const body = input['body'];
      if (typeof body !== 'string') throw new GqlFieldError('addComment: a body is required');
      const now = store.nowIso();
      const comment: CommentRec = { id: store.allocCommentId(), body, createdAt: now, updatedAt: now };
      found.issue.comments.push(comment);
      const edge = obj('IssueCommentEdge', {
        node: commentObj(found.repo, found.issue, comment),
        cursor: cursorFor(found.issue.comments.length - 1),
      });
      const subject = found.issue.pull !== null ? prObj(found.repo, found.issue) : issueObj(found.repo, found.issue);
      return obj('AddCommentPayload', { clientMutationId, commentEdge: edge, subject });
    }
    default:
      throw new GqlFieldError(`mutation ${field} is not implemented`);
  }
}

function resolveSearch(args: Record<string, unknown>): Obj {
  const query = typeof args['query'] === 'string' ? (args['query'] as string).toLowerCase() : '';
  const type = typeof args['type'] === 'string' ? (args['type'] as string) : 'ISSUE';
  let items: Obj[] = [];
  let issueCount = 0;
  let repositoryCount = 0;
  let userCount = 0;
  if (type === 'REPOSITORY') {
    const repos = store.listRepos().filter((repo) => query === '' || repo.name.toLowerCase().includes(query));
    repositoryCount = repos.length;
    items = repos.map((repo) => repoObj(repo));
  } else if (type === 'USER') {
    if (query === '' || VIEWER.login.toLowerCase().includes(query)) {
      userCount = 1;
      items = [viewerObj()];
    }
  } else {
    const found: Obj[] = [];
    for (const repo of store.listRepos()) {
      for (const issue of repo.issues.values()) {
        if (issue.pull !== null) continue;
        if (query !== '' && !issue.title.toLowerCase().includes(query)) continue;
        found.push(issueObj(repo, issue));
      }
    }
    issueCount = found.length;
    items = found;
  }
  const page = paginateItems(items, args);
  return connectionObj('SearchResultItemConnection', page, {
    issueCount,
    repositoryCount,
    userCount,
    discussionCount: 0,
    codeCount: 0,
  });
}

function resolveNode(id: unknown): Obj | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) {
    // A bare numeric repository databaseId still resolves, for robustness.
    if (typeof id === 'string' && /^\d+$/.test(id)) {
      const repo = findRepoById(Number.parseInt(id, 10));
      return repo === null ? null : repoObj(repo);
    }
    return null;
  }
  switch (decoded.type) {
    case 'Repository': {
      const repo = findRepoById(decoded.key);
      return repo === null ? null : repoObj(repo);
    }
    case 'User':
      return decoded.key === VIEWER.id ? viewerObj() : null;
    case 'Issue':
    case 'PullRequest': {
      const found = findByDatabaseId(decoded.key);
      if (found === null) return null;
      return found.issue.pull !== null ? prObj(found.repo, found.issue) : issueObj(found.repo, found.issue);
    }
    case 'IssueComment': {
      for (const repo of store.listRepos()) {
        for (const issue of repo.issues.values()) {
          const comment = issue.comments.find((entry) => entry.id === decoded.key);
          if (comment !== undefined) return commentObj(repo, issue, comment);
        }
      }
      return null;
    }
    case 'Label': {
      for (const repo of store.listRepos()) {
        const names = [...repo.labels.keys()];
        const name = names[decoded.key - repo.id * 1_000_000 - 1];
        if (name !== undefined) return labelObj(repo, name);
      }
      return null;
    }
    default:
      return null;
  }
}

function resolveField(typeName: string, source: Obj, field: string, args: Record<string, unknown>): unknown {
  switch (typeName) {
    case 'Query':
      switch (field) {
        case 'viewer':
          return viewerObj();
        case 'repository': {
          const owner = typeof args['owner'] === 'string' ? (args['owner'] as string) : '';
          const name = typeof args['name'] === 'string' ? (args['name'] as string) : '';
          const repo = store.getRepo(owner, name);
          return repo === undefined ? null : repoObj(repo);
        }
        case 'node':
          return resolveNode(args['id']);
        case 'nodes':
          return Array.isArray(args['ids']) ? (args['ids'] as unknown[]).map((id) => resolveNode(id)) : [];
        case 'rateLimit':
          return obj('RateLimit', {
            limit: 5000,
            cost: 1,
            remaining: 4999,
            used: 1,
            resetAt: store.peekIso(),
            nodeCount: 1,
          });
        case 'search':
          return resolveSearch(args);
        case '__type': {
          const name = typeof args['name'] === 'string' ? (args['name'] as string) : '';
          if (!allTypeNames().includes(name)) return null;
          return namedTypeObj(name);
        }
        case '__schema':
          return schemaObj();
        default:
          break;
      }
      break;
    case 'Mutation':
      return resolveMutation(field, args);
    case '__Schema':
      switch (field) {
        case 'queryType':
          return namedTypeObj('Query');
        case 'mutationType':
          return namedTypeObj('Mutation');
        case 'subscriptionType':
          return null;
        case 'types':
          return allTypeNames().map((name) => namedTypeObj(name));
        case 'directives':
          return [];
        default:
          break;
      }
      break;
    case '__Type':
      switch (field) {
        case 'kind':
          return source['_kind'];
        case 'name':
          return source['_name'];
        case 'description':
          return null;
        case 'fields': {
          const name = source['_name'];
          if (typeof name !== 'string') return null;
          const fields = TYPE_FIELDS[name];
          if (fields === undefined) return null;
          return Object.entries(fields).map(([fieldName, typeRef]) => fieldObj(fieldName, typeRef));
        }
        case 'enumValues': {
          const name = source['_name'];
          if (typeof name !== 'string') return null;
          const values = ENUMS[name];
          return values === undefined ? null : values.map((value) => enumValueObj(value));
        }
        case 'inputFields':
          return [];
        case 'possibleTypes': {
          const name = source['_name'];
          if (name === 'Node') return ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Label', 'Commit', 'Tree'].map((t) => namedTypeObj(t));
          if (name === 'Actor' || name === 'RepositoryOwner') return [namedTypeObj('User')];
          if (name === 'GitObject') return ['Commit', 'Tree', 'Blob'].map((t) => namedTypeObj(t));
          return null;
        }
        case 'ofType':
          return source['_ofType'] ?? null;
        case 'specifiedByURL':
          return null;
        default:
          break;
      }
      break;
    case '__Field':
      if (field === 'type') return typeRefObj(String(source['_typeRef'] ?? 'String'));
      if (field === 'args') return [];
      break;
    case '__EnumValue':
      break;
    case 'Repository': {
      const repo = repoOf(source);
      switch (field) {
        case 'owner':
          return viewerObj();
        case 'defaultBranchRef':
          return refObj(repo, repo.defaultBranch);
        case 'issue': {
          const number = typeof args['number'] === 'number' ? (args['number'] as number) : -1;
          const issue = repo.issues.get(number);
          return issue !== undefined && issue.pull === null ? issueObj(repo, issue) : null;
        }
        case 'pullRequest': {
          const number = typeof args['number'] === 'number' ? (args['number'] as number) : -1;
          const issue = repo.issues.get(number);
          return issue !== undefined && issue.pull !== null ? prObj(repo, issue) : null;
        }
        case 'issues':
          return issuesConnection(repo, args, false);
        case 'pullRequests':
          return issuesConnection(repo, args, true);
        case 'label': {
          const name = typeof args['name'] === 'string' ? (args['name'] as string) : '';
          return repo.labels.has(name) ? labelObj(repo, name) : null;
        }
        case 'labels':
          return labelsConnection(repo, null, args);
        default:
          break;
      }
      break;
    }
    case 'Issue': {
      const repo = repoOf(source);
      const issue = issueOf(source);
      switch (field) {
        case 'repository':
          return repoObj(repo);
        case 'author':
        case 'editor':
          return viewerObj();
        case 'labels':
          return labelsConnection(repo, issue, args);
        case 'comments':
          return commentsConnection(repo, issue, args);
        case 'assignees':
        case 'participants':
          return connectionObj('UserConnection', paginateItems([], args));
        default:
          break;
      }
      break;
    }
    case 'PullRequest': {
      const repo = repoOf(source);
      const issue = issueOf(source);
      const pull = issue.pull as NonNullable<IssueRec['pull']>;
      switch (field) {
        case 'repository':
          return repoObj(repo);
        case 'author':
          return viewerObj();
        case 'mergedBy':
          return pull.merged ? viewerObj() : null;
        case 'headRef':
          return repo.refs.has(pull.headRef) ? refObj(repo, shortRef(pull.headRef)) : null;
        case 'baseRef':
          return repo.refs.has(pull.baseRef) ? refObj(repo, shortRef(pull.baseRef)) : null;
        case 'headRepository':
          return repoObj(repo);
        case 'headRepositoryOwner':
          return viewerObj();
        case 'files': {
          const items = changedFiles(repo, issue).map((file) =>
            obj('PullRequestChangedFile', {
              path: file.path,
              additions: file.additions,
              deletions: file.deletions,
              changeType: file.changeType,
              viewerViewedState: 'UNVIEWED',
            }),
          );
          return connectionObj('PullRequestChangedFileConnection', paginateItems(items, args));
        }
        case 'commits': {
          const items = [
            obj('PullRequestCommit', {
              _repo: repo,
              _sha: pull.headSha,
              id: globalId('PullRequest', issueDatabaseId(repo, issue)),
              url: '',
            }),
          ];
          return connectionObj('PullRequestCommitConnection', paginateItems(items, args));
        }
        case 'comments':
          return commentsConnection(repo, issue, args);
        case 'labels':
          return labelsConnection(repo, issue, args);
        case 'mergeCommit':
          return pull.mergeCommitSha !== null ? commitObj(repo, pull.mergeCommitSha) : null;
        case 'potentialMergeCommit':
          return null;
        case 'latestReviews':
          return null;
        default:
          break;
      }
      break;
    }
    case 'PullRequestCommit':
      if (field === 'commit') return commitObj(repoOf(source), String(source['_sha'] ?? ''));
      if (field === 'pullRequest') return null;
      break;
    case 'Ref': {
      const repo = repoOf(source);
      switch (field) {
        case 'target':
          return typeof source['_sha'] === 'string' ? commitObj(repo, source['_sha'] as string) : null;
        case 'repository':
          return repoObj(repo);
        case 'associatedPullRequests': {
          const full = `refs/heads/${String(source['_branch'] ?? '')}`;
          const items = [...repo.issues.values()]
            .filter((issue) => issue.pull !== null && issue.pull.headRef === full)
            .map((issue) => prObj(repo, issue));
          return connectionObj('PullRequestConnection', paginateItems(items, args));
        }
        default:
          break;
      }
      break;
    }
    case 'Commit': {
      const repo = repoOf(source);
      const sha = String(source['_sha'] ?? source['oid'] ?? '');
      const record = repo.objects.get(sha);
      const parsed = record !== undefined && record.type === 'commit' ? parseCommitData(record.data) : null;
      switch (field) {
        case 'tree':
          return obj('Tree', { _repo: repo, _sha: parsed?.tree ?? '', id: parsed?.tree ?? '', oid: parsed?.tree ?? '', abbreviatedOid: (parsed?.tree ?? '').slice(0, 7) });
        case 'parents': {
          const items = (parsed?.parents ?? []).map((parent) => commitObj(repo, parent));
          return connectionObj('CommitConnection', paginateItems(items, args));
        }
        case 'history': {
          const items = [commitObj(repo, sha)];
          return connectionObj('CommitHistoryConnection', paginateItems(items, args));
        }
        case 'author':
        case 'committer':
          return parsed !== null ? gitActorObj(field === 'author' ? parsed.author : parsed.committer) : null;
        case 'repository':
          return repoObj(repo);
        default:
          break;
      }
      break;
    }
    case 'Tree': {
      const repo = repoOf(source);
      if (field === 'repository') return repoObj(repo);
      if (field === 'entries') {
        const treeSha = String(source['_sha'] ?? source['oid'] ?? '');
        const record = repo.objects.get(treeSha);
        if (record === undefined || record.type !== 'tree') return [];
        const entries: Obj[] = [];
        const data = record.data;
        let i = 0;
        while (i < data.length) {
          const space = data.indexOf(0x20, i);
          if (space < 0) break;
          const mode = data.toString('utf8', i, space);
          const nul = data.indexOf(0x00, space);
          if (nul < 0) break;
          const name = data.toString('utf8', space + 1, nul);
          const entrySha = data.toString('hex', nul + 1, nul + 21);
          i = nul + 21;
          entries.push(
            obj('TreeEntry', {
              _repo: repo,
              _sha: entrySha,
              _mode: mode,
              name,
              path: name,
              mode: Number.parseInt(mode, 10),
              type: mode === '40000' ? 'tree' : 'blob',
            }),
          );
        }
        return entries;
      }
      break;
    }
    case 'TreeEntry':
      if (field === 'object') {
        const repo = repoOf(source);
        const sha = String(source['_sha'] ?? '');
        return source['_mode'] === '40000'
          ? obj('Tree', { _repo: repo, _sha: sha, id: sha, oid: sha, abbreviatedOid: sha.slice(0, 7) })
          : obj('Blob', { _repo: repo, _sha: sha, id: sha, oid: sha, abbreviatedOid: sha.slice(0, 7), isTruncated: false, byteSize: repo.objects.get(sha)?.data.length ?? 0 });
      }
      break;
    case 'GitActor':
      if (field === 'user') return source['_email'] === VIEWER.email ? viewerObj() : null;
      break;
    case 'IssueComment': {
      const repo = repoOf(source);
      const issue = issueOf(source);
      switch (field) {
        case 'author':
        case 'editor':
          return viewerObj();
        case 'issue':
          return issueObj(repo, issue);
        case 'repository':
          return repoObj(repo);
        default:
          break;
      }
      break;
    }
    default:
      break;
  }
  // Connections, edges, page info, payloads and plain scalar props ride on the wrapper.
  if (typeName.endsWith('Connection')) {
    if (field === 'pageInfo') return pageInfoObj(source['_page'] as Page);
    if (field === 'edges') return source['_edges'];
  }
  const value = source[field];
  return value === undefined ? null : value;
}

// ---------------------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------------------

function baseTypeName(typeRef: string): string {
  return typeRef.replace(/[[\]!]/g, '');
}

function executeSelections(source: Obj, selections: SelectionNode[], state: ExecState, out: Record<string, unknown>): void {
  const typeName = source.__typename;
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || isInterfaceOf(selection.typeCondition, typeName)) {
        executeSelections(source, selection.selectionSet, state, out);
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = state.fragments.get(selection.name);
      if (fragment === undefined) {
        state.errors.push({ message: `fragment "${selection.name}" is not defined` });
        continue;
      }
      if (fragment.typeCondition === typeName || isInterfaceOf(fragment.typeCondition, typeName)) {
        executeSelections(source, fragment.selectionSet, state, out);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const fields = TYPE_FIELDS[typeName];
    const typeRef = fields?.[selection.name];
    if (typeRef === undefined) {
      state.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argNode] of Object.entries(selection.args)) args[argName] = evalValue(argNode, state.variables);
    let value: unknown;
    try {
      value = resolveField(typeName, source, selection.name, args);
    } catch (err) {
      state.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, typeRef, selection.selectionSet, state);
  }
}

function isInterfaceOf(condition: string, concrete: string): boolean {
  if (condition === 'Node') return true;
  if (condition === 'Actor' || condition === 'RepositoryOwner') return concrete === 'User';
  if (condition === 'GitObject') return concrete === 'Commit' || concrete === 'Tree' || concrete === 'Blob';
  return false;
}

function completeValue(value: unknown, typeRef: string, selectionSet: SelectionNode[] | null, state: ExecState): unknown {
  if (value === null || value === undefined) return null;
  const trimmed = typeRef.trim();
  if (trimmed.endsWith('!')) return completeValue(value, trimmed.slice(0, -1), selectionSet, state);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    if (!Array.isArray(value)) return null;
    const inner = trimmed.slice(1, -1);
    return value.map((entry) => completeValue(entry, inner, selectionSet, state));
  }
  const kind = typeKind(trimmed);
  if (kind === 'SCALAR' || kind === 'ENUM') return value;
  if (typeof value === 'object' && value !== null && '__typename' in (value as Record<string, unknown>)) {
    if (selectionSet === null) return null;
    const out: Record<string, unknown> = {};
    executeSelections(value as Obj, selectionSet, state, out);
    return out;
  }
  return value;
}

interface GraphQLRequestEntry {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeRequest(entry: GraphQLRequestEntry): Record<string, unknown> {
  if (typeof entry.query !== 'string' || entry.query.trim() === '') {
    return { data: null, errors: [{ message: 'a GraphQL query string is required' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(entry.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `could not parse the document: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
  let operation: OperationNode | undefined;
  if (operationName !== null) operation = document.operations.find((op) => op.name === operationName);
  else if (document.operations.length === 1) operation = document.operations[0];
  else operation = document.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: operationName !== null ? `operation "${operationName}" was not found in the document` : 'the document holds no operation' }] };
  }
  const variables: Record<string, unknown> = {};
  if (entry.variables !== null && typeof entry.variables === 'object' && !Array.isArray(entry.variables)) {
    Object.assign(variables, entry.variables as Record<string, unknown>);
  }
  for (const [name, defaultNode] of Object.entries(operation.variableDefaults)) {
    if (variables[name] === undefined) variables[name] = evalValue(defaultNode, {});
  }
  const state: ExecState = { variables, fragments: document.fragments, errors: [] };
  const root = obj(operation.operation === 'mutation' ? 'Mutation' : 'Query');
  const data: Record<string, unknown> = {};
  executeSelections(root, operation.selectionSet, state, data);
  const result: Record<string, unknown> = { data };
  if (state.errors.length > 0) result['errors'] = state.errors;
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// The handler: one operation object, or a JSON array of them (operation batching).
// ---------------------------------------------------------------------------------------------------------

export async function handleGraphQL(ctx: HandlerContext): Promise<void> {
  const text = ctx.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    sendJson(ctx.res, 400, { errors: [{ message: 'the request body is not valid JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) =>
      executeRequest(entry !== null && typeof entry === 'object' ? (entry as GraphQLRequestEntry) : {}),
    );
    sendJson(ctx.res, 200, results);
    return;
  }
  if (parsed !== null && typeof parsed === 'object') {
    sendJson(ctx.res, 200, executeRequest(parsed as GraphQLRequestEntry));
    return;
  }
  sendJson(ctx.res, 400, { errors: [{ message: 'the request body must be a GraphQL operation or an array of operations' }] });
}
