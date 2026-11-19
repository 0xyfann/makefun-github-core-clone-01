import test from 'node:test';
import assert from 'node:assert/strict';
import { ForgeStore } from '../store.ts';
import { executeGraphQL } from '../graphql.ts';

function run(store: ForgeStore, query: string, variables: Record<string, unknown> = {}) {
  return executeGraphQL({ query, variables }, store) as { data: Record<string, any> | null; errors?: { message: string }[] };
}

test('keeps quoted GraphQL literals as strings', () => {
  const store = new ForgeStore('ada');
  const repo = store.createRepo({ name: 'literals' });
  for (const title of ['true', 'null', '[', 'OPEN']) {
    const result = run(store, `mutation { createIssue(input: { repositoryId: "${repo.node_id}", title: ${JSON.stringify(title)} }) { issue { title } } }`);
    assert.equal(result.data?.createIssue?.issue?.title, title);
  }
});

test('applies include and skip directives with variable defaults', () => {
  const result = run(new ForgeStore('ada'), 'query Viewer($show: Boolean! = true) { viewer { login @include(if: $show) hidden: login @skip(if: true) } }');
  assert.deepEqual(result, { data: { viewer: { login: 'ada' } } });
});

test('resolves named and inline fragments', () => {
  const store = new ForgeStore('ada');
  const repo = store.createRepo({ name: 'fragments' });
  const result = run(store, 'query Read($id: ID!) { node(id: $id) { id ...RepoFields } } fragment RepoFields on Repository { name ... on Repository { nameWithOwner } }', { id: repo.node_id });
  assert.deepEqual(result.data?.node, { id: repo.node_id, name: repo.name, nameWithOwner: repo.full_name });
});

test('filters merged pull requests and returns GraphQL enum values', () => {
  const store = new ForgeStore('ada');
  const repo = store.createRepo({ name: 'pulls' });
  const pull = { id: 4, node_id: 'pull-node', number: 1, title: 'merged', body: '', state: 'closed', merged: true, mergeable: false, head: { ref: 'topic', sha: 'a' }, base: { ref: 'main', sha: 'b' } } as any;
  repo.pulls.set(1, pull);
  const result = run(store, 'query { repository(owner: "ada", name: "pulls") { pullRequests(states: [MERGED]) { nodes { state mergeable } } } }');
  assert.deepEqual(result.data?.repository?.pullRequests?.nodes, [{ state: 'MERGED', mergeable: 'CONFLICTING' }]);
});

function pullFixture() {
  const store = new ForgeStore('ada');
  const repo = store.createRepo({ name: 'fixture', auto_init: true });
  repo.git.refs.set('refs/heads/topic', repo.git.refs.get('refs/heads/main')!);
  repo.git.writeFile('topic', 'one.txt', Buffer.from('one'), 'Add one');
  repo.git.writeFile('topic', 'two.txt', Buffer.from('two'), 'Add two');
  const pull = store.createPull(repo, { title: 'A pull', head: 'topic', base: 'main' });
  return { store, repo, pull };
}

test('round-trips issued repository, issue and pull request ids through node', () => {
  const { store, repo, pull } = pullFixture();
  const issue = store.createIssue(repo, { title: 'An issue' });
  const read = run(store, '{ repository(owner: "ada", name: "fixture") { id issue(number: 2) { id } pullRequest(number: 1) { id } } }');
  assert.equal(read.errors, undefined);
  const ids = [read.data?.repository.id, read.data?.repository.issue.id, read.data?.repository.pullRequest.id];
  for (const [index, object] of [repo, issue, pull].entries()) {
    const result = run(store, 'query Read($id: ID!) { node(id: $id) { id ... on Repository { name } ... on Issue { title } ... on PullRequest { title } } }', { id: ids[index] });
    assert.deepEqual(result, { data: { node: { id: object.node_id, ...(index === 0 ? { name: repo.name } : { title: index === 1 ? issue.title : pull.title }) } } });
  }
  assert.deepEqual(run(store, '{ node(id: "missing") { id } }'), { data: { node: null } });
});

test('returns an issue updatedAt after a mutation changes it', () => {
  const store = new ForgeStore('ada');
  const repo = store.createRepo({ name: 'timestamps' });
  const issue = store.createIssue(repo, { title: 'Before' });
  store.updateIssue(repo, issue, { title: 'After' });
  assert.notEqual(issue.updated_at, issue.created_at);
  assert.deepEqual(run(store, '{ repository(owner: "ada", name: "timestamps") { issue(number: 1) { createdAt updatedAt } } }'), {
    data: { repository: { issue: { createdAt: issue.created_at, updatedAt: issue.updated_at } } },
  });
});

test('keeps closed and merged pull request filters distinct', () => {
  const { store, repo, pull } = pullFixture();
  const closed = store.createPull(repo, { title: 'Closed', head: 'topic', base: 'main' });
  closed.state = 'closed';
  store.mergePull(repo, pull.number);
  const result = run(store, '{ repository(owner: "ada", name: "fixture") { closed: pullRequests(states: [CLOSED]) { nodes { number state } } merged: pullRequests(states: [MERGED]) { nodes { number state } } both: pullRequests(states: [CLOSED, MERGED]) { nodes { number state } } } }');
  assert.deepEqual(result, { data: { repository: {
    closed: { nodes: [{ number: closed.number, state: 'CLOSED' }] },
    merged: { nodes: [{ number: pull.number, state: 'MERGED' }] },
    both: { nodes: [{ number: pull.number, state: 'MERGED' }, { number: closed.number, state: 'CLOSED' }] },
  } } });
});

test('limits changed files with first including zero and omitted limits', () => {
  const { store } = pullFixture();
  const result = run(store, '{ repository(owner: "ada", name: "fixture") { pullRequest(number: 1) { all: files { nodes { path } } limited: files(first: 1) { nodes { path } } empty: files(first: 0) { nodes { path } } } } }');
  assert.equal(result.errors, undefined);
  const files = result.data?.repository.pullRequest;
  assert.deepEqual(files.all.nodes.map((file: { path: string }) => file.path).sort(), ['one.txt', 'two.txt']);
  assert.deepEqual(files.limited.nodes, files.all.nodes.slice(0, 1));
  assert.deepEqual(files.empty.nodes, []);
});

test('applies nested named fragments only to matching runtime types', () => {
  const { store, repo } = pullFixture();
  store.createIssue(repo, { title: 'Issue title' });
  const result = run(store, `{
    repository(owner: "ada", name: "fixture") {
      issue(number: 2) { ...IssueFields ...PullFields }
      pullRequest(number: 1) { ...IssueFields ...PullFields }
    }
  }
  fragment IssueFields on Issue { issueTitle: title ...IssueNumber }
  fragment IssueNumber on Issue { number }
  fragment PullFields on PullRequest { pullTitle: title }`);
  assert.deepEqual(result, { data: { repository: {
    issue: { issueTitle: 'Issue title', number: 2 },
    pullRequest: { pullTitle: 'A pull' },
  } } });
});
