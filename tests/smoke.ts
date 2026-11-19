import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../app.ts';

const TOKEN = 'smoke-token';
const LOGIN = 'smoke-user';

type RunningApp = { base: string; close: () => Promise<void> };

async function startApp(options: { token?: string; login?: string; trialNow?: string } = {}): Promise<RunningApp> {
  const server = createApp({ token: TOKEN, login: LOGIN, trialNow: '2026-01-02T03:04:05.000Z', ...options });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function jsonRequest(base: string, path: string, method = 'GET', body?: unknown, auth = true) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, value: text ? JSON.parse(text) as unknown : null };
}

function rpc(id: string | number, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

async function mcp(base: string, request: unknown, auth = true) {
  return jsonRequest(base, '/mcp', 'POST', request, auth);
}

async function createRepo(base: string, name: string) {
  const result = await mcp(base, rpc(`repo-${name}`, 'tools/call', { name: 'create_repo', arguments: { name, description: 'smoke repository', private: true } }));
  assert.equal(result.response.status, 200);
  const rpcValue = result.value as { result?: { structuredContent?: Record<string, unknown> } };
  assert.equal(rpcValue.result?.structuredContent?.full_name, `${LOGIN}/${name}`);
  return rpcValue.result!.structuredContent!;
}

async function restRepo(base: string, name: string) {
  const { response, value } = await jsonRequest(base, `/api/v3/repos/${LOGIN}/${name}`);
  assert.equal(response.status, 200);
  return value as Record<string, unknown>;
}

describe('HTTP and MCP smoke regressions', () => {
  let app: RunningApp;
  before(async () => { app = await startApp(); });
  after(async () => { await app.close(); });

  it('rejects malformed JSON and unauthenticated MCP calls with HTTP errors', async () => {
    const malformed = await fetch(`${app.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });

    const unauthenticated = await mcp(app.base, rpc(1, 'tools/list'), false);
    assert.equal(unauthenticated.response.status, 401);
    assert.equal((unauthenticated.value as { message?: string }).message, 'Bad credentials');
  });

  it('returns JSON-RPC errors for unknown methods, tools, and invalid arguments', async () => {
    const method = await mcp(app.base, rpc('method', 'not/a/method'));
    assert.equal((method.value as { error?: { code: number } }).error?.code, -32601);

    const tool = await mcp(app.base, rpc('tool', 'tools/call', { name: 'does_not_exist', arguments: {} }));
    assert.equal((tool.value as { error?: { code: number } }).error?.code, -32602);

    const args = await mcp(app.base, rpc('args', 'tools/call', { name: 'create_issue', arguments: { owner: LOGIN, repo: 'missing' } }));
    const toolResult = (args.value as { result?: { isError?: boolean } }).result;
    assert.equal(toolResult?.isError, true);
  });

  it('preserves repository and issue identity across MCP and REST', async () => {
    const name = 'mcp-rest-parity';
    const created = await createRepo(app.base, name);
    const restBefore = await restRepo(app.base, name);
    assert.equal(created.id, restBefore.id);
    assert.equal(created.node_id, restBefore.node_id);

    const issueCall = await mcp(app.base, rpc('issue', 'tools/call', {
      name: 'create_issue', arguments: { owner: LOGIN, repo: name, title: 'Created over MCP', body: 'visible over REST' },
    }));
    assert.equal(issueCall.response.status, 200);
    const issue = (issueCall.value as { result?: { structuredContent?: Record<string, unknown> } }).result?.structuredContent;
    assert.ok(issue);

    const listed = await jsonRequest(app.base, `/api/v3/repos/${LOGIN}/${name}/issues?state=all`);
    assert.equal(listed.response.status, 200);
    const issues = listed.value as Array<Record<string, unknown>>;
    const restIssue = issues.find((entry) => entry.number === issue.number);
    assert.ok(restIssue);
    assert.equal(restIssue.id, issue.id);
    assert.equal(restIssue.node_id, issue.node_id);
    assert.equal(restIssue.title, 'Created over MCP');

    const restAgain = await restRepo(app.base, name);
    assert.equal(restAgain.id, restBefore.id);
  });

  it('keeps concurrent JSON-RPC ids and repository results paired', async () => {
    await createRepo(app.base, 'parallel-left');
    await createRepo(app.base, 'parallel-right');
    const calls = [
      mcp(app.base, rpc('left-id', 'tools/call', { name: 'get_repo', arguments: { owner: LOGIN, repo: 'parallel-left' } })),
      mcp(app.base, rpc('right-id', 'tools/call', { name: 'get_repo', arguments: { owner: LOGIN, repo: 'parallel-right' } })),
    ];
    const [left, right] = await Promise.all(calls);
    const leftRpc = left.value as { id: string; result: { structuredContent: Record<string, unknown> } };
    const rightRpc = right.value as { id: string; result: { structuredContent: Record<string, unknown> } };
    assert.equal(leftRpc.id, 'left-id');
    assert.equal(rightRpc.id, 'right-id');
    assert.equal(leftRpc.result.structuredContent.name, 'parallel-left');
    assert.equal(rightRpc.result.structuredContent.name, 'parallel-right');
  });

  it('produces identical outcomes across identically configured app instances', async () => {
    const first = await startApp();
    const second = await startApp();
    try {
      const operations = async (base: string) => {
        const repo = await createRepo(base, 'deterministic');
        const issue = await mcp(base, rpc('same-issue-id', 'tools/call', {
          name: 'create_issue', arguments: { owner: LOGIN, repo: 'deterministic', title: 'Stable issue', body: 'same input' },
        }));
        const repoAgain = await restRepo(base, 'deterministic');
        return { repo, issue: issue.value, repoAgain };
      };
      assert.deepEqual(await operations(first.base), await operations(second.base));
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('registers an ephemeral port, retries registration, and exits when the fake env reports done', async () => {
    let registerAttempts = 0;
    let doneChecks = 0;
    let registeredPort = 0;
    let healthResponse: Response | undefined;
    const fakeEnv = createServer(async (req, res) => {
      if (req.url === '/register' && req.method === 'POST') {
        registerAttempts += 1;
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { port?: unknown };
        assert.equal(typeof payload.port, 'number');
        assert.ok(Number.isInteger(payload.port) && payload.port > 0);
        registeredPort = payload.port;
        res.statusCode = registerAttempts === 1 ? 503 : 200;
        res.end();
        return;
      }
      if (req.url === '/done' && req.method === 'GET') {
        doneChecks += 1;
        healthResponse = await fetch(`http://127.0.0.1:${registeredPort}/healthz`);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ done: doneChecks > 1 }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      fakeEnv.once('error', reject);
      fakeEnv.listen(0, '127.0.0.1', resolve);
    });
    const envAddress = fakeEnv.address();
    assert.ok(envAddress && typeof envAddress !== 'string');

    const child = spawn(process.execPath, ['--experimental-strip-types', new URL('../main.ts', import.meta.url).pathname], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, MAKEFUN_ENV_URL: `http://127.0.0.1:${envAddress.port}`, MAKEFUN_SHOP_TOKEN: TOKEN, MAKEFUN_FORGE_LOGIN: LOGIN, MAKEFUN_TRIAL_NOW: '2026-01-02T03:04:05.000Z' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try {
      const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
      assert.equal(signal, null, stderr);
      assert.equal(code, 0, stderr);
      assert.equal(registerAttempts, 2);
      assert.ok(doneChecks >= 2);
      assert.ok(registeredPort > 0);
      assert.equal(healthResponse?.status, 200);
      assert.match(stdout, /registered; waiting for the env to say done/);
      assert.match(stdout, /\[entry\] done/);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await new Promise<void>((resolve) => fakeEnv.close(() => resolve()));
    }
  });
});
