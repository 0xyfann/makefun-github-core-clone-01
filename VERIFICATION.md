# Local verification

Verification is performed with the unmodified competition kit at `../kit/github-core-clone-01-kit` and standard-library regression tests in `tests/`.

## Commands

```sh
npm test

node ../kit/github-core-clone-01-kit/sdk/run.ts \
  --url http://127.0.0.1:PORT --token local-token --perf --json

node ../kit/github-core-clone-01-kit/cli/makefun.mjs grade-local \
  --kit ../kit/github-core-clone-01-kit --bot . --driver process \
  --worktree --instances 3 --save /tmp/forge-final-grade --json
```

The Git CLI regression uses Git only as an independent client, in temporary repositories. Application runtime modules never invoke it. It exercises actual pushes, delta-pack reception, clone, fetch, shallow clone/deepen, branch deletion and `git fsck`. It also reads a pushed file via REST and the repository via GraphQL, creates an issue, pushes a branch from the clone, opens and squash-merges its PR through REST, then fetches the merge with Git and verifies that both independent branch changes survive.

The HTTP/MCP regressions cover malformed requests, authentication, error shape, IDs shared with REST, concurrent JSON-RPC IDs, and deterministic responses from fresh instances. The lifecycle regression launches the actual `main.ts` against a fake local environment, forces one registration retry, verifies the registered ephemeral port, and requires a successful exit after `/done` reports completion. Store regressions check squash commit parentage, merge conflicts and shared issue/PR numbering.

## Environment and limits of the evidence

The development machine provides Node.js v24.22.1 and Git 2.43.0. Docker and a Node 22 executable are unavailable on PATH. The kit's `--driver process` runs the real env, entry lifecycle, scorer and replay on loopback. These are local measurements, not an official sandbox score. The kit metadata additionally reports its server harness uses v26.13.1, differing from the Node 22 runtime described by RULES.txt. Neither that harness runtime nor Node 22 was tested here. No provider keys or model calls are needed.

The grade command runs feature checks, all four performance workloads and replay, and re-scores the saved export. Transcripts are not passed to these runtime runs, so their eligibility metadata reports `no_transcripts`, `coverage_below_gate` and `cost_unpriced`; this verification does not establish submission authorship eligibility.

## Final regression and snapshot checks

- `npm test`: 23 passed, 0 failed, 0 skipped (including real Git CLI integration).
- `node --check` on every root/test TypeScript source: 12 passed, 0 failed.
- Direct curl checks: 5 passed, 0 failed.
- LICENSE starts with exactly `SPDX-License-Identifier: MIT`, followed by the full MIT text.
- No dependency fields in package.json; runtime imports are local modules or Node built-ins. Only main.ts makes outbound runtime requests, to the configured environment's `/register` and `/done`.
- No node_modules or __pycache__ directories; no nonlocal literal network URLs in TypeScript sources. Source caps are 16 MiB total and 8 MiB per file.
- main.ts is unchanged during this completion session: 2,386 bytes; SHA-256 `da83af8fb46e47298249de4b3139070047eff0aed2cbdb58256fdefd3c80940a`. Its registration, retry, completion-poll and exit behavior matches the starter.

Changes during completion: git.ts now decodes request pkt-lines, peels tags in ls-refs, excludes held objects in fetch, handles shallow/deepen metadata and frames sideband output in bounded packets with consistent flush termination. Receive-pack uses the validated git-pack.ts decoder, and obsolete decoding/upload paths were removed. graphql.ts now round-trips issue/PR node IDs, resolves updatedAt, distinguishes CLOSED from MERGED, honors files(first:), and preserves named fragment type conditions. app.ts uses a localhost URL parsing base. tests/graphql.ts adds five focused regressions; tests/git-cli.ts adds the REST/GraphQL/Git merge integration. VERIFICATION.md records the observed results.

## Initial failures and fixes

The first `npm test` run passed 17/18 tests; real Git failed `fetch --deepen=2` with an unexpected response-end packet. The first kit run passed 113/120 checks: all REST, GraphQL and MCP checks passed, while seven Git checks failed (tag peeling, incremental/no-op fetch, shallow deepen/new-tip, and a 100-file push). All three initial practice live/replay exports matched. These failures are retained here to distinguish initial results from the final verification below.

A direct curl smoke run passed 5/5 assertions: MCP legacy initialize (2025-11-25), initialized notification (202), create_repo, create_issue, and REST reading the issue created over MCP. The kit separately exercises modern 2026-07-28 discovery and all six tools.

## Final practice results

The final command used `--save /tmp/forge-finish-final`; its JSON report is `/tmp/forge-finish-final-report.json`. All three practice trials and their replays finished, with no timeouts or nondeterminism. Each trial passed 120/120 conformance checks: Git 30/30, repositories 15/15, issues 15/15, pulls 20/20, REST protocol 5/5, GraphQL 20/20, and MCP 15/15. The scorer's L1 regrade reproduced successfully.

| Practice trial | Feature | Agent | Performance | Total | Works | Replay |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 600 | 200 | 190 | 990 | 1 | identical |
| 1 | 600 | 200 | 176 | 976 | 1 | identical |
| 2 | 600 | 200 | 192 | 992 | 1 | identical |
| Mean | 600 | 200 | 186 | 986 | 1 | 3/3 passed |

Workload p50 values below are milliseconds for the complete operation batch, median of three timed rounds after warmup. Each workload completed on each trial (12/12 workload runs).

| Workload | Operations per round | Trial 0 p50 | Trial 1 p50 | Trial 2 p50 |
| --- | ---: | ---: | ---: | ---: |
| Push 1 KiB change | 200 | 305.050 | 688.211 | 312.231 |
| Concurrent shallow clone | 50 | 104.659 | 107.956 | 97.844 |
| Issue read | 2,000 | 680.600 | 567.195 | 520.943 |
| Issue creation | 200 | 100.116 | 122.683 | 90.347 |

All six live/replay state exports have SHA-256 `a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590`. Model calls: 0; provider spend: 0. The standalone SDK conformance run also passed 120/120 (`/tmp/forge-finish-conformance.json`). Full evidence is in temporary local paths and is not bundled into the source snapshot. The final practice run tested the final runtime/test code; only this verification document was expanded afterward.

The Docker sandbox run and exact Node 22 run could not be performed because Docker and node22 are unavailable on PATH. Process-driver trials, replay, curl and genuine Git CLI supply the local evidence reported here. Final hidden instances, public hosting, submission and transcript gate checks are outside this local completion run.
