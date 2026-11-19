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
- Milestone 3: git pack POST — receive-pack (push, fast-forward only, per-ref
  report-status) and upload-pack (v2 ls-refs/fetch and v0 fetch, shallow and
  deepen, side-band-64k packs). Packfiles are read with full ofs/ref delta
  resolution and written delta-free; pushed commits are visible to the REST
  layer through the same store. Verified with a real git client (push, clone,
  byte-identical files and shas) as well as the kit suite: git 30/30.
- Milestone 4: labels, issues (+ comments) and pull requests (+ merge) over the
  same store. Merge is a real two-parent merge commit from a three-way file
  merge — clean when only one side changed a path, 405 on a genuine conflict —
  and the base branch advances to it. Kit suite: issues 15/15, pulls 20/20,
  protocol 5/5.
