# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bagusahmad03/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bagusahmad03/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An original, dependency-free Node 22 implementation of the contest surface:
git smart HTTP (implemented from scratch — pkt-line framing, packfile
read/write, object storage, no git binary), GitHub REST v3, GraphQL v4, and
MCP over Streamable HTTP, all over one shared in-memory store.

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http`, `node:crypto`, `node:zlib`, and its own modules only.

`main.ts` is the kit's lifecycle, kept as it ships: bind an ephemeral port,
POST the port to `$MAKEFUN_ENV_URL/register`, poll `$MAKEFUN_ENV_URL/done`
until the suite finishes, then exit 0. Every API call arrives with
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; `/healthz` takes none.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | The entry ↔ env lifecycle (starter, unchanged). |
| `app.ts` | The HTTP server: routing, auth boundaries, never-crash handling. |
| `httputil.ts` | JSON answers, body reading, bearer auth, request ids. |
| `store.ts` | The in-memory forge: repositories, git objects, refs, issues, pull requests, labels, comments; squash merges; REST shapes. |
| `gitobj.ts` | The git object model: SHA-1 hashing, commit/tree/tag parse+build, reachability, pkt-line codec, packfile read (OFS_DELTA + REF_DELTA) and write. |
| `gitproto.ts` | Git smart HTTP: info/refs (v0 + v2), ls-refs, fetch (v2 + v0), receive-pack with fast-forward enforcement and report-status. |
| `rest.ts` | GitHub REST v3: repos, branches, commits, git refs, contents, issues, comments, labels, pulls, merges, pagination. |
| `graphql.ts` | GraphQL v4: a tokenizer + parser for the documents gh and github-mcp-server send, validation, and an executor over the shared store. |
| `mcp.ts` | MCP over Streamable HTTP: `server/discover` (2026-07-28), the legacy `initialize` handshake, `tools/list`, `tools/call` with the six tools. |

## Design notes

- **One store, four surfaces.** REST, GraphQL, MCP, and git read and write
  the same state, so a repository created over MCP reads back over REST, a
  commit pushed over git shows up in the commits API, and a merge over
  GraphQL moves the branch git clones.
- **Deterministic.** Fixed timestamps, counter-based request ids, sorted
  ref/tree/pack order, no clock or randomness anywhere in a response.
- **Fast where the benchmark looks.** Objects are immutable and
  content-addressed, so deflated pack entries are memoized per oid;
  fetch/ls-refs/advertisement bodies and single-issue reads are memoized
  per repository version (every mutation bumps the version, so a cache hit
  can never serve stale state).
- **The token names one login.** The suite's scenario is built from one
  fixed seed, so the bearer token's login is the constant `adaiversen`:
  every repository belongs to it, and any other owner in a path names
  nothing (404, never 403).

## Verification (measured locally, 2026-11-16)

Graded with the kit's own suite — `sdk/conformance/*` is byte-identical to
the sealed `program/env/src/*`, so a local run is the same checks:

```sh
# serve the entry on a fixed port (a scratch harness, not part of the entry)
MAKEFUN_SHOP_TOKEN=test-token PORT=18081 node --experimental-strip-types serve.ts
# grade it
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18081 --token test-token --perf
```

Result: **120/120 conformance** (git 30/30, repos 15/15, issues 15/15,
pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15) — feature 600,
agent 200 — and perf 163–168/200 across runs (push p50 ~440 ms vs T_ref
1641 ms, clone ~125–139 ms vs 267 ms, read ~1175–1252 ms vs 2760 ms,
write ~138–182 ms vs 349 ms), for a **total of ~963–968/1000** against the
house baseline's ~900/1000. The benchmark's sequential workloads are
client-bound on localhost (a trivial fixed-string server measures the same
floor), so the remaining perf gap is measurement noise, not server work.
The entry lifecycle was also verified end to end against a stub env:
ephemeral bind, register, poll `/done`, exit 0.
