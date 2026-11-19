import { GitRepo } from './git.ts';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ApiError(422, `${field} is required`);
  return value;
}

export function validRef(ref: string): boolean {
  return /^refs\/(heads|tags)\/.+/.test(ref) && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) &&
    !ref.includes('..') && !ref.includes('@{') && !ref.endsWith('.') &&
    ref.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

type Identity = { id: number; node_id: string };
export type User = Identity & { login: string };
export type Label = Identity & { name: string; color: string; description: string | null };
export type Issue = Identity & {
  number: number; title: string; body: string; state: 'open' | 'closed'; labels: Label[];
  user: User; comments: number; created_at: string; updated_at: string; closed_at: string | null;
  url: string; html_url: string;
};
export type Comment = Identity & { body: string; user: User; created_at: string; updated_at: string };
type Branch = { ref: string; sha: string; label: string };
export type Pull = Identity & {
  number: number; title: string; body: string; state: 'open' | 'closed'; head: Branch; base: Branch;
  merged: boolean; mergeable: boolean | null; merged_at: string | null; merge_commit_sha: string | null;
  user: User; created_at: string; updated_at: string; closed_at: string | null;
  url: string; html_url: string; draft: boolean;
};
export type Repo = Identity & {
  owner: User; name: string; full_name: string; private: boolean; description: string | null;
  default_branch: string; has_issues: boolean; created_at: string; updated_at: string;
  git: GitRepo; issues: Map<number, Issue>; pulls: Map<number, Pull>;
  labels: Map<string, Label>; comments: Map<number, Comment[]>; nextNumber: number;
};

function identity(kind: string, id: number): Identity {
  return { id, node_id: Buffer.from(`${kind}:${id}`).toString('base64') };
}

export class ForgeStore {
  readonly viewer: User;
  readonly repos = new Map<string, Repo>();
  private readonly reposById = new Map<string, Repo>();
  private serial = 1;
  private tick = 0;
  private readonly epoch: number;

  constructor(login: string, trialNow?: string) {
    this.viewer = { ...identity('User', 1), login };
    const start = trialNow ? Date.parse(trialNow) : NaN;
    this.epoch = Number.isFinite(start) ? start : Date.UTC(2026, 0, 1);
  }

  private now(): string {
    return new Date(this.epoch + this.tick++ * 1_000).toISOString();
  }

  findRepo(owner: string, name: string): Repo | undefined {
    return owner.toLowerCase() === this.viewer.login.toLowerCase() ? this.repos.get(name.toLowerCase()) : undefined;
  }

  repoById(id: string | number): Repo | undefined {
    return this.reposById.get(String(id));
  }

  createRepo(input: { name?: unknown; description?: unknown; private?: unknown; auto_init?: unknown; default_branch?: unknown }): Repo {
    const name = requiredText(input.name, 'name');
    if (!/^[a-z0-9._-]{1,100}$/i.test(name) || name === '.' || name === '..' || name.toLowerCase().endsWith('.git')) {
      throw new ApiError(422, 'Invalid repository name');
    }
    if (this.repos.has(name.toLowerCase())) throw new ApiError(422, 'Repository already exists');
    const branch = typeof input.default_branch === 'string' ? input.default_branch : 'main';
    if (!validRef(`refs/heads/${branch}`)) throw new ApiError(422, 'Invalid default branch');
    const git = new GitRepo(branch);
    if (input.auto_init === true) git.writeFile(branch, 'README.md', Buffer.from(`# ${name}\n`), 'Initial commit');
    const timestamp = this.now();
    const repo: Repo = {
      ...identity('Repository', ++this.serial), owner: this.viewer, name, full_name: `${this.viewer.login}/${name}`,
      private: input.private === true, description: typeof input.description === 'string' ? input.description : null,
      default_branch: branch, has_issues: true, created_at: timestamp, updated_at: timestamp, git,
      issues: new Map(), pulls: new Map(), labels: new Map(), comments: new Map(), nextNumber: 1,
    };
    this.repos.set(name.toLowerCase(), repo);
    this.reposById.set(String(repo.id), repo);
    this.reposById.set(repo.node_id, repo);
    return repo;
  }

  repoView(repo: Repo) {
    const { id, node_id, name, full_name, private: isPrivate, owner, description, default_branch, has_issues, created_at, updated_at } = repo;
    return {
      id, node_id, name, full_name, private: isPrivate, owner, description, default_branch, has_issues, created_at, updated_at,
      visibility: isPrivate ? 'private' : 'public', fork: false,
      url: `/api/v3/repos/${full_name}`, html_url: `/${full_name}`, clone_url: `/${full_name}.git`,
      permissions: { admin: true, push: true, pull: true },
    };
  }

  updateRepo(repo: Repo, input: Record<string, unknown>): void {
    if (typeof input.description === 'string' || input.description === null) repo.description = input.description;
    if (typeof input.private === 'boolean') repo.private = input.private;
    if (typeof input.has_issues === 'boolean') repo.has_issues = input.has_issues;
    repo.updated_at = this.now();
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name.toLowerCase());
    this.reposById.delete(String(repo.id));
    this.reposById.delete(repo.node_id);
  }

  createLabel(repo: Repo, input: Record<string, unknown>): Label {
    const name = requiredText(input.name, 'name');
    const key = name.toLowerCase();
    if (repo.labels.has(key)) throw new ApiError(422, 'Label already exists');
    const color = typeof input.color === 'string' ? input.color : 'ededed';
    if (!/^[a-f0-9]{6}$/i.test(color)) throw new ApiError(422, 'Invalid label color');
    const label = { ...identity('Label', ++this.serial), name, color, description: typeof input.description === 'string' ? input.description : null };
    repo.labels.set(key, label);
    return label;
  }

  private issueLabels(repo: Repo, value: unknown): Label[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new ApiError(422, 'labels must be an array');
    const labels = value.map((name) => {
      const label = typeof name === 'string' ? repo.labels.get(name.toLowerCase()) : undefined;
      if (!label) throw new ApiError(422, `Unknown label: ${String(name)}`);
      return label;
    });
    return [...new Set(labels)];
  }

  createIssue(repo: Repo, input: { title?: unknown; body?: unknown; labels?: unknown }): Issue {
    if (!repo.has_issues) throw new ApiError(410, 'Issues are disabled');
    const title = requiredText(input.title, 'title');
    const labels = this.issueLabels(repo, input.labels);
    const number = repo.nextNumber++;
    const timestamp = this.now();
    const issue: Issue = {
      ...identity('Issue', ++this.serial), number, title, labels, body: typeof input.body === 'string' ? input.body : '',
      state: 'open', user: this.viewer, comments: 0, created_at: timestamp, updated_at: timestamp, closed_at: null,
      html_url: `/${repo.full_name}/issues/${number}`, url: `/api/v3/repos/${repo.full_name}/issues/${number}`,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  updateIssue(repo: Repo, issue: Issue, input: Record<string, unknown>): Issue {
    const title = input.title === undefined ? issue.title : requiredText(input.title, 'title');
    const labels = input.labels === undefined ? issue.labels : this.issueLabels(repo, input.labels);
    const state = input.state ?? issue.state;
    if (state !== 'open' && state !== 'closed') throw new ApiError(422, 'Invalid issue state');
    issue.title = title;
    issue.labels = labels;
    if (typeof input.body === 'string') issue.body = input.body;
    issue.updated_at = this.now();
    if (issue.state !== state) issue.closed_at = state === 'closed' ? issue.updated_at : null;
    issue.state = state;
    return issue;
  }

  listIssues(repo: Repo, state = 'open', direction = 'desc', sort = 'created'): Issue[] {
    const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state.toLowerCase());
    const order = direction === 'asc' ? 1 : -1;
    return issues.sort((a, b) => {
      const comparison = sort === 'updated' ? a.updated_at.localeCompare(b.updated_at) : sort === 'comments' ? a.comments - b.comments : 0;
      return (comparison || a.number - b.number) * order;
    });
  }

  createComment(repo: Repo, issue: Issue, value: unknown): Comment {
    const body = requiredText(value, 'body');
    const timestamp = this.now();
    const comment = { ...identity('IssueComment', ++this.serial), body, user: this.viewer, created_at: timestamp, updated_at: timestamp };
    const comments = repo.comments.get(issue.number) ?? [];
    comments.push(comment);
    repo.comments.set(issue.number, comments);
    issue.comments = comments.length;
    issue.updated_at = timestamp;
    return comment;
  }

  createPull(repo: Repo, input: { title?: unknown; head?: unknown; base?: unknown; body?: unknown; draft?: unknown }): Pull {
    const inputHead = requiredText(input.head, 'head');
    const base = requiredText(input.base, 'base');
    const title = requiredText(input.title, 'title');
    const colon = inputHead.indexOf(':');
    const head = colon < 0 ? inputHead : inputHead.slice(colon + 1);
    const headSha = repo.git.refs.get(`refs/heads/${head}`);
    const baseSha = repo.git.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha || head === base || (colon >= 0 && inputHead.slice(0, colon).toLowerCase() !== repo.owner.login.toLowerCase())) {
      throw new ApiError(422, 'Invalid pull request branches');
    }
    const number = repo.nextNumber++;
    const timestamp = this.now();
    const pull: Pull = {
      ...identity('PullRequest', ++this.serial), number, title, body: typeof input.body === 'string' ? input.body : '', state: 'open',
      head: { ref: head, sha: headSha, label: `${repo.owner.login}:${head}` }, base: { ref: base, sha: baseSha, label: `${repo.owner.login}:${base}` },
      draft: input.draft === true, merged: false, mergeable: null, merge_commit_sha: null, user: this.viewer,
      created_at: timestamp, updated_at: timestamp, closed_at: null, merged_at: null,
      url: `/api/v3/repos/${repo.full_name}/pulls/${number}`, html_url: `/${repo.full_name}/pull/${number}`,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  pullFiles(repo: Repo, pull: Pull) {
    const head = pull.merged ? pull.head.sha : repo.git.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
    const base = pull.merged ? pull.base.sha : repo.git.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
    return repo.git.changes(base, head);
  }

  mergePull(repo: Repo, number: number, input: { commit_title?: unknown; commit_message?: unknown; sha?: unknown } = {}): { sha: string; merged: true; message: string } {
    const pull = repo.pulls.get(number);
    if (!pull) throw new ApiError(404, 'Not Found');
    if (pull.state !== 'open' || pull.draft) throw new ApiError(405, 'Pull request is not mergeable');
    const head = repo.git.refs.get(`refs/heads/${pull.head.ref}`);
    const base = repo.git.refs.get(`refs/heads/${pull.base.ref}`);
    if (input.sha !== undefined && input.sha !== head) throw new ApiError(409, 'Head branch changed');
    const title = typeof input.commit_title === 'string' ? input.commit_title : `${pull.title} (#${number})`;
    const content = typeof input.commit_message === 'string' ? `${title}\n\n${input.commit_message}` : title;
    const sha = head && base && repo.git.merge(pull.base.ref, pull.head.ref, content);
    if (!sha) {
      pull.mergeable = false;
      throw new ApiError(405, 'Pull request has conflicts');
    }
    pull.base.sha = base;
    pull.head.sha = head;
    pull.merged = true;
    pull.mergeable = true;
    pull.state = 'closed';
    pull.merge_commit_sha = sha;
    pull.updated_at = pull.closed_at = pull.merged_at = this.now();
    return { sha, merged: true, message: 'Pull Request successfully merged' };
  }
}
