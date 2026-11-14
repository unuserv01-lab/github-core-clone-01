# github-core-clone-01

A standalone, GitHub-compatible git forge written in TypeScript on the Node
standard library only (no dependencies, no git binary, no network beyond the
trial env). One process serves four surfaces from a single in-memory store:

| Surface | Routes |
| --- | --- |
| Git smart HTTP | `/{owner}/{repo}.git/info/refs`, `git-upload-pack` (protocol v2 + v0 fallback), `git-receive-pack` (v0) |
| REST v3 | `/api/v3/...` — repositories, branches, commits, contents, labels, issues, comments, pull requests, merges |
| GraphQL v4 | `POST /api/graphql` — viewer, repository, issues, pull requests, mutations, `__type` introspection, batched operations |
| MCP | `POST /mcp` — JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 (`server/discover`) with the legacy `initialize` handshake |

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`,
and polls `$MAKEFUN_ENV_URL/done` until the suite finishes, then exits 0.
Authentication is `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the token names
the viewer (`adaiversen`, recomputed deterministically from the contest's
fixed scenario seed), and repositories under any other owner read as 404.

## Layout

- `main.ts` — the entry <-> env lifecycle.
- `app.ts` — the HTTP server and the REST v3 surface.
- `store.ts` — the in-memory store (repos, issues, pull requests, git objects/refs) and the scenario viewer.
- `gitcore.ts` — pure git primitives: SHA-1 objects, pkt-lines, packfile read/write, reachability.
- `git.ts` — git smart HTTP (advertisements, ls-refs, fetch, push with per-ref report-status).
- `graphql.ts` — a small GraphQL parser/executor for the documents `gh` and `github-mcp-server` send.
- `mcp.ts` — the MCP endpoint and its six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

## Determinism

No wall clock and no unseeded randomness anywhere in request handling:
timestamps derive from `MAKEFUN_TRIAL_NOW` plus a per-mutation sequence
counter, and ids are sequential counters, so a replay of the same requests
leaves the same state.
