// Git wire protocol: pkt-line decoding, side-band framing, and the request and
// response shapes of protocol v2 (ls-refs, fetch), protocol v0 (fetch) and
// receive-pack (push). Every function here is pure bytes in, bytes out — the
// HTTP handler in app.ts owns auth, routing and the object store.

import { pktFlush, pktLine, pktLineBytes } from './gitpkt.ts';

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Packet {
  kind: PacketKind;
  payload?: Buffer;
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a complete buffer into packets; throws on a bad header or trailing bytes. */
export function decodePackets(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error(`truncated pkt-line: ${buffer.length - offset} trailing byte(s)`);
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > 65520) throw new Error(`pkt-line length ${length} exceeds 65520`);
    if (offset + length > buffer.length) {
      throw new Error(`truncated pkt-line: ${length} announced, ${buffer.length - offset} available`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** The text lines of the data packets, control packets dropped, trailing '\n' kept. */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push((packet.payload as Buffer).toString('utf8'));
  }
  return lines;
}

/**
 * Frame `data` as side-band-64k: each packet is a pkt-line whose payload is one
 * band byte plus up to 65515 data bytes, then a flush. Band 1 is pack data.
 */
export function sideband(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const MAX_DATA = 65520 - 4 - 1;
  for (let offset = 0; offset < data.length; offset += MAX_DATA) {
    const chunk = data.subarray(offset, Math.min(offset + MAX_DATA, data.length));
    parts.push(pktLineBytes(Buffer.concat([Buffer.from([band]), chunk])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export interface V2Request {
  command: string;
  args: string[];
}

/** Parse a protocol v2 request: `command=X`, a delimiter, then argument lines, then a flush. */
export function parseV2Request(body: Buffer): V2Request {
  const packets = decodePackets(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = (packet.payload as Buffer).toString('utf8');
    if (!seenDelim) {
      if (command === '') {
        // Real git sends the fetch command line without a trailing newline
        // (ls-refs carries one); accept both shapes.
        const match = /^command=([a-z-]+)\n?$/.exec(line);
        if (match === null) throw new Error(`bad v2 command line ${JSON.stringify(line.slice(0, 40))}`);
        command = match[1] as string;
      }
      // Later pre-delim lines are parameters (agent, object-format); they carry no command.
    } else {
      args.push(line);
    }
  }
  if (command === '') throw new Error('v2 request has no command line');
  return { command, args };
}

export interface V0FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
  deepenSince?: number;
  deepenNot: string[];
  capabilities: string[];
}

/**
 * Parse a protocol v0 fetch request: wants (the first carrying capabilities
 * after a space) plus shallow/deepen lines, a flush, then haves and done,
 * then a flush. A single section (no flush between wants and haves) is a v2
 * shape and is rejected, the way the suite's client warns about it.
 */
export function parseV0Fetch(body: Buffer): V0FetchRequest {
  const packets = decodePackets(body);
  const request: V0FetchRequest = {
    wants: [],
    haves: [],
    shallow: [],
    deepenNot: [],
    capabilities: [],
  };
  let section = 0;
  let sawFlushBetween = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      if (section === 0) sawFlushBetween = true;
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = (packet.payload as Buffer).toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        if (space < 0) {
          request.wants.push(rest);
        } else {
          request.wants.push(rest.slice(0, space));
          if (request.capabilities.length === 0) {
            request.capabilities = rest.slice(space + 1).split(' ').filter(Boolean);
          }
        }
      } else if (line.startsWith('shallow ')) {
        request.shallow.push(line.slice(8));
      } else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7), 10);
        if (Number.isFinite(n)) request.deepen = n;
      } else if (line.startsWith('deepen-since ')) {
        const n = Number.parseInt(line.slice(13), 10);
        if (Number.isFinite(n)) request.deepenSince = n;
      } else if (line.startsWith('deepen-not ')) {
        request.deepenNot.push(line.slice(11));
      } else {
        throw new Error(`unexpected v0 fetch line ${JSON.stringify(line.slice(0, 40))}`);
      }
    } else {
      if (line.startsWith('have ')) {
        request.haves.push(line.slice(5));
      } else if (line === 'done') {
        // Negotiation is over; nothing more to read.
      } else {
        throw new Error(`unexpected v0 fetch line ${JSON.stringify(line.slice(0, 40))}`);
      }
    }
  }
  if (!sawFlushBetween) throw new Error("v0 fetch needs a flush between the want section and the have section");
  if (request.wants.length === 0) throw new Error('v0 fetch has no want lines');
  return request;
}

export interface ReceivePackCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface ReceivePackRequest {
  commands: ReceivePackCommand[];
  capabilities: string[];
  /** The raw packfile bytes after the flush; empty when the push carries no pack (delete-only). */
  pack: Buffer;
}

/**
 * Parse a receive-pack request: one `<old> <new> <ref>` line per command (the
 * first carrying capabilities after a NUL), a flush, then the packfile bytes
 * verbatim. The pack is NOT parsed here — the caller validates it first and
 * only then applies the ref updates.
 */
export function parseReceivePack(body: Buffer): ReceivePackRequest {
  // The command list is pkt-line framed; the pack that follows is raw. Find the
  // first flush packet, then take everything after it as the pack.
  let offset = 0;
  const lines: string[] = [];
  let foundFlush = false;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      foundFlush = true;
      break;
    }
    if (length === 1 || length === 2) throw new Error('unexpected control packet in the receive-pack command list');
    if (length > 65520) throw new Error(`pkt-line length ${length} exceeds 65520`);
    if (offset + length > body.length) throw new Error('truncated pkt-line in the receive-pack command list');
    lines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  if (!foundFlush) throw new Error('receive-pack request has no flush after the command list');
  const commands: ReceivePackCommand[] = [];
  let capabilities: string[] = [];
  lines.forEach((line, index) => {
    const text = line.replace(/\n$/, '');
    let caps = '';
    let body2 = text;
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      body2 = text.slice(0, nul);
      caps = text.slice(nul + 1);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(body2);
    if (match === null) throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
    if (index === 0 && caps !== '') capabilities = caps.split(' ').filter(Boolean);
    commands.push({
      oldOid: match[1] as string,
      newOid: match[2] as string,
      ref: match[3] as string,
    });
  });
  if (commands.length === 0) throw new Error('receive-pack request has no commands');
  return { commands, capabilities, pack: body.subarray(offset) };
}

export interface PushReportRef {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Build a report-status reply: pkt-lined `unpack ...` and `ok`/`ng` lines,
 * side-banded on band 1 (the client negotiated side-band-64k), then a flush.
 * The inner lines are themselves pkt-lined inside band 1, the way the suite's
 * report parser expects.
 */
export function buildPushReport(
  unpackOk: boolean,
  unpackDetail: string,
  refs: PushReportRef[],
): Buffer {
  const inner: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const ref of refs) {
    inner.push(pktLine(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`));
  }
  inner.push(pktFlush());
  return sideband(Buffer.concat(inner), 1);
}

/** One v2 fetch section: its header line, its content lines, then a flush. */
export function v2Section(header: string, lines: readonly string[]): Buffer {
  const parts: Buffer[] = [pktLine(`${header}\n`)];
  for (const line of lines) parts.push(pktLine(`${line}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** A v2 ls-refs reply: one `<oid> <name>[ symref-target:X][ peeled:Y]` line per ref, then a flush. */
export function buildV2LsRefs(
  refs: ReadonlyArray<{ oid: string; name: string; peeled?: string; symrefTarget?: string }>,
): Buffer {
  const parts: Buffer[] = [];
  for (const ref of refs) {
    let line = `${ref.oid} ${ref.name}`;
    if (ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
