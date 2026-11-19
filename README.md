# github-core-clone-01 — a standalone GitHub-compatible forge

One Node process, no dependencies, no UI, no outside service: it serves git
smart HTTP, the REST v3 API, GraphQL v4 and MCP from its own in-memory store.

## Run

```sh
node --experimental-strip-types main.ts
```

The trial runs `node /bot/main.ts` on Node 22. The process binds an ephemeral
port, registers it at `$MAKEFUN_ENV_URL/register`, serves until
`GET $MAKEFUN_ENV_URL/done` answers `{"done": true}`, then exits 0.

## Milestone 1

Lifecycle, `GET /healthz`, the API root, `GET /api/v3/meta`, the in-memory
repository store, REST repository create/read/update/delete with pagination,
and the git `info/refs` advertisement (upload-pack v2 and v0, receive-pack v0)
for empty repositories.

## Layout

- `main.ts` — the entry lifecycle: bind, register, wait for done.
- `app.ts` — the HTTP server and every route.
- `store.ts` — the in-memory repository store.
- `gitpkt.ts` — pkt-line framing and the git advertisements.
