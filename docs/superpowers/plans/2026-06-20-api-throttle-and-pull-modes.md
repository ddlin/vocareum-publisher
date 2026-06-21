# API Throttle & Pull Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a proactive, configurable request scheduler to `VocareumClient` and make `pull`'s expensive content-drift detection opt-in and scopeable, so the tool stops over-querying Vocareum's API servers.

**Architecture:** A new `RequestScheduler` (strict-FIFO queue + concurrency cap + jittered request-start spacing, all injectable for tests) gates the single chokepoint in `VocareumClient.attempt()`. Throttle settings come from a validated `vocareum.throttle` YAML block plus env overrides, resolved at command startup and passed pre-validated into the client constructor. `pull` gains `--content` (opt-in drift), `--assignment`/`--part` (scoping), leaving the separate orphan-import path and its existing `--skip-content` flag unchanged.

**Tech Stack:** TypeScript (Node ≥18), axios, zod, Commander, vitest.

## Global Constraints

- All Vocareum IDs are strings — never numbers.
- New code follows existing patterns; no new runtime dependencies.
- Scheduler governs only requests through `VocareumClient` — NOT the raw S3 `axios.get()` in `content.ts`, NOT OAuth token exchange.
- Throttle bounds (verbatim): `max_concurrency` integer `1..5` (default `1`); `min_interval_ms` integer `0..60000` (default `300`); `jitter` boolean (default `true`).
- Jitter is ±40% of `min_interval_ms`, applied to request-start spacing only — the existing exponential backoff sleep is NOT randomized.
- Env override keys: `VOCAREUM_MAX_CONCURRENCY`, `VOCAREUM_MIN_REQUEST_INTERVAL_MS`, `VOCAREUM_THROTTLE_JITTER`. Resolution order (highest wins): env → `vocareum.throttle` → default. Out-of-range/non-numeric env vars are hard errors (no silent clamp).
- Throttle resolution + validation MUST complete before any client request, in every command.
- `--content` gates content-drift detection only; orphan-import content behavior stays governed solely by `--skip-content`. The two flags are orthogonal.
- Spec: `docs/superpowers/specs/2026-06-20-api-throttle-and-pull-modes-design.md`.
- Tests live in `test/unit/` and `test/integration/`; vitest `globals: true` (describe/it/expect/vi are global but existing files import them explicitly — match that).
- Commit after every task. Branch is `feat/api-throttle-pull-modes`.

---

### Task 1: RequestScheduler

**Files:**
- Create: `src/api/scheduler.ts`
- Test: `test/unit/scheduler.test.ts`

**Interfaces:**
- Produces:
  - `interface SchedulerOptions { maxConcurrency: number; minIntervalMs: number; jitter: boolean; now?: () => number; setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; random?: () => number; }`
  - `class RequestScheduler { constructor(opts: SchedulerOptions); schedule<T>(task: () => Promise<T>): Promise<T>; }`
  - Note: no `clearTimeoutFn` — timers are one-shot and self-clearing (`pendingTimer` reset inside the callback), and this repo's `noUnusedLocals: true` would reject an unread injected field.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/scheduler.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RequestScheduler } from '../../src/api/scheduler';

afterEach(() => { vi.useRealTimers(); });

describe('RequestScheduler', () => {
  it('runs the first task immediately and spaces the next by minIntervalMs (concurrency 1)', async () => {
    vi.useFakeTimers();
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 1000, jitter: false });
    const order: number[] = [];
    const p1 = s.schedule(async () => { order.push(1); });
    const p2 = s.schedule(async () => { order.push(2); });
    await p1;
    expect(order).toEqual([1]);
    await vi.advanceTimersByTimeAsync(999);
    expect(order).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it('runs queued tasks in strict FIFO order (concurrency 1)', async () => {
    vi.useFakeTimers();
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 100, jitter: false });
    const order: string[] = [];
    const ps = ['A', 'B', 'C'].map((n) => s.schedule(async () => { order.push(n); }));
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(ps);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('fires a spacing-blocked task via timer even with nothing else in flight', async () => {
    vi.useFakeTimers();
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 500, jitter: false });
    const order: string[] = [];
    await s.schedule(async () => { order.push('first'); });
    const p = s.schedule(async () => { order.push('second'); });
    expect(order).toEqual(['first']);
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(order).toEqual(['first', 'second']);
  });

  it('does not delay when minIntervalMs is 0', async () => {
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 0, jitter: false });
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => s.schedule(async () => { order.push(n); })));
    expect(order).toEqual([1, 2, 3]);
  });

  it('caps in-flight tasks at maxConcurrency', async () => {
    vi.useFakeTimers();
    const s = new RequestScheduler({ maxConcurrency: 3, minIntervalMs: 0, jitter: false });
    let started = 0;
    const release: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      void s.schedule(() => new Promise<void>((res) => { started++; release.push(res); }));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(3);
    release[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(4);
    release.forEach((r) => r());
  });

  it('applies jitter at the low edge (random=0 -> -40%)', async () => {
    vi.useFakeTimers();
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 1000, jitter: true, random: () => 0 });
    const order: string[] = [];
    await s.schedule(async () => { order.push('a'); });
    const p = s.schedule(async () => { order.push('b'); });
    await vi.advanceTimersByTimeAsync(599);
    expect(order).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(order).toEqual(['a', 'b']);
  });

  it('applies jitter at the high edge (random=1 -> +40%)', async () => {
    vi.useFakeTimers();
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 1000, jitter: true, random: () => 1 });
    const order: string[] = [];
    await s.schedule(async () => { order.push('a'); });
    const p = s.schedule(async () => { order.push('b'); });
    await vi.advanceTimersByTimeAsync(1399);
    expect(order).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(order).toEqual(['a', 'b']);
  });

  it('releases the slot even when a task throws', async () => {
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 0, jitter: false });
    await expect(s.schedule(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const ran = await s.schedule(async () => 'ok');
    expect(ran).toBe('ok');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/scheduler.test.ts`
Expected: FAIL — "Cannot find module '../../src/api/scheduler'".

- [ ] **Step 3: Implement the scheduler**

Create `src/api/scheduler.ts`:

```typescript
/**
 * RequestScheduler — strict-FIFO request gate with a concurrency cap and
 * jittered minimum spacing between request starts. Clock, timer, and RNG are
 * injectable so spacing is deterministic in tests.
 *
 * Governs only requests routed through VocareumClient.
 */
export interface SchedulerOptions {
  maxConcurrency: number;
  minIntervalMs: number;
  jitter: boolean;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  random?: () => number;
}

export class RequestScheduler {
  private readonly maxConcurrency: number;
  private readonly minIntervalMs: number;
  private readonly jitter: boolean;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly random: () => number;

  private readonly queue: Array<() => void> = [];
  private activeCount = 0;
  private nextAllowedStart = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: SchedulerOptions) {
    this.maxConcurrency = opts.maxConcurrency;
    this.minIntervalMs = opts.minIntervalMs;
    this.jitter = opts.jitter;
    this.now = opts.now ?? (() => Date.now());
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.random = opts.random ?? (() => Math.random());
  }

  /** Acquire a slot, run the task, release the slot (even on throw). */
  public async schedule<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** Always enqueues (never inline-starts) so ordering is strictly FIFO. */
  private acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }

  private release(): void {
    this.activeCount -= 1;
    this.pump();
  }

  /** Start eligible work from the head of the queue; schedule a timer when the
   *  head is concurrency-eligible but spacing-blocked. */
  private pump(): void {
    while (this.queue.length > 0 && this.activeCount < this.maxConcurrency) {
      const current = this.now();
      if (current < this.nextAllowedStart) {
        this.scheduleTimer(this.nextAllowedStart - current);
        return;
      }
      const start = this.queue.shift()!;
      this.activeCount += 1;
      this.nextAllowedStart = current + this.spacing();
      start();
    }
  }

  private scheduleTimer(delay: number): void {
    if (this.pendingTimer !== undefined) { return; }
    this.pendingTimer = this.setTimeoutFn(() => {
      this.pendingTimer = undefined;
      this.pump();
    }, delay);
  }

  private spacing(): number {
    if (this.minIntervalMs <= 0) { return 0; }
    if (!this.jitter) { return this.minIntervalMs; }
    const offset = (this.random() * 2 - 1) * 0.4 * this.minIntervalMs;
    return this.minIntervalMs + offset;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/scheduler.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/scheduler.ts test/unit/scheduler.test.ts
git commit -m "feat: add RequestScheduler (FIFO queue, concurrency cap, jittered spacing)"
```

---

### Task 2: Throttle config schema

**Files:**
- Modify: `src/types/config.ts` (add `ThrottleConfigSchema`, wire into `VocareumConfigSchema`)
- Test: `test/unit/config.test.ts` (append cases)

**Interfaces:**
- Consumes: existing `VocareumConfigSchema` (`src/types/config.ts:406`), `validateConfig` (`src/core/config.ts:89`).
- Produces:
  - `export const ThrottleConfigSchema` (zod, `.strict().optional()`)
  - `export type ThrottleConfig = z.infer<typeof ThrottleConfigSchema>`
  - `vocareum.throttle` field on parsed config.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/config.test.ts` (inside the existing top-level `describe`, or add a new one; import `validateConfig` if not already imported — it is exported from `../../src/core/config`):

```typescript
describe('throttle config validation', () => {
  const base = {
    version: '1.0',
    vocareum: { org_id: 'o1', course_id: 'c1' },
    assignments: [],
  };
  const withThrottle = (throttle: unknown) => ({
    ...base,
    vocareum: { ...base.vocareum, throttle },
  });

  it('accepts a valid throttle block', () => {
    const r = validateConfig(withThrottle({ max_concurrency: 2, min_interval_ms: 500, jitter: false }));
    expect(r.valid).toBe(true);
  });

  it('accepts absent throttle (uses defaults later)', () => {
    expect(validateConfig(base).valid).toBe(true);
  });

  it('rejects a string number for max_concurrency', () => {
    expect(validateConfig(withThrottle({ max_concurrency: '2' })).valid).toBe(false);
  });

  it('rejects negative min_interval_ms', () => {
    expect(validateConfig(withThrottle({ min_interval_ms: -100 })).valid).toBe(false);
  });

  it('rejects max_concurrency above 5', () => {
    expect(validateConfig(withThrottle({ max_concurrency: 10000 })).valid).toBe(false);
  });

  it('rejects non-integer max_concurrency', () => {
    expect(validateConfig(withThrottle({ max_concurrency: 1.5 })).valid).toBe(false);
  });

  it('rejects min_interval_ms above 60000', () => {
    expect(validateConfig(withThrottle({ min_interval_ms: 60001 })).valid).toBe(false);
  });

  it('rejects wrong type for jitter', () => {
    expect(validateConfig(withThrottle({ jitter: 'yes' })).valid).toBe(false);
  });

  it('rejects unknown keys inside throttle (strict)', () => {
    expect(validateConfig(withThrottle({ maxConcurrency: 1 })).valid).toBe(false);
  });

  it('rejects an array for throttle', () => {
    expect(validateConfig(withThrottle([])).valid).toBe(false);
  });

  it('rejects throttle nested in itself', () => {
    expect(validateConfig(withThrottle({ throttle: { max_concurrency: 1 } })).valid).toBe(false);
  });
});
```

(`validateConfig` returns `ValidationResult` with a boolean `valid` field — confirmed in `src/core/config.ts`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts -t throttle`
Expected: FAIL — unknown-key and type cases pass through because `throttle` isn't defined yet (passthrough), so assertions expecting `false` fail.

- [ ] **Step 3: Add the schema**

In `src/types/config.ts`, immediately before `export const VocareumConfigSchema = z.object({` (line ~406):

```typescript
/**
 * Proactive client throttle. Tightly bounded; `.strict()` so a typo'd key
 * (e.g. camelCase) is rejected rather than silently ignored.
 */
export const ThrottleConfigSchema = z
  .object({
    max_concurrency: z.number().int().min(1).max(5).optional(),
    min_interval_ms: z.number().int().min(0).max(60000).optional(),
    jitter: z.boolean().optional(),
  })
  .strict()
  .optional();

export type ThrottleConfig = z.infer<typeof ThrottleConfigSchema>;
```

Then add this field inside the `VocareumConfigSchema` object literal (e.g. right after the `excluded_assignments` line, before the closing `}).passthrough();`):

```typescript
  /** Proactive request throttle for the Vocareum API client. */
  throttle: ThrottleConfigSchema,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts -t throttle`
Expected: PASS (11 cases).

- [ ] **Step 5: Commit**

```bash
git add src/types/config.ts test/unit/config.test.ts
git commit -m "feat: validate vocareum.throttle config block (strict, bounded)"
```

---

### Task 3: Throttle resolution (env + config + defaults)

**Files:**
- Create: `src/api/throttle.ts`
- Test: `test/unit/throttle.test.ts`

**Interfaces:**
- Consumes: `ThrottleConfig` from `src/types/config.ts` (Task 2).
- Produces:
  - `interface ResolvedThrottle { maxConcurrency: number; minIntervalMs: number; jitter: boolean; }`
  - `const DEFAULT_THROTTLE: ResolvedThrottle` = `{ maxConcurrency: 1, minIntervalMs: 300, jitter: true }`
  - `function resolveThrottle(configThrottle?: ThrottleConfig, env?: NodeJS.ProcessEnv): ResolvedThrottle`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/throttle.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveThrottle, DEFAULT_THROTTLE } from '../../src/api/throttle';

describe('resolveThrottle', () => {
  it('returns defaults when nothing is set', () => {
    expect(resolveThrottle(undefined, {})).toEqual(DEFAULT_THROTTLE);
  });

  it('applies config values over defaults', () => {
    expect(resolveThrottle({ max_concurrency: 3, min_interval_ms: 500, jitter: false }, {}))
      .toEqual({ maxConcurrency: 3, minIntervalMs: 500, jitter: false });
  });

  it('lets env override config', () => {
    const r = resolveThrottle(
      { max_concurrency: 2, min_interval_ms: 500, jitter: false },
      { VOCAREUM_MAX_CONCURRENCY: '4', VOCAREUM_MIN_REQUEST_INTERVAL_MS: '1000', VOCAREUM_THROTTLE_JITTER: 'true' },
    );
    expect(r).toEqual({ maxConcurrency: 4, minIntervalMs: 1000, jitter: true });
  });

  it('parses boolean env forms 0/1/true/false', () => {
    expect(resolveThrottle(undefined, { VOCAREUM_THROTTLE_JITTER: '0' }).jitter).toBe(false);
    expect(resolveThrottle(undefined, { VOCAREUM_THROTTLE_JITTER: '1' }).jitter).toBe(true);
    expect(resolveThrottle(undefined, { VOCAREUM_THROTTLE_JITTER: 'false' }).jitter).toBe(false);
    expect(resolveThrottle(undefined, { VOCAREUM_THROTTLE_JITTER: 'true' }).jitter).toBe(true);
  });

  it('throws on non-numeric interval env', () => {
    expect(() => resolveThrottle(undefined, { VOCAREUM_MIN_REQUEST_INTERVAL_MS: 'abc' })).toThrow(/VOCAREUM_MIN_REQUEST_INTERVAL_MS/);
  });

  it('throws on out-of-range concurrency env (0)', () => {
    expect(() => resolveThrottle(undefined, { VOCAREUM_MAX_CONCURRENCY: '0' })).toThrow(/VOCAREUM_MAX_CONCURRENCY/);
  });

  it('throws on concurrency env above 5', () => {
    expect(() => resolveThrottle(undefined, { VOCAREUM_MAX_CONCURRENCY: '6' })).toThrow(/VOCAREUM_MAX_CONCURRENCY/);
  });

  it('throws on interval env above 60000', () => {
    expect(() => resolveThrottle(undefined, { VOCAREUM_MIN_REQUEST_INTERVAL_MS: '60001' })).toThrow(/VOCAREUM_MIN_REQUEST_INTERVAL_MS/);
  });

  it('throws on an unrecognized jitter env value', () => {
    expect(() => resolveThrottle(undefined, { VOCAREUM_THROTTLE_JITTER: 'maybe' })).toThrow(/VOCAREUM_THROTTLE_JITTER/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/throttle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

Create `src/api/throttle.ts`:

```typescript
import type { ThrottleConfig } from '../types/config';

export interface ResolvedThrottle {
  maxConcurrency: number;
  minIntervalMs: number;
  jitter: boolean;
}

export const DEFAULT_THROTTLE: ResolvedThrottle = {
  maxConcurrency: 1,
  minIntervalMs: 300,
  jitter: true,
};

function parseIntEnv(name: string, raw: string, min: number, max: number): number {
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
  }
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
  }
  return n;
}

function parseBoolEnv(name: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true') { return true; }
  if (v === '0' || v === 'false') { return false; }
  throw new Error(`${name} must be one of 0/1/true/false (got "${raw}").`);
}

/**
 * Resolve throttle settings. Precedence (highest first): env var, config
 * block, built-in default. Config is assumed already schema-validated; env
 * vars are validated here and throw on bad values (no silent clamp).
 */
export function resolveThrottle(
  configThrottle?: ThrottleConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedThrottle {
  let maxConcurrency = configThrottle?.max_concurrency ?? DEFAULT_THROTTLE.maxConcurrency;
  let minIntervalMs = configThrottle?.min_interval_ms ?? DEFAULT_THROTTLE.minIntervalMs;
  let jitter = configThrottle?.jitter ?? DEFAULT_THROTTLE.jitter;

  const cEnv = env.VOCAREUM_MAX_CONCURRENCY;
  if (cEnv !== undefined && cEnv !== '') {
    maxConcurrency = parseIntEnv('VOCAREUM_MAX_CONCURRENCY', cEnv, 1, 5);
  }
  const iEnv = env.VOCAREUM_MIN_REQUEST_INTERVAL_MS;
  if (iEnv !== undefined && iEnv !== '') {
    minIntervalMs = parseIntEnv('VOCAREUM_MIN_REQUEST_INTERVAL_MS', iEnv, 0, 60000);
  }
  const jEnv = env.VOCAREUM_THROTTLE_JITTER;
  if (jEnv !== undefined && jEnv !== '') {
    jitter = parseBoolEnv('VOCAREUM_THROTTLE_JITTER', jEnv);
  }

  return { maxConcurrency, minIntervalMs, jitter };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/throttle.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/throttle.ts test/unit/throttle.test.ts
git commit -m "feat: resolve throttle settings from env + config + defaults"
```

---

### Task 4: Gate VocareumClient through the scheduler

**Files:**
- Modify: `src/api/client.ts` (constructor + `attempt`)
- Test: `test/unit/client-auth.test.ts` (append)

**Interfaces:**
- Consumes: `RequestScheduler`, `SchedulerOptions` (Task 1); `ResolvedThrottle`, `DEFAULT_THROTTLE` (Task 3).
- Produces: `new VocareumClient(authProvider, throttle?: ResolvedThrottle)` — second param optional, defaults to `DEFAULT_THROTTLE`. Every request flows through the scheduler.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/client-auth.test.ts` (the `setAdapter` helper and `FakeProvider` already exist in this file):

```typescript
describe('VocareumClient throttle scheduling', () => {
  it('spaces requests by minIntervalMs through the scheduler', async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider();
      const client = new VocareumClient(provider, { maxConcurrency: 1, minIntervalMs: 1000, jitter: false });
      let calls = 0;
      setAdapter(client, async (config: unknown) => {
        calls += 1;
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      });
      const all = Promise.all([
        client.request({ method: 'GET', url: '/a' }),
        client.request({ method: 'GET', url: '/b' }),
        client.request({ method: 'GET', url: '/c' }),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(3);
      await all;
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client-auth.test.ts -t "throttle scheduling"`
Expected: FAIL — `VocareumClient` constructor ignores the 2nd arg; all three calls fire immediately so `calls` is `3` at the first assertion.

- [ ] **Step 3: Wire the scheduler in**

In `src/api/client.ts`:

Add imports near the top (after the existing imports):

```typescript
import { RequestScheduler } from './scheduler';
import { DEFAULT_THROTTLE, type ResolvedThrottle } from './throttle';
```

Add a private field and extend the constructor (replace the existing `private authProvider: AuthProvider;` / constructor block):

```typescript
  private axios: AxiosInstance;
  private authProvider: AuthProvider;
  private scheduler: RequestScheduler;

  constructor(authProvider: AuthProvider, throttle: ResolvedThrottle = DEFAULT_THROTTLE) {
    assertAllowedBaseUrl(authProvider.apiBaseUrl);
    this.authProvider = authProvider;
    this.scheduler = new RequestScheduler(throttle);
    this.axios = axios.create({
      baseURL: authProvider.apiBaseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
    this.axios.interceptors.request.use(async (config) => {
      config.headers.set('Authorization', await this.authProvider.getAuthorizationHeader());
      return config;
    });
  }
```

In `attempt`, wrap the axios call (replace the existing `const response = await this.axios.request<T>(config);` line):

```typescript
        const response = await this.scheduler.schedule(() => this.axios.request<T>(config));
```

- [ ] **Step 3b: Neutralize the scheduler in existing timing-sensitive tests**

The constructor now defaults to `DEFAULT_THROTTLE` (`minIntervalMs: 300`, `jitter: true`). Existing
retry/Retry-After tests in `test/unit/client-auth.test.ts` construct `new VocareumClient(provider)`
and advance fake timers by small amounts (e.g. `backoff: 25` advancing only 25ms; the invalid
Retry-After `it.each` at ~line 408). With a 300ms default spacing the retry's second attempt would be
held past those advances and the tests would hang/fail. Also `jitter: true` would make spacing
nondeterministic.

Define a no-op throttle constant near the top of the file (after the imports):

```typescript
const NO_THROTTLE = { maxConcurrency: 1, minIntervalMs: 0, jitter: false } as const;
```

Then pass it as the second arg to **every** `new VocareumClient(provider...)` construction in this
file *except* the new "throttle scheduling" test from Step 1 (which sets its own throttle). This
preserves the prior semantics (scheduler becomes a pass-through) for all existing tests:

- `new VocareumClient(provider)` → `new VocareumClient(provider, NO_THROTTLE)`
- `new VocareumClient(provider as AuthProvider)` → `new VocareumClient(provider as AuthProvider, NO_THROTTLE)`

(Find/replace handles the common form; the two cast variants near the 401-refresh tests need the
arg added by hand.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/client-auth.test.ts`
Expected: PASS (all existing tests, now scheduler-neutral, + the new throttle test).

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts test/unit/client-auth.test.ts
git commit -m "feat: route every VocareumClient request through the scheduler"
```

---

### Task 5: Thread resolved throttle into command client construction

**Files:**
- Modify: `src/commands/pull.ts:987`
- Modify: `src/commands/publish.ts:49`
- Test: `test/unit/pull-command.test.ts` (add throttle mock + wiring test)
- Test: `test/unit/publish-command.test.ts` (add throttle mock + wiring test)

**Interfaces:**
- Consumes: `resolveThrottle` (Task 3); `config.vocareum.throttle` (Task 2); `new VocareumClient(provider, throttle)` (Task 4).
- Produces: both commands resolve throttle (which validates env) BEFORE constructing/using the client.

These are real command-level tests: they mock `resolveThrottle` to throw and assert the client constructor and the downstream worker (`reconcile`/`publish`) were never called — proving throttle resolution precedes any request.

- [ ] **Step 1: Add the throttle mock to both command test files**

In `test/unit/pull-command.test.ts`, add this `vi.mock` alongside the others (e.g. after the `../../src/api/content` mock at line ~65), then set a default no-op return at module scope (survives the file's `vi.clearAllMocks()`):

```typescript
vi.mock('../../src/api/throttle', () => ({
  resolveThrottle: vi.fn(() => ({ maxConcurrency: 1, minIntervalMs: 0, jitter: false })),
  DEFAULT_THROTTLE: { maxConcurrency: 1, minIntervalMs: 0, jitter: false },
}));
```

Add an import to obtain typed handles (top of file, with the other imports):

```typescript
import { resolveThrottle } from '../../src/api/throttle';
import { VocareumClient } from '../../src/api/client';
```

Do the exact same `vi.mock('../../src/api/throttle', ...)` block and the `resolveThrottle`/`VocareumClient` imports in `test/unit/publish-command.test.ts`.

- [ ] **Step 2: Write the failing wiring tests**

Append to `test/unit/pull-command.test.ts` (new top-level `describe`):

```typescript
describe('pullCommand resolves throttle before using the client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VOCAREUM_API_KEY = 'token';
    isCIMock.mockReturnValue(false);
    loadConfigMock.mockResolvedValue({
      version: '1.0',
      vocareum: { org_id: '1', course_id: 'c1', api_base_url: 'https://api.vocareum.com' },
      assignments: [],
      publish_options: {},
      publish_history: [],
    });
    vi.mocked(resolveThrottle).mockReturnValue({ maxConcurrency: 1, minIntervalMs: 0, jitter: false });
  });

  it('does not construct the client or call reconcile when throttle resolution throws', async () => {
    vi.mocked(resolveThrottle).mockImplementationOnce(() => { throw new Error('bad throttle env'); });
    await expect(pullCommand({ nonInteractive: true })).rejects.toThrow('bad throttle env');
    expect(vi.mocked(VocareumClient)).not.toHaveBeenCalled();
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
```

Append to `test/unit/publish-command.test.ts` (new top-level `describe`):

```typescript
describe('publishCommand resolves throttle before using the client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VOCAREUM_API_KEY = 'token';
    isCIMock.mockReturnValue(false);
    loadConfigMock.mockResolvedValue({
      version: '1.0',
      vocareum: { org_id: '1', course_id: 'c1', api_base_url: 'https://api.vocareum.com' },
      assignments: [],
      publish_options: {},
      publish_history: [],
    });
    vi.mocked(resolveThrottle).mockReturnValue({ maxConcurrency: 1, minIntervalMs: 0, jitter: false });
  });

  it('does not construct the client or call publish when throttle resolution throws', async () => {
    vi.mocked(resolveThrottle).mockImplementationOnce(() => { throw new Error('bad throttle env'); });
    await expect(publishCommand({ config: 'vocareum.yaml' })).rejects.toThrow('bad throttle env');
    expect(vi.mocked(VocareumClient)).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the wiring tests to verify they FAIL**

Run: `npx vitest run test/unit/pull-command.test.ts test/unit/publish-command.test.ts -t "resolves throttle before"`
Expected: FAIL — commands don't call `resolveThrottle` yet, so the `mockImplementationOnce` throw never fires; the client IS constructed and reconcile/publish ARE called, so `not.toHaveBeenCalled()` fails.

- [ ] **Step 4: Wire both command call sites**

In `src/commands/publish.ts`, add the import (alongside existing imports):

```typescript
import { resolveThrottle } from '../api/throttle';
```

Replace line 49 (`const client = new VocareumClient(...)`):

```typescript
    const throttle = resolveThrottle(config.vocareum.throttle);
    const client = new VocareumClient(resolveAuthProvider(options, config.vocareum.api_base_url), throttle);
```

In `src/commands/pull.ts`, add the import (alongside existing imports):

```typescript
import { resolveThrottle } from '../api/throttle';
```

Replace line 987 (`const client = new VocareumClient(...)`):

```typescript
    const throttle = resolveThrottle(config.vocareum.throttle);
    const client = new VocareumClient(resolveAuthProvider(options, config.vocareum.api_base_url), throttle);
```

- [ ] **Step 5: Run the wiring tests + full suite**

Run: `npx vitest run test/unit/pull-command.test.ts test/unit/publish-command.test.ts && npm run typecheck`
Expected: PASS — throttle now resolved before the client; the throw short-circuits before construction. Typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/commands/pull.ts src/commands/publish.ts test/unit/pull-command.test.ts test/unit/publish-command.test.ts
git commit -m "feat: resolve+validate throttle before constructing pull/publish clients"
```

---

### Task 6: Pull content-drift opt-in + scoping flags

**Files:**
- Modify: `src/commands/pull.ts` (PullOptions type ~line 45; add helpers; gate `detectContentDrift` call ~line 999; add skip note)
- Modify: `src/index.ts` (pull command options ~line 188; collector)
- Test: `test/unit/pull-content-flags.test.ts` (new)

**Interfaces:**
- Consumes: existing `detectContentDrift` (`src/commands/pull.ts:571`), `Assignment` type, `PullOptions`.
- Produces (exported from `src/commands/pull.ts` for testing):
  - `function validatePullContentFlags(opts: { content?: boolean; assignment?: string[]; part?: string[] }): void` — throws `Error` with a clear message on invalid combos.
  - `function scopeAssignmentsForContent(assignments: Assignment[], assignmentSelectors: string[], partSelectors: string[]): { assignments: Assignment[]; partIds: Set<string> | undefined }` — throws on unknown selectors.
- `PullOptions` gains: `content?: boolean; assignment?: string[]; part?: string[];`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/pull-content-flags.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validatePullContentFlags, scopeAssignmentsForContent } from '../../src/commands/pull';
import type { Assignment } from '../../src/types/config';

// part_id and assignment_id are `string | null` in the schema; `settings` is
// omitted because these helpers only read name/id/parts (cast bypasses it).
const asn = (name: string, id: string, partIds: string[]): Assignment => ({
  name,
  path: name,
  assignment_id: id,
  parts: partIds.map((pid, i) => ({ part_id: pid, path: `${name}/p${i}` })),
} as unknown as Assignment);

describe('validatePullContentFlags', () => {
  it('allows bare pull (no flags)', () => {
    expect(() => validatePullContentFlags({})).not.toThrow();
  });
  it('allows --content alone', () => {
    expect(() => validatePullContentFlags({ content: true })).not.toThrow();
  });
  it('allows --content with one --assignment', () => {
    expect(() => validatePullContentFlags({ content: true, assignment: ['lab1'] })).not.toThrow();
  });
  it('allows --content with one --assignment and --part', () => {
    expect(() => validatePullContentFlags({ content: true, assignment: ['lab1'], part: ['p1'] })).not.toThrow();
  });
  it('errors on --assignment without --content', () => {
    expect(() => validatePullContentFlags({ assignment: ['lab1'] })).toThrow(/--content/);
  });
  it('errors on --part without --content', () => {
    expect(() => validatePullContentFlags({ part: ['p1'] })).toThrow(/--content/);
  });
  it('errors on --part without --assignment', () => {
    expect(() => validatePullContentFlags({ content: true, part: ['p1'] })).toThrow(/--part requires --assignment/);
  });
  it('errors on --part with more than one --assignment', () => {
    expect(() => validatePullContentFlags({ content: true, assignment: ['lab1', 'lab2'], part: ['p1'] }))
      .toThrow(/exactly one --assignment/);
  });
});

describe('scopeAssignmentsForContent', () => {
  const all = [asn('lab1', '111', ['p1', 'p2']), asn('lab2', '222', ['p3'])];

  it('returns all assignments and no part filter when no selectors', () => {
    const r = scopeAssignmentsForContent(all, [], []);
    expect(r.assignments).toHaveLength(2);
    expect(r.partIds).toBeUndefined();
  });
  it('scopes to named assignment(s) by name', () => {
    const r = scopeAssignmentsForContent(all, ['lab1'], []);
    expect(r.assignments.map((a) => a.name)).toEqual(['lab1']);
    expect(r.partIds).toBeUndefined();
  });
  it('scopes by assignment_id too', () => {
    const r = scopeAssignmentsForContent(all, ['222'], []);
    expect(r.assignments.map((a) => a.name)).toEqual(['lab2']);
  });
  it('collects repeated assignment selectors', () => {
    const r = scopeAssignmentsForContent(all, ['lab1', 'lab2'], []);
    expect(r.assignments.map((a) => a.name).sort()).toEqual(['lab1', 'lab2']);
  });
  it('scopes parts within the single selected assignment', () => {
    const r = scopeAssignmentsForContent(all, ['lab1'], ['p2']);
    expect(r.assignments.map((a) => a.name)).toEqual(['lab1']);
    expect([...(r.partIds ?? [])]).toEqual(['p2']);
  });
  it('errors on an unknown assignment selector', () => {
    expect(() => scopeAssignmentsForContent(all, ['nope'], [])).toThrow(/nope/);
  });
  it('errors on a part not under the selected assignment', () => {
    expect(() => scopeAssignmentsForContent(all, ['lab1'], ['p3'])).toThrow(/p3/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/pull-content-flags.test.ts`
Expected: FAIL — `validatePullContentFlags`/`scopeAssignmentsForContent` not exported.

- [ ] **Step 3: Implement the helpers and gate the call**

In `src/commands/pull.ts`, extend `PullOptions` (after the `skipContent` field, before `auth`):

```typescript
  /** Opt in to content-drift detection (downloads remote files to diff them). */
  content?: boolean;
  /** Limit --content drift to these assignment name(s) or id(s). Repeatable. */
  assignment?: string[];
  /** Limit --content drift to these part id(s); requires exactly one --assignment. */
  part?: string[];
```

Add the two exported helpers (place them near `detectContentDrift`, e.g. just above its definition at line ~571):

```typescript
/**
 * Validate the --content / --assignment / --part flag combination. Throws with
 * a user-facing message on any invalid combination. Pure: no config needed.
 */
export function validatePullContentFlags(opts: {
  content?: boolean;
  assignment?: string[];
  part?: string[];
}): void {
  const assignmentSel = opts.assignment ?? [];
  const partSel = opts.part ?? [];
  if (!opts.content && (assignmentSel.length > 0 || partSel.length > 0)) {
    throw new Error('--assignment/--part only apply with --content. Add --content or remove the selectors.');
  }
  if (partSel.length > 0 && assignmentSel.length === 0) {
    throw new Error('--part requires --assignment (part selectors are not unique across a course).');
  }
  if (partSel.length > 0 && assignmentSel.length > 1) {
    throw new Error('--part requires exactly one --assignment (part selectors are not unique across assignments).');
  }
}

/**
 * Narrow the assignment list (and optionally part ids) for scoped content
 * drift. Matches assignment selectors against name OR assignment_id, and part
 * selectors against part_id within the single selected assignment. Throws on
 * any unmatched selector. With no selectors, returns all assignments and no
 * part filter.
 */
export function scopeAssignmentsForContent(
  assignments: Assignment[],
  assignmentSelectors: string[],
  partSelectors: string[],
): { assignments: Assignment[]; partIds: Set<string> | undefined } {
  if (assignmentSelectors.length === 0) {
    return { assignments, partIds: undefined };
  }
  const selected: Assignment[] = [];
  for (const sel of assignmentSelectors) {
    const match = assignments.find((a) => a.name === sel || a.assignment_id === sel);
    if (!match) {
      const valid = assignments.map((a) => `${a.name} (${a.assignment_id ?? 'no id'})`).join(', ');
      throw new Error(`Unknown --assignment "${sel}". Valid choices: ${valid || '(none)'}.`);
    }
    if (!selected.includes(match)) { selected.push(match); }
  }
  if (partSelectors.length === 0) {
    return { assignments: selected, partIds: undefined };
  }
  // validatePullContentFlags guarantees exactly one assignment here.
  const target = selected[0];
  const validPartIds = new Set((target.parts ?? []).map((p) => p.part_id).filter((id): id is string => id != null));
  for (const p of partSelectors) {
    if (!validPartIds.has(p)) {
      const valid = [...validPartIds].join(', ');
      throw new Error(`Unknown --part "${p}" in assignment "${target.name}". Valid parts: ${valid || '(none)'}.`);
    }
  }
  return { assignments: selected, partIds: new Set(partSelectors) };
}
```

Add an optional `partIds` filter parameter to `detectContentDrift`. Change its signature (line ~571) to append a parameter:

```typescript
async function detectContentDrift(
  config: { assignments: Assignment[]; vocareum: { course_id: string; excluded_assignments?: string[]; architecture?: 'elite' | 'container' } },
  client: VocareumClient,
  skipAssignmentIds: Set<string>,
  workspaceRoot: string,
  partIds?: Set<string>,
): Promise<AssignmentContentDrift[]> {
```

Inside `detectContentDrift`, within the loop over `assignment.parts` (find the `for (const configPart of ...)` that drives `downloadContent`), add a skip at the top of the part loop body:

```typescript
      if (partIds !== undefined && (configPart.part_id == null || !partIds.has(configPart.part_id))) {
        continue;
      }
```

In `pullCommandLocked`, validate flags right after `const config = await loadConfig(configPath);` (line ~985, before constructing the client is fine; flag-only validation needs no network):

```typescript
    validatePullContentFlags(options);
```

Replace the unconditional content-drift call (line ~999):

```typescript
    // Content drift is opt-in (it downloads remote files). Orphan import below
    // is unaffected and still governed by --skip-content.
    let contentDrift: AssignmentContentDrift[] = [];
    if (options.content) {
      const scoped = scopeAssignmentsForContent(
        config.assignments,
        options.assignment ?? [],
        options.part ?? [],
      );
      contentDrift = await detectContentDrift(
        { ...config, assignments: scoped.assignments },
        client,
        staleAssignmentIds,
        workspaceRoot,
        scoped.partIds,
      );
    }
```

Add the skip note just before the `const hasOrphans = ...` line (so it prints whether or not issues are found):

```typescript
    if (!options.content) {
      logger.info('Content drift not checked. Run `vocgit pull --content` to compare file contents (downloads remote files).');
    }
```

- [ ] **Step 4: Add the CLI flags**

In `src/index.ts`, just before the `pull` command definition (before `const pullCmd = program`), add the collector:

```typescript
const collectFlag = (value: string, acc: string[]): string[] => { acc.push(value); return acc; };
```

Add the three options to `pullCmd` (after the existing `--skip-content` option, before `--verbose`):

```typescript
  .option('--content', 'Detect content drift (downloads remote files to diff them; off by default)')
  .option('--assignment <name|id>', 'Limit --content drift to assignment(s); repeatable', collectFlag, [])
  .option('--part <id>', 'Limit --content drift to part(s); requires exactly one --assignment', collectFlag, [])
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/unit/pull-content-flags.test.ts && npm run typecheck`
Expected: PASS (16 cases); typecheck clean.

- [ ] **Step 6: Write `pullCommand`-level tests for the behavior change (mocked client)**

The pure-helper tests above don't prove the command actually gates the download. Add behavioral
tests in `test/unit/pull-command.test.ts` that assert the mocked `downloadContent` (already mocked
at line ~63) is or isn't called. Add the handle import at the top of the file:

```typescript
import { downloadContent } from '../../src/api/content';
```

Append this `describe` (self-contained: `reconcile` returns no orphans/stale, `getAssignment`
rejects so settings drift is empty, and `downloadContent` returns `{}` so content drift is empty —
the command reaches "No sync issues found" without prompting; we assert only the call pattern):

```typescript
describe('pullCommand content-drift gating', () => {
  const twoAssignmentConfig: Config = {
    version: '1.0',
    vocareum: { org_id: '1', course_id: 'c1', api_base_url: 'https://api.vocareum.com', excluded_assignments: [] },
    assignments: [
      { assignment_id: 'a-lab1', name: 'lab1', path: 'lab1', create_from_template: false, settings: {},
        parts: [{ part_id: 'p1', path: 'part1', settings: {} }] },
      { assignment_id: 'a-lab2', name: 'lab2', path: 'lab2', create_from_template: false, settings: {},
        parts: [{ part_id: 'p2', path: 'part1', settings: {} }] },
    ],
    publish_options: { on_missing_id: 'skip', auto_commit: false, abort_on_error: false, sync_deletes: false, exclude_patterns: [] },
    publish_history: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VOCAREUM_API_KEY = 'token';
    isCIMock.mockReturnValue(false);
    loadConfigMock.mockResolvedValue(twoAssignmentConfig);
    updateConfigMock.mockResolvedValue(undefined);
    getAssignmentMock.mockRejectedValue(new Error('skip settings drift'));
    reconcileMock.mockResolvedValue({
      config: twoAssignmentConfig, course: { type: 'skip' }, assignments: [],
      summary: { coursesToUpdate: 0, assignmentsToCreate: 0, assignmentsToUpdate: 0, assignmentsWithDiscoveredIds: 0, assignmentsToSkip: 0, partsToCreate: 0, partsToUpdate: 0, estimatedApiCalls: 0 },
      orphanedInVocareum: [], staleInConfig: [],
    });
    vi.mocked(downloadContent).mockResolvedValue({});
  });

  it('bare pull does NOT download content for drift', async () => {
    await pullCommand({ nonInteractive: true });
    expect(vi.mocked(downloadContent)).not.toHaveBeenCalled();
  });

  it('--content downloads content for all linked parts', async () => {
    await pullCommand({ nonInteractive: true, content: true });
    expect(vi.mocked(downloadContent)).toHaveBeenCalled();
    const courseIds = vi.mocked(downloadContent).mock.calls.map((c) => c[2]); // assignmentId arg
    expect(new Set(courseIds)).toEqual(new Set(['a-lab1', 'a-lab2']));
  });

  it('--content --assignment lab1 downloads only lab1 parts', async () => {
    await pullCommand({ nonInteractive: true, content: true, assignment: ['lab1'] });
    expect(vi.mocked(downloadContent)).toHaveBeenCalled();
    const assignmentIds = vi.mocked(downloadContent).mock.calls.map((c) => c[2]);
    expect(new Set(assignmentIds)).toEqual(new Set(['a-lab1']));
  });
});
```

(`downloadContent(client, courseId, assignmentId, partId, ...)` — assignmentId is the 3rd
positional arg, index `[2]`. Confirmed against `src/api/content.ts:600`.)

- [ ] **Step 7: Run the new command tests + full suite**

Run: `npx vitest run test/unit/pull-command.test.ts test/unit/pull-content-flags.test.ts && npm run typecheck`
Expected: PASS. The bare-pull test proves zero content-drift downloads; `--content` and scoping prove the gate and the filter.

- [ ] **Step 8: Commit**

```bash
git add src/commands/pull.ts src/index.ts test/unit/pull-content-flags.test.ts test/unit/pull-command.test.ts
git commit -m "feat: make pull content drift opt-in via --content with --assignment/--part scoping"
```

---

### Task 7: Docs — README, CHANGELOG, help text

**Files:**
- Modify: `README.md` (pull section + a new Throttling/config section)
- Modify: `CHANGELOG.md` (new entry with a "Behavior changes" note)
- Modify: `src/index.ts` (pull `addHelpText` examples ~line 228)

**Interfaces:** none (documentation).

- [ ] **Step 1: Update the pull help examples**

In `src/index.ts`, in the pull command's `addHelpText('after', ...)` Examples block (~line 228), add:

```
  $ vocgit pull --content     # also check content drift (downloads remote files)
  $ vocgit pull --content --assignment lab1        # scope content drift to lab1
  $ vocgit pull --content --assignment lab1 --part part1   # scope to one part
```

And update the existing description text that says bare pull detects content drift to note it is now opt-in via `--content`.

- [ ] **Step 2: Update README**

In `README.md`:
- In the `pull` documentation, state that `pull` no longer downloads content by default; content drift requires `--content`, scoped with `--assignment`/`--part`. Clarify `--skip-content` still controls orphan-import content only.
- Add a "Throttling the Vocareum API" subsection documenting the `vocareum.throttle` block (`max_concurrency` 1..5 default 1, `min_interval_ms` 0..60000 default 300, `jitter` default true) and the three env overrides, with this example:

````markdown
```yaml
vocareum:
  org_id: "..."
  course_id: "..."
  throttle:
    max_concurrency: 1
    min_interval_ms: 300
    jitter: true
```
````

- Add a GitHub Action workflow snippet showing a `concurrency:` group keyed by the config/course so separate runners don't overlap:

````markdown
```yaml
concurrency:
  group: vocareum-publish-${{ github.repository }}
  cancel-in-progress: false
```
````

- [ ] **Step 3: Update CHANGELOG**

In `CHANGELOG.md`, add a new top entry (match existing version/heading style; pick the next version per the maintainer's scheme — this is a behavior change, recommend a minor bump):

```markdown
## [Unreleased]

### Behavior changes
- `vocgit pull` no longer downloads remote content by default. Content-drift
  detection is now opt-in via `--content`, optionally scoped with
  `--assignment <name|id>` (repeatable) and `--part <id>` (requires exactly one
  `--assignment`). Orphan-import behavior and `--skip-content` are unchanged.

### Added
- Proactive request throttle for the Vocareum API client: `vocareum.throttle`
  config block (`max_concurrency` 1..5, default 1; `min_interval_ms` 0..60000,
  default 300; `jitter`, default true) plus env overrides
  `VOCAREUM_MAX_CONCURRENCY`, `VOCAREUM_MIN_REQUEST_INTERVAL_MS`,
  `VOCAREUM_THROTTLE_JITTER`. Requests are FIFO-scheduled with a concurrency cap
  and jittered minimum spacing.
```

- [ ] **Step 4: Verify build + full suite**

Run: `npm run build && npm run typecheck && npx vitest run && npm run lint`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md src/index.ts
git commit -m "docs: document throttle config, opt-in pull content drift, CI concurrency group"
```

---

## Self-Review

**Spec coverage:**
- Scheduler (FIFO, concurrency cap, jittered start spacing, timer pump, injected clock/timer/RNG) → Task 1. ✓
- Scope note (Vocareum-only, not S3/OAuth) → Global Constraints + Task 4 wiring. ✓
- maxConcurrency>1 needs real queue → Task 1 (`activeCount` + queue). ✓
- Accurate jitter claim (start spacing only) → Task 1 `spacing()`; backoff sleep untouched. ✓
- Throttle config block, strict, bounded, adversarial table → Task 2 (11 cases). ✓
- Env resolution + precedence + hard errors → Task 3 (9 cases). ✓
- Validation-before-request ordering → Task 5 command-level wiring tests: `resolveThrottle` mocked to throw, asserting `VocareumClient` + `reconcile`/`publish` are never called. ✓
- Existing client-auth retry/timer tests neutralized against the new default throttle → Task 5 Step 3b (`NO_THROTTLE`). ✓
- Pull `--content` opt-in, `--assignment` repeatable, `--part` requires single `--assignment`, error combos → Task 6 pure-helper tests (16 cases) + `pullCommand`-level tests (Step 6) proving bare pull issues zero `downloadContent` calls, `--content` downloads all, scoping filters. ✓
- Drift vs orphan-import separation; `--skip-content` unchanged → Task 6 (guard only wraps `detectContentDrift`; orphan import + `skipContent` untouched). ✓
- Skip note output → Task 6 Step 3. ✓
- Repeated-`--assignment` Commander collector → Task 6 Step 4. ✓
- README/CHANGELOG/CI concurrency group + behavior-change note → Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every test step shows assertions. ✓

**Type consistency:** `ResolvedThrottle` (Task 3) is structurally assignable to `SchedulerOptions` (Task 1, no `clearTimeoutFn`) — client passes it directly (Task 4). `ThrottleConfig` (Task 2) consumed by `resolveThrottle` (Task 3). `validatePullContentFlags`/`scopeAssignmentsForContent` names match between Task 6 implementation, exports, and tests. `detectContentDrift` gains a trailing optional `partIds?: Set<string>` consistent between definition and call. Verified against source: `ValidationResult.valid` (`src/core/config.ts`); `Assignment.assignment_id`/`Part.part_id` are `string | null`, `Assignment.parts`/`name`/`path` present, `Part` has no `seqnum` (`src/types/config.ts`); `downloadContent` assignmentId arg at index `[2]` (`src/api/content.ts:600`); `tsconfig` `noUnusedLocals: true` honored (no unread fields). ✓
