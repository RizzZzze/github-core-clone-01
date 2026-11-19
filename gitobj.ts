// Git object layer: content-addressed blobs, trees and commits over SHA-1, built
// from the object format itself. No git binary: the forge hashes, frames and parses
// objects with node:crypto only. Every byte is deterministic — fixed author, fixed
// timestamp — so the same requests always mint the same shas, and a replay sees the
// same state.

import { createHash } from 'node:crypto';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export const FIXED_AUTHOR_NAME = 'adaiversen';
export const FIXED_AUTHOR_EMAIL = 'adaiversen@example.invalid';
/** 2025-01-01T00:00:00Z: the only timestamp any commit carries. */
export const FIXED_TIMESTAMP = 1735689600;
export const FIXED_DATE = '2025-01-01T00:00:00Z';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The stored bytes of an object: "<type> <len>\0<payload>". The sha is over these bytes. */
export function objectBytes(type: ObjectType, payload: Buffer): Buffer {
  const head = Buffer.from(`${type} ${payload.length}\0`, 'ascii');
  return Buffer.concat([head, payload]);
}

export function blobSha(content: Buffer): string {
  return sha1Hex(objectBytes('blob', content));
}

/** One tree entry: mode, name and the hex id. */
export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Build a tree object from entries, sorted the way git sorts them (dirs as name + '/'). */
export function buildTree(entries: TreeEntry[]): { sha: string; bytes: Buffer } {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  const payload = Buffer.concat(parts);
  const bytes = objectBytes('tree', payload);
  return { sha: sha1Hex(bytes), bytes };
}

/** Parse a tree object's payload into entries. */
export function parseTree(payload: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < payload.length) {
    const sp = payload.indexOf(0x20, i);
    const nul = payload.indexOf(0x00, sp);
    if (sp < 0 || nul < 0 || nul + 21 > payload.length) break;
    const mode = payload.subarray(i, sp).toString('ascii');
    const name = payload.subarray(sp + 1, nul).toString('utf8');
    const sha = payload.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

export interface CommitInput {
  treeSha: string;
  parents: string[];
  message: string;
}

/** Build a commit object. The message is stored verbatim — no trailing newline added. */
export function buildCommit(input: CommitInput): { sha: string; bytes: Buffer } {
  const lines = [`tree ${input.treeSha}`];
  for (const p of input.parents) lines.push(`parent ${p}`);
  const who = `${FIXED_AUTHOR_NAME} <${FIXED_AUTHOR_EMAIL}> ${FIXED_TIMESTAMP} +0000`;
  lines.push(`author ${who}`, `committer ${who}`, '', input.message);
  const payload = Buffer.from(lines.join('\n'), 'utf8');
  const bytes = objectBytes('commit', payload);
  return { sha: sha1Hex(bytes), bytes };
}

/** Split stored object bytes back into type + payload. */
export function splitObject(bytes: Buffer): { type: ObjectType; payload: Buffer } | null {
  const nul = bytes.indexOf(0x00);
  if (nul < 0) return null;
  const head = bytes.subarray(0, nul).toString('ascii');
  const [type, len] = head.split(' ');
  if (
    (type !== 'blob' && type !== 'tree' && type !== 'commit' && type !== 'tag') ||
    Number(len) !== bytes.length - nul - 1
  ) {
    return null;
  }
  return { type, payload: bytes.subarray(nul + 1) };
}

/**
 * Build every tree object a file map needs, bottom-up, and return the root tree
 * sha. `put` stores each new tree object. Files are path -> blob sha.
 */
export function buildTreesForFiles(
  files: ReadonlyMap<string, string>,
  put: (sha: string, bytes: Buffer) => void,
): string {
  const build = (dir: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Set<string>();
    for (const [path, blob] of files) {
      if (!path.startsWith(dir)) continue;
      const rest = path.slice(dir.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ mode: '100644', name: rest, sha: blob });
      } else {
        subdirs.add(rest.slice(0, slash));
      }
    }
    for (const sub of [...subdirs].sort()) {
      const subSha = build(`${dir}${sub}/`);
      entries.push({ mode: '40000', name: sub, sha: subSha });
    }
    const { sha, bytes } = buildTree(entries);
    put(sha, bytes);
    return sha;
  };
  return build('');
}

/** Read the full file map (path -> blob sha) of a tree, recursing into subtrees. */
export function filesOfTree(
  rootSha: string,
  get: (sha: string) => Buffer | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (treeSha: string, prefix: string): void => {
    const bytes = get(treeSha);
    if (bytes === undefined) return;
    const split = splitObject(bytes);
    if (split === null || split.type !== 'tree') return;
    for (const e of parseTree(split.payload)) {
      if (e.mode === '40000') walk(e.sha, `${prefix}${e.name}/`);
      else out.set(`${prefix}${e.name}`, e.sha);
    }
  };
  walk(rootSha, '');
  return out;
}

export interface ParsedCommit {
  treeSha: string;
  parents: string[];
  message: string;
}

/** Parse a commit object's payload: tree, parents and the verbatim message. */
export function parseCommit(payload: Buffer): ParsedCommit | null {
  const text = payload.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  if (headEnd < 0) return null;
  const head = text.slice(0, headEnd);
  const tree = /^tree ([0-9a-f]{40})$/m.exec(head);
  if (tree === null) return null;
  const parents: string[] = [];
  for (const m of head.matchAll(/^parent ([0-9a-f]{40})$/gm)) parents.push(m[1] as string);
  return { treeSha: tree[1] as string, parents, message: text.slice(headEnd + 2) };
}
