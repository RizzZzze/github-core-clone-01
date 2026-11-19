// Packfile read/write plus the reachability math an upload-pack needs.
//
// The wire format is git's packfile v2: `PACK`, version, object count, then one
// entry per object (a type/size varint, an optional delta header, a zlib stream),
// then a 20-byte SHA-1 trailer over everything before it. Entries the server
// WRITES never carry deltas — a plain object per entry — but entries it READS
// must resolve ofs-delta and ref-delta chains down to base objects, because a
// real git client deltas what it pushes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync as zlibInflateSync } from 'node:zlib';
import { objectBytes, parseCommit, parseTree, sha1Hex, type ObjectType } from './gitobj.ts';

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface PackObject {
  type: ObjectType;
  data: Buffer;
}

export interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

export type ObjectLookup = (oid: string) => StoredObject | undefined;

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = zlibInflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++] as number;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset++] as number) * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset++] as number) * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Parse a packfile into resolved objects (oid -> type + payload bytes).
 * Deltas resolve against earlier pack entries or, for ref-deltas, `resolveBase`.
 * Throws on any structural fault: short header, bad version, bad trailer,
 * truncated entries, size mismatches, delta cycles, missing delta bases.
 */
export function readPack(pack: Buffer, resolveBase?: ObjectLookup): Map<string, StoredObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: ObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, StoredObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: ObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) {
          throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjectType;
      data = entry.data;
    }
    const oid = sha1Hex(objectBytes(type, data));
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

/** Encode one object's pack header: the type/size varint git's pack format uses. */
function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). The trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<PackObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export interface ReachResult {
  /** Every object reachable from the roots (within the depth limit, if any). */
  objects: Set<string>;
  /** Each commit's distance from the nearest root, 1-based. */
  commitDepth: Map<string, number>;
}

/**
 * The closure of `roots`: commits walk to tree + parents, tags to their target,
 * trees to their entries (gitlinks skipped). With `maxDepth`, a commit at depth
 * `maxDepth` still contributes its tree and blobs, but its parents are cut off.
 * A commit in `stopAt` contributes itself and its tree, but its parents are
 * never walked — that is how a client's shallow boundary is honoured when the
 * closure of its haves is computed: the client holds the boundary commit, not
 * the history behind it. Missing objects are skipped, never fatal — the caller
 * decides what a gap means.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  maxDepth?: number,
  stopAt?: ReadonlySet<string>,
): ReachResult {
  const objects = new Set<string>();
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) if (/^[0-9a-f]{40}$/.test(root)) queue.push({ oid: root, depth: 1 });
  while (queue.length) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (objects.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    objects.add(oid);
    if (object.type === 'commit') {
      commitDepth.set(oid, depth);
      const parsed = parseCommit(object.data);
      if (parsed === null) continue;
      queue.push({ oid: parsed.treeSha, depth });
      const stopped = stopAt !== undefined && stopAt.has(oid);
      if (!stopped && (maxDepth === undefined || depth < maxDepth)) {
        for (const parent of parsed.parents) queue.push({ oid: parent, depth: depth + 1 });
      }
    } else if (object.type === 'tag') {
      const parsed = parseTag(object.data);
      if (parsed !== null) queue.push({ oid: parsed.object, depth });
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push({ oid: entry.sha, depth });
      }
    }
  }
  return { objects, commitDepth };
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  message: string;
}

/** Parse an annotated tag object's payload: object, type, tag and the message. */
export function parseTag(payload: Buffer): ParsedTag | null {
  const text = payload.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  if (headEnd < 0) return null;
  const head = text.slice(0, headEnd);
  const object = /^object ([0-9a-f]{40})$/m.exec(head);
  const type = /^type (\w+)$/m.exec(head);
  const tag = /^tag (.+)$/m.exec(head);
  if (object === null || type === null || tag === null) return null;
  return {
    object: object[1] as string,
    type: type[1] as string,
    tag: tag[1] as string,
    message: text.slice(headEnd + 2),
  };
}

export interface FetchPlan {
  /** Objects to send, sorted by sha so the pack bytes are deterministic. */
  send: Array<{ sha: string; type: ObjectType; data: Buffer }>;
  /** Commits at the depth boundary: the client's new shallow lines. */
  shallow: string[];
  /** Old shallow boundaries whose history is now included. */
  unshallow: string[];
}

/**
 * Plan a fetch: the depth-limited closure of `wants`, minus the full closure
 * of `haves`. `oldShallow` is the client's current shallow boundary list.
 */
export function planFetch(
  lookup: ObjectLookup,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | undefined,
  oldShallow: readonly string[],
): FetchPlan {
  const wantReach = collectReachable(wants, lookup, depth);
  // The haves closure stops at the client's shallow boundaries: the client
  // holds those commits but not the history behind them, so that history must
  // not be subtracted from what the fetch sends.
  const haveReach = collectReachable(haves, lookup, undefined, new Set(oldShallow));
  const send = [...wantReach.objects]
    .filter((oid) => !haveReach.objects.has(oid))
    .sort()
    .map((sha) => {
      const object = lookup(sha) as StoredObject;
      return { sha, type: object.type, data: object.data };
    });
  const shallow =
    depth === undefined
      ? []
      : [...wantReach.commitDepth.entries()]
          .filter(([, d]) => d === depth)
          .map(([sha]) => sha)
          .sort();
  const unshallow = oldShallow.filter((sha) => wantReach.objects.has(sha) && !shallow.includes(sha));
  return { send, shallow, unshallow };
}
