// The forge's HTTP server: health probe, API root, REST v3 repositories and the
// git smart-HTTP advertisement. Everything is JSON except the git advertisements,
// every reply carries a request id, and every route the suite drives is answered
// from the in-memory store. No clock, no randomness: ids and request ids are
// counters, so two runs that receive the same requests answer byte for byte alike.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RepoStore, VIEWER_LOGIN, repoJson, type RepoRecord } from './store.ts';
import { advertiseV0ReceivePack, advertiseV0UploadPack, advertiseV2UploadPack } from './gitpkt.ts';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const JSON_BODY = 'application/json; charset=utf-8';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';

/** The token the trial hands the process; every API call must present it. */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function bearerOf(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string') return null;
  const prefix = 'Bearer ';
  if (!raw.startsWith(prefix)) return null;
  return raw.slice(prefix.length);
}

/** Split a path into decoded segments; a bad escape reads as an empty route. */
function segmentsOf(path: string): string[] {
  const clean = path.replace(/\/+$/, '') || '/';
  if (clean === '/') return [];
  const out: string[] = [];
  for (const part of clean.slice(1).split('/')) {
    try {
      out.push(decodeURIComponent(part));
    } catch {
      return [];
    }
  }
  return out;
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read a request body, capped; null when it overruns the cap. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | null): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(Buffer.concat(chunks)));
  });
}

/** Parse a JSON body; the string 'bad-json' when it does not parse, null when empty. */
function parseJson(raw: Buffer | null): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (raw === null) return { ok: false, reason: 'body too large' };
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false, reason: 'bad-json' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validRepoName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length >= 1 &&
    name.length <= 100 &&
    /^[A-Za-z0-9._-]+$/.test(name) &&
    name !== '.' &&
    name !== '..'
  );
}

export function createApp(): Server {
  const store = new RepoStore();
  let requestSeq = 0;
  const token = expectedToken();

  const sendJson = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    const text = JSON.stringify(body);
    requestSeq += 1;
    res.writeHead(status, {
      'content-type': JSON_BODY,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': `req-${requestSeq}`,
      ...extra,
    });
    res.end(text);
  };

  const sendEmpty = (res: ServerResponse, status: number): void => {
    requestSeq += 1;
    res.writeHead(status, { 'x-github-request-id': `req-${requestSeq}`, 'content-length': 0 });
    res.end();
  };

  const sendRaw = (res: ServerResponse, status: number, body: Buffer, contentType: string): void => {
    requestSeq += 1;
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': body.length,
      'cache-control': 'no-cache',
      'x-github-request-id': `req-${requestSeq}`,
    });
    res.end(body);
  };

  const notFound = (res: ServerResponse): void => sendJson(res, 404, { message: 'Not Found' });
  const badJson = (res: ServerResponse): void => sendJson(res, 400, { message: 'Invalid JSON body' });
  const unauthorised = (res: ServerResponse): void => sendJson(res, 401, { message: 'Requires authentication' });

  /** Bearer check: exact match against the trial token, or any bearer when unset (local runs). */
  const authed = (req: IncomingMessage): boolean => {
    const bearer = bearerOf(req);
    if (bearer === null || bearer === '') return false;
    if (token === '') return true;
    return bearer === token;
  };

  /** The repository at /repos/{owner}/{name}, or null with the right status already sent. */
  const loadRepo = (res: ServerResponse, owner: string, name: string): RepoRecord | null => {
    if (owner !== VIEWER_LOGIN) {
      notFound(res);
      return null;
    }
    const rec = store.get(name);
    if (rec === undefined) {
      notFound(res);
      return null;
    }
    return rec;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      let path = '/';
      try {
        path = new URL(req.url ?? '/', 'http://entry').pathname;
      } catch {
        path = '/';
      }
      const seg = segmentsOf(path);

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        sendJson(
          res,
          200,
          { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
          { 'x-oauth-scopes': 'repo, read:org' },
        );
        return;
      }

      // Everything under /api/v3 past the root, and every git path, needs the token.
      if (seg[0] === 'api' && seg[1] === 'v3') {
        if (!authed(req)) {
          unauthorised(res);
          return;
        }
        if (method === 'GET' && seg.length === 3 && seg[2] === 'meta') {
          sendJson(res, 200, { installed_version: '1.0.0' });
          return;
        }
        if (seg.length >= 3 && seg[2] === 'user' && seg[3] === 'repos') {
          if (seg.length !== 4) {
            notFound(res);
            return;
          }
          if (method === 'POST') {
            const parsed = parseJson(await readBody(req));
            if (!parsed.ok) {
              badJson(res);
              return;
            }
            const body = parsed.value;
            if (!isRecord(body) || !validRepoName(body.name)) {
              sendJson(res, 422, { message: 'Invalid repository name' });
              return;
            }
            if (
              (body.description !== undefined && body.description !== null && typeof body.description !== 'string') ||
              (body.default_branch !== undefined && typeof body.default_branch !== 'string') ||
              (body.private !== undefined && typeof body.private !== 'boolean')
            ) {
              sendJson(res, 422, { message: 'Invalid repository field' });
              return;
            }
            const isPrivate = body.private === true;
            const description = typeof body.description === 'string' ? body.description : null;
            const defaultBranch =
              typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : 'main';
            const rec = store.create({ name: body.name, isPrivate, description, defaultBranch });
            if (rec === null) {
              sendJson(res, 422, { message: 'Repository already exists' });
              return;
            }
            sendJson(res, 201, repoJson(rec, originOf(req)));
            return;
          }
          if (method === 'GET') {
            const query = queryOf(req);
            const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
            const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
            const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
            const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
            const all = store.list();
            const start = (page - 1) * perPage;
            const slice = all.slice(start, start + perPage);
            const extra: Record<string, string> = {};
            if (start + perPage < all.length) {
              const origin = originOf(req);
              const next = `${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
              const lastPage = Math.ceil(all.length / perPage);
              const last = `${origin}/api/v3/user/repos?per_page=${perPage}&page=${lastPage}`;
              extra.link = `<${next}>; rel="next", <${last}>; rel="last"`;
            }
            sendJson(res, 200, slice.map((rec) => repoJson(rec, originOf(req))), extra);
            return;
          }
          notFound(res);
          return;
        }
        if (seg.length >= 4 && seg[2] === 'repos') {
          const owner = seg[3] ?? '';
          const name = seg[4] ?? '';
          if (seg.length === 5) {
            if (method === 'GET') {
              const rec = loadRepo(res, owner, name);
              if (rec === null) return;
              sendJson(res, 200, repoJson(rec, originOf(req)));
              return;
            }
            if (method === 'PATCH') {
              const parsed = parseJson(await readBody(req));
              if (!parsed.ok) {
                badJson(res);
                return;
              }
              const body = parsed.value;
              if (!isRecord(body)) {
                badJson(res);
                return;
              }
              if (
                (body.description !== undefined && body.description !== null && typeof body.description !== 'string') ||
                (body.default_branch !== undefined && typeof body.default_branch !== 'string') ||
                (body.private !== undefined && typeof body.private !== 'boolean')
              ) {
                sendJson(res, 422, { message: 'Invalid repository field' });
                return;
              }
              const rec = loadRepo(res, owner, name);
              if (rec === null) return;
              const updated = store.patch(name, {
                description:
                  body.description === undefined ? undefined : (body.description as string | null),
                defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : undefined,
                isPrivate: typeof body.private === 'boolean' ? body.private : undefined,
              });
              if (updated === undefined) {
                notFound(res);
                return;
              }
              sendJson(res, 200, repoJson(updated, originOf(req)));
              return;
            }
            if (method === 'DELETE') {
              const rec = loadRepo(res, owner, name);
              if (rec === null) return;
              store.remove(name);
              sendEmpty(res, 204);
              return;
            }
            notFound(res);
            return;
          }
          notFound(res);
          return;
        }
        notFound(res);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/info/refs?service=git-upload-pack (or receive-pack).
      if (seg.length === 4 && seg[1].endsWith('.git') && seg[2] === 'info' && seg[3] === 'refs') {
        if (method !== 'GET') {
          notFound(res);
          return;
        }
        if (!authed(req)) {
          unauthorised(res);
          return;
        }
        const owner = seg[0] ?? '';
        const repoName = seg[1].slice(0, -'.git'.length);
        const rec = loadRepo(res, owner, repoName);
        if (rec === null) return;
        const service = queryOf(req).get('service') ?? '';
        if (service === 'git-upload-pack') {
          const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          sendRaw(res, 200, v2 ? advertiseV2UploadPack() : advertiseV0UploadPack(), UPLOAD_AD);
          return;
        }
        if (service === 'git-receive-pack') {
          sendRaw(res, 200, advertiseV0ReceivePack(), RECEIVE_AD);
          return;
        }
        sendJson(res, 400, { message: 'Unknown service' });
        return;
      }

      notFound(res);
    })().catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // The socket is gone; nothing left to answer.
      }
    });
  });

  return server;
}
