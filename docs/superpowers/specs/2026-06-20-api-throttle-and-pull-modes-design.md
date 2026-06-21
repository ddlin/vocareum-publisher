# API Throttle & Pull Modes — Design

**Date:** 2026-06-20
**Status:** Approved (design), pending implementation plan
**Author:** David Lin (with Claude Code)

## Problem

Two related ways `vocgit` can be impolite to Vocareum's API servers:

1. **`pull` is chatty before the user picks an action.** It always runs reconcile →
   settings drift → **full content drift**, and content drift downloads every file of
   every linked part via `downloadContent`
   ([content.ts:412](../../../src/api/content.ts), [content.ts:455](../../../src/api/content.ts)).
   Each file is one Vocareum signed-URL request plus an S3 fetch; directory placeholders add
   list calls. On a large course a single scan can be hundreds-to-thousands of requests, even
   if the user only wanted to see whether anything is linked.
   See [pull.ts:580](../../../src/commands/pull.ts), [pull.ts:991](../../../src/commands/pull.ts).

2. **No proactive throttle.** The client honors `429`/`Retry-After` and does exponential
   backoff, but only *reactively* — after the server pushes back. There is no minimum spacing,
   queue, jitter, or shared budget. A large `--content` pull or repeated CI runs can steadily
   hammer the API. See [client.ts:361](../../../src/api/client.ts), [client.ts:377](../../../src/api/client.ts).

## Goals

- Add a **proactive, configurable request scheduler** to `VocareumClient` so every Vocareum API
  request through the client is spaced out and capped in concurrency.
- Make `pull`'s expensive **content drift opt-in and scopeable**, so a default scan stays cheap
  (metadata only).
- Validate all new config and flag inputs tightly, including adversarial inputs from
  hand-edited `vocareum.yaml`.

## Non-Goals (explicitly out of scope for this spec)

- **Conservative write-retry on ambiguous timeout** (re-sending large base64 zip PUTs). Deferred.
- **Polling backoff/jitter** for transaction polls (content 1s×30, copy 2s×30). Deferred.
- **README workflow `concurrency:` group** doc update. Deferred.
- **A separate S3 download limiter.** The scheduler governs *Vocareum API* requests only (see
  scope note below); the raw signed-URL S3 fetch is left unthrottled for now.

---

## Part 1 — Request Scheduler

### Scope of coverage (precise)

The scheduler governs **every Vocareum API request made through `VocareumClient`** — list,
get, download-URL acquisition, transaction polls, settings/content PUTs, copies, *and their
retries*. It is installed at the single chokepoint in `VocareumClient.attempt()` immediately
before `this.axios.request(config)` ([client.ts:369](../../../src/api/client.ts)).

It explicitly does **not** cover:
- The raw signed **S3 `axios.get()`** in `content.ts` (not routed through `VocareumClient`).
- **OAuth token exchange** in the auth providers (not routed through `VocareumClient`).

This is acceptable because the stated goal is "don't overload Vocareum *API* servers"; S3 and
the IdP token endpoint are different hosts. If a download limiter is wanted later, it is a
separate, additive piece.

### Behavior

A small in-house `RequestScheduler` (no new dependency). Each call to `attempt()` does
`await scheduler.acquire()` before issuing the axios request, and releases the slot in a
`finally`.

Two controls:

- **`maxConcurrency`** — max requests in flight. Default **1** (matches today's strictly
  sequential reality). Enforcing it structurally means a future accidental `Promise.all`
  cannot bypass the throttle.
- **`minIntervalMs`** — minimum spacing between request **starts**. Default **300**. `0`
  disables spacing.
- **jitter** — request-start spacing is randomized by ±40% of `minIntervalMs` so multiple CI
  runners that get throttled together don't re-fire in lockstep. The RNG is injected
  (constructor param defaulting to `Math.random`) so tests can stub it deterministically.

### Implementation note: concurrency==1 vs >1

A simple promise-chain gate is sufficient **only** for `maxConcurrency: 1`. Because we expose
values `> 1`, the scheduler must be a **real queue with active-count tracking plus request-start
spacing** — not just a serial chain — so the implementation matches the advertised API. The
queue:

1. On `acquire()`: **if `queue.length > 0`, always enqueue** (never jump the line), then run the
   pump. Only when the queue is empty may a fresh arrival start inline — and even then only if
   `activeCount < maxConcurrency` **and** `now >= nextAllowedStart`; otherwise it enqueues. This
   makes the scheduler strictly **FIFO**: a newer `acquire()` that happens to satisfy the spacing
   condition cannot leapfrog an older request still waiting on its timer.
2. The pump always starts work **from the head** of the queue, applying the same
   `activeCount`/`nextAllowedStart` gates; it stops at the first head item that isn't eligible.
3. Each start stamps `nextAllowedStart = now + minIntervalMs ± jitter`.
4. On `release()`, decrement `activeCount` and pump the queue.

**Time-based pump (required).** `release()` is not the only thing that can unblock the queue: an
item can be blocked *solely* by `nextAllowedStart` while `activeCount == 0` (nothing in flight to
release). The pump must therefore handle this case: when the head of the queue is eligible by
concurrency but not yet by spacing, schedule a one-shot timer for `nextAllowedStart - now` (via the
injected `setTimeout`) that re-runs the pump. Guard against scheduling multiple overlapping timers
(track a single pending-pump handle). Without this, a queued request can sit forever after the
spacing delay if no other request completes.

A clock and timer are injected (defaulting to `Date.now`/`setTimeout`/`clearTimeout`) so spacing is
testable without real waits.

### Accurate claim about retry jitter

The scheduler adds **request-start** jitter. It does **not** randomize the existing exponential
backoff `sleep()` ([client.ts:383](../../../src/api/client.ts)) itself — that sleep duration is
unchanged. The practical effect: a retry's backoff sleep runs first, then the retry re-acquires
the gate, and *that acquisition* is spaced+jittered. So the moment a retry actually hits the wire
is de-synchronized across runners, but we do **not** claim the backoff curve itself is jittered.

### Configuration

New optional `throttle` block under `vocareum:` in `vocareum.yaml`. Resolution order
(highest wins): **env var → `vocareum.throttle` → built-in default.**

```yaml
vocareum:
  org_id: "..."
  course_id: "..."
  throttle:
    max_concurrency: 1        # integer 1..5,  default 1
    min_interval_ms: 300      # integer 0..60000, default 300
    jitter: true              # boolean, default true
```

Env overrides:
- `VOCAREUM_MAX_CONCURRENCY` — integer `1..5`
- `VOCAREUM_MIN_REQUEST_INTERVAL_MS` — integer `0..60000`
- `VOCAREUM_THROTTLE_JITTER` — `0`/`1`/`true`/`false`

### Config validation (zod)

`ThrottleConfigSchema` is **`.strict()`** (rejects unknown keys inside `throttle`), in contrast to
the surrounding `.passthrough()` schemas:

```ts
const ThrottleConfigSchema = z.object({
  max_concurrency: z.number().int().min(1).max(5).optional(),
  min_interval_ms: z.number().int().min(0).max(60000).optional(),
  jitter: z.boolean().optional(),
}).strict().optional();
```

Invalid values fail `safeParse` with a clear, field-named message (reusing the existing
`zodErrorsToValidationErrors` path in `config.ts`). Env vars are parsed with explicit
integer/boolean coercion and the **same bounds**; an out-of-range or non-numeric env var is a
hard error, not a silent clamp, so misconfiguration is visible.

### Adversarial-input contract (per AGENTS.md §"adversarial-input contract")

`throttle` is user-editable, so enumerate the nasty inputs and how each is handled:

| Input | Handling |
|---|---|
| `max_concurrency: "1"` (string number) | zod `z.number()` rejects → validation error. (Documented: we do **not** coerce strings; YAML numbers are unquoted.) |
| `min_interval_ms: -100` (negative) | `.min(0)` rejects → error |
| `max_concurrency: 10000` (huge) | `.max(5)` rejects → error |
| `max_concurrency: 1.5` (non-integer) | `.int()` rejects → error |
| `jitter: "yes"` (wrong type) | `z.boolean()` rejects → error |
| `throttle: { maxConcurrency: 1 }` (camelCase / unknown key) | `.strict()` rejects unknown key → error naming the bad key |
| `throttle: []` (array, not object) | zod object rejects → error |
| `throttle: { throttle: {...} }` (wrapper nested in itself) | `throttle` is not a key of `ThrottleConfigSchema` → `.strict()` rejects |
| `VOCAREUM_MIN_REQUEST_INTERVAL_MS=abc` | integer parse fails → hard error |
| `VOCAREUM_MAX_CONCURRENCY=0` | below `.min(1)` → hard error |
| `throttle:` absent | use defaults (1 / 300 / jitter on) |

---

## Part 2 — Pull content drift becomes opt-in

### What `--content` does and does NOT govern

`pull` has **two independent** content-download paths today. This spec changes only the first:

1. **Content-drift detection** (the new `--content` gate) — the phase that downloads remote files
   of linked parts purely to *compare* them against local files
   ([pull.ts:580](../../../src/commands/pull.ts), [pull.ts:991](../../../src/commands/pull.ts)).
   This is what becomes opt-in.
2. **Orphan import** — when a remote-only assignment is *imported* into the repo, its content is
   downloaded as part of materializing it locally ([pull.ts:757](../../../src/commands/pull.ts),
   [pull.ts:1041](../../../src/commands/pull.ts); `--batch` auto-imports). This is governed by the
   **existing** `--skip-content` flag ([index.ts:188-189](../../../src/index.ts)) and is
   **unchanged** by this spec.

**Tightened contract:** *Content drift detection is opt-in via `--content`. Orphan-import content
behavior is unchanged and remains governed solely by the existing `--skip-content` flag.* `--content`
and `--skip-content` are orthogonal: `--content` turns the drift phase on; `--skip-content` tells the
import phase to reuse local content. Neither flag's meaning changes the other.

### Flags & behavior

| Command | Behavior |
|---|---|
| `vocgit pull` | reconcile + settings drift + orphan/stale handling (as today), but **no content-drift download**. Prints a one-line note that content drift was skipped and how to enable it. |
| `vocgit pull --content` | additionally runs content-drift detection (downloads + diffs file content) for all linked parts — today's drift behavior. |
| `vocgit pull --content --assignment <name\|id>` | scope content-drift detection to the named assignment(s). Repeatable. |
| `vocgit pull --content --assignment <name\|id> --part <id>` | scope drift further to specific part(s) within that assignment. |
| `vocgit pull --skip-content` (± `--batch`) | unchanged: affects orphan **import**, not drift. Composes with `--content` independently. |

### Flag parsing (Commander)

`--assignment` must collect **repeated** occurrences into an array. Commander does **not** do this by
default — a plain `.option('--assignment <x>')` keeps only the last value. Use a collector:

```ts
const collect = (val: string, acc: string[]): string[] => { acc.push(val); return acc; };
pullCmd.option('--content', 'Detect content drift (downloads remote files to diff)');
pullCmd.option('--assignment <name|id>', 'Limit --content drift to assignment(s); repeatable', collect, []);
pullCmd.option('--part <id>', 'Limit --content drift to part(s); requires --assignment', collect, []);
```

`--part` also collects (array), and is only meaningful with a single `--assignment` (see validation).

### Flag-combination validation (errors, not silent no-ops)

- `--assignment` **or** `--part` **without** `--content` → error: "`--assignment`/`--part` only
  apply with `--content`."
- `--part` **without** `--assignment` → error: "`--part` requires `--assignment` (part
  selectors are not unique across a course)."
- `--part` **with more than one** `--assignment` → error: "`--part` requires exactly one
  `--assignment` (part selectors are not unique across assignments)." (No Cartesian/broadcast
  behavior — part IDs are not globally unique, so we refuse the ambiguous case rather than guess.)
- `--assignment <x>` where `x` matches no linked assignment → error listing valid choices.
- `--part <p>` where `p` is not under the selected assignment → error listing valid parts.

Settings drift does **not** gain `--assignment` scoping in this spec (YAGNI; it's metadata-cheap).

### Output contract

Bare `pull` output ends with, e.g.:
> `Content drift not checked. Run \`vocgit pull --content\` to compare file contents (downloads remote files).`

So the reduced default is discoverable, not surprising.

---

## Backward compatibility & versioning

Changing the default behavior of the published `pull` command (currently v1.2.0) is a
**behavior change**. CHANGELOG must call it out prominently under a "Behavior changes" heading.
Recommend at least a minor bump with the note; final version semantics decided at release.

---

## Testing

### Scheduler (unit)
- N sequential requests with `minIntervalMs=M`, `maxConcurrency=1` take ≥ `(N-1)·M` (injected clock).
- `maxConcurrency=3` allows 3 concurrent in-flight, queues the 4th, and still spaces starts.
- `minIntervalMs=0` disables spacing (no added delay).
- **Time-based pump:** a single request enqueued while blocked *only* by spacing (`activeCount==0`)
  still fires once the injected timer advances past `nextAllowedStart` — i.e. it does **not** depend
  on another `release()`. Assert the injected `setTimeout` was scheduled for `nextAllowedStart - now`
  and that exactly one pending-pump timer exists (no overlapping timers).
- Jitter stays within ±40% bounds (injected RNG at 0.0 and 1.0 extremes).
- **FIFO order:** with `maxConcurrency=1`, enqueue A then B; while A's spacing timer is pending,
  a later `acquire()` for B (even one arriving after `nextAllowedStart`) must **not** start before
  A. Assert start order is A → B regardless of arrival timing relative to the interval.
- **Jitter varies wire time:** two acquisitions fed *different* RNG samples produce *different*
  `nextAllowedStart` stamps. (This is the unit-provable claim; CI-runner de-synchronization is the
  expected real-world *effect* of this, not something a deterministic test asserts.)
- Slot released on both success and thrown error (a failed request doesn't deadlock the queue).
- Scheduler wraps retries: a 429→retry sequence passes the gate twice.

### Config validation (unit) — adversarial table above
Each row in the adversarial-input table is a named test (yaml-level and env-level).

### Pull (integration-ish, mocked client)
- `vocgit pull` issues **zero** content-drift `downloadContent` requests; still runs reconcile +
  settings drift + orphan/stale handling.
- `vocgit pull --content` restores full content-drift download.
- `--content --assignment lab1` drift-downloads only `lab1`'s parts.
- `--content --assignment lab1 --part part1` drift-downloads only that part.
- **Repeated `--assignment lab1 --assignment lab2`** collects **both** selectors (guards against the
  Commander last-value-wins trap); drift covers `lab1` and `lab2` only.
- `--assignment` without `--content` → error.
- `--part` without `--assignment` → error.
- `--content --assignment lab1 --assignment lab2 --part p1` (part with >1 assignment) → error.
- unknown `--assignment`/`--part` value → error with valid choices.
- **Orphan import unchanged:** with an orphan present, `pull --batch` still downloads import content;
  `pull --batch --skip-content` still reuses local content — neither is affected by `--content`'s
  presence or absence (run the matrix: `{--content}×{--skip-content}` leaves import behavior keyed
  only on `--skip-content`).

### Scenario contract (per AGENTS.md §4)
- "User runs a quick `pull` on a 500-file course" → no content-drift requests fired; finishes after metadata + orphan/stale calls only.
- "User adds `throttle.min_interval_ms: 1000` and runs `--content`" → consecutive requests are ≥1s apart.
- "Two CI runners get 429 at the same instant" → de-synchronization is the *expected effect* of
  request-start jitter; not asserted by a deterministic test. The unit test instead proves different
  jitter samples yield different start times (above).
- "User imports an orphan with `--batch`" → import content still downloads (drift opt-in does not regress import).
- "User typos `throttle: { max_concurrency: 99 }`" → run fails fast with a bounds error, no requests sent.

### Validation-before-request ordering (required invariant)

For the "no requests sent" guarantees to hold, **throttle resolution + validation must complete
before any `VocareumClient` request is issued, in every command.** Concretely: config load (which
runs `ThrottleConfigSchema`) and env-var parsing happen at command startup, and the resolved/
validated throttle settings are passed into the `VocareumClient` constructor. An invalid YAML
`throttle` block or out-of-range env var therefore throws during startup — before the client makes
its first call. The client constructor must receive already-validated settings (it does not re-read
env or accept raw/unvalidated values). This ordering is the same place `assertAllowedBaseUrl`
already runs ([client.ts:316](../../../src/api/client.ts)), so validation co-locates with existing
construction-time checks.

### System-trace checkpoint (per AGENTS.md §3)
After implementation, a separate review traces: (a) config YAML → schema → env resolution →
`VocareumClient` construction → actual spacing on the wire, **confirming no client request precedes
throttle validation**; (b) `pull` flag parsing → which parts content-drift `downloadContent` is
(not) called for, and that orphan import is unaffected.

---

## Files touched (anticipated)

- `src/api/scheduler.ts` (new) — `RequestScheduler` (FIFO queue, spacing, jitter, injected clock/timer/RNG).
- `src/api/client.ts` — accept **already-validated** throttle settings; instantiate scheduler; gate
  `attempt()`. Constructor does not read env or accept raw values (validation happens upstream).
- **Command entrypoints** (`src/index.ts` and any command that builds a `VocareumClient`) — ensure
  throttle is resolved + validated at startup and passed into the client, before any request.
- `src/types/config.ts` — `ThrottleConfigSchema` under `VocareumConfigSchema`.
- `src/utils/env.ts` — parse/validate the three env overrides.
- `src/commands/pull.ts` — `--content`/`--assignment`/`--part` flags, default skips content drift,
  scoping, flag-combo validation, output note.
- `src/index.ts` — register the new `pull` options.
- `CHANGELOG.md` / `README.md` — behavior change + new flags + throttle config.
- Tests under `test/` mirroring the sections above.
