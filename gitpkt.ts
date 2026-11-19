// Minimal pkt-line framing for git smart HTTP, written from the protocol itself:
// every line is a 4-hex-digit length (including the 4 digits) followed by payload,
// and '0000' is a flush. No git binary, no library: the suite speaks this framing
// in process, so the forge must frame it byte for byte.

const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'forge/1.0';

/** One pkt-line carrying `text` (which must already end with '\n' when the protocol wants one). */
export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const size = payload.length + 4;
  const head = size.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(head, 'ascii'), payload]);
}

/** The flush packet: four ASCII zeroes. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The '# service=...' first line of a v0 advertisement. */
function serviceLine(service: string): Buffer {
  return pktLine(`# service=${service}\n`);
}

/**
 * The v2 capability advertisement: the literal 'version 2' line, then one
 * capability per pkt-line, then a flush. The suite asks for v2 with the
 * Git-Protocol: version=2 header; a v0 answer loses the v2 checks.
 */
export function advertiseV2UploadPack(): Buffer {
  const caps = [
    `agent=${AGENT}`,
    'ls-refs=unborn',
    'fetch=shallow filter',
    'server-option',
    'object-format=sha1',
  ];
  return Buffer.concat([pktLine('version 2\n'), ...caps.map((c) => pktLine(`${c}\n`)), pktFlush()]);
}

/**
 * The v0 upload-pack advertisement of an empty repository: the service line, a
 * flush, then the zero object id carrying the capabilities. An empty repository
 * has no refs to list, so the capabilities ride on the zero id's line.
 * side-band-64k is mandatory: without it the client cannot frame the pack.
 */
export function advertiseV0UploadPack(): Buffer {
  const caps = [
    'multi_ack',
    'thin-pack',
    'side-band',
    'side-band-64k',
    'ofs-delta',
    'shallow',
    'deepen-since',
    'deepen-not',
    'deepen-relative',
    'no-progress',
    'include-tag',
    'multi_ack_detailed',
    'allow-tip-sha1-in-want',
    'allow-reachable-sha1-in-want',
    'no-done',
    'filter',
    `agent=${AGENT}`,
  ].join(' ');
  const capLine = pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  return Buffer.concat([serviceLine('git-upload-pack'), pktFlush(), capLine, pktFlush()]);
}

/**
 * The v0 receive-pack advertisement of an empty repository. The rules require
 * report-status, side-band-64k and delete-refs to be advertised.
 */
export function advertiseV0ReceivePack(): Buffer {
  const caps = [
    'report-status',
    'report-status-v2',
    'delete-refs',
    'side-band-64k',
    'quiet',
    'atomic',
    'ofs-delta',
    `agent=${AGENT}`,
  ].join(' ');
  const capLine = pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  return Buffer.concat([serviceLine('git-receive-pack'), pktFlush(), capLine, pktFlush()]);
}
