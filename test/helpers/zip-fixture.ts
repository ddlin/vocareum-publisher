/**
 * Byte-level zip builder for tests. It assembles local headers, the central
 * directory and the end-of-directory records by hand, so malformed structures
 * (understated counts, wrong CRCs, lying sizes, odd attributes) can be built
 * that a zip-writing library would refuse to produce.
 */
import { deflateRawSync } from 'zlib';
import { crc32 } from '../../src/api/content';

export interface FixtureEntry {
  /** Raw entry name, written as UTF-8 (the UTF-8 flag is set when non-ASCII). */
  name: string;
  /** Uncompressed content; empty when omitted. */
  data?: Buffer | string;
  /** Unix mode written into the high 16 bits of the external attributes (host = Unix). */
  unixMode?: number;
  /** DOS attribute byte written into the low bits of the external attributes. */
  dosAttr?: number;
  /** Compression method: 0 stored (default), 8 deflate; anything else writes the data raw. */
  method?: number;
  /** Sets general-purpose bit 0 (traditional encryption); the data is written as is. */
  encrypted?: boolean;
  /** CRC-32 written in place of the real one. */
  crcOverride?: number;
  /** Uncompressed size written in place of the real one. */
  declaredSize?: number;
  /** Shorthand for a Unix symlink entry: mode 0o120777, data is the target. */
  symlink?: boolean;
}

export interface BuildZipOptions {
  /** Records subtracted from the end-of-directory entry count. */
  understateCount?: number;
  /** Bytes subtracted from the end-of-directory central-directory size. */
  understateCdSize?: number;
  /** Write a ZIP64 end record and locator; the classic fields carry the 0xFFFF/0xFFFFFFFF sentinels. */
  zip64?: boolean;
  /** Archive comment. */
  comment?: string;
  /** Every entry uses a data descriptor: local sizes and CRC are 0, the real ones follow the data. */
  dataDescriptor?: boolean;
}

const VERSION = 20;
const VERSION_ZIP64 = 45;

/**
 * Build a zip archive byte by byte.
 *
 * @param entries - the entries, in order
 * @param opts - structural options for malformed or unusual archives
 * @returns the archive bytes
 */
export function buildZip(entries: FixtureEntry[], opts: BuildZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
    const method = e.method ?? 0;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = e.crcOverride ?? crc32(data);
    const size = e.declaredSize ?? data.length;
    const nameBuf = Buffer.from(e.name, 'utf8');
    // eslint-disable-next-line no-control-regex
    const utf8 = /[^\x00-\x7f]/.test(e.name);
    let flags = 0;
    if (utf8) flags |= 0x800;
    if (e.encrypted === true) flags |= 0x1;
    if (opts.dataDescriptor === true) flags |= 0x8;

    const unixMode = e.symlink === true ? 0o120777 : e.unixMode;
    const external = (((unixMode ?? 0) & 0xffff) << 16 | ((e.dosAttr ?? 0) & 0xff)) >>> 0;
    const madeBy = unixMode !== undefined ? (3 << 8) | VERSION : VERSION;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    if (opts.dataDescriptor === true) {
      local.writeUInt32LE(0, 14);
      local.writeUInt32LE(0, 18);
      local.writeUInt32LE(0, 22);
    } else {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const parts = [local, nameBuf, body];
    if (opts.dataDescriptor === true) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(size, 12);
      parts.push(dd);
    }
    const localAll = Buffer.concat(parts);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(madeBy, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(external, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(localAll);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localAll.length;
  }

  const cd = Buffer.concat(centrals);
  const cdOffset = offset;
  const count = entries.length - (opts.understateCount ?? 0);
  const cdSize = cd.length - (opts.understateCdSize ?? 0);
  const comment = Buffer.from(opts.comment ?? '', 'utf8');

  const tail: Buffer[] = [];
  if (opts.zip64 === true) {
    const zip64Offset = cdOffset + cd.length;
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE((3 << 8) | VERSION_ZIP64, 12);
    rec.writeUInt16LE(VERSION_ZIP64, 14);
    rec.writeUInt32LE(0, 16);
    rec.writeUInt32LE(0, 20);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(zip64Offset), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(opts.zip64 === true ? 0xffff : count, 8);
  eocd.writeUInt16LE(opts.zip64 === true ? 0xffff : count, 10);
  eocd.writeUInt32LE(opts.zip64 === true ? 0xffffffff : cdSize, 12);
  eocd.writeUInt32LE(opts.zip64 === true ? 0xffffffff : cdOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  tail.push(eocd, comment);

  return Buffer.concat([...locals, cd, ...tail]);
}
