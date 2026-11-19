import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ApiError, ForgeStore, requiredText, validRef, type Repo } from './store.ts';
import { handleGit } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { executeMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const notFound = () => new ApiError(404, 'Not Found');

function send(res: ServerResponse, status: number, value?: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', JSON_TYPE);
  if (status === 204 || status === 202) {
    res.end();
    return;
  }
  const body = JSON.stringify(value);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

async function parseJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      req.resume();
      throw new ApiError(413, 'Request body too large');
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new ApiError(400, 'Malformed JSON');
  }
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'Expected a JSON object');
  return value as Record<string, unknown>;
}

function page<T>(items: T[], req: IncomingMessage, res: ServerResponse, url: URL): T[] {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('per_page') ?? '', 10) || 30));
  const current = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '', 10) || 1);
  const last = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  function link(index: number, relation: string) {
    const next = new URL(url.pathname + url.search, `http://${req.headers.host ?? 'localhost'}`);
    next.searchParams.set('page', String(index));
    links.push(`<${next.href}>; rel="${relation}"`);
  }
  if (current < last) {
    link(current + 1, 'next');
    link(last, 'last');
  }
  if (current > 1) {
    link(1, 'first');
    link(current - 1, 'prev');
  }
  if (links.length) res.setHeader('Link', links.join(', '));
  return items.slice((current - 1) * perPage, current * perPage);
}

function fileView(path: string, entry: { sha: string; data: Buffer }) {
  return {
    type: 'file', name: path.split('/').at(-1), path, sha: entry.sha, size: entry.data.length,
    encoding: 'base64', content: entry.data.toString('base64'),
  };
}

function contentRoute(req: IncomingMessage, res: ServerResponse, url: URL, repo: Repo, path: string, input: Record<string, unknown>): void {
  if (path && path.split('/').some((segment) => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git' || /[\0\\]/.test(segment))) {
    throw new ApiError(422, 'Invalid file path');
  }
  const method = req.method;
  if (method === 'GET') {
    const ref = url.searchParams.get('ref') ?? repo.default_branch;
    const file = path ? repo.git.getFile(ref, path) : undefined;
    if (file) return send(res, 200, fileView(path, file));
    const children = repo.git.listDirectory(ref, path);
    if (!children) throw notFound();
    return send(res, 200, children.map((entry) => ({ ...entry, path: path ? `${path}/${entry.name}` : entry.name })));
  }
  if (!path || (method !== 'PUT' && method !== 'DELETE')) throw notFound();
  const branch = typeof input.branch === 'string' ? input.branch : repo.default_branch;
  if (branch !== repo.default_branch && !repo.git.refs.has(`refs/heads/${branch}`)) throw notFound();
  const existing = repo.git.getFile(branch, path);
  if (method === 'DELETE' && !existing) throw notFound();
  if (existing?.sha !== input.sha) throw new ApiError(409, 'File sha does not match');
  const message = requiredText(input.message, 'message');
  let data: Buffer | null = null;
  if (method === 'PUT') {
    if (typeof input.content !== 'string') throw new ApiError(422, 'Base64 content is required');
    const compact = input.content.replace(/[\r\n\t ]/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) throw new ApiError(422, 'Invalid base64 content');
    if (repo.git.listDirectory(branch, path)) throw new ApiError(409, 'Path is a directory');
    for (let split = path.indexOf('/'); split >= 0; split = path.indexOf('/', split + 1)) {
      if (repo.git.getFile(branch, path.slice(0, split))) throw new ApiError(409, 'Parent path is a file');
    }
    data = Buffer.from(compact, 'base64');
  }
  const sha = repo.git.writeFile(branch, path, data, message);
  const file = data === null ? undefined : repo.git.getFile(branch, path);
  send(res, file && !existing ? 201 : 200, { content: file ? fileView(path, file) : null, commit: { sha, message } });
}

function restRoute(req: IncomingMessage, res: ServerResponse, url: URL, path: string[], store: ForgeStore, input: Record<string, unknown>): void {
  const method = req.method;
  if (path.length === 0 && method === 'GET') {
    res.setHeader('X-OAuth-Scopes', 'repo, read:org');
    return send(res, 200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' });
  }
  if (path.length === 1 && method === 'GET') {
    if (path[0] === 'meta') return send(res, 200, { installed_version: 'forge-1.0.0' });
    if (path[0] === 'user') return send(res, 200, store.viewer);
  }
  if (path.length === 2 && path[0] === 'user' && path[1] === 'repos') {
    if (method === 'POST') return send(res, 201, store.repoView(store.createRepo(input)));
    if (method === 'GET') return send(res, 200, page([...store.repos.values()], req, res, url).map((repo) => store.repoView(repo)));
  }
  if (path.length < 3 || path[0] !== 'repos') throw notFound();
  const repo = store.findRepo(path[1], path[2]);
  if (!repo) throw notFound();
  const [, , , resource, number, action] = path;
  if (path.length === 3) {
    if (method === 'GET') return send(res, 200, store.repoView(repo));
    if (method === 'PATCH') {
      store.updateRepo(repo, input);
      return send(res, 200, store.repoView(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return send(res, 204);
    }
  }
  if (resource === 'contents') return contentRoute(req, res, url, repo, path.slice(4).join('/'), input);
  if (resource === 'git' && number === 'refs' && path.length === 5 && method === 'POST') {
    const ref = requiredText(input.ref, 'ref');
    const sha = requiredText(input.sha, 'sha');
    const conflicting = [...repo.git.refs.keys()].some((key) => key === ref || key.startsWith(`${ref}/`) || ref.startsWith(`${key}/`));
    if (!validRef(ref) || conflicting || !repo.git.hasCommit(sha)) throw new ApiError(422, 'Invalid or existing reference');
    repo.git.refs.set(ref, sha);
    return send(res, 201, { ref, object: { type: 'commit', sha } });
  }
  if (resource === 'git' && (number === 'ref' || number === 'refs') && path.length > 5 && method === 'GET') {
    const ref = `refs/${path.slice(5).join('/')}`;
    const sha = repo.git.refs.get(ref);
    if (!sha) throw notFound();
    return send(res, 200, { ref, object: { type: repo.git.objects.get(sha)?.type ?? 'commit', sha } });
  }
  if (resource === 'branches' && path.length > 4 && method === 'GET') {
    const branch = path.slice(4).join('/');
    const sha = repo.git.refs.get(`refs/heads/${branch}`);
    if (!sha) throw notFound();
    return send(res, 200, { name: branch, commit: { sha }, protected: false });
  }
  if (path.length === 4 && resource === 'branches' && method === 'GET') {
    const branches = [...repo.git.refs].filter(([ref]) => ref.startsWith('refs/heads/'));
    return send(res, 200, page(branches, req, res, url).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha }, protected: false })));
  }
  if (path.length === 4 && resource === 'commits' && method === 'GET') {
    const ref = url.searchParams.get('sha') ?? repo.default_branch;
    return send(res, 200, page(repo.git.commitLog(ref), req, res, url).map(({ sha, message }) => ({ sha, commit: { message } })));
  }
  if (path.length === 4 && resource === 'labels') {
    if (method === 'POST') return send(res, 201, store.createLabel(repo, input));
    if (method === 'GET') return send(res, 200, page([...repo.labels.values()], req, res, url));
  }
  if (resource === 'issues') {
    if (path.length === 4) {
      if (method === 'POST') return send(res, 201, store.createIssue(repo, input));
      if (method === 'GET') {
        const query = url.searchParams;
        const issues = store.listIssues(repo, query.get('state') ?? 'open', query.get('direction') ?? 'desc', query.get('sort') ?? 'created');
        return send(res, 200, page(issues, req, res, url));
      }
    }
    const issue = /^\d+$/.test(number ?? '') ? repo.issues.get(Number(number)) : undefined;
    if (!issue) throw notFound();
    if (path.length === 5 && method === 'GET') return send(res, 200, issue);
    if (path.length === 5 && method === 'PATCH') return send(res, 200, store.updateIssue(repo, issue, input));
    if (path.length === 6 && action === 'comments') {
      if (method === 'GET') return send(res, 200, page(repo.comments.get(issue.number) ?? [], req, res, url));
      if (method === 'POST') return send(res, 201, store.createComment(repo, issue, input.body));
    }
  }
  if (resource === 'pulls') {
    if (path.length === 4) {
      if (method === 'POST') return send(res, 201, store.createPull(repo, input));
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const pulls = [...repo.pulls.values()].filter((pull) => state === 'all' || state === pull.state).reverse();
        return send(res, 200, page(pulls, req, res, url));
      }
    }
    const pull = /^\d+$/.test(number ?? '') ? repo.pulls.get(Number(number)) : undefined;
    if (!pull) throw notFound();
    if (path.length === 5 && method === 'GET') return send(res, 200, pull);
    if (path.length === 6 && action === 'files' && method === 'GET') return send(res, 200, page(store.pullFiles(repo, pull), req, res, url));
    if (path.length === 6 && action === 'merge' && method === 'PUT') return send(res, 200, store.mergePull(repo, pull.number, input));
  }
  throw notFound();
}

function safeEqual(a: string, b: string): boolean {
  const actual = Buffer.from(a);
  const expected = Buffer.from(b);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createApp(options: { token?: string; login?: string; trialNow?: string } = {}) {
  const token = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  // A single opaque credential is provisioned for one login. Deployment can choose that login.
  const login = options.login ?? process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen';
  const store = new ForgeStore(login, options.trialNow ?? process.env.MAKEFUN_TRIAL_NOW);
  let requestId = 0;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname.replace(/\/$/, '') || '/';
      if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true });
      const rest = pathname === '/api/v3' || pathname.startsWith('/api/v3/');
      const graphql = pathname === '/api/graphql';
      const mcp = pathname === '/mcp';
      const bearer = !!token && safeEqual(req.headers.authorization ?? '', `Bearer ${token}`);
      if (rest) res.setHeader('X-GitHub-Request-Id', (++requestId).toString(16));
      if (rest || graphql || mcp) {
        if (!bearer) {
          res.setHeader('WWW-Authenticate', 'Bearer');
          throw new ApiError(401, 'Bad credentials');
        }
        if ((graphql || mcp) && req.method !== 'POST') throw new ApiError(405, 'Method Not Allowed');
        let body: unknown;
        try {
          body = req.method === 'GET' || req.method === 'HEAD' ? {} : await parseJson(req);
        } catch (error) {
          if (mcp && error instanceof ApiError && error.status === 400) {
            return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          }
          throw error;
        }
        if (graphql) return send(res, 200, executeGraphQL(body, store));
        if (mcp) {
          const version = req.headers['mcp-protocol-version'];
          const result = executeMcp(body, store, typeof version === 'string' ? version : undefined);
          return send(res, result === undefined ? 202 : 200, result);
        }
        const path = pathname === '/api/v3' ? [] : pathname.slice(8).split('/').map(decodeURIComponent);
        return restRoute(req, res, url, path, store, bodyObject(body));
      }
      const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
      if (!match) throw notFound();
      const repo = store.findRepo(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      if (!repo) throw notFound();
      const receive = match[3] === 'git-receive-pack' || url.searchParams.get('service') === 'git-receive-pack';
      if (repo.private || receive) {
        const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : '';
        const split = basic.indexOf(':');
        if (!bearer && !(token && split >= 0 && safeEqual(basic.slice(split + 1), token))) {
          res.setHeader('WWW-Authenticate', 'Basic realm="Git"');
          throw new ApiError(401, 'Bad credentials');
        }
      }
      await handleGit(req, res, url, repo.git, match[3]);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof ApiError) send(res, error.status, { message: error.message });
      else if (error instanceof URIError) send(res, 400, { message: 'Invalid URL encoding' });
      else {
        process.stderr.write(`[forge] ${error instanceof Error ? error.message : String(error)}\n`);
        send(res, 500, { message: 'Internal Server Error' });
      }
    }
  });
}
