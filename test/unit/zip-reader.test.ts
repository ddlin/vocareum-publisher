import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomBytes } from 'crypto';
import * as yauzl from 'yauzl';
import { Readable } from 'stream';
import { readZip, crc32Update, type StagingSet } from '../../src/api/zip-reader';
import { crc32 } from '../../src/api/content';
import { buildZip, type FixtureEntry } from '../helpers/zip-fixture';

const BIG = { maxEntries: 1000, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 };

function read(buf: Buffer, over: Partial<typeof BIG> = {}, signal: AbortSignal = new AbortController().signal) {
  return readZip(buf, { ...BIG, ...over, signal });
}

function staged(r: Awaited<ReturnType<typeof readZip>>): StagingSet {
  if ('reason' in r) throw new Error(`expected a staging set, got ${r.reason}`);
  return r;
}

function fileNames(s: StagingSet): string[] {
  return [...s.files.keys()].sort();
}

const DIR = 0o040755;
const REG = 0o100644;

/** Read a zip with plain yauzl, independent of readZip, to check the fixture builder. */
function yauzlRead(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) => {
      if (err !== null) { reject(err); return; }
      const out = new Map<string, Buffer>();
      zf.on('error', reject);
      zf.on('end', () => resolve(out));
      zf.on('entry', (entry: yauzl.Entry) => {
        zf.openReadStream(entry, (e2, stream) => {
          if (e2 !== null) { reject(e2); return; }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => { out.set(entry.fileName, Buffer.concat(chunks)); zf.readEntry(); });
        });
      });
      zf.readEntry();
    });
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('buildZip fixture sanity', () => {
  it('stored and deflated entries read back through plain yauzl', async () => {
    const buf = buildZip([
      { name: 'a.txt', data: 'hello' },
      { name: 'b/c.txt', data: 'world '.repeat(100), method: 8 },
    ]);
    const out = await yauzlRead(buf);
    expect(out.get('a.txt')?.toString()).toBe('hello');
    expect(out.get('b/c.txt')?.toString()).toBe('world '.repeat(100));
  });

  it('data descriptors, a comment and ZIP64 records read back through plain yauzl', async () => {
    const buf = buildZip(
      [{ name: 'x', data: 'xyz', method: 8 }, { name: 'y', data: 'stored' }],
      { dataDescriptor: true, comment: 'note', zip64: true },
    );
    const out = await yauzlRead(buf);
    expect(out.get('x')?.toString()).toBe('xyz');
    expect(out.get('y')?.toString()).toBe('stored');
  });

  it('a valid fixture is staged by readZip with its bytes intact', async () => {
    const payload = randomBytes(200_000);
    const s = staged(await read(buildZip([
      { name: 'dir/', unixMode: DIR },
      { name: 'dir/blob.bin', data: payload, method: 8, unixMode: REG },
      { name: 'top.txt', data: 'top' },
    ])));
    expect(fileNames(s)).toEqual(['dir/blob.bin', 'top.txt']);
    expect(s.files.get('dir/blob.bin')?.equals(payload)).toBe(true);
    expect([...s.dirs]).toEqual(['dir']);
  });
});

describe('crc32Update', () => {
  it('chunked updates equal the one-shot crc32 from content.ts', () => {
    const data = randomBytes(100_003);
    let state = 0;
    for (let i = 0; i < data.length; i += 7_919) state = crc32Update(state, data.subarray(i, i + 7_919));
    expect(state).toBe(crc32(data));
    expect(crc32Update(0, Buffer.alloc(0))).toBe(crc32(Buffer.alloc(0)));
  });
});

describe('readZip (S11: adversarial archive rows)', () => {
  it.each([
    ['../x'], ['a/../x'], ['/abs'], ['a\\b'], ['C:x'], ['a\u0000b'], ['a//b'], ['./a'], ['a/./b'], ['a//'], [''],
  ])('S11: bad entry name %j rejects the whole zip', async (name) => {
    const r = await read(buildZip([{ name: 'ok.txt', data: 'ok' }, { name, data: 'x' }]));
    expect(r).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: literal %2e%2e, Unicode and space-containing names are stored literally', async () => {
    const s = staged(await read(buildZip([
      { name: '%2e%2e/x', data: '1' },
      { name: 'café/日本.txt', data: '2' },
      { name: 'my dir/a file.txt', data: '3' },
    ])));
    expect(fileNames(s)).toEqual(['%2e%2e/x', 'café/日本.txt', 'my dir/a file.txt'].sort());
  });

  it('S11: public/ with children is one directory public (no trailing slash)', async () => {
    const s = staged(await read(buildZip([
      { name: 'public/', unixMode: DIR },
      { name: 'public/a.txt', data: 'a' },
      { name: 'public/b.txt', data: 'b' },
    ])));
    expect([...s.dirs]).toEqual(['public']);
    expect(fileNames(s)).toEqual(['public/a.txt', 'public/b.txt']);
  });

  it('S11: a lone empty public/ is staged as directory public', async () => {
    const s = staged(await read(buildZip([{ name: 'public/' }])));
    expect([...s.dirs]).toEqual(['public']);
    expect(s.files.size).toBe(0);
  });

  it('S11: only a/b/ stages directory a/b (the implied a is added by the filter, Task 7)', async () => {
    const s = staged(await read(buildZip([{ name: 'a/b/' }])));
    expect([...s.dirs]).toEqual(['a/b']);
    expect(s.files.size).toBe(0);
  });

  it('S11: directory Unix mode without a trailing slash is a directory', async () => {
    const s = staged(await read(buildZip([
      { name: 'public', unixMode: DIR },
      { name: 'public/x', data: 'x', unixMode: REG },
    ])));
    expect([...s.dirs]).toEqual(['public']);
    expect(fileNames(s)).toEqual(['public/x']);
  });

  it('S11: the DOS directory bit without a trailing slash is a directory', async () => {
    const s = staged(await read(buildZip([
      { name: 'public', dosAttr: 0x10 },
      { name: 'public/x', data: 'x', dosAttr: 0x20 },
    ])));
    expect([...s.dirs]).toEqual(['public']);
    expect(fileNames(s)).toEqual(['public/x']);
  });

  it('S11: a trailing slash with a regular-file Unix mode rejects the zip', async () => {
    const r = await read(buildZip([{ name: 'public/', unixMode: REG }]));
    expect(r).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: the DOS directory bit with a regular-file Unix mode rejects the zip', async () => {
    const r = await read(buildZip([{ name: 'public', unixMode: REG, dosAttr: 0x10 }]));
    expect(r).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: a directory entry carrying data rejects the zip', async () => {
    const r = await read(buildZip([{ name: 'public/', data: 'surprise' }]));
    expect(r).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: a 12-segment file and foo/.hidden/file are staged verbatim (depth and dotfile filtering is step 6)', async () => {
    const deep = Array.from({ length: 12 }, (_, i) => `s${i}`).join('/');
    const s = staged(await read(buildZip([{ name: deep, data: 'd' }, { name: 'foo/.hidden/file', data: 'h' }])));
    expect(fileNames(s)).toEqual([deep, 'foo/.hidden/file'].sort());
    expect(s.dirs.size).toBe(0);
  });

  it('S11: a childless directory entry is staged for the step-7 handoff', async () => {
    const s = staged(await read(buildZip([{ name: 'empty/', unixMode: DIR }, { name: 'f', data: 'f' }])));
    expect([...s.dirs]).toEqual(['empty']);
    expect(fileNames(s)).toEqual(['f']);
  });

  it.each([
    ['symlink', { name: 'link', data: 'target', symlink: true }],
    ['FIFO', { name: 'fifo', unixMode: 0o010644 }],
    ['character device', { name: 'chr', unixMode: 0o020644 }],
    ['block device', { name: 'blk', unixMode: 0o060644 }],
    ['socket', { name: 'sock', unixMode: 0o140644 }],
  ] as Array<[string, FixtureEntry]>)('S11: a %s entry rejects the whole zip', async (_label, entry) => {
    const r = await read(buildZip([{ name: 'ok', data: 'ok' }, entry]));
    expect(r).toEqual({ reason: 'zip_invalid' });
  });

  it.each([
    ['the same file twice', [{ name: 'a', data: '1' }, { name: 'a', data: '2' }]],
    ['a/ and a directory-mode a (same after normalisation)', [{ name: 'a/' }, { name: 'a', unixMode: DIR }]],
    ['a as both file and directory', [{ name: 'a', data: '1' }, { name: 'a/' }]],
    ['file a plus a/b', [{ name: 'a', data: '1' }, { name: 'a/b', data: '2' }]],
    ['a/b before file a', [{ name: 'a/b', data: '2' }, { name: 'a', data: '1' }]],
    ['file a/b plus deeper a/b/c', [{ name: 'a/b', data: '1' }, { name: 'a/b/c', data: '2' }]],
  ] as Array<[string, FixtureEntry[]]>)('S11: collision (%s) rejects the whole zip', async (_label, entries) => {
    expect(await read(buildZip(entries))).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: a declared size over maxFileBytes is over budget at preflight, before inflating', async () => {
    // The data is not a valid deflate stream: reaching inflation would give zip_invalid.
    const buf = buildZip([{ name: 'big', data: Buffer.from([0xff, 0xff, 0xff]), method: 8, declaredSize: 5000 }]);
    expect(await read(buf, { maxFileBytes: 4096 })).toEqual({ reason: 'zip_over_budget' });
  });

  it('S11: a declared total over maxTotalBytes is over budget at preflight, before inflating', async () => {
    const buf = buildZip([
      { name: 'a', data: 'x'.repeat(600), method: 8 },
      { name: 'b', data: Buffer.from([0xff, 0xff]), method: 8, declaredSize: 600 },
    ]);
    expect(await read(buf, { maxTotalBytes: 1000 })).toEqual({ reason: 'zip_over_budget' });
  });

  it('S11: a real entry count (directories included) over maxEntries is over budget', async () => {
    const buf = buildZip([{ name: 'd/' }, { name: 'd/a', data: 'a' }, { name: 'd/b', data: 'b' }]);
    expect(await read(buf, { maxEntries: 2 })).toEqual({ reason: 'zip_over_budget' });
    expect('reason' in (await read(buf, { maxEntries: 3 }))).toBe(false);
  });

  it('S11: an understated count with the size correct leaves a gap and is rejected at preflight', async () => {
    const buf = buildZip([{ name: 'a', data: 'a' }, { name: 'b', data: 'b' }], { understateCount: 1 });
    expect(await read(buf)).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: an understated size with the count correct is rejected at preflight', async () => {
    const buf = buildZip([{ name: 'a', data: 'a' }, { name: 'b', data: 'b' }], { understateCdSize: 1 });
    expect(await read(buf)).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: count and size both understated: the hidden record is never read', async () => {
    // The central record for 'hidden' is 46 bytes plus its 6-byte name.
    const buf = buildZip([{ name: 'a', data: 'a' }, { name: 'hidden', data: 'h' }], { understateCount: 1, understateCdSize: 52 });
    const s = staged(await read(buf));
    expect(fileNames(s)).toEqual(['a']);
  });

  it('S11: ZIP64 with a 0xFFFFFFFF classic size is accepted and span-checked against the ZIP64 record', async () => {
    const entries: FixtureEntry[] = [{ name: 'a', data: 'a' }, { name: 'b', data: 'bb', method: 8 }];
    const s = staged(await read(buildZip(entries, { zip64: true })));
    expect(fileNames(s)).toEqual(['a', 'b']);
    expect(await read(buildZip(entries, { zip64: true, understateCount: 1 }))).toEqual({ reason: 'zip_invalid' });
    expect(await read(buildZip(entries, { zip64: true, understateCdSize: 1 }))).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: a deflate stream that expands past its declared size is aborted and rejected', async () => {
    const buf = buildZip([{ name: 'bomb', data: Buffer.alloc(1_000_000), method: 8, declaredSize: 1000 }]);
    expect(await read(buf)).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: our own counter aborts an endless entry stream past its declared size (not only yauzl)', async () => {
    // Stand in for an inflater that never stops, so only our counter can end the read.
    let endless: Readable | undefined;
    let produced = 0;
    vi.spyOn(yauzl.ZipFile.prototype, 'openReadStream').mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stream: Readable) => void;
      endless = Readable.from((function* () { for (;;) { produced++; yield Buffer.alloc(1024); } })());
      cb(null, endless);
    });
    const buf = buildZip([{ name: 'a', data: 'x'.repeat(5000) }]);
    expect(await read(buf)).toEqual({ reason: 'zip_invalid' });
    expect(endless?.destroyed).toBe(true);
    // Aborted on the chunk that crossed 5,000 bytes, not at the total budget.
    expect(produced).toBeLessThan(16);
  });

  it('S11: a deflate stream shorter than its declared size is rejected', async () => {
    const buf = buildZip([{ name: 'short', data: 'abc', method: 8, declaredSize: 10 }]);
    expect(await read(buf)).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: a stored entry whose sizes disagree is rejected', async () => {
    const buf = buildZip([{ name: 's', data: 'abc', declaredSize: 2 }]);
    expect(await read(buf)).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: data descriptor entries are read correctly, sizes and CRC checked', async () => {
    const payload = randomBytes(50_000);
    const s = staged(await read(buildZip(
      [{ name: 'd', data: payload, method: 8 }, { name: 's', data: 'stored' }],
      { dataDescriptor: true },
    )));
    expect(s.files.get('d')?.equals(payload)).toBe(true);
    expect(s.files.get('s')?.toString()).toBe('stored');
    const bad = buildZip([{ name: 'd', data: 'x', method: 8, crcOverride: 1 }], { dataDescriptor: true });
    expect(await read(bad)).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: an archive comment and a well-formed ZIP64 are accepted', async () => {
    const s = staged(await read(buildZip([{ name: 'a', data: 'a' }], { comment: 'built by tests', zip64: true })));
    expect(fileNames(s)).toEqual(['a']);
  });

  it('S11: a malformed ZIP64 record, a truncated zip and non-zip bytes are rejected', async () => {
    const z = buildZip([{ name: 'a', data: 'a' }], { zip64: true });
    const sig = z.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
    const broken = Buffer.from(z);
    broken[sig + 3] = 0x09;
    expect(await read(broken)).toEqual({ reason: 'zip_invalid' });
    expect(await read(z.subarray(0, z.length - 5))).toEqual({ reason: 'zip_invalid' });
    expect(await read(Buffer.from('not a zip at all'))).toEqual({ reason: 'zip_invalid' });
    expect(await read(Buffer.alloc(0))).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: a ZIP64 record that disagrees with the classic fields is rejected', async () => {
    const z = buildZip([{ name: 'a', data: 'a' }, { name: 'b', data: 'b' }], { zip64: true });
    const eocd = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const odd = Buffer.from(z);
    odd.writeUInt16LE(1, eocd + 10); // classic count says 1, ZIP64 says 2
    expect(await read(odd)).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: a classic sentinel with no ZIP64 record is rejected', async () => {
    const z = buildZip([{ name: 'a', data: 'a' }]);
    const eocd = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const odd = Buffer.from(z);
    odd.writeUInt32LE(0xffffffff, eocd + 12);
    expect(await read(odd)).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: a CRC mismatch rejects the whole zip (our own CRC-32)', async () => {
    expect(await read(buildZip([{ name: 'a', data: 'abc', crcOverride: 0x12345678 }]))).toEqual({ reason: 'zip_invalid' });
    expect(await read(buildZip([{ name: 'a', data: 'abc', method: 8, crcOverride: 0x12345678 }]))).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: an encrypted entry rejects the whole zip', async () => {
    expect(await read(buildZip([{ name: 'a', data: 'abc', encrypted: true }]))).toEqual({ reason: 'zip_invalid' });
  });

  it('S11: an unknown compression method rejects the whole zip', async () => {
    expect(await read(buildZip([{ name: 'a', data: 'abc', method: 12 }]))).toEqual({ reason: 'zip_invalid' });
  });
});

describe('readZip deadline', () => {
  it('an already-aborted signal gives deadline', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await read(buildZip([{ name: 'a', data: 'a' }]), {}, ac.signal)).toEqual({ reason: 'deadline' });
  });

  it('abort mid-inflate gives deadline, destroys the entry stream and closes the zip file', async () => {
    const ac = new AbortController();
    let captured: Readable | undefined;
    const original = yauzl.ZipFile.prototype.openReadStream;
    vi.spyOn(yauzl.ZipFile.prototype, 'openReadStream').mockImplementation(function (
      this: yauzl.ZipFile, entry: yauzl.Entry, ...rest: unknown[]
    ) {
      const cb = rest[rest.length - 1] as (err: Error | null, stream: Readable) => void;
      const wrapped = (err: Error | null, stream: Readable): void => {
        if (err === null) {
          captured = stream;
          stream.once('data', () => { ac.abort(); });
        }
        cb(err, stream);
      };
      (original as (e: yauzl.Entry, c: typeof wrapped) => void).call(this, entry, wrapped);
    });
    const close = vi.spyOn(yauzl.ZipFile.prototype, 'close');

    const buf = buildZip([{ name: 'big', data: randomBytes(4_000_000), method: 8 }]);
    expect(await read(buf, {}, ac.signal)).toEqual({ reason: 'deadline' });
    expect(captured?.destroyed).toBe(true);
    expect(close).toHaveBeenCalled();
  });
});

describe('readZip: a synchronous throw inside a stream callback (memory pressure)', () => {
  // Buffer.allocUnsafe or a copy can throw under memory pressure. Inside a yauzl
  // or stream callback that throw would escape readZip as an uncaught exception
  // and crash the pull; it must end the read as zip_invalid instead.
  afterEach(() => { vi.restoreAllMocks(); });

  function failAlloc(size: number): void {
    const real = Buffer.allocUnsafe;
    vi.spyOn(Buffer, 'allocUnsafe').mockImplementation((n: number) => {
      if (n === size) { throw new RangeError('Array buffer allocation failed'); }
      return real.call(Buffer, n);
    });
  }

  it('in the first entry (next, from the central-directory end handler)', async () => {
    failAlloc(12_345);
    const buf = buildZip([{ name: 'a.bin', data: Buffer.alloc(12_345, 1) }]);
    expect(await read(buf)).toEqual({ reason: 'zip_invalid' });
  });

  it('in a later entry (next, from the previous entry\'s end handler)', async () => {
    failAlloc(12_345);
    const buf = buildZip([{ name: 'a.txt', data: 'ok' }, { name: 'b.bin', data: Buffer.alloc(12_345, 2) }]);
    expect(await read(buf)).toEqual({ reason: 'zip_invalid' });
  });

  it('in the data handler', async () => {
    const real = Buffer.prototype.copy;
    vi.spyOn(Buffer.prototype, 'copy').mockImplementation(function (this: Buffer, target: Uint8Array, ...rest: number[]) {
      if (target.length === 12_346) { throw new RangeError('copy failed'); }
      return real.call(this, target, ...rest);
    });
    const buf = buildZip([{ name: 'c.bin', data: Buffer.alloc(12_346, 3) }]);
    expect(await read(buf)).toEqual({ reason: 'zip_invalid' });
  });
});

describe('readZip: a synchronous throw in the yauzl open and entry callbacks', () => {
  // The same guard as the stream callbacks: a throw there would escape readZip
  // as an uncaught exception and leave its promise unsettled.
  afterEach(() => { vi.restoreAllMocks(); });

  function failReadEntry(onCall: number): void {
    const real = yauzl.ZipFile.prototype.readEntry;
    let calls = 0;
    vi.spyOn(yauzl.ZipFile.prototype, 'readEntry').mockImplementation(function (this: yauzl.ZipFile) {
      calls += 1;
      if (calls === onCall) { throw new RangeError('readEntry failed'); }
      return real.call(this);
    });
  }

  it('in the fromBuffer callback body (its first readEntry)', async () => {
    failReadEntry(1);
    const buf = buildZip([{ name: 'a.txt', data: 'a' }, { name: 'b.txt', data: 'b' }]);
    expect(await read(buf)).toEqual({ reason: 'zip_invalid' });
  });

  it('in the entry handler (the readEntry after an entry)', async () => {
    failReadEntry(2);
    const buf = buildZip([{ name: 'a.txt', data: 'a' }, { name: 'b.txt', data: 'b' }]);
    expect(await read(buf)).toEqual({ reason: 'zip_invalid' });
  });
});
