import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../app.ts';

const exec = promisify(execFile);

test('real Git CLI pushes delta packs, clones v2, fetches and shallow-clones', async () => {
  const token = 'git-cli-local-test';
  const app = createApp({ token, login: 'local-user' });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  const address = app.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const root = await mkdtemp(join(tmpdir(), 'forge-cli-'));
  async function git(args: string[], cwd = root) {
    return exec('git', ['-c', `http.extraHeader=Authorization: Bearer ${token}`, ...args], {
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Local Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Local Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
      timeout: 30_000,
    });
  }
  try {
    const created = await fetch(`${origin}/api/v3/user/repos`, { method: 'POST', headers, body: JSON.stringify({ name: 'wire', private: true }) });
    assert.equal(created.status, 201);
    const remote = `${origin}/local-user/wire.git`;
    const source = join(root, 'source');
    await mkdir(source);
    await git(['init', '-b', 'main'], source);
    let text = Array.from({ length: 2000 }, (_, index) => `line ${index}: a long shared payload for delta compression\n`).join('');
    await writeFile(join(source, 'large.txt'), text);
    await git(['add', '.'], source);
    await git(['commit', '-m', 'initial'], source);
    await git(['push', remote, 'main'], source);
    for (let index = 0; index < 5; index++) {
      text += `change ${index}\n`;
      await writeFile(join(source, 'large.txt'), text);
      await git(['add', '.'], source);
      await git(['commit', '-m', `change ${index}`], source);
    }
    await git(['-c', 'pack.window=10', 'push', remote, 'main'], source);
    const clone = join(root, 'clone');
    await git(['-c', 'protocol.version=2', 'clone', remote, clone]);
    assert.equal(await readFile(join(clone, 'large.txt'), 'utf8'), text);
    await git(['fsck', '--full'], clone);
    const sourceHead = (await git(['rev-parse', 'HEAD'], source)).stdout.trim();
    assert.equal((await git(['rev-parse', 'HEAD'], clone)).stdout.trim(), sourceHead);
    const shallow = join(root, 'shallow');
    await git(['clone', '--depth=1', remote, shallow]);
    assert.equal((await git(['rev-list', '--count', 'HEAD'], shallow)).stdout.trim(), '1');
    await git(['fetch', '--deepen=2'], shallow);
    assert.equal((await git(['rev-list', '--count', 'HEAD'], shallow)).stdout.trim(), '3');
    await writeFile(join(source, 'new.txt'), 'incremental\n');
    await git(['add', '.'], source);
    await git(['commit', '-m', 'incremental'], source);
    await git(['push', remote, 'main'], source);
    await git(['fetch', remote, 'main'], clone);
    assert.equal((await git(['rev-parse', 'FETCH_HEAD'], clone)).stdout.trim(), (await git(['rev-parse', 'HEAD'], source)).stdout.trim());
    await git(['push', remote, 'HEAD:refs/heads/topic'], source);
    await git(['push', remote, ':refs/heads/topic'], source);
    await git(['fsck', '--full'], source);

    const api = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const restFile = await api('/api/v3/repos/local-user/wire/contents/new.txt');
    assert.equal(restFile.status, 200);
    assert.equal(Buffer.from(restFile.body.content, 'base64').toString(), 'incremental\n');
    const graph = await api('/api/graphql', 'POST', {
      query: '{ repository(owner:"local-user", name:"wire") { name defaultBranchRef { name } } }',
    });
    assert.equal(graph.status, 200);
    assert.equal(graph.body.errors, undefined);
    assert.equal(graph.body.data.repository.name, 'wire');
    assert.equal(graph.body.data.repository.defaultBranchRef.name, 'main');
    const issue = await api('/api/v3/repos/local-user/wire/issues', 'POST', { title: 'Review pushed change' });
    assert.equal(issue.status, 201);
    await git(['checkout', '-b', 'review'], clone);
    await writeFile(join(clone, 'review.txt'), 'clone-side change\n');
    await git(['add', '.'], clone);
    await git(['commit', '-m', 'review change'], clone);
    await git(['push', remote, 'review'], clone);
    const pull = await api('/api/v3/repos/local-user/wire/pulls', 'POST', { title: 'Merge actual Git branch', head: 'review', base: 'main' });
    assert.equal(pull.status, 201);
    const merged = await api(`/api/v3/repos/local-user/wire/pulls/${pull.body.number}/merge`, 'PUT', { merge_method: 'squash' });
    assert.equal(merged.status, 200);
    assert.equal(merged.body.merged, true);
    await git(['fetch', remote, 'main'], clone);
    assert.equal((await git(['rev-parse', 'FETCH_HEAD'], clone)).stdout.trim(), merged.body.sha);
    assert.equal((await git(['show', 'FETCH_HEAD:review.txt'], clone)).stdout, 'clone-side change\n');
    assert.equal((await git(['show', 'FETCH_HEAD:new.txt'], clone)).stdout, 'incremental\n');
    await git(['fsck', '--full'], clone);
  } finally {
    app.closeAllConnections();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    // root is created exclusively by mkdtemp above and never comes from request input.
    await rm(root, { recursive: true, force: true });
  }
});
