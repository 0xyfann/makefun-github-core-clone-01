# GitHub Core Forge

A standalone, deterministic, in-memory Git forge. Runtime modules use only Node.js standard library APIs; no install step, Git executable, network service, model call or writable repository is needed.

## Run

Use Node.js 22.18+ (native TypeScript stripping):

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 \
MAKEFUN_SHOP_TOKEN=local-token \
node main.ts
```

`main.ts` preserves the starter lifecycle: bind port 0, register the chosen port, retry registration/poll failures with the starter backoff, poll `/done`, and exit successfully only when the environment reports completion. Registration HTTP 400/405 terminates with an error; 409 is accepted.

For development without an environment:

```sh
MAKEFUN_SHOP_TOKEN=local-token node --input-type=module -e \
  "import {createApp} from './app.ts'; const s=createApp(); s.listen(0,()=>console.log(s.address().port));"
```

The single bearer credential is provisioned for one login. `createApp({token, login, trialNow})` can configure an isolated server directly. Deployment uses `MAKEFUN_SHOP_TOKEN`, optional `MAKEFUN_FORGE_LOGIN` (default `adaiversen`, the kit's provisioned viewer), and `MAKEFUN_TRIAL_NOW`. Owner lookups are case-insensitive and foreign owners receive 404. Git accepts bearer credentials and HTTP Basic passwords containing that same token.

## Surfaces

- `/healthz`: unauthenticated health probe.
- `/api/v3`: JSON REST repositories, pagination, labels, issues and comments, branches and commit history, file/directory contents, pull requests, changed files and squash merging.
- `/{owner}/{repo}.git`: upload-pack v2/v0, receive-pack v0, Git objects and pack files, shallow fetches, branch/tag updates and per-reference fast-forward enforcement.
- `/api/graphql`: queries and mutations over the shared store, schema introspection, variables, aliases/fragments, connections and batch requests.
- `/mcp`: JSON-RPC streamable HTTP with discovery and initialize negotiation; six tools for repositories, issues and pull requests backed by the same store.

All REST responses use JSON and a request ID. Missing/wrong API credentials receive 401. JSON errors carry a message. Deterministic IDs, timestamps, content hashes and Git commit metadata support trial replay. All state disappears on process exit.

This implements the competition's compatibility surface rather than the whole GitHub API. It has no organizations, fork network, persistence, multi-user credential provisioning or production rate limiting. GraphQL supports the provided compatibility schema rather than the complete GitHub schema. Merge conflicts are detected conservatively at file level.

## Verification

The kit's exact local suite can run against a development server:

```sh
node ../kit/github-core-clone-01-kit/sdk/run.ts \
  --url http://127.0.0.1:PORT --token local-token --perf --json
```

The full lifecycle, practice instances and replay can be exercised with the local process driver:

```sh
node ../kit/github-core-clone-01-kit/cli/makefun.mjs grade-local \
  --kit ../kit/github-core-clone-01-kit --bot . --driver process \
  --worktree --instances 3 --save /tmp/forge-grade --json
```

See `VERIFICATION.md` for recorded results and runtime limitations.
