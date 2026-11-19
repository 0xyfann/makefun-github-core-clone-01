import type { ForgeStore, Repo } from './store.ts';

const MODERN = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcError(id: unknown, code: number, message: string): RecordValue {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(value: unknown): RecordValue {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolFailure(error: unknown): RecordValue {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoOrThrow(store: ForgeStore, args: RecordValue): Repo {
  const owner = typeof args.owner === 'string' ? args.owner : typeof args.owner_login === 'string' ? args.owner_login : '';
  const name = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  if (!owner || !name) throw new TypeError('owner and repo are required');
  const repo = store.findRepo(owner, name);
  if (!repo) throw new Error(`Repository ${owner}/${name} not found`);
  return repo;
}

const TOOLS = Object.freeze([
  { name: 'create_repo', description: 'Create a repository.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request by its number.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' }, commit_title: { type: 'string' }, commit_message: { type: 'string' } }, required: ['owner', 'repo', 'pull_number'] } },
]);

function executeTool(store: ForgeStore, name: string, args: RecordValue): unknown {
  switch (name) {
    case 'create_repo': {
      if (typeof args.name !== 'string' || args.name.length === 0) throw new TypeError('name is required');
      const repo = store.createRepo({ name: args.name, description: typeof args.description === 'string' ? args.description : undefined, private: typeof args.private === 'boolean' ? args.private : undefined });
      return store.repoView(repo);
    }
    case 'get_repo': return store.repoView(repoOrThrow(store, args));
    case 'create_issue': {
      const repo = repoOrThrow(store, args);
      if (typeof args.title !== 'string' || args.title.length === 0) throw new TypeError('title is required');
      return store.createIssue(repo, { title: args.title, body: typeof args.body === 'string' ? args.body : undefined, labels: Array.isArray(args.labels) && args.labels.every((v) => typeof v === 'string') ? args.labels as string[] : undefined });
    }
    case 'list_issues': return store.listIssues(repoOrThrow(store, args), typeof args.state === 'string' ? args.state : undefined);
    case 'create_pull_request': {
      const repo = repoOrThrow(store, args);
      if (typeof args.title !== 'string' || typeof args.head !== 'string' || typeof args.base !== 'string') throw new TypeError('title, head, and base are required');
      return store.createPull(repo, { title: args.title, head: args.head, base: args.base, body: typeof args.body === 'string' ? args.body : undefined });
    }
    case 'merge_pull_request': {
      const repo = repoOrThrow(store, args);
      const number = args.pull_number ?? args.number;
      if (typeof number !== 'number' || !Number.isInteger(number)) throw new TypeError('pull_number is required');
      return store.mergePull(repo, number, { commit_title: typeof args.commit_title === 'string' ? args.commit_title : undefined, commit_message: typeof args.commit_message === 'string' ? args.commit_message : undefined });
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

/** Execute one MCP JSON-RPC request. HTTP transport, authentication, and body parsing are handled by the app. */
export function executeMcp(body: unknown, store: ForgeStore, requestVersion?: string): unknown | undefined {
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return rpcError(isRecord(body) ? body.id : null, -32600, 'Invalid Request');
  const hasId = Object.prototype.hasOwnProperty.call(body, 'id');
  const id = body.id;
  if (hasId && !(typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) || id === null)) return rpcError(null, -32600, 'Invalid Request');
  if (!isRecord(body.params ?? {})) return hasId ? rpcError(id, -32602, 'Invalid params') : undefined;
  const params = (body.params ?? {}) as RecordValue;
  if (!hasId) return undefined;

  const meta = isRecord(params._meta) ? params._meta : {};
  const version = typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string'
    ? meta['io.modelcontextprotocol/protocolVersion'] as string
    : typeof meta.protocolVersion === 'string' ? meta.protocolVersion : requestVersion;

  switch (body.method) {
    case 'server/discover':
      return { jsonrpc: '2.0', id, result: { resultType: 'discover', supportedVersions: [MODERN, ...LEGACY], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } } };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = (LEGACY as readonly string[]).includes(requested) ? requested : LEGACY[0];
      return { jsonrpc: '2.0', id, result: { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
    }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      if (version && !/^\d{4}-\d{2}-\d{2}$/.test(version)) return rpcError(id, -32602, 'Invalid protocol version');
      const name = params.name;
      const args = params.arguments;
      if (typeof name !== 'string') return rpcError(id, -32602, 'Tool name is required');
      if (!isRecord(args)) return rpcError(id, -32602, 'Tool arguments must be an object');
      if (!TOOLS.some((tool) => tool.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        return { jsonrpc: '2.0', id, result: toolResult(executeTool(store, name, args)) };
      } catch (error) {
        return { jsonrpc: '2.0', id, result: toolFailure(error) };
      }
    }
    default: return rpcError(id, -32601, `Method not found: ${body.method}`);
  }
}
