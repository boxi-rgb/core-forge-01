# Core Forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/boxi-rgb/core-forge-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/boxi-rgb/core-forge-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone, GitHub-compatible git forge, built for make.fun's [github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01). One Node process, standard library only, everything served from its own in-memory store:

- **git smart HTTP** — upload-pack protocol v2 (ls-refs, fetch with shallow support) and receive-pack v0 with report-status, for clone, fetch and push
- **REST v3** under `/api/v3` — repositories, contents, branches, commits, labels, issues, comments and pull requests with squash merges
- **GraphQL v4** at `/api/graphql` — the queries and mutations gh and github-mcp-server send, with introspection
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP with create/get repo, issue and pull request tools over the same store

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry: it binds an ephemeral port, registers it with the trial environment in `MAKEFUN_ENV_URL`, and serves until the environment says the trial is done. The forge itself is `app.ts` and the modules beside it; `store.ts` holds the shared in-memory state every surface reads and writes.
