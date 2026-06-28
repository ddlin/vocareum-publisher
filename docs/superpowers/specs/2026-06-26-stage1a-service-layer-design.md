# Stage 1a — Command/Service Layer Refactor — Design

**Date:** 2026-06-26
**Status:** Draft, rev 3 — rev 2 addressed an earlier 4-P0/2-P1 round; rev 3 addresses a further cross-spec round (pull interleaving P0 #1, `updateConfig` lock correction, event-sink transitive scope P1 #4, Commander mapping P2 #9, semantic-plan fingerprint hook for P0 #2). All verified against code. Prerequisite for org scope (Stage 1b); ships as its own release with a production canary before any org code.
**Author:** David Lin (vocgit maintainer)
**Related specs:** [2026-06-26-org-scope-stage1-design.md](2026-06-26-org-scope-stage1-design.md) (Stage 1b — the consumer of this layer). Split out of that spec's §0 after review found Stage 1a substantial enough to need its own design.

## Problem

The org runner (Stage 1b) must drive many courses from one invocation: render **one** aggregate plan/confirmation, isolate per-course failures, aggregate exit status. It cannot do this on today's command layer, which intermixes business logic with CLI concerns:

- `push` runs reconcile → confirm → execute → state-write as a single `publish()` call inside one `withConfigLock` ([publish.ts:37](../../../src/commands/publish.ts#L37), [publish.ts:83](../../../src/commands/publish.ts#L83)). There is no read-only "plan" the runner can collect across courses before committing to execute.
- `status`, `validate`, `fix` call `process.exit()` directly ([status.ts:162](../../../src/commands/status.ts#L162), [validate.ts:52](../../../src/commands/validate.ts#L52), [fix.ts:88](../../../src/commands/fix.ts#L88)) — a runner invoking them would be terminated mid-run by the first member, killing failure isolation and skipping `finally` cleanup / output flush. The entrypoint itself uses sync `program.parse()` ([index.ts:359](../../../src/index.ts#L359)), so it cannot observe a thrown async outcome either.
- `pull` interleaves remote inspection with **interactive per-item decisions** (`'import'|'exclude'|'skip'`, reset/remove, directory-name prompts) all inside one `withConfigLock` ([pull.ts:1047](../../../src/commands/pull.ts#L1047), [pull.ts:1126](../../../src/commands/pull.ts#L1126)).

Stage 1a extracts a **service layer** that returns structured data and never terminates the process or renders to the user, so both the existing CLI and the future org runner can call it. **This is a behavior-preserving refactor for the single-course CLI** — output, exit codes, prompts, filesystem effects, and **the API-call sequence** must be byte-for-byte unchanged. New behavior (detached plan/execute, optimistic revalidation) exists **only** on the org-runner path, which has no pre-refactor baseline to preserve.

### Architectural pivot from rev 1 (resolves P0 #1–#4 together)

Rev 1 split every `push` into detached `plan` then `execute`. Review showed that for the **single-course CLI** this is both wrong and unnecessary:
- It adds execute-time re-fetches, breaking the "identical API-call sequence" acceptance criterion (#2).
- It forces the state-writer to reacquire a **non-reentrant** `wx` lock (#3 — confirmed: [config.ts:295](../../../src/core/config.ts#L295), `flag: 'wx'`, throws `CONFIG_LOCKED` on reacquire).
- A detached `applyPull` loses the lock/staleness guarantee `pull` has today (#4).
- The lock is **advisory and local only** — *"it only guards vocgit against itself"* ([config.ts:292](../../../src/core/config.ts#L292)) — so a remote "does-not-exist" recheck cannot *prevent* cross-workspace duplicate creation; it only reduces the window (#1).

**Corrected model:** the service layer's unit of work is a **locked session**. The single-course CLI runs inspect → plan → confirm → apply **inside one session = one lock**, exactly as today (same calls, same prompts, same concurrency). The org runner is the *only* caller that detaches planning (read-only, across members) from execution (per-member locked session with optimistic revalidation). Revalidation, replanning, and the extra remote checks live solely on that detached path.

## Goals

1. Extract a service layer the CLI and org runner both call, with **operation-specific** contracts (not a forced-uniform `plan/execute`).
2. Model the unit of work as a **locked session**: one layer owns the lock; the state-writer is patch-based and assumes the lock is held (no reacquisition).
3. Single-course CLI behavior is **preserved exactly**, including the API-call sequence: CLI composes inspect/plan/confirm/apply inside one session with no added remote calls.
4. Support the org runner's **detached** plan-then-execute with optimistic precondition revalidation, documented as race **reduction**, not prevention.
5. Define **operation-specific contexts** so offline commands (`status`, `validate`) need no client/credentials; services emit **structured events** to an injected sink rather than rendering.
6. Move all process termination to one top-level boundary: `index.ts` uses `parseAsync()` with a single catch and sets `process.exitCode` once.
7. Scope to the four commands org mode consumes — `push`, `pull`, `status`, `validate`. `init`/`new`/`fix` are not service-refactored (only their `process.exit` is removed per Goal 6).
8. Golden CLI regression tests proving CLI behavior preservation; existing GitHub Action smoke tests; a production canary before Stage 1b.

## Non-Goals

- Any org schema, `vocareum.org.yaml`, selectors, or multi-course iteration — Stage 1b.
- Service-layer redesign of `init`/`new`/`fix` (review P2 #6 — unnecessary scope/risk).
- New single-course user-facing behavior. If a CLI user observes a difference, it is a bug.
- A cross-workspace or server-side duplicate-create guarantee. Stage 1a cannot provide one (see §3); it documents the limitation and degrades safely.
- Changing the API client, throttle, auth providers, or config schema beyond the additive injected-scheduler parameter (§6).

## Design

### 1. Operation-specific contexts (resolves P1 #5) + event sink (resolves P1 #6)

No single universal context. A small base, plus per-operation extensions, so offline commands need no client:

```ts
// src/core/services/context.ts
interface BaseContext {
  readonly persistedConfig: Config;   // as parsed from disk (post-Zod); authoritative for writes
  readonly effectiveConfig: Config;   // what to ACT on; === persistedConfig in single-course CLI;
                                       // = persisted + runtime defaults in org mode (org spec §4)
  readonly configPath: string;
  readonly workspaceRoot: string;
  readonly events: EventSink;          // services EMIT structured events here; they never render
  readonly prompter: Prompter;         // CLI = interactive; CI/org = non-interactive (throws if a
                                       //   required decision was not pre-resolved)
}

// Offline ops — NO client, NO credentials required:
type StatusContext   = BaseContext & { readonly runtime: RuntimeFacts };  // CI provider, auth-readiness, etc.
type ValidateContext = BaseContext;

// Online ops — client built by the caller (carries resolved auth + the §6 shared scheduler):
type PushContext = BaseContext & { readonly client: VocareumClient };
type PullContext = BaseContext & { readonly client: VocareumClient };
```

- **Offline preserved (P1 #5):** `status` and ordinary `validate` build **no** client and require **no** credentials. `status`'s current inputs that come from runtime — CI provider, credential readiness ([status.ts:37](../../../src/commands/status.ts#L37) onward) — are passed in as explicit `RuntimeFacts`, not rediscovered by constructing a client.
- **`persistedConfig` vs `effectiveConfig`:** the seam that lets Stage 1b's runtime-defaults merge (org spec §4) survive without the service reloading disk. Equal objects in single-course use.
- **Services never reload config, read `process.cwd()`, load `.env`, or construct clients.** The CLI wrapper does all of that (it already does — [publish.ts:34-51](../../../src/commands/publish.ts#L34)) and packs the context.
- **Event sink (P1 #6) — and its true scope (P1 #4):** services emit structured events (`{level, code, data}`) to `events`; they do **not** call the rendering `logger`. The CLI wrapper supplies a sink that renders to today's `logger` (preserving output exactly); the org runner supplies a **collecting** sink that buffers per-course events and renders them grouped, so Stage 1b output does not interleave across courses.

  The boundary is **not** just `src/core/services/` — review P1 #4 correctly noted the entire transitive business-logic graph currently renders through the global `logger`: `publisher` ([publisher.ts](../../../src/core/publisher.ts)), `reconciler` ([reconciler.ts](../../../src/core/reconciler.ts)), `uploader` ([uploader.ts](../../../src/core/uploader.ts)), `validator`, and `UnknownFieldReporter`. If only the top service layer emits events while these still call `logger`, Stage 1b output **will** interleave across concurrent courses. Therefore Stage 1a **threads the `EventSink` through the whole call graph** these services reach: each module takes the sink (via the context or an explicit parameter) and emits instead of calling `logger`; `UnknownFieldReporter` becomes a sink consumer rather than a direct renderer. This is the **largest single piece** of Stage 1a and is scoped as such in the plan. It stays behavior-preserving because the CLI sink renders through today's `logger` formatting (golden tests in §8 lock the output). Modules **not** reached by the four refactored commands keep their `logger` calls; the plan must enumerate any global-`logger` call that remains on a concurrent path and prove it cannot interleave (e.g. only fires before fan-out).

### 2. Operation-specific service contracts + locked session (resolves P1 #3 of rev1 / P0 #3)

The unit of execution is a `LockedSession` that **owns** the lock and exposes a writer — **one layer owns locking** (P0 #3). Correction from rev 1 (per review): `updateConfig()` does **not** acquire its own lock ([config.ts:140](../../../src/core/config.ts#L140) — it writes atomically; callers wrap it in `withConfigLock`). So the session writer can safely **delegate to the existing `updateConfig()`** while already inside the session's `withConfigLock`; there is no reacquisition and no need to reimplement its patch/write behavior.

```ts
// acquires withConfigLock(configPath) once; the writer delegates to updateConfig(),
// which performs no locking of its own, so no reacquisition occurs.
withSession(configPath, async (session) => { /* … */ });
interface LockedSession {
  applyConfigUpdate(updates: ConfigUpdates): Promise<void>;  // delegates to updateConfig(); lock already held
}
```

Contracts (no universal plan/execute). The pull contract is corrected per **P0 #1**: decisions are resolved **per item inside the apply loop**, not all up front, so today's prompt-then-immediately-import interleaving, `-N` directory allocation, and mid-run failure behavior are preserved.

| Op | Contract | CLI composition (single lock) | Org-runner composition |
|---|---|---|---|
| **push** | `planPush(ctx) → PushPlan` (read-only) · `executePush(session, ctx, plan) → PushResult` | one session: `planPush` → confirm via prompter → `executePush`; **no gap, no re-fetch** | `planPush` all members outside lock → aggregate confirm → per-member session that revalidates then `executePush` |
| **pull** | `inspectPull(ctx) → PullInspection` · `applyPull(session, ctx, inspection, resolver) → PullResult` — apply **iterates issues and invokes `resolver` immediately before each action** (import/exclude/skip, dir-name) | one session: `inspectPull` → `applyPull` with the **interactive resolver** (reproduces today's per-orphan prompt→import loop exactly) | inspect outside lock → per-member session → `applyPull` with a **pre-set org-policy resolver** (same interface, no prompts) |
| **status** | `inspectStatus(ctx) → StatusReport` (read-only, offline) | no lock needed | per-member, read-only |
| **validate** | `validateWorkspace(ctx) → ValidationReport` (read-only, offline) | no lock needed | per-member, read-only |

All results are plain data (`{succeeded, failed, changes, …}`). No service prints, prompts, or exits. The pull `resolver` is the single seam that decides per item: CLI = interactive prompter (today's `promptChoice`/`prompt` loop, [pull.ts:1145](../../../src/commands/pull.ts#L1145)); `--batch` = the existing non-interactive policy; org runner = a pre-set policy implementing the same `(issue) → decision` interface. Because the resolver is invoked **inside** `applyPull`'s iteration, interleaving and directory allocation are byte-for-byte preserved (P0 #1, #4).

### 3. Push staleness — CLI vs. detached (resolves P0 #1, P0 #2)

**Single-course CLI (behavior-preserving):** `planPush` and `executePush` run in **one locked session with no gap**. The lock already prevents vocgit-vs-vocgit interleaving exactly as today; there is **no execute-time re-fetch and no added API call**, so the API-call sequence is identical (satisfying the §8 golden test). Cross-workspace concurrency was already an unguarded race *today* (the lock is local/advisory) — Stage 1a does not change that, for better or worse. No new `StalePlanError` path is exercised by the CLI.

**Org runner (detached, new behavior — no preservation baseline):** plans are computed read-only across members, then each member executes in its own locked session that **optimistically revalidates** preconditions captured in the plan:
- `configDigest` (local config edited since plan), `contentHashes` (local files edited), `assignmentIds`/`partIds` (config re-pointed), and `remoteAssumptions` (the minimal remote facts relied on).
- On any mismatch → throw `StalePlanError`; the runner **replans that member** (does not auto-loop — a second staleness is surfaced).
- **Semantic-plan fingerprint (for P0 #2, consumed by Stage 1b):** `PushPlan` exposes a stable `semanticFingerprint` over its *change set* (which assignments/parts/dirs will be created/updated, not incidental ordering). A replan that yields the **same** fingerprint is safe to execute under the original confirmation; a **different** fingerprint means the confirmed delta no longer matches reality, and Stage 1b decides whether to re-confirm (interactive) or fail-stale (non-interactive) — see org spec §3. Stage 1a's job is only to make the fingerprint available and stable.

**Duplicate-create is race *reduction*, not prevention (P0 #1):** re-fetching "assignment does not exist" then creating is still check-then-act; another workspace can create it in between, and the local advisory lock cannot stop that. So:
- If revalidation/execute discovers an assignment that the plan assumed absent now **exists**, that is a `StalePlanError` → **replan** (the replan adopts the now-existing IDs and resolves local IDs/content). We do **not** "skip create," which rev 1 wrongly proposed — that would leave local IDs/content unresolved.
- True prevention requires **server-side idempotency/uniqueness** or **externally serialized CI** (e.g. a GitHub Actions concurrency group — already the documented guidance, [config.ts:311](../../../src/core/config.ts#L311)). The spec states this limitation; it does not claim a guarantee it cannot keep.

### 4. Planning-failure policy (org-runner path)

Single-course CLI has one member → "plan fails ⇒ command fails," unchanged. For the org runner the service contracts must return planning errors **as data / typed throws (never exit)** so this policy is implementable:
- Collect planning failures; do not abort the whole run on the first.
- Aggregate confirmation shows the **successfully-planned subset** + the planning failures.
- Execute only successfully-planned members; report the rest; **exit non-zero** if any member failed to plan or execute.

### 5. Single top-level exit boundary (resolves P1 #5 of rev1 + Commander note)

- Remove every `process.exit()` from `src/commands/*` — the four refactored commands **and** `init`/`new`/`fix` (mechanical, per Goal 7).
- Commands/services signal outcome by **returning** a result or **throwing** a typed error.
- **Commander (corrected per P2 #9):** change `index.ts:359` from `program.parse()` to **`await program.parseAsync()`** wrapped in a single `try/catch`. `parseAsync` awaits action promises but does **not** return their values — so the entrypoint **cannot** read a returned `{success:false}`. Therefore: every `.action()` wrapper maps an unsuccessful service result to a **thrown typed `CommandFailureError`** (carrying an exit code); the single top-level `catch` sets `process.exitCode` from it. Success → falls through to `process.exitCode = 0`. The exit code is set **once**, after `finally` cleanup (`reporter.printSummary()`) and stdout/stderr flush. Closes the "direct exit skips `finally`/flush" bug class. (No reliance on Commander surfacing return values.)

### 6. Shared scheduler parameter (additive)

`VocareumClient`'s constructor gains an **optional injected** `RequestScheduler` (default = construct its own — today's behavior, covered by a test). Stage 1a only adds the parameter; Stage 1b injects one shared instance (org spec §3).

## Behavior-Preservation Contract (this refactor's matrix)

Dominant invariant: **nothing observable changes for the single-course CLI.** Each row → a golden test. Staleness/replan rows are explicitly **org-runner-only** (no CLI baseline).

| Aspect | Before | After (required) |
|---|---|---|
| `push` happy path (CLI) | reconcile→confirm→execute→write in one lock, exit 0 | identical stdout/fs/exit **and identical API-call sequence** (one session, no re-fetch) |
| `push` error (CLI) | `process.exit(1)` (may skip finally) | throw typed error; entrypoint exits 1 **after** `finally`/flush |
| `pull` interactive (CLI) | per-item prompts in one lock | identical prompt sequence via the in-session resolver |
| `pull --batch` (CLI) | import all / pull drift / skip stale, no prompts | identical via non-interactive resolver |
| `status`/`validate` (CLI) | print + `process.exit(n)`, **offline** | print + **return**, still offline (no client built); entrypoint sets same exit code |
| `init`/`new`/`fix` | current behavior incl. `process.exit` | identical behavior; exit at entrypoint, not inline |
| Cross-workspace concurrency | unguarded race (lock is local/advisory) | **unchanged** for CLI — Stage 1a neither adds nor removes this guarantee |
| `StalePlanError`/replan | n/a | **org-runner only**; not reachable on the CLI path |

## Adversarial / Edge Contract

| Scenario | Handling |
|---|---|
| State-writer reacquires the lock | Cannot happen: the **session owner** acquires `withConfigLock` once; the writer delegates to `updateConfig()`, which performs **no** locking of its own ([config.ts:140](../../../src/core/config.ts#L140)). CI grep guard: `withConfigLock` is called only by session owners (CLI wrappers / org runner), never inside `src/core/services/`. |
| Service reloads config (drops org defaults) | Forbidden (§1); CI guard: no `loadConfig` import under `src/core/services/`. |
| `process.exit` reintroduced in a service/command | Forbidden; CI grep guard: `process.exit` only in `src/index.ts`. |
| `status`/`validate` run without credentials | Must succeed — offline contexts build no client (P1 #5). Test: status with no `.env`/token. |
| Service calls the rendering `logger` | Forbidden; services emit to `events` only (P1 #6). Guard: no `logger` import under `src/core/services/`. |
| Org runner: concurrent workspace creates a planned-new assignment | Discovered at revalidation → `StalePlanError` → replan (adopts existing IDs). Not silently skipped. Documented as race reduction (P0 #1). |
| Non-interactive context hits an unresolved decision | `Prompter` throws a typed error (no hang, no silent default). |
| Detached `applyPull` runs against changed state | Bound to the inspection digest + reserved import paths; revalidated under the session lock; mismatch → `StalePlanError` (P0 #4). |

## System-Trace Checkpoint

Before merge, trace through the cumulative refactor:
- **Lock ownership**: exactly one `withConfigLock` per CLI operation (the session); does any writer reacquire? Is `applyConfigPatch` always inside the session?
- **API-sequence parity (CLI)**: recording-client golden test shows an identical method+path sequence pre/post refactor for `push`/`pull` — confirm no execute-time re-fetch leaked onto the CLI path.
- **Offline parity**: `status`/`validate` build no client and pass with no credentials.
- **Event/render split**: grep — no `logger`/`process.exit`/`loadConfig` imports under `src/core/services/`; does the CLI sink reproduce today's output, and does `finally` still run on the error path?
- **Pull interleaving**: CLI resolver reproduces the exact prompt order/text of the inline loop.
- **Entrypoint**: `parseAsync` + single catch; `process.exitCode` set once, after flush.

## Open Questions (for the plan)

- Exact `RuntimeFacts` shape for `status` (which CI/auth-readiness fields it currently derives) — enumerate against the current `statusCommand` body.
- `EventSink` event taxonomy (codes/levels) sufficient for both the CLI renderer and the org collector — draft from the existing `logger.*` call sites in the four commands.
- Whether `validate` ever needs the client (remote validation mode); if so it becomes an online context with an explicit `--remote` flag (default offline).
