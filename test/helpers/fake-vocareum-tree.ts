/**
 * One in-memory Vocareum workspace that serves everything a pull touches:
 *  - the paged listing (`?dir=…&list=true`, 100 names per page, dotfiles hidden);
 *  - the single-file API (`?filename=…`) and the signed download it returns;
 *  - the directory zip job (`?dir=…` start, `?transactionid=…` poll);
 *  - the shared S3 object `u1_p<part>.zip` (ranged GET headers and the body).
 *
 * The client is the REAL `VocareumClient` with this tree as its axios adapter,
 * so the scheduler, retries and deadline handling are all in the path. S3 is a
 * bare `http.get` fake (injected as `options.zip.http`); the walk's own signed
 * downloads go through `axios.get`, which `install()` spies on.
 *
 * Disagreements are injected on purpose, never hidden: `intercept` can fail or
 * replace any request, `onWritten` runs right after a job's object lands (a
 * late write, a deletion between steps, a new file), `s3Intercept` can fail or
 * rewrite any S3 answer, and `writeObject` places a stale or shared object.
 *
 * Clocks: run under fake timers that fake `performance`. S3's clock is
 * `performance.now() + OFFSET`, so its `Date` and `Last-Modified` are what a
 * truthful origin would send.
 */
import { Readable } from 'node:stream';
import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { vi } from 'vitest';
import { VocareumClient } from '../../src/api/client';
import { RequestScheduler } from '../../src/api/scheduler';
import { crc32, toApiDirPath } from '../../src/api/content';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import type { AuthProvider } from '../../src/api/auth/auth-provider';
import type { DirectoryType } from '../../src/types/config';
import { buildZip, type FixtureEntry } from './zip-fixture';

/** S3 epoch = monotonic + OFFSET (a whole second). */
export const OFFSET = 1_800_000_000_000;
export const PAGE_SIZE = 100;
export const COURSE = '215500';
export const ASSIGNMENT = '3001';
export const PART = '6036046';
const FILE_HOST = 'https://files.example/';

export type FakeNode =
  | { kind: 'file'; data: Buffer; listedSize?: number }
  | { kind: 'dir'; children: Map<string, FakeNode>; alias?: boolean }
  /** A symlink. Without a target it is unreadable (dangling, or a managed link);
   *  with one, listing and fetching resolve through the target. Never in a zip. */
  | { kind: 'link'; target?: string };

export type RequestKind = 'list' | 'start' | 'poll' | 'fetch' | 'download' | 's3-range' | 's3-get';

export interface LogEntry {
  t: number;
  kind: RequestKind;
  /** API path (list/start), FileMap-style name (fetch), or the job's dir (poll/s3). */
  path: string;
  page?: number;
}

/** A job the fake ran: its directory, when it started, when its object landed. */
export interface FakeJob {
  tid: string;
  dir: string;
  startedAt: number;
  writtenAt?: number;
  /** Monotonic time the poll answering `success` was answered. */
  successAt?: number;
  etag?: string;
}

interface Version { at: number; etag: string; body: Buffer }

/** What an intercept may do: answer instead, or throw. `undefined` = default handling. */
export type Intercept = (kind: RequestKind, path: string, n: number) => unknown;

export interface FakeTreeOptions {
  architecture?: 'elite' | 'container';
  /** Emit an explicit `dir/` entry for every directory (default true). Empty ones always get one. */
  explicitDirs?: boolean;
  /** Deflate file entries (default false: stored). */
  deflate?: boolean;
  /** Listings return `{path, size}` objects instead of bare names. */
  listedSizes?: boolean;
  /** How long a job takes before its object is written (ms). */
  jobMs?: number;
  /** S3 round trip (ms). */
  s3RoundTrip?: number;
}

function httpError(config: InternalAxiosRequestConfig, status: number, message: string): AxiosError {
  return new AxiosError(message, 'ERR_BAD_REQUEST', config, {}, {
    status, statusText: '', headers: {}, config, data: { error: { message } },
  } as never);
}

function ok(config: InternalAxiosRequestConfig, data: unknown) {
  return { status: 200, statusText: 'OK', headers: {}, config, data };
}

class TokenProvider implements AuthProvider {
  readonly apiBaseUrl = 'https://api.vocareum.com/api/v2';
  async getAuthorizationHeader(): Promise<string> { return 'Token fake'; }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class FakeVocareumTree {
  readonly root: FakeNode & { kind: 'dir' } = { kind: 'dir', children: new Map() };
  readonly log: LogEntry[] = [];
  readonly jobs: FakeJob[] = [];
  readonly versions: Version[] = [];
  readonly opts: Required<FakeTreeOptions>;
  intercept: Intercept = () => undefined;
  /** S3 intercept by request kind and 1-based S3 request number; may throw or return a response. */
  s3Intercept: (kind: 's3-range' | 's3-get', n: number) => unknown = () => undefined;
  /** Runs right after a job's object is written. */
  onWritten: (job: FakeJob) => void = () => undefined;
  private counts = new Map<string, number>();
  private tid = 0;
  private s3n = 0;

  constructor(opts: FakeTreeOptions = {}) {
    this.opts = {
      architecture: opts.architecture ?? 'container',
      explicitDirs: opts.explicitDirs ?? true,
      deflate: opts.deflate ?? false,
      listedSizes: opts.listedSizes ?? false,
      jobMs: opts.jobMs ?? 400,
      s3RoundTrip: opts.s3RoundTrip ?? 100,
    };
  }

  /** API path of a part directory, e.g. `startercode` → `/voc/startercode`. */
  apiPath(directory: DirectoryType): string {
    return toApiDirPath(directory, this.opts.architecture);
  }

  private parentOf(path: string, create: boolean): { dir: FakeNode & { kind: 'dir' }; name: string } {
    const segs = path.split('/').filter((s) => s !== '');
    let node = this.root;
    for (const seg of segs.slice(0, -1)) {
      let next = node.children.get(seg);
      if (next === undefined && create) {
        next = { kind: 'dir', children: new Map() };
        node.children.set(seg, next);
      }
      if (next === undefined || next.kind !== 'dir') { throw new Error(`fake tree: no directory at ${seg} in ${path}`); }
      node = next;
    }
    return { dir: node, name: segs[segs.length - 1] };
  }

  /** Add (or replace) a file at an API path such as `/voc/startercode/a.txt`. */
  file(path: string, data: string | Buffer, listedSize?: number): this {
    const { dir, name } = this.parentOf(path, true);
    dir.children.set(name, { kind: 'file', data: Buffer.from(data), listedSize });
    return this;
  }

  /** Add an (empty) directory; `alias` dirs are listable and zipped but refuse single-file fetches below them. */
  dir(path: string, alias = false): this {
    const { dir, name } = this.parentOf(path, true);
    const existing = dir.children.get(name);
    if (existing?.kind === 'dir') { existing.alias = alias || existing.alias; return this; }
    dir.children.set(name, { kind: 'dir', children: new Map(), alias });
    return this;
  }

  link(path: string, target?: string): this {
    const { dir, name } = this.parentOf(path, true);
    dir.children.set(name, { kind: 'link', target });
    return this;
  }

  remove(path: string): this {
    const { dir, name } = this.parentOf(path, false);
    dir.children.delete(name);
    return this;
  }

  /** Resolve a path, following links. `viaAlias` is true when the path passes through an alias directory. */
  resolve(path: string): { node: FakeNode; viaAlias: boolean } | undefined {
    const segs = path.split('/').filter((s) => s !== '');
    let node: FakeNode = this.root;
    let viaAlias = false;
    for (let i = 0; i < segs.length; i++) {
      if (node.kind !== 'dir') { return undefined; }
      if (node.alias === true) { viaAlias = true; }
      const next = node.children.get(segs[i]);
      if (next === undefined) { return undefined; }
      if (next.kind === 'link') {
        if (next.target === undefined) { return i === segs.length - 1 ? { node: next, viaAlias } : undefined; }
        const rest = segs.slice(i + 1).join('/');
        const inner = this.resolve(rest === '' ? next.target : `${next.target}/${rest}`);
        return inner === undefined ? undefined : { node: inner.node, viaAlias: viaAlias || inner.viaAlias };
      }
      node = next;
    }
    return { node, viaAlias };
  }

  private count(key: string): number {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n;
  }

  /** Zip entries for a directory node, relative to it. Links are left out, as the server does. */
  private zipEntries(node: FakeNode & { kind: 'dir' }, prefix = ''): FixtureEntry[] {
    const out: FixtureEntry[] = [];
    for (const [name, child] of node.children) {
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (child.kind === 'file') {
        out.push({ name: rel, data: child.data, method: this.opts.deflate ? 8 : 0 });
      } else if (child.kind === 'dir') {
        if (this.opts.explicitDirs || child.children.size === 0) { out.push({ name: `${rel}/` }); }
        out.push(...this.zipEntries(child, rel));
      }
    }
    return out;
  }

  /** ETag of a body: equal bytes give equal ETags, as on S3. */
  static etagOf(body: Buffer): string {
    return `"${crc32(body).toString(16)}-${body.length}"`;
  }

  /** Place an object version directly (a stale or shared object), landing at monotonic `at`. */
  writeObject(at: number, body: Buffer): void {
    this.versions.push({ at, etag: FakeVocareumTree.etagOf(body), body });
  }

  /** The zip the server would build for an API directory now. */
  buildZipFor(apiDir: string): Buffer {
    const r = this.resolve(apiDir);
    if (r === undefined || r.node.kind !== 'dir') { throw new Error(`fake tree: no directory ${apiDir}`); }
    return buildZip(this.zipEntries(r.node));
  }

  signedUrl(): string {
    return `https://bucket.s3.amazonaws.com/u1_p${PART}.zip?X-Amz-Credential=CREDSECRET&X-Amz-Signature=SIGSECRET`;
  }

  /** The axios adapter for the client: listing, single-file API and the zip job. */
  adapter = async (config: InternalAxiosRequestConfig): Promise<unknown> => {
    const params = (config.params ?? {}) as Record<string, unknown>;
    const t = performance.now();
    if (typeof params.dir === 'string' && params.list === true) {
      const dir = params.dir;
      const page = typeof params.page === 'number' ? params.page : 0;
      this.log.push({ t, kind: 'list', path: dir, page });
      const hit = this.intercept('list', dir, this.count(`list ${dir}`));
      if (hit instanceof Error) { throw hit; }
      if (hit !== undefined) { return ok(config, hit); }
      const r = this.resolve(dir);
      if (r === undefined || r.node.kind !== 'dir') { throw httpError(config, 400, `${dir} doesn't exist`); }
      const names = [...r.node.children.entries()].filter(([name]) => !name.startsWith('.'));
      const slice = names.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const files = this.opts.listedSizes
        ? slice.map(([name, n]) => ({ path: name, size: n.kind === 'file' ? (n.listedSize ?? n.data.length) : 0 }))
        : slice.map(([name]) => name);
      return ok(config, { files });
    }
    if (typeof params.dir === 'string') {
      const dir = params.dir;
      this.log.push({ t, kind: 'start', path: dir });
      const hit = this.intercept('start', dir, this.count(`start ${dir}`));
      if (hit instanceof Error) { throw hit; }
      if (hit !== undefined) { return ok(config, hit); }
      const r = this.resolve(dir);
      if (r === undefined || r.node.kind !== 'dir') { throw httpError(config, 400, `${dir} doesn't exist`); }
      const job: FakeJob = { tid: String(++this.tid), dir, startedAt: t };
      this.jobs.push(job);
      // An empty top-level directory never finishes (Elite).
      if (r.node.children.size > 0) {
        setTimeout(() => {
          const body = this.buildZipFor(dir);
          job.writtenAt = performance.now();
          job.etag = FakeVocareumTree.etagOf(body);
          this.versions.push({ at: job.writtenAt, etag: job.etag, body });
          this.onWritten(job);
        }, this.opts.jobMs);
      }
      return ok(config, { status: 'success', message: 'Started', transactionid: job.tid, objid: '42' });
    }
    if (params.transactionid !== undefined) {
      const job = this.jobs.find((j) => j.tid === String(params.transactionid));
      this.log.push({ t, kind: 'poll', path: job?.dir ?? '?' });
      const hit = this.intercept('poll', job?.dir ?? '?', this.count(`poll ${job?.tid}`));
      if (hit instanceof Error) { throw hit; }
      if (hit !== undefined) { return ok(config, hit); }
      if (job?.writtenAt === undefined) { return ok(config, { state: 'pending', message: 'Working' }); }
      job.successAt = t;
      return ok(config, { state: 'success', message: this.signedUrl() });
    }
    if (typeof params.filename === 'string') {
      const filename = params.filename;
      this.log.push({ t, kind: 'fetch', path: filename });
      const hit = this.intercept('fetch', filename, this.count(`fetch ${filename}`));
      if (hit instanceof Error) { throw hit; }
      if (hit !== undefined) { return ok(config, hit); }
      const r = this.resolve(this.fileApiPath(filename));
      if (r === undefined || r.node.kind !== 'file' || r.viaAlias) {
        throw httpError(config, 400, `specified file does not exist ${filename}`);
      }
      return ok(config, { status: 'success', files: [{ filename, download_url: `${FILE_HOST}${filename}` }] });
    }
    throw new Error(`fake tree: unexpected request ${JSON.stringify(params)}`);
  };

  /** `startercode/a/b.txt` → `/voc/startercode/a/b.txt`. */
  fileApiPath(filename: string): string {
    const slash = filename.indexOf('/');
    const dir = filename.slice(0, slash) as DirectoryType;
    return `${this.apiPath(dir)}/${filename.slice(slash + 1)}`;
  }

  /** The walk's signed download (`axios.get`). */
  download = async (url: string, config?: { maxContentLength?: number }): Promise<{ data: Buffer }> => {
    const filename = url.slice(FILE_HOST.length);
    this.log.push({ t: performance.now(), kind: 'download', path: filename });
    const hit = this.intercept('download', filename, this.count(`download ${filename}`));
    if (hit instanceof Error) { throw hit; }
    const r = this.resolve(this.fileApiPath(filename));
    if (r === undefined || r.node.kind !== 'file') {
      throw new AxiosError('Request failed with status code 404', 'ERR_BAD_REQUEST', undefined, {}, {
        status: 404, statusText: '', headers: {}, config: {} as never, data: '',
      } as never);
    }
    const max = config?.maxContentLength;
    if (max !== undefined && max >= 0 && r.node.data.length > max) {
      throw new AxiosError(`maxContentLength size of ${max} exceeded`, 'ERR_BAD_RESPONSE');
    }
    return { data: Buffer.from(r.node.data) };
  };

  private currentVersion(t: number): Version | undefined {
    return [...this.versions].filter((v) => v.at <= t).pop();
  }

  /** S3 for the zip path: a bare `get`, answered with the version current mid-round-trip. */
  s3Get = async (_url: string, config: { headers?: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown> => {
    const headers = config.headers ?? {};
    const ranged = headers.Range === 'bytes=0-0';
    const kind = ranged ? 's3-range' : 's3-get';
    const n = ++this.s3n;
    this.log.push({ t: performance.now(), kind, path: '' });
    const signal = config.signal;
    await sleep(this.opts.s3RoundTrip / 2);
    if (signal?.aborted === true) { throw new axios.CanceledError('canceled'); }
    const mid = performance.now();
    const hit = this.s3Intercept(kind, n);
    if (hit instanceof Error) { throw hit; }
    const v = this.currentVersion(mid);
    await sleep(this.opts.s3RoundTrip / 2);
    if (signal?.aborted === true) { throw new axios.CanceledError('canceled'); }
    if (hit !== undefined) { return hit; }
    const date = new Date(mid + OFFSET).toUTCString();
    if (v === undefined) {
      return { status: 404, statusText: '', headers: { date }, data: Readable.from([]) };
    }
    const common = { date, etag: v.etag, 'last-modified': new Date(v.at + OFFSET).toUTCString() };
    const ifMatch = headers['If-Match'];
    if (typeof ifMatch === 'string' && ifMatch !== v.etag) {
      return { status: 412, statusText: '', headers: common, data: Readable.from([]) };
    }
    if (ranged) {
      return {
        status: 206, statusText: '', headers: { ...common, 'content-range': `bytes 0-0/${v.body.length}` },
        data: Readable.from([v.body.subarray(0, 1)]),
      };
    }
    return { status: 200, statusText: '', headers: { ...common, 'content-length': String(v.body.length) }, data: Readable.from([v.body]) };
  };

  /** Requests of one kind, optionally for one path. */
  requests(kind: RequestKind, path?: string): LogEntry[] {
    return this.log.filter((e) => e.kind === kind && (path === undefined || e.path === path));
  }
}

export interface Installed {
  client: VocareumClient;
  events: CollectingEventSink;
  http: AxiosInstance;
  scheduler: RequestScheduler;
}

/**
 * Wire a tree to a real client (adapter), a fake S3 `http`, and a spy on the
 * walk's `axios.get`. Call `vi.restoreAllMocks()` in `afterEach`.
 */
export function install(tree: FakeVocareumTree): Installed {
  const events = new CollectingEventSink();
  const throttle = { maxConcurrency: 4, minIntervalMs: 0, jitter: false };
  const scheduler = new RequestScheduler(throttle);
  const client = new VocareumClient(new TokenProvider(), throttle, scheduler, events);
  (client as unknown as { axios: { defaults: Record<string, unknown> } }).axios.defaults.adapter = tree.adapter;
  vi.spyOn(axios, 'get').mockImplementation(tree.download as never);
  const http = { get: tree.s3Get } as unknown as AxiosInstance;
  return { client, events, http, scheduler };
}

/** The scheduler's slots in use (private field). */
export function activeSlots(scheduler: RequestScheduler): number {
  return (scheduler as unknown as { activeCount: number }).activeCount;
}
