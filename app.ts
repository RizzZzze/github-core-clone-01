// The forge's HTTP server: health probe, API root, REST v3 repositories and the
// git smart-HTTP advertisement. Everything is JSON except the git advertisements,
// every reply carries a request id, and every route the suite drives is answered
// from the in-memory store. No clock, no randomness: ids and request ids are
// counters, so two runs that receive the same requests answer byte for byte alike.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RepoStore, VIEWER_LOGIN, repoJson, type CommitMeta, type RepoRecord } from './store.ts';
import { advertiseV0ReceivePack, advertiseV0UploadPack, advertiseV2UploadPack } from './gitpkt.ts';
import {
  FIXED_AUTHOR_EMAIL,
  FIXED_AUTHOR_NAME,
  FIXED_DATE,
  blobSha,
  buildCommit,
  buildTreesForFiles,
  filesOfTree,
  objectBytes,
  parseTree,
  splitObject,
} from './gitobj.ts';

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

  /** The tip commit of a branch, or null when the branch has no commit yet. */
  const branchTip = (rec: RepoRecord, branch: string): string | null => {
    return rec.refs.get(`refs/heads/${branch}`) ?? null;
  };

  /** Resolve a ref-ish (branch name or full commit sha) to a commit sha. */
  const resolveRef = (rec: RepoRecord, ref: string): string | null => {
    const byBranch = rec.refs.get(`refs/heads/${ref}`);
    if (byBranch !== undefined) return byBranch;
    if (/^[0-9a-f]{40}$/.test(ref) && rec.commits.has(ref)) return ref;
    return null;
  };

  /** The commit object GitHub returns for one commit. */
  const commitJson = (rec: RepoRecord, meta: CommitMeta, origin: string): Record<string, unknown> => {
    const fullName = `${rec.ownerLogin}/${rec.name}`;
    return {
      sha: meta.sha,
      node_id: `C_${meta.sha.slice(0, 12)}`,
      url: `${origin}/api/v3/repos/${fullName}/commits/${meta.sha}`,
      html_url: `${origin}/${fullName}/commit/${meta.sha}`,
      author: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
      committer: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
      commit: {
        author: { name: FIXED_AUTHOR_NAME, email: FIXED_AUTHOR_EMAIL, date: FIXED_DATE },
        committer: { name: FIXED_AUTHOR_NAME, email: FIXED_AUTHOR_EMAIL, date: FIXED_DATE },
        message: meta.message,
        tree: { sha: meta.treeSha, url: `${origin}/api/v3/repos/${fullName}/git/trees/${meta.treeSha}` },
        url: `${origin}/api/v3/repos/${fullName}/git/commits/${meta.sha}`,
        comment_count: 0,
        verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
      },
      parents: meta.parents.map((p) => ({
        sha: p,
        url: `${origin}/api/v3/repos/${fullName}/commits/${p}`,
        html_url: `${origin}/${fullName}/commit/${p}`,
      })),
    };
  };

  /** First-parent history from a tip, newest first. */
  const historyOf = (rec: RepoRecord, tip: string): CommitMeta[] => {
    const out: CommitMeta[] = [];
    const seen = new Set<string>();
    let cur: string | null = tip;
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const meta = rec.commits.get(cur);
      if (meta === undefined) break;
      out.push(meta);
      cur = meta.parents[0] ?? null;
    }
    return out;
  };

  /** Mint a commit on `branch` from a file map and move the branch ref to it. */
  const mintCommit = (
    rec: RepoRecord,
    branch: string,
    files: ReadonlyMap<string, string>,
    message: string,
  ): CommitMeta => {
    const put = (sha: string, bytes: Buffer): void => {
      if (!rec.objects.has(sha)) rec.objects.set(sha, bytes);
    };
    const treeSha = buildTreesForFiles(files, put);
    const parent = branchTip(rec, branch);
    const parents = parent === null ? [] : [parent];
    const { sha, bytes } = buildCommit({ treeSha, parents, message });
    put(sha, bytes);
    const meta: CommitMeta = { sha, treeSha, parents, message, seq: rec.commitSeq++ };
    rec.commits.set(sha, meta);
    rec.refs.set(`refs/heads/${branch}`, sha);
    return meta;
  };

  /** The base64 text of a stored blob, or null when the object is missing. */
  const blobText = (rec: RepoRecord, sha: string): string | null => {
    const bytes = rec.objects.get(sha);
    if (bytes === undefined) return null;
    const split = splitObject(bytes);
    if (split === null || split.type !== 'blob') return null;
    return split.payload.toString('base64');
  };

  /** The byte length of a stored blob, or 0 when it is missing. */
  const blobSize = (rec: RepoRecord, sha: string): number => {
    const bytes = rec.objects.get(sha);
    if (bytes === undefined) return 0;
    const split = splitObject(bytes);
    return split === null ? 0 : split.payload.length;
  };

  /** The tree sha of a directory path inside a root tree, or null. */
  const treeShaAt = (rec: RepoRecord, rootSha: string, dir: string): string | null => {
    if (dir === '') return rootSha;
    let cur = rootSha;
    for (const part of dir.split('/')) {
      const bytes = rec.objects.get(cur);
      if (bytes === undefined) return null;
      const split = splitObject(bytes);
      if (split === null || split.type !== 'tree') return null;
      const next = parseTree(split.payload).find((e) => e.mode === '40000' && e.name === part);
      if (next === undefined) return null;
      cur = next.sha;
    }
    return cur;
  };

  /** One contents entry (file or dir) for a directory listing. */
  const dirEntries = (
    rec: RepoRecord,
    files: ReadonlyMap<string, string>,
    dir: string,
    origin: string,
    rootSha: string,
  ): Record<string, unknown>[] => {
    const prefix = dir === '' ? '' : `${dir}/`;
    const fullName = `${rec.ownerLogin}/${rec.name}`;
    const kids = new Map<string, { kind: 'file' | 'dir'; sha: string; size: number }>();
    for (const [path, blob] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        kids.set(rest, { kind: 'file', sha: blob, size: blobSize(rec, blob) });
      } else {
        const sub = rest.slice(0, slash);
        if (!kids.has(sub)) {
          const subSha = treeShaAt(rec, rootSha, `${prefix}${sub}`);
          kids.set(sub, { kind: 'dir', sha: subSha ?? '', size: 0 });
        }
      }
    }
    const out: Record<string, unknown>[] = [];
    for (const name of [...kids.keys()].sort()) {
      const kid = kids.get(name) as { kind: 'file' | 'dir'; sha: string; size: number };
      const entryPath = prefix + name;
      out.push({
        type: kid.kind,
        size: kid.size,
        name,
        path: entryPath,
        sha: kid.sha,
        url: `${origin}/api/v3/repos/${fullName}/contents/${entryPath}`,
        git_url: `${origin}/api/v3/repos/${fullName}/git/trees/${kid.sha}`,
        html_url: `${origin}/${fullName}/blob/HEAD/${entryPath}`,
        download_url: kid.kind === 'file' ? `${origin}/${fullName}/raw/HEAD/${entryPath}` : null,
        _links: { self: `${origin}/api/v3/repos/${fullName}/contents/${entryPath}` },
      });
    }
    return out;
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
          if (seg.length >= 6 && seg[5] === 'contents') {
            const restPath = seg.slice(6).join('/');
            const rec = loadRepo(res, owner, name);
            if (rec === null) return;
            const origin = originOf(req);
            const fullName = `${rec.ownerLogin}/${rec.name}`;
            if (method === 'GET') {
              const refParam = queryOf(req).get('ref') ?? undefined;
              const tip = refParam === undefined ? branchTip(rec, rec.defaultBranch) : resolveRef(rec, refParam);
              if (tip === null) {
                notFound(res);
                return;
              }
              const meta = rec.commits.get(tip);
              if (meta === undefined) {
                notFound(res);
                return;
              }
              const files = filesOfTree(meta.treeSha, (sha) => rec.objects.get(sha));
              const blob = files.get(restPath);
              if (blob !== undefined) {
                const text = blobText(rec, blob);
                if (text === null) {
                  notFound(res);
                  return;
                }
                sendJson(res, 200, {
                  type: 'file',
                  encoding: 'base64',
                  size: blobSize(rec, blob),
                  name: restPath.split('/').pop() ?? restPath,
                  path: restPath,
                  content: text,
                  sha: blob,
                  url: `${origin}/api/v3/repos/${fullName}/contents/${restPath}`,
                  git_url: `${origin}/api/v3/repos/${fullName}/git/blobs/${blob}`,
                  html_url: `${origin}/${fullName}/blob/HEAD/${restPath}`,
                  download_url: `${origin}/${fullName}/raw/HEAD/${restPath}`,
                  _links: { self: `${origin}/api/v3/repos/${fullName}/contents/${restPath}` },
                });
                return;
              }
              const isDir = restPath === '' || [...files.keys()].some((p) => p.startsWith(`${restPath}/`));
              if (!isDir) {
                notFound(res);
                return;
              }
              sendJson(res, 200, dirEntries(rec, files, restPath, origin, meta.treeSha));
              return;
            }
            if (method === 'PUT') {
              if (restPath === '') {
                sendJson(res, 422, { message: 'Invalid path' });
                return;
              }
              const parsed = parseJson(await readBody(req));
              if (!parsed.ok) {
                badJson(res);
                return;
              }
              const body = parsed.value;
              if (
                !isRecord(body) ||
                typeof body.message !== 'string' ||
                body.message === '' ||
                typeof body.content !== 'string' ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content)
              ) {
                sendJson(res, 422, { message: 'Invalid content body' });
                return;
              }
              const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : rec.defaultBranch;
              const tip = branchTip(rec, branch);
              if (tip === null && (rec.refs.size > 0 || branch !== rec.defaultBranch)) {
                sendJson(res, 422, { message: 'Unknown branch' });
                return;
              }
              const files =
                tip === null
                  ? new Map<string, string>()
                  : filesOfTree(rec.commits.get(tip)?.treeSha ?? '', (sha) => rec.objects.get(sha));
              const existing = files.get(restPath);
              if (existing !== undefined) {
                if (typeof body.sha !== 'string') {
                  sendJson(res, 422, { message: 'sha is required to update a file' });
                  return;
                }
                if (body.sha !== existing) {
                  sendJson(res, 409, { message: 'The file has changed since you last retrieved it' });
                  return;
                }
              }
              const bytes = Buffer.from(body.content, 'base64');
              const blob = blobSha(bytes);
              if (!rec.objects.has(blob)) rec.objects.set(blob, objectBytes('blob', bytes));
              files.set(restPath, blob);
              const meta = mintCommit(rec, branch, files, body.message);
              sendJson(res, existing === undefined ? 201 : 200, {
                content: {
                  name: restPath.split('/').pop() ?? restPath,
                  path: restPath,
                  sha: blob,
                  size: bytes.length,
                  url: `${origin}/api/v3/repos/${fullName}/contents/${restPath}`,
                  git_url: `${origin}/api/v3/repos/${fullName}/git/blobs/${blob}`,
                  html_url: `${origin}/${fullName}/blob/HEAD/${restPath}`,
                  download_url: `${origin}/${fullName}/raw/HEAD/${restPath}`,
                  type: 'file',
                  encoding: 'base64',
                  content: bytes.toString('base64'),
                  _links: { self: `${origin}/api/v3/repos/${fullName}/contents/${restPath}` },
                },
                commit: commitJson(rec, meta, origin),
              });
              return;
            }
            if (method === 'DELETE') {
              const parsed = parseJson(await readBody(req));
              if (!parsed.ok) {
                badJson(res);
                return;
              }
              const body = parsed.value;
              if (
                !isRecord(body) ||
                typeof body.message !== 'string' ||
                body.message === '' ||
                typeof body.sha !== 'string'
              ) {
                sendJson(res, 422, { message: 'Invalid delete body' });
                return;
              }
              const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : rec.defaultBranch;
              const tip = branchTip(rec, branch);
              if (tip === null) {
                notFound(res);
                return;
              }
              const meta0 = rec.commits.get(tip);
              if (meta0 === undefined) {
                notFound(res);
                return;
              }
              const files = filesOfTree(meta0.treeSha, (sha) => rec.objects.get(sha));
              const existing = files.get(restPath);
              if (existing === undefined) {
                notFound(res);
                return;
              }
              if (body.sha !== existing) {
                sendJson(res, 409, { message: 'The file has changed since you last retrieved it' });
                return;
              }
              files.delete(restPath);
              const meta = mintCommit(rec, branch, files, body.message);
              sendJson(res, 200, { commit: commitJson(rec, meta, origin), content: null });
              return;
            }
            notFound(res);
            return;
          }
          if (seg.length === 6 && seg[5] === 'branches') {
            if (method !== 'GET') {
              notFound(res);
              return;
            }
            const rec = loadRepo(res, owner, name);
            if (rec === null) return;
            const origin = originOf(req);
            const list = [...rec.refs.keys()]
              .filter((r) => r.startsWith('refs/heads/'))
              .map((r) => r.slice('refs/heads/'.length))
              .sort()
              .map((branch) => ({
                name: branch,
                commit: {
                  sha: rec.refs.get(`refs/heads/${branch}`) as string,
                  url: `${origin}/api/v3/repos/${rec.ownerLogin}/${rec.name}/commits/${rec.refs.get(`refs/heads/${branch}`)}`,
                },
                protected: false,
              }));
            sendJson(res, 200, list);
            return;
          }
          if (seg.length === 7 && seg[5] === 'branches') {
            if (method !== 'GET') {
              notFound(res);
              return;
            }
            const rec = loadRepo(res, owner, name);
            if (rec === null) return;
            const branch = seg[6] ?? '';
            const tip = branchTip(rec, branch);
            if (tip === null) {
              notFound(res);
              return;
            }
            sendJson(res, 200, {
              name: branch,
              commit: { sha: tip, url: `${originOf(req)}/api/v3/repos/${rec.ownerLogin}/${rec.name}/commits/${tip}` },
              protected: false,
            });
            return;
          }
          if (seg.length === 6 && seg[5] === 'commits') {
            if (method !== 'GET') {
              notFound(res);
              return;
            }
            const rec = loadRepo(res, owner, name);
            if (rec === null) return;
            const refParam = queryOf(req).get('sha') ?? undefined;
            const tip = refParam === undefined ? branchTip(rec, rec.defaultBranch) : resolveRef(rec, refParam);
            if (refParam !== undefined && tip === null) {
              notFound(res);
              return;
            }
            if (tip === null) {
              sendJson(res, 200, []);
              return;
            }
            const origin = originOf(req);
            sendJson(res, 200, historyOf(rec, tip).map((m) => commitJson(rec, m, origin)));
            return;
          }
          if (seg.length === 7 && seg[5] === 'commits') {
            if (method !== 'GET') {
              notFound(res);
              return;
            }
            const rec = loadRepo(res, owner, name);
            if (rec === null) return;
            const sha = resolveRef(rec, seg[6] ?? '');
            if (sha === null) {
              notFound(res);
              return;
            }
            const meta = rec.commits.get(sha);
            if (meta === undefined) {
              notFound(res);
              return;
            }
            sendJson(res, 200, commitJson(rec, meta, originOf(req)));
            return;
          }
          if (seg.length >= 7 && seg[5] === 'git' && seg[6] === 'refs') {
            const rec = loadRepo(res, owner, name);
            if (rec === null) return;
            const origin = originOf(req);
            if (method === 'POST' && seg.length === 7) {
              const parsed = parseJson(await readBody(req));
              if (!parsed.ok) {
                badJson(res);
                return;
              }
              const body = parsed.value;
              if (
                !isRecord(body) ||
                typeof body.ref !== 'string' ||
                !/^refs\/[A-Za-z0-9._/-]+$/.test(body.ref) ||
                body.ref.includes('..') ||
                body.ref.includes('//') ||
                typeof body.sha !== 'string' ||
                !/^[0-9a-f]{40}$/.test(body.sha) ||
                !rec.commits.has(body.sha)
              ) {
                sendJson(res, 422, { message: 'Invalid ref' });
                return;
              }
              if (rec.refs.has(body.ref)) {
                sendJson(res, 422, { message: 'Reference already exists' });
                return;
              }
              rec.refs.set(body.ref, body.sha);
              sendJson(res, 201, {
                ref: body.ref,
                object: {
                  sha: body.sha,
                  type: 'commit',
                  url: `${origin}/api/v3/repos/${rec.ownerLogin}/${rec.name}/git/commits/${body.sha}`,
                },
                url: `${origin}/api/v3/repos/${rec.ownerLogin}/${rec.name}/git/refs/${body.ref.slice('refs/'.length)}`,
              });
              return;
            }
            if (method === 'GET' && seg.length === 7) {
              const list = [...rec.refs.entries()]
                .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
                .map(([ref, sha]) => ({
                  ref,
                  object: {
                    sha,
                    type: 'commit',
                    url: `${origin}/api/v3/repos/${rec.ownerLogin}/${rec.name}/git/commits/${sha}`,
                  },
                  url: `${origin}/api/v3/repos/${rec.ownerLogin}/${rec.name}/git/refs/${ref.slice('refs/'.length)}`,
                }));
              sendJson(res, 200, list);
              return;
            }
            if (method === 'GET' && seg.length > 7) {
              const ref = `refs/${seg.slice(7).join('/')}`;
              const sha = rec.refs.get(ref);
              if (sha === undefined) {
                notFound(res);
                return;
              }
              sendJson(res, 200, {
                ref,
                object: {
                  sha,
                  type: 'commit',
                  url: `${origin}/api/v3/repos/${rec.ownerLogin}/${rec.name}/git/commits/${sha}`,
                },
                url: `${origin}/api/v3/repos/${rec.ownerLogin}/${rec.name}/git/refs/${ref.slice('refs/'.length)}`,
              });
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
