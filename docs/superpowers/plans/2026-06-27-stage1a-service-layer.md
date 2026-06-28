# Stage 1a — Command/Service Layer Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `push`/`pull`/`status`/`validate` onto a behavior-preserving service layer (operation-specific contracts, a locked-session writer, an event sink, and a single top-level exit) so the Stage 1b org runner can drive many courses — with **zero observable change** to today's single-course CLI.

**Architecture:** Characterization (golden) tests are written **first** to lock current behavior. Then additive primitives (event sink, contexts, `withSession`, injected scheduler, plan fingerprint) land unused. Then the entrypoint moves to a single exit boundary. Then each command is reshaped into services that emit events instead of rendering and never call `process.exit`. The event sink is threaded through the transitive business-logic graph (`publisher`/`reconciler`/`uploader`/`validator`/`UnknownFieldReporter`) so concurrent Stage 1b output cannot interleave.

**Tech Stack:** TypeScript (strict), Node ≥18, Commander, vitest (`vi.mock`), js-yaml, zod, axios.

**Spec:** [docs/superpowers/specs/2026-06-26-stage1a-service-layer-design.md](../specs/2026-06-26-stage1a-service-layer-design.md)

## Global Constraints

- All IDs are strings, never numbers.
- No `console.log` in `src/`; rendering goes through `logger` (CLI wrappers only) — services emit to the **event sink**.
- No `process.exit` anywhere except `src/index.ts` (enforced by a CI grep guard, Task 16).
- No `loadConfig`, `process.cwd()`, `loadDotEnvIfPresent`, `new VocareumClient(...)`, or `withConfigLock` inside `src/core/services/` (CI grep guards, Task 16).
- TypeScript strict mode must pass (`npm run typecheck`); eslint clean (`npm run lint`).
- **Behavior preservation is the acceptance criterion:** the Phase 0 golden tests must stay green, byte-for-byte (normalized stdout/stderr, exit code, filesystem/config result, prompt sequence, **API-call sequence**), through every later task. If a golden test changes, that is a bug unless the spec explicitly sanctions the change.
- `vocareum.yaml` schema is unchanged in Stage 1a. No org schema, selectors, or multi-course code (that is Stage 1b).
- `init`/`new`/`fix` are NOT service-refactored; only their `process.exit` calls move to the entrypoint (Phase 2).
- Commit after every task (frequent commits). Run `npm test` before each commit.

---

## Phase 0 — Characterization harness (the regression net)

Produces a recording client + golden tests that capture today's behavior. Independently valuable; everything after this is guarded by it.

### Task 1: Recording API client test double

**Files:**
- Create: `test/helpers/recording-client.ts`
- Test: `test/helpers/recording-client.test.ts`

**Interfaces:**
- Produces: `class RecordingClient` with `request(config: AxiosRequestConfig): Promise<T>` that pushes `{method, url}` onto a public `calls: Array<{method: string; url: string}>` and returns a queued canned response; `enqueue(response: unknown): void`; `sequence(): string[]` returning `` `${method} ${path}` `` strings (path = url without query, for stable snapshots).
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```ts
// test/helpers/recording-client.test.ts
import { describe, it, expect } from 'vitest';
import { RecordingClient } from './recording-client';

describe('RecordingClient', () => {
  it('records method+path and returns enqueued responses in order', async () => {
    const c = new RecordingClient();
    c.enqueue({ courses: [{ id: '1' }] });
    c.enqueue({ status: 'success' });
    const a = await c.request({ method: 'GET', url: '/courses?page=1' });
    const b = await c.request({ method: 'PUT', url: '/courses/1' });
    expect(a).toEqual({ courses: [{ id: '1' }] });
    expect(b).toEqual({ status: 'success' });
    expect(c.sequence()).toEqual(['GET /courses', 'PUT /courses/1']);
  });

  it('throws a clear error when no response is enqueued', async () => {
    const c = new RecordingClient();
    await expect(c.request({ method: 'GET', url: '/x' })).rejects.toThrow(/no enqueued response/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/helpers/recording-client.test.ts`
Expected: FAIL — cannot find module `./recording-client`.

- [ ] **Step 3: Write minimal implementation**

```ts
// test/helpers/recording-client.ts
import type { AxiosRequestConfig } from 'axios';

export class RecordingClient {
  readonly calls: Array<{ method: string; url: string }> = [];
  private responses: unknown[] = [];

  enqueue(response: unknown): void { this.responses.push(response); }

  async request<T = unknown>(config: AxiosRequestConfig): Promise<T> {
    const method = (config.method ?? 'GET').toUpperCase();
    const url = config.url ?? '';
    this.calls.push({ method, url });
    if (this.responses.length === 0) {
      throw new Error(`RecordingClient: no enqueued response for ${method} ${url}`);
    }
    return this.responses.shift() as T;
  }

  sequence(): string[] {
    return this.calls.map((c) => `${c.method} ${c.url.split('?')[0]}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/helpers/recording-client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add test/helpers/recording-client.ts test/helpers/recording-client.test.ts
git commit -m "test: add RecordingClient test double for golden API-sequence tests"
```

### Task 2: Golden test — `status` (offline) behavior

**Files:**
- Create: `test/golden/status.golden.test.ts`
- Uses: `test/fixtures/sample-course/` (exists)

**Interfaces:**
- Consumes: `statusCommand` ([src/commands/status.ts](../../../src/commands/status.ts)), `RecordingClient` (Task 1).
- Produces: a captured baseline of status stdout (normalized) + exit behavior + **zero API calls** (status is offline).

- [ ] **Step 1: Write the characterization test** (captures CURRENT behavior — it must pass against unrefactored code)

```ts
// test/golden/status.golden.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture rendered lines instead of asserting exact strings up front:
const lines: string[] = [];
vi.mock('../../src/utils/logger', () => {
  const sink = (s = '') => { lines.push(String(s)); };
  return { logger: { info: sink, success: sink, error: sink, warn: sink, debug: sink, newline: () => lines.push(''), plain: sink } };
});
vi.mock('../../src/utils/env', () => ({
  loadDotEnvIfPresent: vi.fn(),
  isCI: vi.fn().mockReturnValue(false),
}));

import { statusCommand } from '../../src/commands/status';

const normalize = (ls: string[]) =>
  ls.join('\n')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '<ts>');

describe('golden: status (offline)', () => {
  beforeEach(() => { lines.length = 0; });

  it('renders a stable offline status report for the sample course', async () => {
    await statusCommand({ config: 'test/fixtures/sample-course/vocareum.yaml', root: 'test/fixtures/sample-course' });
    expect(normalize(lines)).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run to generate the snapshot**

Run: `npx vitest run test/golden/status.golden.test.ts`
Expected: PASS — writes `test/golden/__snapshots__/status.golden.test.ts.snap`. **Open the snapshot and sanity-check it reflects today's real status output** (org/course line, assignment counts). This snapshot is the contract.

- [ ] **Step 3: Commit**

```bash
git add test/golden/status.golden.test.ts test/golden/__snapshots__/
git commit -m "test: golden characterization test for status (baseline)"
```

### Task 3: Golden test — `push` API-call sequence + result

**Files:**
- Create: `test/golden/push.golden.test.ts`

**Interfaces:**
- Consumes: `publishCommand` ([src/commands/publish.ts](../../../src/commands/publish.ts)), `RecordingClient` (Task 1). Mocks mirror [test/integration/publish.test.ts](../../../test/integration/publish.test.ts) (config/logger/env/files/git/prompts/client all mocked).
- Produces: a baseline of the **method+path sequence** and rendered lines for a representative push (one assignment with IDs, one changed directory).

- [ ] **Step 1: Write the characterization test**

```ts
// test/golden/push.golden.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecordingClient } from '../helpers/recording-client';
import type { Config } from '../../src/types/config';

const lines: string[] = [];
const recorder = new RecordingClient();

vi.mock('../../src/utils/logger', () => {
  const sink = (s = '') => { lines.push(String(s)); };
  return { logger: { info: sink, success: sink, error: sink, warn: sink, debug: sink, newline: () => lines.push(''), plain: sink } };
});
vi.mock('../../src/utils/env', () => ({
  loadDotEnvIfPresent: vi.fn(), isCI: vi.fn().mockReturnValue(true),
  getApiKeyOrThrow: vi.fn().mockReturnValue('k'), getOAuthClientId: vi.fn(), getOAuthClientSecret: vi.fn(),
  getAuthModeEnv: vi.fn(), getV3ApiBaseUrl: vi.fn().mockReturnValue('https://labs.vocareum.com/api/v3'),
  getOAuthTokenUrl: vi.fn().mockReturnValue('https://labs.vocareum.com/api/v3/oauth/token'),
}));
vi.mock('../../src/core/config', () => ({
  loadConfig: vi.fn(),
  updateConfig: vi.fn(),
  withConfigLock: vi.fn((_p: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../src/api/client', async (orig) => ({
  ...(await orig<typeof import('../../src/api/client')>()),
  VocareumClient: vi.fn().mockImplementation(() => recorder),
}));
vi.mock('../../src/utils/prompts', () => ({ promptConfirm: vi.fn().mockResolvedValue(true) }));

import { publishCommand } from '../../src/commands/publish';
import { loadConfig } from '../../src/core/config';

const sampleConfig: Config = {
  version: '1.0',
  vocareum: { org_id: '347', course_id: '22180', architecture: 'elite', templates: [], template_assignment_ids: [], excluded_assignments: [], api_base_url: 'https://api.vocareum.com' },
  assignments: [{ assignment_id: '900', name: 'Lab 1', path: 'lab1', parts: [{ part_id: '901', path: 'part1' }] }],
  publish_history: [],
} as unknown as Config;

describe('golden: push', () => {
  beforeEach(() => { lines.length = 0; recorder.calls.length = 0; });

  it('produces a stable API-call sequence + output for a no-change push', async () => {
    (loadConfig as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(sampleConfig);
    // enqueue whatever GETs the reconcile path performs; fill iteratively until green
    recorder.enqueue({ assignments: [{ id: '900', name: 'Lab 1' }], total_records: 1 });
    recorder.enqueue({ parts: [{ part_id: '901', seqnum: '0', name: 'part1' }] });
    await publishCommand({ config: 'vocareum.yaml', nonInteractive: true });
    expect({ sequence: recorder.sequence(), output: lines }).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run, iterate enqueued responses until green, then snapshot**

Run: `npx vitest run test/golden/push.golden.test.ts`
Expected: initially FAIL with "no enqueued response for GET …" — add each missing response (mirror real API shapes from [test/integration/publish.test.ts](../../../test/integration/publish.test.ts)) until it passes and a snapshot is written. The captured `sequence` is the API-call contract the refactor must preserve.

- [ ] **Step 3: Commit**

```bash
git add test/golden/push.golden.test.ts test/golden/__snapshots__/
git commit -m "test: golden characterization test for push (API sequence + output)"
```

### Task 4: Golden tests — `validate` (offline) and `pull --batch`

**Files:**
- Create: `test/golden/validate.golden.test.ts`, `test/golden/pull-batch.golden.test.ts`

**Interfaces:**
- Consumes: `validateCommand`, `pullCommand`, `RecordingClient`.
- Produces: baselines for offline validate (no API) and `pull --batch` (non-interactive resolver path; records API sequence + import side effects via mocked `files`).

- [ ] **Step 1: Write `validate` golden test** (offline; mock logger + env like Task 2; call `validateCommand({ config, root })` against the sample fixture; `expect(normalize(lines)).toMatchSnapshot()`).

- [ ] **Step 2: Write `pull-batch` golden test** (mock like Task 3 but set `batch: true`, mock `../../src/utils/files` and `../../src/utils/git` as in [test/integration/pull.test.ts](../../../test/integration/pull.test.ts); enqueue orphan-listing responses; snapshot `{ sequence, output }`).

- [ ] **Step 3: Run both, iterate enqueues until green, snapshot**

Run: `npx vitest run test/golden/validate.golden.test.ts test/golden/pull-batch.golden.test.ts`
Expected: PASS with snapshots written. Sanity-check both snapshots.

- [ ] **Step 4: Commit**

```bash
git add test/golden/ && git commit -m "test: golden characterization tests for validate + pull --batch (baseline)"
```

---

## Phase 1 — Behavior-preserving primitives (land unused)

Each task adds a new module or an additive parameter with its own unit test. No command behavior changes; Phase 0 goldens must stay green.

### Task 5: `EventSink` + CLI and collecting sinks

**Files:**
- Create: `src/core/services/event-sink.ts`
- Test: `test/unit/event-sink.test.ts`

**Interfaces:**
- Produces:
  - `interface ServiceEvent { level: 'info'|'success'|'warn'|'error'|'debug'|'plain'|'newline'; code?: string; message?: string; data?: unknown }`
  - `interface EventSink { emit(e: ServiceEvent): void }`
  - `class LoggerEventSink implements EventSink` — renders each event through the existing `logger` (preserving today's output formatting).
  - `class CollectingEventSink implements EventSink` — buffers events in a public `events: ServiceEvent[]`; `flushTo(sink: EventSink): void` replays them (used by Stage 1b to group per-course output).
- Consumes: `logger` from `src/utils/logger` (LoggerEventSink only).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/event-sink.test.ts
import { describe, it, expect, vi } from 'vitest';
const calls: Array<[string, unknown]> = [];
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: (m: string) => calls.push(['info', m]), success: (m: string) => calls.push(['success', m]),
    warn: (m: string) => calls.push(['warn', m]), error: (m: string) => calls.push(['error', m]),
    debug: (m: string) => calls.push(['debug', m]), plain: (m: string) => calls.push(['plain', m]),
    newline: () => calls.push(['newline', '']),
  },
}));
import { LoggerEventSink, CollectingEventSink } from '../../src/core/services/event-sink';

describe('event sinks', () => {
  it('LoggerEventSink maps events to logger methods', () => {
    calls.length = 0;
    new LoggerEventSink().emit({ level: 'info', message: 'hi' });
    new LoggerEventSink().emit({ level: 'newline' });
    expect(calls).toEqual([['info', 'hi'], ['newline', '']]);
  });
  it('CollectingEventSink buffers then replays in order', () => {
    calls.length = 0;
    const c = new CollectingEventSink();
    c.emit({ level: 'success', message: 'done' });
    expect(c.events).toHaveLength(1);
    c.flushTo(new LoggerEventSink());
    expect(calls).toEqual([['success', 'done']]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/event-sink.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/services/event-sink.ts
import { logger } from '../../utils/logger';

export interface ServiceEvent {
  level: 'info' | 'success' | 'warn' | 'error' | 'debug' | 'plain' | 'newline';
  code?: string;
  message?: string;
  data?: unknown;
}

export interface EventSink { emit(event: ServiceEvent): void; }

export class LoggerEventSink implements EventSink {
  emit(e: ServiceEvent): void {
    const msg = e.message ?? '';
    switch (e.level) {
      case 'info': logger.info(msg); break;
      case 'success': logger.success(msg); break;
      case 'warn': logger.warn(msg); break;
      case 'error': logger.error(msg); break;
      case 'debug': logger.debug(msg); break;
      case 'plain': logger.plain(msg); break;
      case 'newline': logger.newline(); break;
    }
  }
}

export class CollectingEventSink implements EventSink {
  readonly events: ServiceEvent[] = [];
  emit(e: ServiceEvent): void { this.events.push(e); }
  flushTo(sink: EventSink): void { for (const e of this.events) { sink.emit(e); } }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/event-sink.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/event-sink.ts test/unit/event-sink.test.ts
git commit -m "feat: add EventSink with logger-rendering and collecting implementations"
```

### Task 6: Injected scheduler parameter on `VocareumClient`

**Files:**
- Modify: `src/api/client.ts:318-322` (constructor)
- Test: `test/unit/client-scheduler.test.ts`

**Interfaces:**
- Produces: `new VocareumClient(authProvider, throttle?, scheduler?)` — when `scheduler` is provided it is used; otherwise the client constructs its own (today's behavior, default-preserving).
- Consumes: `RequestScheduler` ([src/api/scheduler.ts](../../../src/api/scheduler.ts)).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/client-scheduler.test.ts
import { describe, it, expect } from 'vitest';
import { VocareumClient } from '../../src/api/client';
import { RequestScheduler } from '../../src/api/scheduler';
import { TokenAuthProvider } from '../../src/api/auth/token-auth-provider';

describe('VocareumClient scheduler injection', () => {
  it('uses an injected scheduler when provided', () => {
    const shared = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 0, jitter: false });
    const c = new VocareumClient(new TokenAuthProvider('t', 'https://api.vocareum.com'), undefined, shared);
    expect((c as unknown as { scheduler: RequestScheduler }).scheduler).toBe(shared);
  });
  it('constructs its own scheduler when none injected (default preserved)', () => {
    const c = new VocareumClient(new TokenAuthProvider('t', 'https://api.vocareum.com'));
    expect((c as unknown as { scheduler: RequestScheduler }).scheduler).toBeInstanceOf(RequestScheduler);
  });
});
```

> Verify `RequestScheduler`'s constructor option names against [src/api/scheduler.ts:30](../../../src/api/scheduler.ts#L30) before running; adjust the `{maxConcurrency,...}` literal to match.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/client-scheduler.test.ts`
Expected: FAIL — constructor ignores the 3rd argument.

- [ ] **Step 3: Implement** — change the constructor:

```ts
// src/api/client.ts (constructor)
constructor(
  authProvider: AuthProvider,
  throttle: ResolvedThrottle = DEFAULT_THROTTLE,
  scheduler?: RequestScheduler,
) {
  assertAllowedBaseUrl(authProvider.apiBaseUrl);
  this.authProvider = authProvider;
  this.scheduler = scheduler ?? new RequestScheduler(throttle);
  // …rest unchanged…
}
```

- [ ] **Step 4: Run tests (unit + Phase 0 goldens)**

Run: `npx vitest run test/unit/client-scheduler.test.ts test/golden/`
Expected: PASS — goldens unchanged (default path preserved).

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts test/unit/client-scheduler.test.ts
git commit -m "feat: allow injecting a shared RequestScheduler into VocareumClient (default preserved)"
```

### Task 7: Operation-specific contexts

**Files:**
- Create: `src/core/services/context.ts`
- Test: `test/unit/context.test.ts`

**Interfaces:**
- Produces (types only; no runtime logic beyond a builder):
  - `interface RuntimeFacts { ci: boolean; ciProvider?: string; authReady: boolean }`
  - `interface BaseContext { persistedConfig: Config; effectiveConfig: Config; configPath: string; workspaceRoot: string; events: EventSink; prompter: Prompter }`
  - `type StatusContext = BaseContext & { runtime: RuntimeFacts }`
  - `type ValidateContext = BaseContext`
  - `type PushContext = BaseContext & { client: VocareumClient }`
  - `type PullContext = BaseContext & { client: VocareumClient }`
  - `interface Prompter { confirm(msg: string, def?: boolean): Promise<boolean>; choice(msg: string, choices: string[]): Promise<string>; input(msg: string, def?: string): Promise<string> }`
  - `class InteractivePrompter implements Prompter` (delegates to `src/utils/prompts`), `class NonInteractivePrompter implements Prompter` (throws `UnresolvedDecisionError` on any call).
- Consumes: `Config`, `EventSink` (Task 5), `VocareumClient`, `src/utils/prompts`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/context.test.ts
import { describe, it, expect } from 'vitest';
import { NonInteractivePrompter, UnresolvedDecisionError } from '../../src/core/services/context';

describe('prompters', () => {
  it('NonInteractivePrompter throws a typed error on any decision', async () => {
    const p = new NonInteractivePrompter();
    await expect(p.confirm('ok?')).rejects.toBeInstanceOf(UnresolvedDecisionError);
    await expect(p.choice('pick', ['a'])).rejects.toBeInstanceOf(UnresolvedDecisionError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/core/services/context.ts` with the interfaces above, `InteractivePrompter` delegating to `prompt`/`promptConfirm`/`promptChoice` from `../../utils/prompts`, and:

```ts
export class UnresolvedDecisionError extends Error {
  constructor(public readonly decision: string) {
    super(`A decision ("${decision}") was required but the context is non-interactive and no policy resolved it.`);
    this.name = 'UnresolvedDecisionError';
  }
}
export class NonInteractivePrompter implements Prompter {
  confirm(): Promise<boolean> { return Promise.reject(new UnresolvedDecisionError('confirm')); }
  choice(): Promise<string> { return Promise.reject(new UnresolvedDecisionError('choice')); }
  input(): Promise<string> { return Promise.reject(new UnresolvedDecisionError('input')); }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/context.ts test/unit/context.test.ts
git commit -m "feat: add operation-specific service contexts + Prompter abstraction"
```

### Task 8: `withSession` locked-session writer

**Files:**
- Create: `src/core/services/session.ts`
- Test: `test/unit/session.test.ts`

**Interfaces:**
- Produces:
  - `interface LockedSession { applyConfigUpdate(updates: ConfigUpdates): Promise<void> }`
  - `function withSession<T>(configPath: string, fn: (s: LockedSession) => Promise<T>): Promise<T>` — acquires `withConfigLock(configPath)` ONCE and provides a session whose `applyConfigUpdate` delegates to `updateConfig(configPath, updates)` (which performs no locking of its own — [config.ts:140](../../../src/core/config.ts#L140)).
- Consumes: `withConfigLock`, `updateConfig`, `ConfigUpdates` from `src/core/config` / `src/types/config`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/session.test.ts
import { describe, it, expect, vi } from 'vitest';
const order: string[] = [];
vi.mock('../../src/core/config', () => ({
  withConfigLock: vi.fn(async (_p: string, fn: () => Promise<unknown>) => { order.push('lock'); const r = await fn(); order.push('unlock'); return r; }),
  updateConfig: vi.fn(async () => { order.push('update'); }),
}));
import { withSession } from '../../src/core/services/session';

describe('withSession', () => {
  it('acquires the lock once and delegates writes to updateConfig inside it', async () => {
    order.length = 0;
    await withSession('vocareum.yaml', async (s) => { await s.applyConfigUpdate({ publish_history: [] }); });
    expect(order).toEqual(['lock', 'update', 'unlock']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/services/session.ts
import { withConfigLock, updateConfig } from '../config';
import type { ConfigUpdates } from '../../types/config';

export interface LockedSession { applyConfigUpdate(updates: ConfigUpdates): Promise<void>; }

export function withSession<T>(configPath: string, fn: (s: LockedSession) => Promise<T>): Promise<T> {
  return withConfigLock(configPath, () => {
    const session: LockedSession = { applyConfigUpdate: (u) => updateConfig(configPath, u) };
    return fn(session);
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/session.ts test/unit/session.test.ts
git commit -m "feat: add withSession locked-session that delegates writes to updateConfig under one lock"
```

### Task 9: `semanticFingerprint` over a push change set

**Files:**
- Create: `src/core/services/plan-fingerprint.ts`
- Test: `test/unit/plan-fingerprint.test.ts`

**Interfaces:**
- Produces: `function semanticFingerprint(plan: { created: CreatedEntity[]; updated: UpdatedEntity[]; deleted?: DeletedEntity[] }): string` — a stable hash over the SET of (kind, assignment_id|path, part_id, directory) tuples, order-independent (sorted before hashing), ignoring incidental fields. Used by Stage 1b's replan policy.
- Consumes: `CreatedEntity`/`UpdatedEntity`/`DeletedEntity` from `src/types/state`; `createHash` from `node:crypto`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/plan-fingerprint.test.ts
import { describe, it, expect } from 'vitest';
import { semanticFingerprint } from '../../src/core/services/plan-fingerprint';

describe('semanticFingerprint', () => {
  it('is identical for the same change set regardless of order', () => {
    const a = { created: [{ assignment: 'lab1', parts: ['p1'] }], updated: [{ assignment: 'lab2', parts: ['p2'] }] };
    const b = { created: [{ assignment: 'lab1', parts: ['p1'] }], updated: [{ assignment: 'lab2', parts: ['p2'] }] };
    expect(semanticFingerprint(a as never)).toBe(semanticFingerprint(b as never));
  });
  it('differs when the change set differs', () => {
    const a = { created: [{ assignment: 'lab1', parts: ['p1'] }], updated: [] };
    const c = { created: [{ assignment: 'lab1', parts: ['p1', 'p2'] }], updated: [] };
    expect(semanticFingerprint(a as never)).not.toBe(semanticFingerprint(c as never));
  });
});
```

> Verify `CreatedEntity`/`UpdatedEntity` shapes against [src/types/state.ts](../../../src/types/state.ts) and adjust the tuple projection accordingly.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/plan-fingerprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** a function that projects each entity to a `kind:id:parts` string, sorts the array, joins, and returns `createHash('sha256').update(joined).digest('hex')`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/plan-fingerprint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/plan-fingerprint.ts test/unit/plan-fingerprint.test.ts
git commit -m "feat: add order-independent semanticFingerprint for push change sets"
```

---

## Phase 2 — Single top-level exit boundary

### Task 10: `CommandFailureError` + entrypoint `parseAsync` with one catch

**Files:**
- Create: `src/utils/command-failure.ts`
- Modify: `src/index.ts` — every `.action()` try/catch (lines 62-69, 97-104, 138-145, 172-179, 246-253, 286-293, 349-357) and `program.parse()` (line 359)
- Test: `test/unit/command-failure.test.ts`

**Interfaces:**
- Produces: `class CommandFailureError extends Error { constructor(message: string, public exitCode = 1) }`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/command-failure.test.ts
import { describe, it, expect } from 'vitest';
import { CommandFailureError } from '../../src/utils/command-failure';
describe('CommandFailureError', () => {
  it('carries a message and default exit code 1', () => {
    const e = new CommandFailureError('boom');
    expect(e.exitCode).toBe(1);
    expect(e.message).toBe('boom');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/command-failure.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `command-failure.ts`**, then rewrite each `.action()` to drop its `process.exit(1)` and instead throw, and replace the bottom of `index.ts`:

```ts
// each action becomes (example: push) — log then rethrow as a typed failure:
.action(async (options: PublishCommandOptions) => {
  try {
    await publishCommand(options);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Push failed: ${msg}`);
    throw new CommandFailureError(msg);
  }
});

// replace `program.parse();` (line 359) with:
program.parseAsync().catch((error) => {
  if (!(error instanceof CommandFailureError)) {
    logger.error(error instanceof Error ? error.message : 'Unknown error');
  }
  process.exitCode = error instanceof CommandFailureError ? error.exitCode : 1;
});
```

Apply the same throw-instead-of-exit transform to `init`, `new`, `validate`, `fix`, `pull`, `status` actions. **Add `import { CommandFailureError } from './utils/command-failure';`** near the other imports.

- [ ] **Step 4: Run full suite (goldens must stay green)**

Run: `npm test`
Expected: PASS — `process.exit` no longer in `src/index.ts` actions; goldens unchanged. (`status`/`validate` still set exit code via thrown `CommandFailureError` from their own internal failures — see Task 11/12 which remove their inline `process.exit`.)

- [ ] **Step 5: Commit**

```bash
git add src/utils/command-failure.ts src/index.ts test/unit/command-failure.test.ts
git commit -m "refactor: centralize exit handling in entrypoint via parseAsync + CommandFailureError"
```

### Task 11: Remove inline `process.exit` from `status`/`validate`/`fix`

**Files:**
- Modify: `src/commands/status.ts:162`, `src/commands/validate.ts:51-57`, `src/commands/fix.ts:88`

**Interfaces:**
- Produces: `statusCommand`/`validateCommand`/`fixCommand` that **throw `CommandFailureError`** (with the right exit code) instead of calling `process.exit`. Callers (entrypoint) already map thrown errors to exit codes (Task 10).

- [ ] **Step 1: Update the golden expectation for the exit path** — extend `test/golden/validate.golden.test.ts` with a case asserting that a `--strict` validation failure now **throws `CommandFailureError`** rather than exiting:

```ts
it('throws CommandFailureError (not process.exit) on strict failure', async () => {
  await expect(validateCommand({ config: 'test/fixtures/sample-course/vocareum.yaml', root: 'test/fixtures/sample-course', strict: true /* with an injected warning */ }))
    .rejects.toMatchObject({ name: 'CommandFailureError' });
});
```

> If the sample fixture has no warnings, point at a fixture that does, or stub the validator to emit one. Keep the existing offline snapshot test intact.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/golden/validate.golden.test.ts`
Expected: FAIL — currently calls `process.exit(1)` (which in tests throws/aborts differently), not `CommandFailureError`.

- [ ] **Step 3: Replace each `process.exit(n)`** with `throw new CommandFailureError(<message>, n)` (import the class). For `status.ts:162` (catch block) and `fix.ts:88`, do the same. Remove now-dead `try/catch`-then-exit scaffolding where the entrypoint already wraps.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: PASS — goldens green, new throw-path test green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/status.ts src/commands/validate.ts src/commands/fix.ts test/golden/validate.golden.test.ts
git commit -m "refactor: status/validate/fix throw CommandFailureError instead of process.exit"
```

---

## Phase 3 — Service extraction: offline reads (status, validate)

### Task 12: Extract `inspectStatus` service (offline)

**Files:**
- Create: `src/core/services/status-service.ts`
- Modify: `src/commands/status.ts` (becomes a thin wrapper)
- Test: `test/unit/status-service.test.ts`

**Interfaces:**
- Produces: `function inspectStatus(ctx: StatusContext): StatusReport` — pure, offline, no client, emits events via `ctx.events`, returns a `StatusReport` data object (move the computation currently in `statusCommand` here). Define `interface StatusReport` mirroring today's computed fields (assignment/part counts, linked counts, templates, last-push, git/env facts).
- Consumes: `StatusContext` (Task 7), `EventSink` (Task 5).

- [ ] **Step 1: Write the failing test** — construct a `StatusContext` over the sample config (with a `CollectingEventSink`), call `inspectStatus`, assert the returned `StatusReport` counts match the fixture and that emitted events include the org/course line.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/status-service.test.ts` → module not found.

- [ ] **Step 3: Implement** — move the body of `statusCommand` ([status.ts:37](../../../src/commands/status.ts#L37) onward) into `inspectStatus(ctx)`, replacing `logger.*` with `ctx.events.emit(...)` and reading config/runtime from `ctx`. Rewrite `statusCommand` to: resolve workspace, load config + runtime facts, build `StatusContext` with `LoggerEventSink` + `InteractivePrompter`, call `inspectStatus`, and (for `--json`) serialize the returned report.

- [ ] **Step 4: Run full suite** — `npm test`. Expected: the `status` golden snapshot is **unchanged** (LoggerEventSink reproduces today's output).

- [ ] **Step 5: Commit** — `git commit -m "refactor: extract inspectStatus offline service; status command becomes a wrapper"`

### Task 13: Extract `validateWorkspace` service (offline)

**Files:**
- Create: `src/core/services/validate-service.ts`
- Modify: `src/commands/validate.ts`, and `src/core/validator.ts` to accept an `EventSink` (it currently uses global `logger`)
- Test: `test/unit/validate-service.test.ts`

**Interfaces:**
- Produces: `function validateWorkspace(ctx: ValidateContext): ValidationReport` (offline) — returns `{ errors: string[]; warnings: string[] }`; emits events. The `--remote` (`--vocareum`) path stays in the command wrapper for now (online; out of Stage 1a's offline contract — keep its existing code path, just routed through a `PushContext`-like client if already present).
- Consumes: `ValidateContext`, `validator` core.

- [ ] **Step 1: Write the failing test** — call `validateWorkspace` over the sample fixture; assert `ValidationReport` shape and that a known structural problem (e.g. missing part dir) appears in `errors`/`warnings`.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — thread an `EventSink` parameter through `validator.ts`'s public functions (default to a `LoggerEventSink` to keep existing call sites working), move the orchestration from `validateCommand` into `validateWorkspace(ctx)`, and make `validateCommand` a wrapper that builds the context and throws `CommandFailureError` on `--strict` failures.

- [ ] **Step 4: Run full suite** — goldens unchanged.

- [ ] **Step 5: Commit** — `git commit -m "refactor: extract validateWorkspace offline service; thread EventSink through validator"`

---

## Phase 4 — Service extraction: push (plan/execute + session + event sink)

### Task 14: Split `publish()` into `planPush` + `executePush`; thread EventSink through publisher/reconciler/uploader

**Files:**
- Create: `src/core/services/push-service.ts`
- Modify: `src/core/publisher.ts` (split `publish` at [publisher.ts:255](../../../src/core/publisher.ts#L255)), `src/commands/publish.ts`, and add an `EventSink` param to `reconciler.ts`/`uploader.ts`/`publisher.ts` public functions (default `LoggerEventSink`).
- Test: `test/unit/push-service.test.ts`

**Interfaces:**
- Produces:
  - `function planPush(ctx: PushContext): Promise<PushPlan>` — READ-ONLY: reconcile + compute the change set; performs only GETs; no mutation, no state write. `interface PushPlan { created: CreatedEntity[]; updated: UpdatedEntity[]; skipped: SkippedEntity[]; deleted?: DeletedEntity[]; contentState: Record<string,string>; preconditions: { configDigest: string; contentHashes: Record<string,string>; assignmentIds: string[]; partIds: string[]; remoteAssumptions: unknown }; semanticFingerprint: string; summary: string }`.
  - `function executePush(session: LockedSession, ctx: PushContext, plan: PushPlan): Promise<PushResult>` — applies the change set and writes state via `session.applyConfigUpdate`. `PushResult` = today's `PublishResult` minus the planning fields.
- Consumes: `PushContext`, `LockedSession`, `semanticFingerprint`, `EventSink`, existing `reconcile`/`upload` core.

- [ ] **Step 1: Write the failing test** — using `RecordingClient`, build a `PushContext`; call `planPush` and assert (a) only GET calls were recorded (no PUT), (b) `plan.semanticFingerprint` is set, (c) `plan.preconditions.configDigest` is a non-empty string. Then call `executePush` inside a stubbed session and assert PUTs occur and `session.applyConfigUpdate` was called once.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement the split.** Extract the read/reconcile portion of `publish()` into `planPush` (compute `preconditions`: `configDigest` = hash of the persisted YAML text; `contentHashes` from the existing per-directory hashing; ids from config; `remoteAssumptions` = per-assignment existence + part list for assignments in the change set). Extract the mutate+write portion into `executePush`, replacing the inline `updateConfig(...)` ([publisher.ts:1001](../../../src/core/publisher.ts#L1001)) with `session.applyConfigUpdate(...)` and replacing `logger.*` with `ctx.events.emit(...)`. Thread the `EventSink` through `reconciler.ts`/`uploader.ts` public functions (default param `new LoggerEventSink()` so any remaining direct callers are unaffected).

- [ ] **Step 4: Rewire `publish()` as a thin back-compat shim** that calls `planPush` then `executePush` inside one `withSession` (so existing `publishCommand` and the integration test keep working unchanged):

```ts
export async function publish(config, client, options, reporter?) {
  const ctx = buildPushContextFromLegacyArgs(config, client, options, reporter); // LoggerEventSink + InteractivePrompter
  return withSession(ctx.configPath, async (session) => {
    const plan = await planPush(ctx);
    // confirmation stays in publishCommand (the wrapper), not here
    return executePush(session, ctx, plan);
  });
}
```

> The CLI confirmation (`promptConfirm`) must remain BETWEEN plan and execute and inside the single lock — keep it in `publishCommand`, which now calls `planPush` → confirm → `executePush` within one `withSession`. Update `publishCommand` accordingly so the golden API sequence (no extra GETs) is preserved.

- [ ] **Step 5: Run full suite — the push golden API-sequence snapshot MUST be unchanged.**

Run: `npm test`
Expected: PASS; `test/golden/push.golden.test.ts` snapshot identical. If the sequence changed, a re-fetch leaked onto the CLI path — fix before committing.

- [ ] **Step 6: Commit** — `git commit -m "refactor: split publish into planPush/executePush over a locked session; thread EventSink"`

---

## Phase 5 — Service extraction: pull (inspect/apply + resolver)

### Task 15: Extract `inspectPull` + `applyPull(session, ctx, inspection, resolver)`

**Files:**
- Create: `src/core/services/pull-service.ts`
- Modify: `src/commands/pull.ts` (becomes a wrapper that supplies the interactive resolver), thread `EventSink` where pull calls `logger`
- Test: `test/unit/pull-service.test.ts`

**Interfaces:**
- Produces:
  - `function inspectPull(ctx: PullContext): Promise<PullInspection>` — remote reconnaissance only (orphans, stale, settings drift, optional content drift); no prompts, no writes. `interface PullInspection { orphanedInVocareum: OrphanedEntity[]; stale: ...; settingsDrift: ...; preconditions: { configDigest: string } }`.
  - `type PullResolver = (issue: PullIssue) => Promise<PullDecision>` where `PullDecision = { action: 'import'|'exclude'|'skip'|'reset'|'remove'|'pull'|'keep'; dirName?: string }`.
  - `function applyPull(session: LockedSession, ctx: PullContext, inspection: PullInspection, resolver: PullResolver): Promise<PullResult>` — **iterates issues and calls `resolver` immediately before each action** (preserving today's prompt→import interleaving and `-N` dir allocation), writing via `session.applyConfigUpdate`.
- Consumes: `PullContext`, `LockedSession`, `EventSink`, existing import/download helpers in `pull.ts`.

- [ ] **Step 1: Write the failing test** — with `RecordingClient` + mocked `files`, build a `PullContext`; call `inspectPull` and assert it returns orphans with no writes; then call `applyPull` with a stub resolver returning `{action:'import'}` for the first orphan and `{action:'skip'}` for the rest, and assert the import happened for exactly the first and `session.applyConfigUpdate` was called.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement.** Move `pull.ts`'s detection logic into `inspectPull`. Move the per-issue loop ([pull.ts:1131](../../../src/commands/pull.ts#L1131)) into `applyPull`, replacing the inline `promptChoice`/`prompt` calls with `await resolver(issue)` invoked **inside** the loop right before each action, and `logger.*` with `ctx.events.emit`. The directory-name allocation (`getUniqueDirectoryName`) stays inside the loop, after the resolver decision, exactly as today.

- [ ] **Step 4: Rewrite `pullCommand` as the wrapper** that builds a `PullContext`, opens one `withSession`, calls `inspectPull` then `applyPull` with an **interactive resolver** that reproduces today's `promptChoice`/`prompt` exchanges (and a `--batch`/`--non-interactive` resolver matching today's defaults).

- [ ] **Step 5: Run full suite — `pull-batch` golden snapshot unchanged.**

Run: `npm test`
Expected: PASS; pull goldens identical (interleaving + API sequence preserved).

- [ ] **Step 6: Commit** — `git commit -m "refactor: extract inspectPull/applyPull with per-item resolver; pull command supplies resolver"`

---

## Phase 6 — Hardening: complete the event-sink boundary + CI guards

### Task 16: Thread EventSink through remaining business logic + add grep guards

**Files:**
- Modify: `src/utils/unknown-field-reporter.ts` (accept an `EventSink`, become a sink consumer), any residual `logger.*` calls under the push/pull/status/validate transitive graph
- Create: `test/unit/no-forbidden-imports.test.ts` (the CI guards)

**Interfaces:**
- Produces: a test that fails if forbidden patterns appear under `src/core/services/` or if `process.exit` appears outside `src/index.ts`.

- [ ] **Step 1: Write the guard test**

```ts
// test/unit/no-forbidden-imports.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('architecture guards', () => {
  it('no process.exit outside src/index.ts', () => {
    const offenders = walk('src').filter((f) => f !== 'src/index.ts' && /process\.exit\s*\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('src/core/services/ does not import logger, loadConfig, withConfigLock, or construct a client', () => {
    const offenders = walk('src/core/services').filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /from '.*utils\/logger'/.test(s) || /\bloadConfig\b/.test(s) || /\bwithConfigLock\b/.test(s) || /new VocareumClient\(/.test(s);
    });
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect failures listing every remaining offender.**

Run: `npx vitest run test/unit/no-forbidden-imports.test.ts`
Expected: FAIL — lists residual `logger`/`loadConfig`/etc. under services and any stray `process.exit`.

- [ ] **Step 3: Fix each offender** — convert `UnknownFieldReporter` to take an `EventSink`; replace remaining `logger.*` in service-graph modules with event emissions; ensure services receive config/client via context, not by importing loaders. For any global-`logger` call you intentionally leave (only on a non-concurrent path, e.g. a pre-fan-out banner in a CLI wrapper, which is NOT under `src/core/services/`), document it in a comment.

- [ ] **Step 4: Run full suite + typecheck + lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS — guards green, all goldens unchanged.

- [ ] **Step 5: Commit** — `git commit -m "refactor: complete EventSink threading; add architecture grep guards"`

### Task 17: GitHub Action smoke confirmation + release prep

**Files:**
- Modify: `CHANGELOG.md` (add Stage 1a entry), verify `.github/` Action smoke workflow still passes
- No code changes beyond docs

- [ ] **Step 1: Run the full suite once more, including integration tests**

Run: `npm test`
Expected: PASS — unit, golden, and `test/integration/{publish,pull,root-context}.test.ts` all green (these are the higher-level behavior guards).

- [ ] **Step 2: Add a CHANGELOG entry** describing the internal refactor (no user-facing change) and the new injected-scheduler capability.

- [ ] **Step 3: Commit** — `git commit -m "docs: changelog for Stage 1a service-layer refactor (no user-facing change)"`

- [ ] **Step 4: Canary note** — do NOT bump/publish here. Per spec §8, Stage 1a ships as its own release and soaks via a production canary before Stage 1b begins. Release (bump → commit → npm publish → Action tag) is a separate, explicit step per AGENTS.md constraint #10.

---

## Self-Review

**Spec coverage (spec §-by-§ → task):**
- §1 operation-specific contexts → Task 7; offline `status` no-client → Tasks 7, 12; `RuntimeFacts` → Task 7/12.
- §1 event sink + transitive scope (P1 #4) → Tasks 5, 13, 14, 15, 16.
- §2 locked session / `updateConfig` delegation (P0 #3) → Task 8; operation-specific contracts → Tasks 12–15; pull per-item resolver (P0 #1) → Task 15.
- §3 push plan/execute, CLI one-lock no-refetch (P0 #2 behavior), preconditions, `semanticFingerprint` (P0 #2) → Tasks 9, 14.
- §4 planning-failure policy → returns-as-data contracts (Tasks 14/15); the org-runner policy itself is Stage 1b (out of scope here, correctly).
- §5 single top-level exit, `parseAsync`, `CommandFailureError` (P2 #9) → Tasks 10, 11.
- §6 injected scheduler param → Task 6.
- §8 golden tests (stdout/stderr, exit, fs/config, prompts, API sequence) → Tasks 2–4 + preserved through 12–16; Action smoke + canary → Task 17.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — each task carries real code or exact targets. Three tasks (6, 9, 13/14 detail) include a "verify the real signature against file X" note because the exact upstream shape (scheduler options, entity fields) must be read at implementation time; the verification target is named, not deferred.

**Type consistency:** `EventSink`/`ServiceEvent` (Task 5) used identically in 12–16; `LockedSession.applyConfigUpdate` (Task 8) used in 14/15; `PushContext`/`PullContext`/`StatusContext` (Task 7) consumed in 12/13/14/15; `semanticFingerprint` (Task 9) consumed in 14; `CommandFailureError` (Task 10) consumed in 11. `publish()` is kept as a shim (Task 14) so the existing `test/integration/publish.test.ts` and `publishCommand` signatures remain valid.

**Known judgment calls for the executor:**
- Tasks 14–16 are the largest; if any single task's diff grows beyond one reviewable unit, split per-module (publisher, then reconciler, then uploader) keeping goldens green between splits.
- The exact `preconditions.remoteAssumptions` shape is minimal-by-design (per-assignment existence + part list for change-set assignments only); widen only if a golden reveals a missed assumption.
