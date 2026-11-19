# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/RizzZzze/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/RizzZzze/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in dependency-free Node.js: git smart HTTP (protocol v0/v2, shallow clones, delta packs), REST v3, GraphQL and MCP over one in-memory store.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=e054nszg&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it does

- Git smart HTTP at `/{owner}/{repo}.git`: upload-pack v2 (ls-refs, fetch, shallow, filter) and v0, receive-pack v0 with fast-forward-only ref updates and per-ref report-status.
- REST v3 under `/api/v3`: repositories, branches, commits, contents, labels, issues and comments, pull requests with real two-parent merge commits.
- GraphQL at `/api/graphql`: viewer, repository, issues and pull requests with connections, pagination and mutations.
- MCP at `/mcp`: JSON-RPC with `server/discover`, `initialize`, and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).
- One process, one in-memory store shared by every protocol; no dependencies, Node.js standard library only.
