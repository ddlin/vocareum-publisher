/**
 * Strict zip reader for the zip pull (spec step 5, "Read the zip into a
 * staging area"). It checks the central directory before inflating anything,
 * then inflates each entry into its own preallocated buffer under a byte
 * counter and our own CRC-32. Nothing here touches the FileMap or budget: the
 * caller gets a staging set or a reason, never an exception.
 */
import * as yauzl from 'yauzl';
import type { Readable } from 'stream';

/** Entries read from one zip, names normalised (no trailing `/`). */
export interface StagingSet {
  files: Map<string, Buffer>;
  dirs: Set<string>;
}

/** Why a zip was not staged. */
export interface ZipReadFailure {
  reason: 'zip_invalid' | 'zip_over_budget' | 'deadline';
}

/** Limits are the *remaining* budget at the time of the read. */
export interface ReadZipOptions {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  signal: AbortSignal;
}

const INVALID: ZipReadFailure = { reason: 'zip_invalid' };
const OVER_BUDGET: ZipReadFailure = { reason: 'zip_over_budget' };
const DEADLINE: ZipReadFailure = { reason: 'deadline' };

const CRC_TABLE: Uint32Array = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {c = (c & 1) !== 0 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;}
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Streaming CRC-32: the same checksum as `crc32` in content.ts, fed in chunks.
 * Table-driven because a staged zip can be hundreds of MiB; the bitwise
 * one-shot version would cost seconds per directory.
 *
 * @param crc - the CRC of the bytes so far (0 before the first chunk)
 * @param chunk - the next bytes
 * @returns the CRC of the bytes so far plus `chunk`
 * @internal Exported for testing
 */
export function crc32Update(crc: number, chunk: Uint8Array): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < chunk.length; i++) {c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);}
  return (c ^ 0xffffffff) >>> 0;
}

interface CentralDirectory {
  count: number;
  size: number;
  offset: number;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_LEN = 22;
const ZIP64_LOCATOR_LEN = 20;
const ZIP64_EOCD_LEN = 56;
const CENTRAL_LEN = 46;

function readU64(buf: Buffer, at: number): number | undefined {
  const v = buf.readBigUInt64LE(at);
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(v);
}

/**
 * Locate the end-of-directory record the way yauzl does (scan back from the
 * end, the first signature wins, its comment must reach the end exactly), so
 * the span we check is the one yauzl then reads. A ZIP64 locator in front of
 * it supplies the count, size and offset, as in yauzl.
 */
function locateCentralDirectory(buf: Buffer): CentralDirectory | undefined {
  if (buf.length < EOCD_LEN) {return undefined;}
  const lowest = Math.max(0, buf.length - (EOCD_LEN + ZIP64_LOCATOR_LEN + 0xffff));
  let at = -1;
  for (let i = buf.length - EOCD_LEN; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { at = i; break; }
  }
  if (at < 0) {return undefined;}
  if (at + EOCD_LEN + buf.readUInt16LE(at + 20) !== buf.length) {return undefined;}

  const disk = buf.readUInt16LE(at + 4);
  const cdDisk = buf.readUInt16LE(at + 6);
  const countOnDisk = buf.readUInt16LE(at + 8);
  const count = buf.readUInt16LE(at + 10);
  const size = buf.readUInt32LE(at + 12);
  const offset = buf.readUInt32LE(at + 16);

  const loc = at - ZIP64_LOCATOR_LEN;
  if (loc >= 0 && buf.readUInt32LE(loc) === ZIP64_LOCATOR_SIG) {
    const rec = readU64(buf, loc + 8);
    if (rec === undefined || rec + ZIP64_EOCD_LEN > loc) {return undefined;}
    if (buf.readUInt32LE(rec) !== ZIP64_EOCD_SIG) {return undefined;}
    const count64 = readU64(buf, rec + 32);
    const countOnDisk64 = readU64(buf, rec + 24);
    const size64 = readU64(buf, rec + 40);
    const offset64 = readU64(buf, rec + 48);
    if (count64 === undefined || countOnDisk64 === undefined || size64 === undefined || offset64 === undefined) {
      return undefined;
    }
    if (buf.readUInt32LE(rec + 16) !== 0 || buf.readUInt32LE(rec + 20) !== 0 || countOnDisk64 !== count64) {
      return undefined;
    }
    // A classic field that is not the sentinel must agree with the ZIP64 one:
    // two different answers would mean two different central directories.
    if ((count !== 0xffff && count !== count64) || (countOnDisk !== 0xffff && countOnDisk !== count64)
      || (size !== 0xffffffff && size !== size64) || (offset !== 0xffffffff && offset !== offset64)) {
      return undefined;
    }
    if (offset64 + size64 > rec) {return undefined;}
    return { count: count64, size: size64, offset: offset64 };
  }

  // A sentinel promises a ZIP64 record; without one the real values are unknown.
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {return undefined;}
  if (disk !== 0 || cdDisk !== 0 || countOnDisk !== count) {return undefined;}
  if (offset + size > at) {return undefined;}
  return { count, size, offset };
}

/**
 * The declared records must fill the declared central directory exactly. A
 * gap means an understated count hid records that yauzl would never read but
 * another unzipper might.
 */
function recordsSpanExactly(buf: Buffer, cd: CentralDirectory): boolean {
  const end = cd.offset + cd.size;
  let pos = cd.offset;
  for (let k = 0; k < cd.count; k++) {
    if (pos + CENTRAL_LEN > end || buf.readUInt32LE(pos) !== CENTRAL_SIG) {return false;}
    pos += CENTRAL_LEN + buf.readUInt16LE(pos + 28) + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
    if (pos > end) {return false;}
  }
  return pos === end;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const DOS_DIRECTORY = 0x10;

/** A normalised name is relative, with no empty, `.` or `..` segment, and no backslash, NUL or drive letter. */
function isSafeName(name: string): boolean {
  if (name === '' || name.includes('\0') || name.includes('\\')) {return false;}
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {return false;}
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

interface Planned {
  entry: yauzl.Entry;
  name: string;
  isDir: boolean;
}

/**
 * Classify every central-directory entry before any inflation: name, type,
 * readability, collisions, then budget. Returns the staged plan or a reason.
 */
function preflightEntries(entries: yauzl.Entry[], opts: ReadZipOptions): Planned[] | ZipReadFailure {
  const planned: Planned[] = [];
  const kinds = new Map<string, boolean>();
  for (const entry of entries) {
    if (entry.isEncrypted()) {return INVALID;}
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {return INVALID;}
    const external = entry.externalFileAttributes >>> 0;
    const type = (external >>> 16) & S_IFMT;
    // Type bits are checked only when present: a DOS-made zip carries none.
    if (type !== 0 && type !== S_IFDIR && type !== S_IFREG) {return INVALID;}
    const raw = entry.fileName;
    const slash = raw.endsWith('/');
    const isDir = slash || type === S_IFDIR || (external & DOS_DIRECTORY) !== 0;
    // A directory marker contradicted by a regular-file mode is ambiguous.
    if (isDir && type === S_IFREG) {return INVALID;}
    if (isDir && entry.uncompressedSize !== 0) {return INVALID;}
    const name = slash ? raw.slice(0, -1) : raw;
    if (!isSafeName(name)) {return INVALID;}
    if (kinds.has(name)) {return INVALID;}
    kinds.set(name, isDir);
    planned.push({ entry, name, isDir });
  }
  // A file may not be the parent of any other entry, in whatever order they came.
  for (const name of kinds.keys()) {
    for (let cut = name.indexOf('/'); cut >= 0; cut = name.indexOf('/', cut + 1)) {
      if (kinds.get(name.slice(0, cut)) === false) {return INVALID;}
    }
  }
  let total = 0;
  for (const p of planned) {
    if (p.isDir) {continue;}
    if (p.entry.uncompressedSize > opts.maxFileBytes) {return OVER_BUDGET;}
    total += p.entry.uncompressedSize;
  }
  if (total > opts.maxTotalBytes) {return OVER_BUDGET;}
  return planned;
}

/**
 * Read a downloaded zip into a staging set, strictly.
 *
 * Preflight (before inflating anything): the records must span exactly the
 * declared central-directory size (ZIP64 values when present); the entry
 * count, each declared size and the declared total must fit the budget;
 * every name must be safe and unique after normalisation; only regular files
 * and directories, stored or deflated, unencrypted. Then each file inflates
 * into a buffer preallocated from its declared size, under a byte counter and
 * our own CRC-32 (yauzl does not check CRCs).
 *
 * A name is a directory if it ends in `/`, its Unix mode is a directory, or
 * its DOS attribute has bit 0x10; the trailing `/` is removed.
 *
 * @param buf - the whole zip
 * @param opts - the remaining budget and the directory's deadline signal
 * @returns the staging set, or `zip_invalid`, `zip_over_budget` or `deadline`.
 *   Never throws.
 */
export async function readZip(buf: Buffer, opts: ReadZipOptions): Promise<StagingSet | ZipReadFailure> {
  if (opts.signal.aborted) {return DEADLINE;}
  const cd = locateCentralDirectory(buf);
  if (cd === undefined) {return INVALID;}
  if (cd.count > opts.maxEntries) {return OVER_BUDGET;}
  if (!recordsSpanExactly(buf, cd)) {return INVALID;}

  return new Promise<StagingSet | ZipReadFailure>((resolve) => {
    let zipfile: yauzl.ZipFile | undefined;
    let current: Readable | undefined;
    let settled = false;

    const finish = (result: StagingSet | ZipReadFailure): void => {
      if (settled) {return;}
      settled = true;
      opts.signal.removeEventListener('abort', onAbort);
      current?.destroy();
      current = undefined;
      zipfile?.close();
      resolve(result);
    };
    const onAbort = (): void => { finish(DEADLINE); };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const inflateAll = (zf: yauzl.ZipFile, planned: Planned[]): void => {
      const files = new Map<string, Buffer>();
      const dirs = new Set<string>();
      const pending: Planned[] = [];
      for (const p of planned) {
        if (p.isDir) {dirs.add(p.name);}
        else {pending.push(p);}
      }
      let totalWritten = 0;

      // Every callback body below is guarded: a synchronous throw inside an
      // event callback (Buffer.allocUnsafe or a copy failing under memory
      // pressure) would otherwise escape readZip as an uncaught exception and
      // crash the pull. A read that cannot complete is simply not used.
      const next = (i: number): void => {
        try {
          if (settled) {return;}
          if (i === pending.length) { finish({ files, dirs }); return; }
          const { entry, name } = pending[i];
          const size = entry.uncompressedSize;
          // Every byte is overwritten before the buffer is kept (written === size).
          const out = Buffer.allocUnsafe(size);
          let written = 0;
          let crc = 0;
          zf.openReadStream(entry, (err, stream) => {
            try {
              if (settled) { stream?.destroy(); return; }
              if (err !== null) { finish(INVALID); return; }
              current = stream;
              stream.on('data', (chunk: Buffer) => {
                try {
                  if (settled) {return;}
                  if (written + chunk.length > size || totalWritten + chunk.length > opts.maxTotalBytes) {
                    finish(INVALID);
                    return;
                  }
                  chunk.copy(out, written);
                  written += chunk.length;
                  totalWritten += chunk.length;
                  crc = crc32Update(crc, chunk);
                } catch {
                  finish(INVALID);
                }
              });
              stream.on('error', () => { finish(INVALID); });
              stream.on('end', () => {
                try {
                  if (settled) {return;}
                  current = undefined;
                  if (written !== size || crc !== entry.crc32) { finish(INVALID); return; }
                  files.set(name, out);
                  next(i + 1);
                } catch {
                  finish(INVALID);
                }
              });
            } catch {
              finish(INVALID);
            }
          });
        } catch {
          finish(INVALID);
        }
      };
      next(0);
    };

    try {
      yauzl.fromBuffer(buf, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (err, zf) => {
        // Guarded like every callback below: yauzl calls this asynchronously,
        // so the outer try/catch cannot see a throw from here.
        try {
          if (settled) { zf?.close(); return; }
          if (err !== null) { finish(INVALID); return; }
          zipfile = zf;
          // yauzl must be reading the same central directory we span-checked.
          if (zf.entryCount !== cd.count) { finish(INVALID); return; }
          const entries: yauzl.Entry[] = [];
          zf.on('error', () => { finish(INVALID); });
          zf.on('entry', (entry: yauzl.Entry) => {
            try {
              if (settled) {return;}
              entries.push(entry);
              zf.readEntry();
            } catch {
              finish(INVALID);
            }
          });
          zf.once('end', () => {
            try {
              if (settled) {return;}
              const planned = preflightEntries(entries, opts);
              if ('reason' in planned) { finish(planned); return; }
              inflateAll(zf, planned);
            } catch {
              finish(INVALID);
            }
          });
          zf.readEntry();
        } catch {
          finish(INVALID);
        }
      });
    } catch {
      // yauzl throws synchronously only for impossible sizes; treat as invalid.
      finish(INVALID);
    }
  });
}
