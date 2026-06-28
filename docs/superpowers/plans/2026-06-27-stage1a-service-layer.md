# Stage 1a — Command/Service Layer Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `push`/`pull`/`status`/`validate` onto a behavior-preserving service layer (operation-specific contracts + request objects, a canonical push intent, a locked-session writer, an event sink, and a single top-level exit) so the Stage 1b org runner can drive many courses — with **zero observable change** to today's single-course CLI.

**Architecture:** Characterization (golden) tests are written **first** to lock current behavior across clean/changed/cancel/failure cases. Then additive primitives land unused (event sink with metadata, contexts + request objects, `withSession`, injected scheduler, `PushIntent` + intent fingerprint). Then the entrypoint moves to a single exit boundary without changing error text. Then each command is reshaped into services that take `(ctx, request)`, return data, emit events instead of rendering, and never call `process.exit`. The event sink is threaded through the transitive business-logic graph so Stage 1b output cannot interleave.

**Tech Stack:** TypeScript (strict), Node ≥18, Commander, vitest (`vi.mock`), js-yaml, zod, axios.

**Spec:** [docs/superpowers/specs/2026-06-26-stage1a-service-layer-design.md](../specs/2026-06-26-stage1a-service-layer-design.md)

## Global Constraints

- All IDs are strings, never numbers.
- No `console.log` in `src/`; rendering goes through `logger` (CLI wrappers only) — services emit to the **event sink**.
- No `process.exit` anywhere except `src/index.ts` (CI grep guard, Task 16).
- No `logger`, `loadConfig`, `process.cwd()`, `loadDotEnvIfPresent`, `new VocareumClient(...)`, or `withConfigLock` inside `src/core/services/` (CI grep guards, Task 16). **The lock owner `withSession` lives at `src/core/session.ts` — OUTSIDE `src/core/services/`** (resolves the Task 8↔16 contradiction, review P0 #5).
- TypeScript strict mode (`npm run typecheck`) and eslint (`npm run lint`) must pass.
- **Behavior preservation is THE acceptance criterion:** the Phase 0 golden tests stay byte-for-byte green through every later task — normalized stdout/stderr, exit code, filesystem/config result, prompt sequence, and **API-call sequence including normalized query strings** (query params are preserved, not discarded — pagination must remain visible; only volatile tokens are normalized). A golden change is a bug unless the spec sanctions it.
- `vocareum.yaml` schema unchanged in Stage 1a; no org schema/selectors/multi-course code (Stage 1b).
- `init`/`new`/`fix` are NOT service-refactored; only their `process.exit` moves to the entrypoint (Phase 2).
- Commit after every task; run `npm test` before each commit.

### Canonical types (defined once; referenced by many tasks)

These are the contract spine. Exact field shapes are pinned here so later tasks stay consistent.

```ts
// src/core/services/types.ts (Task 7 creates this)

// Per-invocation options (NOT in the context — the context is the durable
// environment; the request is what this call does). Mirror today's options.
export interface PushRequest {
  dryRun?: boolean; nonInteractive?: boolean; autoCommit?: boolean;
  syncDeletes?: boolean; onMissingId?: 'skip' | 'abort'; abortOnError?: boolean;
  assignment?: string; part?: string; forceAll?: boolean; verbose?: boolean;
}
export interface PullRequest {
  batch?: boolean; nonInteractive?: boolean; skipContent?: boolean;
  content?: boolean; assignment?: string[]; part?: string[]; verbose?: boolean;
}

// Canonical, immutable description of EVERY intended mutation (review P0 #1/#3).
// Derived from the reconciliation plan; this — not result types — is what the
// fingerprint hashes and what executePush consumes.
export type AssignmentAction = 'create' | 'update' | 'skip';
export interface PartIntent {
  partId: string | null;                       // null = to be created
  path: string;
  settingsPayload?: Record<string, unknown>;   // canonical settings to PUT
  contentHashes: Record<string, string>;       // per-directory hash of intended upload
  deletePaths?: string[];                       // files to delete (sync-deletes)
}
export interface AssignmentIntent {
  path: string;
  assignmentId: string | null;                 // null = create-from-template
  templateAssignmentId?: string;               // template identity for creation
  action: AssignmentAction;
  settingsPayload?: Record<string, unknown>;
  parts: PartIntent[];
}
export interface PushIntent { assignments: AssignmentIntent[]; }

export interface RemoteAssumption {
  assignmentPath: string;
  assignmentId: string | null;
  exists: boolean;                             // false for a planned create (duplicate guard)
  partIds: string[];
}
export interface PushPreconditions {
  configDigest: string;                        // hash of persisted YAML text
  contentHashes: Record<string, string>;       // local dir hashes plan was computed from
  assignmentIds: string[];
  partIds: string[];
  remoteAssumptions: RemoteAssumption[];
}
export interface PushPlan {
  intent: PushIntent;
  preconditions: PushPreconditions;
  semanticFingerprint: string;                 // hash of the WHOLE intent (Task 9)
  summary: string;
}
```

---

## Phase 0 — Characterization harness (the regression net)

### Task 1: Recording API client double (query strings preserved)

**Files:**
- Create: `test/helpers/recording-client.ts`
- Test: `test/helpers/recording-client.test.ts`

**Interfaces:**
- Produces: `class RecordingClient` with `request(config): Promise<T>` pushing `{method, url}` onto public `calls`; `enqueue(response)`; `sequence(): string[]` returning `` `${method} ${normalizedUrl}` `` where normalization **keeps query params** but replaces volatile token values (e.g. `client_secret`, `token`) with `<redacted>` (P1 #6 — pagination like `?page=2` must stay visible).
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```ts
// test/helpers/recording-client.test.ts
import { describe, it, expect } from 'vitest';
import { RecordingClient } from './recording-client';

describe('RecordingClient', () => {
  it('records method+path, KEEPS query params, returns enqueued responses in order', async () => {
    const c = new RecordingClient();
    c.enqueue({ a: 1 }); c.enqueue({ b: 2 });
    await c.request({ method: 'GET', url: '/courses/1/assignments?page=2&size=10' });
    await c.request({ method: 'PUT', url: '/courses/1' });
    expect(c.sequence()).toEqual(['GET /courses/1/assignments?page=2&size=10', 'PUT /courses/1']);
  });
  it('redacts volatile token params but keeps the key present', async () => {
    const c = new RecordingClient(); c.enqueue({});
    await c.request({ method: 'POST', url: '/oauth/token?client_secret=abc123' });
    expect(c.sequence()).toEqual(['POST /oauth/token?client_secret=<redacted>']);
  });
  it('throws when no response is enqueued', async () => {
    await expect(new RecordingClient().request({ method: 'GET', url: '/x' })).rejects.toThrow(/no enqueued response/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/helpers/recording-client.test.ts` → module not found.

- [ ] **Step 3: Implement** — `calls` + `enqueue`; `sequence()` parses the URL, sorts query keys, replaces values of a `VOLATILE = new Set(['client_secret','client_id','token','access_token'])` with `<redacted>`, and re-serializes `path?k=v&...`. `request` throws `RecordingClient: no enqueued response for ${method} ${url}` when empty.

- [ ] **Step 4: Run to verify it passes** — same command → PASS (3 tests).

- [ ] **Step 5: Commit** — `git commit -m "test: add RecordingClient double preserving normalized query strings"`

### Task 2: Golden tests — `status` human + `status --json` purity

**Files:** Create `test/golden/status.golden.test.ts`. Uses `test/fixtures/sample-course/`.

**Interfaces:** Consumes `statusCommand`. Captures (a) human output snapshot, (b) **`--json` stdout is a single valid JSON document with no human lines** (P1 #7).

- [ ] **Step 1: Write the characterization tests**

```ts
// test/golden/status.golden.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const out: string[] = []; const err: string[] = [];
vi.mock('../../src/utils/logger', () => {
  const o = (s = '') => out.push(String(s)); const e = (s = '') => err.push(String(s));
  return { logger: { info: o, success: o, plain: o, newline: () => out.push(''), warn: e, error: e, debug: e } };
});
vi.mock('../../src/utils/env', () => ({ loadDotEnvIfPresent: vi.fn(), isCI: () => false, getAuthModeEnv: () => undefined, getOAuthClientId: () => undefined, getOAuthClientSecret: () => undefined, getCIProvider: () => undefined }));
import { statusCommand } from '../../src/commands/status';
const norm = (ls: string[]) => ls.join('\n').replace(/\b[0-9a-f]{7,40}\b/g, '<sha>').replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '<ts>');
const FIX = { config: 'test/fixtures/sample-course/vocareum.yaml', root: 'test/fixtures/sample-course' };

describe('golden: status', () => {
  beforeEach(() => { out.length = 0; err.length = 0; });
  it('human output is stable', async () => { await statusCommand({ ...FIX }); expect(norm(out)).toMatchSnapshot(); });
  it('--json emits exactly one valid JSON doc and no human lines', async () => {
    const json: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { json.push(String(s)); return true; });
    await statusCommand({ ...FIX, json: true });
    spy.mockRestore();
    const printed = json.join('');
    expect(() => JSON.parse(printed)).not.toThrow();           // purity
    expect(out.filter((l) => l.trim() !== '')).toEqual([]);    // no human lines on the JSON path
  });
});
```

> If `statusCommand` writes JSON via `logger.plain` rather than `process.stdout.write`, adapt the capture to whichever it uses today — the assertion (one valid JSON doc, no extra human lines) is the contract.

- [ ] **Step 2: Run to generate snapshots** — `npx vitest run test/golden/status.golden.test.ts` → PASS; inspect the snapshot. **This pins JSON purity BEFORE the Task 12 refactor.**

- [ ] **Step 3: Commit** — `git commit -m "test: golden status human + json-purity baseline"`

### Task 3: Golden tests — `push` (changed, cancel, failure/history)

**Files:** Create `test/golden/push.golden.test.ts`. Mocks mirror [test/integration/publish.test.ts](../../../test/integration/publish.test.ts).

**Interfaces:** Consumes `publishCommand`, `RecordingClient`. Captures the **method+path(+query) sequence** and rendered output for three cases (P1 #6): (a) a push with a **changed** directory (real PUTs), (b) **cancel** at the confirm prompt (no PUTs), (c) a **failed** upload (failure recorded in history, exit path).

- [ ] **Step 1: Write the three characterization cases** — build a `Config` with one assignment/part; for (a) make `readLocalDirectory` return content whose hash differs from `publish_history` so a PUT occurs; for (b) mock `promptConfirm` → `false` and assert `recorder.sequence()` contains no `PUT`; for (c) enqueue an error/empty for an upload PUT and assert the failure appears in the rendered output and the run reports failure. Snapshot `{ sequence, output }` per case.

- [ ] **Step 2: Run, iterate enqueued responses until green, snapshot** — `npx vitest run test/golden/push.golden.test.ts`. Fill missing responses (mirror real shapes) until PASS; sanity-check each snapshot shows the intended behavior (PUT present in (a), absent in (b), failure in (c)).

- [ ] **Step 3: Commit** — `git commit -m "test: golden push baselines (changed, cancel, failure)"`

### Task 4: Golden tests — `validate` (pass + strict-fail) and `pull` (interactive ordering + batch)

**Files:** Create `test/golden/validate.golden.test.ts`, `test/golden/pull.golden.test.ts`.

**Interfaces:** Consumes `validateCommand`, `pullCommand`, `RecordingClient`. Captures: validate clean snapshot + a `--strict` failure case (asserted via thrown error AFTER Task 11; pre-Task-11 it documents today's `process.exit` — see note); **interactive pull** that prompts orphan-by-orphan and imports each before the next (assert the interleaved order of prompt vs import via a shared event log); **`pull --batch`** sequence + import side effects.

- [ ] **Step 1: Write validate clean snapshot** (offline, mock logger/env; snapshot normalized output).

- [ ] **Step 2: Write interactive-pull ordering test** — mock `promptChoice`/`prompt` (from `src/utils/prompts`) to push markers onto a shared `events[]` array, and mock `importAssignment` (via the `files`/client mocks) to push an `import:<name>` marker; with two orphans, assert `events` is `[prompt#1, import#1, prompt#2, import#2]` (today's interleaving — the P0 #4 contract).

- [ ] **Step 3: Write `pull --batch` test** — snapshot `{ sequence, output }`.

- [ ] **Step 4: Run all, iterate enqueues until green, snapshot.** For the validate strict-fail case, write it to capture today's behavior; mark it `it.todo`-style with a comment that Task 11 converts it to `rejects → CommandFailureError`.

- [ ] **Step 5: Commit** — `git commit -m "test: golden validate + pull (interactive ordering, batch) baselines"`

---

## Phase 1 — Behavior-preserving primitives

### Task 5: `EventSink` with metadata forwarding

**Files:** Create `src/core/services/event-sink.ts`; Test `test/unit/event-sink.test.ts`.

**Interfaces:** Produces `ServiceEvent { level; code?; message?; data?: unknown }`, `EventSink`, `LoggerEventSink` (renders via `logger`, **forwarding `data` to `error`/`warn`/`debug` as the `meta` arg** — P1 #8), `CollectingEventSink` (buffers `events`, `flushTo(sink)`).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/event-sink.test.ts
import { describe, it, expect, vi } from 'vitest';
const calls: Array<[string, unknown, unknown]> = [];
vi.mock('../../src/utils/logger', () => ({ logger: {
  info: (m: string) => calls.push(['info', m, undefined]),
  success: (m: string) => calls.push(['success', m, undefined]),
  warn: (m: string, meta?: unknown) => calls.push(['warn', m, meta]),
  error: (m: string, meta?: unknown) => calls.push(['error', m, meta]),
  debug: (m: string, meta?: unknown) => calls.push(['debug', m, meta]),
  plain: (m: string) => calls.push(['plain', m, undefined]),
  newline: () => calls.push(['newline', '', undefined]),
} }));
import { LoggerEventSink, CollectingEventSink } from '../../src/core/services/event-sink';

describe('event sinks', () => {
  it('forwards data as meta for error/warn/debug (P1 #8)', () => {
    calls.length = 0;
    const s = new LoggerEventSink();
    s.emit({ level: 'error', message: 'boom', data: { file: 'x' } });
    s.emit({ level: 'debug', message: 'dbg', data: { n: 1 } });
    expect(calls).toEqual([['error', 'boom', { file: 'x' }], ['debug', 'dbg', { n: 1 }]]);
  });
  it('CollectingEventSink buffers then replays', () => {
    calls.length = 0; const c = new CollectingEventSink();
    c.emit({ level: 'success', message: 'done' }); c.flushTo(new LoggerEventSink());
    expect(calls).toEqual([['success', 'done', undefined]]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — `LoggerEventSink.emit` maps level→method; for `error`/`warn`/`debug` pass `e.data` as the second arg; `info`/`success`/`plain` pass message only; `newline` calls `logger.newline()`.

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit** — `git commit -m "feat: EventSink with metadata forwarding + collecting sink"`

### Task 6: Injected scheduler parameter on `VocareumClient`

**Files:** Modify `src/api/client.ts:318-322`; Test `test/unit/client-scheduler.test.ts`.

**Interfaces:** Produces `new VocareumClient(authProvider, throttle?, scheduler?)` — uses injected `scheduler` if given, else constructs its own (default preserved).

- [ ] **Step 1: Write the failing test** — assert injected scheduler is used (`(c as any).scheduler === shared`) and default path constructs a `RequestScheduler`. (Verify `RequestScheduler` option names against [scheduler.ts:30](../../../src/api/scheduler.ts#L30).)
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — add optional 3rd param; `this.scheduler = scheduler ?? new RequestScheduler(throttle)`.
- [ ] **Step 4: Run unit + `test/golden/` — goldens unchanged.**
- [ ] **Step 5: Commit** — `git commit -m "feat: allow injecting a shared RequestScheduler (default preserved)"`

### Task 7: Contexts, request objects, prompter, RuntimeFacts

**Files:** Create `src/core/services/types.ts` (the canonical types block from Global Constraints) and `src/core/services/context.ts`; Test `test/unit/context.test.ts`.

**Interfaces:** Produces:
- `types.ts`: `PushRequest`, `PullRequest`, `PushIntent`/`AssignmentIntent`/`PartIntent`, `PushPlan`/`PushPreconditions`/`RemoteAssumption` (verbatim from Global Constraints).
- `context.ts`:
  - `interface RuntimeFacts { ci: boolean; ciProvider?: string; authMode: 'token'|'oauth'; credentialLabel: string; credentialsConfigured: boolean }` (P1 #7 — includes auth mode/label/readiness).
  - `interface BaseContext { persistedConfig: Config; effectiveConfig: Config; configPath: string; workspaceRoot: string; events: EventSink; prompter: Prompter }`
  - `StatusContext = BaseContext & { runtime: RuntimeFacts }`, `ValidateContext = BaseContext`, `PushContext = BaseContext & { client: VocareumClient }`, `PullContext = BaseContext & { client: VocareumClient }`.
  - `interface Prompter { confirm(msg, def?): Promise<boolean>; choice(msg, choices): Promise<string>; input(msg, def?): Promise<string> }`; `InteractivePrompter` (delegates to `src/utils/prompts`), `NonInteractivePrompter` (throws `UnresolvedDecisionError`).

- [ ] **Step 1: Write the failing test** — `NonInteractivePrompter` rejects `confirm`/`choice`/`input` with `UnresolvedDecisionError`; a `RuntimeFacts` literal type-checks with `authMode`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat: service contexts + request objects + Prompter + RuntimeFacts(authMode)"`

### Task 8: `withSession` locked-session writer — at `src/core/session.ts`

**Files:** Create `src/core/session.ts` (**not** under `services/` — P0 #5); Test `test/unit/session.test.ts`.

**Interfaces:** Produces `interface LockedSession { applyConfigUpdate(updates: ConfigUpdates): Promise<void> }` and `withSession<T>(configPath, fn): Promise<T>` — acquires `withConfigLock` once; `applyConfigUpdate` delegates to `updateConfig` (no own lock — [config.ts:140](../../../src/core/config.ts#L140)).

- [ ] **Step 1: Write the failing test** — assert order `['lock','update','unlock']` (mock `src/core/config`).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** in `src/core/session.ts` importing `withConfigLock`/`updateConfig` from `./config`.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat: withSession lock owner at src/core/session.ts (outside services/)"`

### Task 9: `semanticFingerprint(intent: PushIntent)` over the full intent

**Files:** Create `src/core/services/plan-fingerprint.ts`; Test `test/unit/plan-fingerprint.test.ts`.

**Interfaces:** Produces `function semanticFingerprint(intent: PushIntent): string` — canonicalizes the WHOLE intent (assignment action, ids, template id, settings payloads, per-directory content hashes, delete paths; sorted for order-independence) and SHA-256s it (P0 #1 — content/settings/deletes/template all participate, so a changed file flips the fingerprint).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/plan-fingerprint.test.ts
import { describe, it, expect } from 'vitest';
import { semanticFingerprint } from '../../src/core/services/plan-fingerprint';
import type { PushIntent } from '../../src/core/services/types';

const base: PushIntent = { assignments: [{ path: 'lab1', assignmentId: '900', action: 'update', parts: [
  { partId: '901', path: 'part1', contentHashes: { startercode: 'h1' }, settingsPayload: { nosubmit: false } },
]}]};

describe('semanticFingerprint', () => {
  it('is order-independent for the same intent', () => {
    const reordered: PushIntent = { assignments: [{ ...base.assignments[0],
      parts: [{ ...base.assignments[0].parts[0] }] }] };
    expect(semanticFingerprint(base)).toBe(semanticFingerprint(reordered));
  });
  it('changes when a content hash changes (P0 #1)', () => {
    const changed: PushIntent = JSON.parse(JSON.stringify(base));
    changed.assignments[0].parts[0].contentHashes.startercode = 'h2';
    expect(semanticFingerprint(base)).not.toBe(semanticFingerprint(changed));
  });
  it('changes when a settings payload changes', () => {
    const changed: PushIntent = JSON.parse(JSON.stringify(base));
    changed.assignments[0].parts[0].settingsPayload = { nosubmit: true };
    expect(semanticFingerprint(base)).not.toBe(semanticFingerprint(changed));
  });
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — a deterministic canonicalizer: recursively sort object keys, sort assignment/part arrays by `path`, JSON.stringify, `createHash('sha256')`.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat: semanticFingerprint over full PushIntent (content+settings+deletes+template)"`

---

## Phase 2 — Single top-level exit boundary

### Task 10: `CommandFailureError` + entrypoint `parseAsync`, one error owner per path

**Files:** Create `src/utils/command-failure.ts`; Modify `src/index.ts`; Test `test/unit/command-failure.test.ts` + `test/integration/exit-codes.test.ts`.

**Interfaces:** Produces `class CommandFailureError extends Error { constructor(message, public exitCode = 1) }`. Entrypoint owns exit-code mapping; **does not re-log a `CommandFailureError` that a command already rendered** (P1 #9).

- [ ] **Step 1: Write the failing unit + subprocess tests**

```ts
// test/integration/exit-codes.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
const run = (args: string[]) => {
  try { execFileSync('node', ['dist/index.js', ...args], { stdio: 'pipe' }); return { code: 0, stderr: '' }; }
  catch (e: any) { return { code: e.status as number, stderr: String(e.stderr) }; }
};
describe('exit codes (subprocess)', () => {
  it('exits non-zero with a single error line on a missing config', () => {
    const r = run(['status', '--config', 'definitely-missing.yaml']);
    expect(r.code).not.toBe(0);
    expect((r.stderr.match(/not found/gi) || []).length).toBeLessThanOrEqual(1); // no double-log
  });
});
```

> Requires `npm run build` first. The CommandFailureError unit test asserts default `exitCode === 1`.

- [ ] **Step 2: Run to verify it fails** — `npm run build && npx vitest run test/integration/exit-codes.test.ts` (today: double "Status failed"/error text or `process.exit` semantics differ).

- [ ] **Step 3: Implement.** Define the class. In each `.action()`: keep the command's own logging where it already exists; map a failure to `throw new CommandFailureError(msg)` **preserving exit code**, and **rethrow an existing `CommandFailureError` unchanged** (don't wrap twice). Replace `program.parse()`:

```ts
program.parseAsync().catch((error) => {
  if (error instanceof CommandFailureError) {
    process.exitCode = error.exitCode;            // already rendered by the command
  } else {
    logger.error(error instanceof Error ? error.message : 'Unknown error');
    process.exitCode = 1;
  }
});
```

Keep today's per-command error text (e.g. push action keeps "Unhandled error" only for genuinely-unhandled, since `publishCommand` logs its own failures — do not add a second "Push failed" line; P1 #9).

- [ ] **Step 4: Run** `npm run build && npm test` — goldens green; exit-code subprocess test green.
- [ ] **Step 5: Commit** — `git commit -m "refactor: centralize exit via parseAsync; one error owner per path"`

### Task 11: Remove inline `process.exit` from `status`/`validate`/`fix`

**Files:** Modify `src/commands/status.ts:162`, `src/commands/validate.ts:51-57`, `src/commands/fix.ts:88`.

**Interfaces:** These throw `CommandFailureError(msg, code)` instead of `process.exit`; entrypoint maps it (Task 10).

- [ ] **Step 1: Convert the validate golden strict-fail case** (from Task 4) to assert `rejects → { name: 'CommandFailureError' }`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Replace each `process.exit(n)`** with `throw new CommandFailureError(message, n)`; remove now-redundant catch-then-exit scaffolding the entrypoint covers.
- [ ] **Step 4: Run** `npm test` — goldens green.
- [ ] **Step 5: Commit** — `git commit -m "refactor: status/validate/fix throw CommandFailureError instead of process.exit"`

---

## Phase 3 — Offline read services (status, validate)

### Task 12: Extract `inspectStatus` — pure data, no human rendering on the JSON path

**Files:** Create `src/core/services/status-service.ts`; Modify `src/commands/status.ts`; Test `test/unit/status-service.test.ts`.

**Interfaces:** Produces `function inspectStatus(ctx: StatusContext): Promise<StatusReport>` — **returns a data object; performs NO human rendering** (P1 #7). `StatusReport` mirrors today's JSON document fields (course, auth `{mode, configured}`, runtime, git, per-assignment content status, last_push, counts). The wrapper picks the renderer:
- human → a `renderStatusHuman(report, events)` that emits today's lines via `ctx.events`;
- `--json` → `JSON.stringify(report)` to stdout, with **no events emitted** (purity).

- [ ] **Step 1: Write the failing test** — build a `StatusContext` over the sample config with a `CollectingEventSink`; assert `inspectStatus` returns a `StatusReport` with correct counts and `auth.mode`, and that **calling it emits zero events** (rendering is the wrapper's job).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — move the computation from `statusCommand` ([status.ts:37+](../../../src/commands/status.ts#L37)) into `inspectStatus` returning data. Add `renderStatusHuman`. Rewrite `statusCommand` to build the context (+`RuntimeFacts` from the existing `authMode`/`credentialLabel`/`credentialsConfigured`/`getCIProvider` logic), call `inspectStatus`, then either `JSON.stringify` (json) or `renderStatusHuman` (human).
- [ ] **Step 4: Run** `npm test` — **both** status goldens unchanged (human snapshot + JSON purity).
- [ ] **Step 5: Commit** — `git commit -m "refactor: inspectStatus returns data; wrapper renders human/json separately"`

### Task 13: Extract `validateWorkspace` — thread EventSink through validator

**Files:** Create `src/core/services/validate-service.ts`; Modify `src/commands/validate.ts`, `src/core/validator.ts`; Test `test/unit/validate-service.test.ts`.

**Interfaces:** Produces `function validateWorkspace(ctx: ValidateContext): Promise<ValidationReport>` (offline) returning `{ errors: string[]; warnings: string[] }`; emits via `ctx.events`. `--vocareum` (remote) path stays in the wrapper for Stage 1a.

- [ ] **Step 1: Write the failing test** — over a fixture with a known structural problem, assert `ValidationReport` lists it.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — add an `EventSink` parameter to `validator.ts` public fns (default `new LoggerEventSink()` so other callers are unaffected); move orchestration into `validateWorkspace`; wrapper builds context, throws `CommandFailureError` on `--strict` failure.
- [ ] **Step 4: Run** `npm test` — goldens unchanged.
- [ ] **Step 5: Commit** — `git commit -m "refactor: validateWorkspace offline service; EventSink through validator"`

---

## Phase 4 — Push service (intent/plan/execute + session)

### Task 14: `planPush`/`executePush` over `PushIntent`; internal `publish()` made non-interactive

**Files:** Create `src/core/services/push-service.ts`; Modify `src/core/publisher.ts` (split `publish` at [255](../../../src/core/publisher.ts#L255)), `src/commands/publish.ts`, and add an `EventSink` param to `reconciler.ts`/`uploader.ts`/`publisher.ts` public fns (default `LoggerEventSink`).

**Interfaces:** Produces:
- `function planPush(ctx: PushContext, req: PushRequest): Promise<PushPlan>` — READ-ONLY: reconcile → build a `PushIntent` (with settings payloads + per-dir content hashes + delete paths + template ids), compute `PushPreconditions` (configDigest, contentHashes, ids, `remoteAssumptions` incl. `exists:false` for planned creates), and `semanticFingerprint(intent)`. Only GETs; no mutation. Honors `req` (filters/forceAll/syncDeletes/dryRun affect what the intent contains).
- `function executePush(session: LockedSession, ctx: PushContext, req: PushRequest, plan: PushPlan): Promise<PublishResult>` — applies `plan.intent` (creates get their new IDs HERE, populating `PublishResult.created` with real IDs — P0 #3), writes state via `session.applyConfigUpdate`. `PublishResult` (with `id`-bearing `CreatedEntity`/`UpdatedEntity`) is the RESULT type, distinct from the plan.

- [ ] **Step 1: Write the failing test** — with `RecordingClient`: `planPush` records **only GETs**, returns a `PushPlan` whose `intent` reflects a changed directory and whose `semanticFingerprint` is set and `preconditions.configDigest` non-empty; then `executePush` in a stub session records PUTs, returns a `PublishResult` whose `created` entries carry real IDs, and calls `applyConfigUpdate` once.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement the split** — extract reconcile/intent-build into `planPush`; extract mutate+write into `executePush`, replacing inline `updateConfig` ([publisher.ts:1001](../../../src/core/publisher.ts#L1001)) with `session.applyConfigUpdate` and `logger.*` with `ctx.events.emit`. Thread `EventSink` through `reconciler.ts`/`uploader.ts` (default `LoggerEventSink`).
- [ ] **Step 4: Make `publish()` an explicit INTERNAL non-interactive compat API (P1 #10)** — JSDoc: "Internal: executes a push without prompting; confirmation belongs to the CLI wrapper." Implement as one `withSession`: `planPush` → (no confirm) → `executePush`. Update its ONLY callers: `publishCommand` is rewritten to orchestrate `withSession(plan → confirm via prompter → execute)` directly; the integration test ([test/integration/publish.test.ts](../../../test/integration/publish.test.ts), which already runs `nonInteractive`/CI) keeps working through `publishCommand`. Grep to confirm no other caller of `publish()` exists; if found, route it through the new non-interactive contract.
- [ ] **Step 5: Run** `npm run build && npm test` — **the push golden API-sequence snapshots (changed/cancel/failure) are unchanged.** A changed sequence means a re-fetch leaked onto the CLI path — fix before committing.
- [ ] **Step 6: Commit** — `git commit -m "refactor: planPush/executePush over PushIntent; publish() is internal non-interactive"`

---

## Phase 5 — Pull service (inspect + apply with split resolver)

### Task 15: `inspectPull` + `applyPull` with `resolveAction` then `resolveImportPath`

**Files:** Create `src/core/services/pull-service.ts`; Modify `src/commands/pull.ts`; Test `test/unit/pull-service.test.ts`.

**Interfaces:** Produces:
- `function inspectPull(ctx: PullContext, req: PullRequest): Promise<PullInspection>` — remote reconnaissance only; no prompts/writes.
- `interface PullResolver { resolveAction(issue: PullIssue): Promise<PullAction>; resolveImportPath(issue: PullIssue, suggestedPath: string): Promise<string> }` (**split** — P0 #4: action first, then the suggested unique path is computed, then the path resolver runs, matching [pull.ts:1160-1172](../../../src/commands/pull.ts#L1160)).
- `function applyPull(session, ctx, req, inspection, resolver): Promise<PullResult>` — iterates issues; per item: `await resolver.resolveAction(issue)`; if `import`, compute `suggestedPath` (today's `findExistingImportTarget`/`getUniqueDirectoryName`), then `await resolver.resolveImportPath(issue, suggestedPath)`, then import — **immediately, before the next issue** (preserves interleaving + `-N` allocation). Writes via `session.applyConfigUpdate`; `logger.*` → `ctx.events.emit`.

- [ ] **Step 1: Write the failing test** — two orphans; a stub resolver whose `resolveAction` returns `import` then `skip`, and whose `resolveImportPath` echoes the suggested path; assert (a) import happened only for the first, (b) `resolveImportPath` received the computed suggestion, (c) `applyConfigUpdate` called.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — move detection into `inspectPull`; move the loop ([pull.ts:1131](../../../src/commands/pull.ts#L1131)) into `applyPull` with the two-step resolver; keep dir allocation between the two resolver calls.
- [ ] **Step 4: Rewrite `pullCommand`** to build a `PullContext`+`PullRequest`, open one `withSession`, call `inspectPull` then `applyPull` with an **interactive resolver** (`resolveAction` = today's `promptChoice`; `resolveImportPath` = today's `prompt('Local directory name:', suggested)`), and a `--batch`/`--non-interactive` resolver matching today's defaults.
- [ ] **Step 5: Run** `npm test` — **interactive-ordering golden and batch golden unchanged** (the `[prompt#1, import#1, prompt#2, import#2]` order holds).
- [ ] **Step 6: Commit** — `git commit -m "refactor: inspectPull/applyPull with split resolveAction/resolveImportPath"`

---

## Phase 6 — Hardening: finish EventSink boundary + guards

### Task 16: Thread EventSink through remaining business logic + CI guards

**Files:** Modify `src/utils/unknown-field-reporter.ts` (accept `EventSink`), any residual `logger.*` in the push/pull/status/validate transitive graph; Create `test/unit/no-forbidden-imports.test.ts`.

**Interfaces:** Produces a guard test failing on forbidden patterns under `src/core/services/` or `process.exit` outside `src/index.ts`. **`src/core/session.ts` is explicitly allowed to use `withConfigLock`** (it is the lock owner and lives outside `services/`).

- [ ] **Step 1: Write the guard test**

```ts
// test/unit/no-forbidden-imports.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
const walk = (d: string): string[] => readdirSync(d).flatMap((e) => {
  const p = join(d, e); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
});
describe('architecture guards', () => {
  it('no process.exit outside src/index.ts', () => {
    expect(walk('src').filter((f) => f !== 'src/index.ts' && /process\.exit\s*\(/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
  it('src/core/services/ imports no logger/loadConfig/withConfigLock and constructs no client', () => {
    expect(walk('src/core/services').filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /utils\/logger/.test(s) || /\bloadConfig\b/.test(s) || /\bwithConfigLock\b/.test(s) || /new VocareumClient\(/.test(s);
    })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect a list of offenders.**
- [ ] **Step 3: Fix each** — `UnknownFieldReporter` takes an `EventSink`; replace residual service-graph `logger.*` with events; ensure no service imports a loader/lock/client. Any intentionally-retained global `logger` call must be in a CLI wrapper (outside `services/`) on a non-concurrent path, with a comment.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` — guards green, goldens unchanged.
- [ ] **Step 5: Commit** — `git commit -m "refactor: complete EventSink threading; add architecture grep guards"`

### Task 17: Composite-action smoke test + release notes

**Files:** Create `test/integration/action-smoke.test.ts`; Modify `CHANGELOG.md`.

**Interfaces:** A concrete smoke test (P2 #11 — today there is NO such test): build the CLI, then invoke the published-entry binary against the sample fixture to prove install+invoke works headlessly.

- [ ] **Step 1: Write the smoke test**

```ts
// test/integration/action-smoke.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
describe('action smoke (built CLI)', () => {
  it('runs `status` against the sample fixture and exits 0', () => {
    const out = execFileSync('node', ['dist/index.js', 'status',
      '--config', 'test/fixtures/sample-course/vocareum.yaml',
      '--root', 'test/fixtures/sample-course'], { stdio: 'pipe' });
    expect(String(out)).toMatch(/course/i);
  });
});
```

- [ ] **Step 2: Run** `npm run build && npx vitest run test/integration/action-smoke.test.ts` — PASS.
- [ ] **Step 3: Add a CHANGELOG entry** (internal refactor; no user-facing change; new injected-scheduler capability).
- [ ] **Step 4: Commit** — `git commit -m "test+docs: composite-action smoke test; Stage 1a changelog"`
- [ ] **Step 5: Canary note** — do NOT bump/publish here. Per spec §8, Stage 1a ships as its own release and soaks via a production canary before Stage 1b. Release (bump → commit → npm publish → Action tag) is a separate explicit step per AGENTS.md constraint #10.

---

## Self-Review

**Spec coverage:** §1 contexts/offline status/RuntimeFacts → Tasks 7,12; event sink + transitive scope (P1 #4) → 5,13,14,15,16. §2 locked session/`updateConfig` delegation → 8; operation-specific contracts → 12–15; pull per-item split resolver (P0 #1 prev round / this P0 #4) → 15. §3 push intent/plan/execute, preconditions, `semanticFingerprint` (P0 #1/#3) → 9,14; CLI one-lock no-refetch → 14 step 5. §4 planning-failure-as-data → 14,15 (org policy is Stage 1b). §5 single exit/`parseAsync`/`CommandFailureError`, no double-log (P1 #9), exit-code subprocess tests → 10,11. §6 injected scheduler → 6. §8 golden matrix (changed/cancel/failure/interactive/json-purity), preserved query strings (P1 #6), action smoke (P2 #11) → 1–4,17.

**Review findings → fixes:** P0 #1 full-intent fingerprint → Task 9 + `PushIntent`. P0 #2 request objects → Task 7 `PushRequest`/`PullRequest` (consumed 14,15). P0 #3 plan uses `PushIntent`/`AssignmentIntent`, results reserve `CreatedEntity` → Tasks 9,14. P0 #4 split `resolveAction`/`resolveImportPath` → Task 15. P0 #5 `withSession` at `src/core/session.ts`, guard exempts it → Tasks 8,16. P1 #6 expanded goldens + query preservation → Tasks 1–4. P1 #7 `inspectStatus` returns data, json purity, RuntimeFacts authMode → Tasks 7,12. P1 #8 metadata forwarding → Task 5. P1 #9 one error owner, rethrow CommandFailureError, subprocess tests → Task 10. P1 #10 `publish()` internal non-interactive + callers updated → Task 14 step 4. P2 #11 concrete smoke test → Task 17.

**Type consistency:** canonical types live in `src/core/services/types.ts` (Task 7), imported by 9,14,15. `PushPlan.intent: PushIntent` (not result types); `executePush` returns `PublishResult` (id-bearing). `LockedSession.applyConfigUpdate` (Task 8) used in 14,15. `RuntimeFacts.authMode` (Task 7) used in 12. `CommandFailureError` (Task 10) used in 11,12,13. `EventSink` (Task 5) used 12–16.

**Judgment calls for the executor:** Tasks 14–16 are largest; split per-module (publisher → reconciler → uploader) keeping goldens green between splits if a diff exceeds one reviewable unit. `remoteAssumptions` stays minimal (existence + part list for change-set assignments) — widen only if a golden reveals a missed assumption.
