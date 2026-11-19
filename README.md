# github-core-clone-01

A standalone GitHub-compatible git forge in one Node process: git smart HTTP,
REST v3, GraphQL and MCP over its own in-memory store. No dependencies, no git
binary, no outside service.

## Run

```sh
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must point at the harness environment. The process binds an
ephemeral port, registers it, long-polls `/done`, and exits 0 when told.

## Layout

- `main.ts` — lifecycle: bind, register, poll done, exit.
- `app.ts` — HTTP server and every route.
- `store.ts` — in-memory repo store (repos, objects, refs, commits).
- `gitobj.ts` — git object layer: SHA-1 blobs, trees and commits, deterministic.
- `gitpkt.ts` — pkt-line framing and ref advertisements.

## Status

- Milestone 1: lifecycle, healthz, API root, repo store, REST repos, git info/refs.
- Milestone 2: contents (PUT/GET/DELETE), branches, commits, git refs — one shared
  object store, one commit history per branch, fixed author and timestamp so the
  same requests always mint the same shas.
