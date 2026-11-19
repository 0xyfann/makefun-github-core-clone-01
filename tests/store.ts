import test from 'node:test';
import assert from 'node:assert/strict';
import { ForgeStore, ApiError } from '../store.ts';

function store() {
  return new ForgeStore('local-user', '2026-01-01T00:00:00Z');
}

test('squash merge keeps independent base edits and has one parent', () => {
  const s = store();
  const repo = s.createRepo({ name: 'merge' });
  const initial = repo.git.writeFile('main', 'shared.txt', Buffer.from('original\n'), 'initial');
  repo.git.refs.set('refs/heads/topic', initial);
  repo.git.writeFile('topic', 'topic.txt', Buffer.from('topic\n'), 'topic');
  const previous = repo.git.writeFile('main', 'main.txt', Buffer.from('main\n'), 'main advance');
  const pull = s.createPull(repo, { title: 'Merge topic', head: 'topic', base: 'main' });
  const result = s.mergePull(repo, pull.number);
  assert.equal(result.merged, true);
  assert.equal(repo.git.refs.get('refs/heads/main'), result.sha);
  assert.equal(repo.git.getFile('main', 'topic.txt')?.data.toString(), 'topic\n');
  assert.equal(repo.git.getFile('main', 'main.txt')?.data.toString(), 'main\n');
  assert.equal(repo.git.getFile(result.sha, 'shared.txt')?.data.toString(), 'original\n');
  const commit = repo.git.objects.get(result.sha)?.data.toString() ?? '';
  assert.deepEqual([...commit.matchAll(/^parent (.+)$/gm)].map((match) => match[1]), [previous]);
  assert.equal(pull.state, 'closed');
  assert.equal(pull.merge_commit_sha, result.sha);
});

test('a conflicted merge leaves both refs and pull state intact', () => {
  const s = store();
  const repo = s.createRepo({ name: 'conflict' });
  const initial = repo.git.writeFile('main', 'shared.txt', Buffer.from('original\n'), 'initial');
  repo.git.refs.set('refs/heads/topic', initial);
  const head = repo.git.writeFile('topic', 'shared.txt', Buffer.from('topic edit\n'), 'topic');
  const base = repo.git.writeFile('main', 'shared.txt', Buffer.from('main edit\n'), 'main');
  const pull = s.createPull(repo, { title: 'Conflict', head: 'topic', base: 'main' });
  assert.throws(() => s.mergePull(repo, pull.number), (error) => error instanceof ApiError && error.status === 405);
  assert.equal(repo.git.refs.get('refs/heads/main'), base);
  assert.equal(repo.git.refs.get('refs/heads/topic'), head);
  assert.equal(pull.state, 'open');
  assert.equal(pull.merged, false);
});

test('unknown labels reject atomically and issue and pull numbers share one sequence', () => {
  const s = store();
  const repo = s.createRepo({ name: 'numbers', auto_init: true });
  assert.throws(() => s.createIssue(repo, { title: 'bad label', labels: ['unknown'] }), (error) => error instanceof ApiError && error.status === 422);
  const label = s.createLabel(repo, { name: 'Bug', color: 'abcdef' });
  const first = s.createIssue(repo, { title: 'first', labels: ['bug'] });
  assert.equal(first.number, 1);
  assert.equal(first.labels[0].id, label.id);
  repo.git.refs.set('refs/heads/topic', repo.git.refs.get('refs/heads/main')!);
  repo.git.writeFile('topic', 'topic.txt', Buffer.from('topic\n'), 'topic');
  const pull = s.createPull(repo, { title: 'second', head: 'topic', base: 'main' });
  assert.equal(pull.number, 2);
  assert.equal(s.createIssue(repo, { title: 'third' }).number, 3);
  assert.equal(s.findRepo('foreign-user', repo.name), undefined);
});
