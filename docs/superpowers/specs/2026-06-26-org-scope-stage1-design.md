# Org Scope — Stage 1: Org Overlay + Org Identity — Design

**Date:** 2026-06-26
**Status:** Draft, rev 3 — rev 2 addressed an 8-finding round; rev 3 addresses a further cross-spec round (replan-after-confirm P0 #2, four runner workflows + offline membership P0 #3, event-sink transitive scope P1 #4, shared-scheduler vs course-worker cap P1 #5, org-mode auto-commit P1 #6, Action auth default P1 #7, `org init` exclusions + canonical-realpath dedup P1 #8). All verified against code. Pending re-review before an implementation plan.
**Author:** David Lin (vocgit maintainer)
**Related specs:** [2026-05-27-v3-oauth-support-design.md](2026-05-27-v3-oauth-support-design.md) (the org credential reuses the v3 OAuth provider), [2026-06-20-api-throttle-and-pull-modes-design.md](2026-06-20-api-throttle-and-pull-modes-design.md) (the org iteration engine reuses the throttle).

## Problem

vocgit is scoped to a **single Vocareum course**. One `vocareum.yaml` per Git repo binds to exactly one `course_id` inside one `org_id` ([config.ts:421](../../../src/types/config.ts#L421)), and every command (`publish`, `pull`, `status`, `validate`, `new`, `fix`) operates against that one course. `org_id` is stored but otherwise inert. All state — assignment/part IDs, content hashes, `publish_history` — lives inline in that one file.

Course authors who own **many** courses in an org (curriculum leads, courseware-ops teams, Vocareum-managed accounts) have no way to publish, pull, or audit across courses from one place. They currently maintain N repos with N tokens and run N invocations.

This is **Stage 1** of a staged expansion to full org scope. It delivers the foundation — **org identity** and **multi-course addressing** — without disrupting any existing single-course deployment. Later stages (shared org resources; org-wide ops & reporting) are additive consumers of this foundation and are explicitly out of scope here.

## Goals

1. Let one invocation address **many courses** in an org via a new, **optional** `vocareum.org.yaml` overlay (topology "A", chosen 2026-06-26).
2. Adopt a single **org credential** (preferred: v3 OAuth client-credentials, already implemented) that drives all member courses.
3. **Zero disruption** to existing deployments: no change to the `vocareum.yaml` schema; existing repos and their GitHub Actions keep running with no edits. **Org mode activates ONLY via an explicit `--course`/`--all-courses` selector or a `vocgit org …` subcommand** — never merely because a `vocareum.org.yaml` is present. Absent a selector, every command behaves exactly as today (single-course, keyed off `vocareum.yaml`). This is the corrected activation rule (review P0 #1): the previous "present file → prompt/error" rule would have broken existing default Action invocations the moment an org file was added.
4. Reuse the existing per-course **business logic** via a refactored command/service layer (Stage 1a) — the org layer orchestrates that layer, it does not reimplement reconcile/upload logic.
5. Per-course failure isolation with an aggregated report and a correct process exit code (for CI).
6. Scaffolding/audit helpers: `vocgit org init` (discover courses via `GET /courses`) and `vocgit org status` (tracked vs. visible-but-untracked drift).

## Non-Goals

- **Shared org resources** (org-level templates/defaults inheritance beyond the minimal runtime `defaults` merge below) — Stage 2.
- **Org-wide reporting/bulk-mutation** beyond `org status` (e.g. `org audit`, `org drift`, bulk-apply a setting) — Stage 3.
- **Multi-repo** topology (org manifest referencing course repos by Git URL, topology "C") — deferred; the org file is forward-designed so a future `repo:` member field can add it without a breaking change.
- **Unified single-file config** (topology "B", a top-level `courses:` array) — rejected: fights the per-course inline-state and per-course-CI model.
- **Provisioning new courses** (creating courses via API) — out of scope; Stage 1 manages existing courses only. Assignment creation remains local-only and per-course, per existing constraint.
- Changing auth mechanics — the v2 token and v3 OAuth providers are reused as-is; no new credential type.
- **Per-course distinct identity** — dropped from Stage 1 (review P1 #5). `auth_mode` alone cannot supply two different credentials of the same type (both `oauth` members share one env client_id/secret), so a per-course override would be a half-feature. A future "credential references" mechanism (members naming which env var holds their secret) can add this without a breaking change. Stage 1 is **one org credential for all members**.

## Design

### 0. Prerequisite — Stage 1a (command/service layer), specified separately

Review P0 #2 established that the org runner **cannot** reuse today's pipeline unchanged: `status`/`validate`/`fix` call `process.exit()` directly and `push` runs reconcile→confirm→execute→write as one locked `publish()` call with no plan/execute seam. A runner calling these would be killed mid-run and could not render one org-wide plan.

Stage 1a — the service-layer refactor that fixes this — is **substantial enough to be its own design and release**, and is specified in **[2026-06-26-stage1a-service-layer-design.md](2026-06-26-stage1a-service-layer-design.md)**. It ships, with a production canary, **before** any code in this spec. Stage 1b (everything below) is built on the service contracts that spec defines:
- operation-specific services (`planPush`/`executePush`; `inspectPull`/`applyPull(…, resolver)` with the resolver invoked per-item inside the apply loop; `inspectStatus`; `validateWorkspace`) that return data and never exit, render, or prompt — they emit structured events to an injected sink;
- **operation-specific contexts** carrying **`persistedConfig` + `effectiveConfig`** (the seam that lets §4's runtime-defaults merge survive without the service reloading disk), `configPath`, `workspaceRoot`, a `prompter`, and an event sink; **online** contexts (push/pull) add a pre-built `client` with the §3 shared scheduler, while **offline** contexts (status/validate) build no client and need no credentials;
- a **locked-session** model where one layer owns the lock and the writer is patch-based (no lock reacquisition);
- the org runner is the **only** caller that detaches `planPush` from `executePush`; that detached path uses optimistic precondition revalidation (config digest / content hashes / remote assumptions) and treats a discovered concurrent create as `StalePlanError` → replan (race **reduction**, not prevention — the config lock is local/advisory). The single-course CLI keeps today's one-lock behavior and API-call sequence unchanged;
- a single top-level exit boundary (`index.ts` uses `parseAsync()` + one catch, sets `process.exitCode` once).

The rest of this document assumes that layer exists. In particular, Stage 1b's **shared scheduler** (§3), **per-member isolation** (§3), and **preflight-then-execute** (§1/§3) are the detached-path consumers of Stage 1a's contracts.

### 1. The org file (`vocareum.org.yaml`)

A new, **optional** file at the repo root. **Its presence alone changes nothing** — org mode activates only via an explicit selector or `org` subcommand (§3, Goal 3). If absent, or present-but-no-selector, vocgit behaves exactly as today.

```yaml
version: "1"
org:
  org_id: "347"
  auth_mode: oauth                            # "token" (v2, default) | "oauth" (v3); see §2
  # token mode only — ignored under oauth (oauth base URL is env-driven, see §2):
  token_api_base_url: "https://api.vocareum.com"
  max_courses_in_flight: 2                     # OPTIONAL course-worker cap (§3); default 2
  auto_commit: false                          # OPTIONAL single aggregate commit after all members (§4); default false
  throttle: { max_concurrency: 2 }            # OPTIONAL org-wide request budget (§3); else conservative member merge
courses:
  - name: cs101            # stable local handle, unique within the file; used by --course
    path: cs101            # dir (relative to org file) containing that course's vocareum.yaml
  - name: root-course
    path: .                # a course at the repo root IS a valid member (review P2 #8)
defaults:                  # OPTIONAL; merged into each member IN MEMORY at load, never written to disk
  publish_options:
    sync_settings: true
```

Schema (new `src/types/org-config.ts`, Zod, mirroring config.ts conventions — all IDs strings; `.strict()` on the tightly-bounded `org` and `defaults` objects so a stray/secret key is rejected, not silently accepted):

- `version: string` (required).
- `org.org_id: string` (required).
- `org.auth_mode: enum('token','oauth')` (optional, default `token` — matches existing global default).
- `org.token_api_base_url: string` (optional, default `https://api.vocareum.com`). **Token mode only.** Named explicitly (not `api_base_url`) to make P1 #5 unambiguous: under `oauth`, the base URL is the v3 host resolved from `VOCAREUM_API_V3_BASE_URL` and this field is ignored.
- `org.max_courses_in_flight: int` (optional, default 2) — course-worker cap (§3).
- `org.auto_commit: bool` (optional, default false) — one serialized aggregate commit after all members (§4); never in CI.
- `org.throttle: ThrottleConfig` (optional) — org-wide request budget (§3); if omitted, the conservative merge of member throttles is used.
- `courses: array` of `{ name: string; path: string }`, **min length 1**. (No per-course `auth_mode` — dropped, see Non-Goals / P1 #5.)
  - `name` unique within the file (duplicate → error).
  - `path` unique by **canonical realpath** (P1 #8): paths are resolved via `fs.realpath` + normalization before comparison, so `a`, `./a`, `a/`, and symlinked aliases pointing at the same directory are rejected as duplicates — not just string-distinct entries.
  - `path` resolved relative to the org file's directory; must resolve **inside** the repo root (reuse `path-security.ts` traversal guard — an org file is user-editable untrusted input, see Adversarial-Input Contract). `.` (root) is **allowed** — the guard rejects escapes (`../`), not the root itself.
- `defaults: { publish_options?: Partial<PublishOptions> }` (optional, `.strict()`). Stage 1 supports **only** `publish_options` keys; any other key under `defaults` is rejected so Stage 2's richer inheritance is introduced deliberately, not silently half-working.

**Invariants — split into preflight (abort) vs. runtime (isolate)** (resolving the rev-2 review's preflight-vs-isolation finding):

The org runner has an explicit **preflight phase** that validates *all* selected members before *any* mutation. The rule: **structural/identity errors abort the whole run before mutation; runtime/API errors isolate to one member.**

- *Preflight-abort errors* (whole run fails, exit non-zero, **nothing mutated**): org-file schema invalid; duplicate `name` or `path`; member `path` escapes root; a member's `vocareum.yaml` missing or unparseable; `org.org_id` ≠ a member's `vocareum.org_id` ([config.ts:422](../../../src/types/config.ts#L422)) (`OrgMismatchError`). These are config bugs the operator must fix; partially mutating an org on a known-bad manifest is worse than failing fast.
- *Runtime-isolate errors* (that member marked failed, others proceed): an API call fails mid-execute; a file upload fails; a network/timeout error. These are transient/per-course and isolation maximizes useful work.
- `validate --all-courses` reports an unparseable member as a validation failure (Open Question 3 resolved: yes).

A member `vocareum.yaml` is **byte-identical to today's schema**; the org file only *references* it. This is the structural guarantee behind Goal 3.

### 2. Org identity / auth

**One org credential drives all members** (Stage 1; per-course identity dropped, see Non-Goals). Mode resolution precedence, pinned (resolves P1 #5):

1. CLI `--auth <mode>` (highest — an operator override applies to the whole org run).
2. Else `VOCAREUM_AUTH_MODE` env.
3. Else org-file `org.auth_mode`.
4. Else built-in default `token`.

Base URL is **mode-specific** (this was the bug in the original spec — a single `api_base_url` field cannot serve both):

- `token` mode → `org.token_api_base_url` (default `https://api.vocareum.com`), passed to `createAuthProvider({ apiBaseUrl })`.
- `oauth` mode → v3 host from `VOCAREUM_API_V3_BASE_URL` via the existing OAuth provider; `org.token_api_base_url` is ignored. (Matches current `createAuthProvider` behavior — it only forwards `apiBaseUrl` for token mode.)

The provider is built with the **existing** `createAuthProvider()` ([auth-provider.ts:36](../../../src/api/auth/auth-provider.ts#L36)) — no new auth code. Secrets come from env/secret manager exactly as today; the org file **never contains secrets** (`.strict()` `org` has no token field).

- **Preferred:** `oauth` — issued to the org/service, not a person; one client authorized for all members. `GET /courses` returns exactly the credential's visible set.
- **Membership validation (warn, not fail) — online ops only (P0 #3):** for the **online** workflows (`push --all-courses`, `pull --all-courses`, `validate --remote --all-courses`, and `org status`), call `GET /courses` **once per run** (credential is org-scoped — resolves Open Question 2) and warn for any member `course_id` not in the visible set. **Offline workflows (`status --all-courses`, local `validate --all-courses`) make no API call** and skip membership validation entirely, honoring Stage 1a's offline contract. Warn, don't hard-fail — visibility semantics may vary.
- **GitHub Action auth precedence bug (P1 #7):** the precedence above puts env (`VOCAREUM_AUTH_MODE`) ahead of `org.auth_mode`, but the composite Action exports `VOCAREUM_AUTH_MODE` from its `auth` input whose default is `'token'` ([action.yml:30](../../../action.yml#L30)). An org file requesting `oauth` would be silently overridden. **Fix: change the Action's `auth` input default to empty.** With no value and no selector, `createAuthProvider` still falls back to `token` (existing behavior preserved); in org mode, an empty env lets `org.auth_mode` win. This action.yml change lands with Stage 1b.

### 3. CLI surface + iteration engine

**(a) Selectors on existing commands.** `push`, `pull`, `status`, `validate` (note: the command is `push`, not `publish` — [index.ts:297](../../../src/index.ts#L297); `status` is the default command) gain:
- `--all-courses` — act on every member.
- `--course <name>` — act on one member (by org-file `name`).

Activation (corrected per P0 #1 — **a selector, not the file's presence, is the gate**):
- Selector given **and** an org file is present → org mode, act on the selection.
- Selector given but **no** org file → error (`--course/--all-courses requires vocareum.org.yaml`).
- **No selector → today's single-course behavior, regardless of whether an org file exists.** The default `status` invocation, and every existing GitHub Action, therefore behave identically after an org file is added. This is the structural backing for Goal 3.

`--course`/`--all-courses` compose with the existing `--config`/`--root` workspace resolution ([workspace.ts](../../../src/core/workspace.ts)): in org mode the runner derives each member's workspace from its `path` and ignores `--config`/`--root` (they are single-course concepts); supplying both an org selector and `--config` is an error.

**(b) `vocgit org <subcommand>` namespace:**
- `vocgit org init` — see §3a below (specified to satisfy P1 #7).
- `vocgit org status` — tracked members vs. visible-but-untracked courses (drift vs. `GET /courses`), plus per-member config validity.

**Iteration engine** (`src/core/org-runner.ts`). There is **no single generic workflow** (review P0 #3 — generic plan→confirm→execute only describes push). Every workflow shares a common spine — **preflight all selected members (§1; preflight-abort errors stop the run, nothing mutated) → per-member work under the concurrency controls below → aggregated report (exit non-zero on any runtime failure)** — but the middle differs per command:

| Command (`--all-courses`/`--course`) | Online? | Per-member workflow |
|---|---|---|
| **push** | yes | `planPush` all members → **one aggregate confirmation** → per-member locked-session `executePush` with revalidation (Stage 1a §3) and the replan policy below |
| **pull** | yes | per-member locked-session `inspectPull` → `applyPull` with a **pre-set org-policy resolver** (no interactive per-item prompts across courses). Org pull **requires** an explicit policy: `--batch` (import orphans, pull drift, skip stale) or `--org-pull-policy <…>`; without one, org pull errors rather than prompting per item across N courses. Interactive per-course pull is still available via `--course <name>` (single member, today's interactive resolver). |
| **status** | **no** | per-member `inspectStatus` (offline, no client); aggregate the reports |
| **validate** | **no** (unless `--remote`) | per-member `validateWorkspace` (offline); `--remote` makes it online |

**Replan-after-confirmation policy (resolves P0 #2):** the single aggregate confirmation covers the plans as shown. If a member's pre-execute revalidation forces a **replan** (Stage 1a §3) and the new plan's `semanticFingerprint` **differs** from the confirmed one:
- **interactive** → re-confirm *that member's* new delta before executing it (others proceed);
- **non-interactive / `--batch`** → **fail that member as stale** (do not execute an unconfirmed change set), report it, exit non-zero.
A replan with an identical fingerprint executes without re-confirmation.

**Concurrency — two distinct limits (resolves P1 #5):**
1. A **shared org-level request scheduler**: one `RequestScheduler` injected into every member's `VocareumClient` so the aggregate honors one API request budget. Because members may declare **different** `throttle` configs, the org scheduler uses an explicit **`org.throttle`** from `vocareum.org.yaml` if present, else the **conservative merge** of member throttles (min concurrency, max interval). This bounds **API requests only**.
2. A separate **course-worker cap** (`org.max_courses_in_flight`, default 2) bounding how many member workflows run concurrently — because a request scheduler does **not** bound ZIP building, downloads, or Git operations. The spec does **not** claim the scheduler alone bounds cross-course execution.

**Aggregated report**: per-member status (`✓ cs101 — 3 updated`, `✗ cs201 — 2 files failed: …`, `⊘ cs301 — stale, skipped`). Exit non-zero if any member failed or was skipped-stale.

**(3a) `vocgit org init` — specified (P1 #7, hardened per P1 #8).** Stage 1 `org init` builds a manifest from courses that **already have** a `vocareum.yaml`; it does **not** create course configs (that is per-course `vocgit init`, kept separate). Flow:
- Resolve the org credential (§2). If it sees **multiple** orgs, prompt for which `org_id` (or require `--org-id`); single org → use it.
- **Discovery scan — with exclusions and inclusion criteria (P1 #8).** This repo itself contains `vocareum.yaml` files under `test/fixtures/` and `examples/`; a naive filename scan would propose fixtures and produce a manifest that fails preflight. Therefore the scan:
  - **excludes** `node_modules/`, `.git/`, `dist/`, `coverage/`, `test/`, `tests/`, `**/fixtures/**`, `examples/`, and anything matched by `.gitignore`;
  - **includes** a candidate only if its `vocareum.yaml` parses **and** its `vocareum.org_id` matches the chosen org (a fixture for a different org is skipped);
  - presents the candidate list and **requires explicit confirmation** before writing — never auto-commits the manifest.
  - Cross-references `GET /courses` to annotate each candidate with its Vocareum course name and to list visible-but-untracked courses (**not** auto-added — they have no local config; prints guidance to run `vocgit init` per new dir).
- **Duplicate detection by canonical realpath (P1 #8):** member `path` uniqueness is checked on `fs.realpath`-resolved, normalized absolute paths — so `a`, `./a`, `a/`, and symlinked aliases that resolve to the same directory are detected as duplicates, not just string-distinct entries.
- `name` sanitization: derive from directory path, lowercased, non-`[a-z0-9-_]` → `-`; on collision, suffix `-2`, `-3`, … Report the mapping.
- Idempotent: if `vocareum.org.yaml` exists, **merge** — add newly-discovered members, leave existing entries untouched, never delete a hand-added member; print a diff and require confirmation before writing.

### 4. Backward-compatibility & state

- `vocareum.yaml` schema **unchanged** → existing repos parse and push identically; existing GitHub Actions need no edits (the no-selector default path is untouched — §3).
- State stays **per-course, inline** in each member's `vocareum.yaml`. The org file holds **no state** — a pure, hand-editable index. (Why topology A over B: no merged state file, no cross-team merge conflicts, no history entanglement.)
- **`defaults` precedence + merge (resolves P1 #3):** precedence is **member explicit value > org `defaults` > built-in default**. Because `loadConfig()` bakes Zod defaults into `parsed.data` ([config.ts:61](../../../src/core/config.ts#L61)) — making a synthesized `sync_settings:true` indistinguishable from an explicit one — the merge operates on the **raw validated YAML** (members' `publish_options` keys *actually present in the file*) **before** `PublishOptionsSchema` defaults are applied. Concretely: org-config load reads each member's raw `publish_options` object, overlays org `defaults.publish_options` only for keys the member omitted, then applies the schema (and its built-in defaults) to the merged result. Merge is **shallow** over `publish_options` keys (the only supported `defaults` surface in Stage 1). The merge is runtime-only and **never written back** — member files stay diff-clean.
- **Auto-commit in org mode is disabled (resolves P1 #6).** Per-member config locks do **not** serialize Git: concurrent members each inheriting `auto_commit: true` would run `commitChanges` against the **same shared worktree** ([publisher.ts:1006](../../../src/core/publisher.ts#L1006)), racing. In org mode (`--all-courses`, and `--course` while other members could run) the runner **forces `auto_commit: false`** and, after all members finish, performs **one serialized aggregate commit** of all changed `vocareum.yaml` files (opt-in via `org.auto_commit`, default false; never in CI, matching the existing CI guard). Single-course CLI auto-commit is unchanged.
- **GitHub Action:** add optional inputs `course:` / `all-courses:` mapping to the selectors, and **change the `auth` input default to empty** (P1 #7) so the org file's `auth_mode` is not overridden by the Action's exported `VOCAREUM_AUTH_MODE`. With no selector and empty auth, behavior is identical to today (falls back to `token`). A repo may run one Action job per course (isolation) **or** one org job.

### 5. Persona walkthrough

| Persona | Stage 1 experience |
|---|---|
| **Course author / instructor** (today's user) | Does nothing, notices nothing. No selector → no new behavior, even if an org file exists in the repo. Their repo + CI untouched. "No disruption" is **structural**, not promised. |
| **Org-admin / curriculum-ops** (new persona, the reason this stage exists) | One credential. `vocgit org init` to scaffold, `vocgit push --all-courses` to deploy, one aggregated report. `vocgit org status` to audit coverage. |
| **CI/CD / DevOps** | Per-course isolation preserved (one job per course) **or** single org job with continue-on-error + non-zero aggregate exit. One shared scheduler caps org-wide API pressure. Org mode never activates without an explicit selector → existing default Action invocations keep their exact single-course behavior; no accidental org-wide blast radius. |
| **Vocareum platform / support** | Onboarding = "create one OAuth client for the org; run `vocgit org init`." No per-course token sprawl. |

### 6. How this de-risks Stages 2–3

- **Stage 2 (shared resources):** extend `defaults` beyond `publish_options` and add an org-level `templates:` list — the runtime-merge machinery (§1/§4) already exists; only the schema scope (`.strict()` allow-list) widens.
- **Stage 3 (ops/reporting):** new read-only subcommands on the §3 iteration engine (`org audit`, `org drift`) — the per-member iteration + aggregation already exists.

## Round-Trip Matrix (per AGENTS.md Feature Development Discipline)

State introduced: the org file's `courses[]` membership and the in-memory `defaults` merge. Every row maps to a test.

| Transition | Scenario | Expected | Test |
|---|---|---|---|
| **added** | New member added to `courses[]` | Next org run includes it | `org-runner: new member is iterated` |
| **removed** | Member removed from `courses[]` | Org run no longer touches it; its `vocareum.yaml` left intact on disk (NOT deleted) | `org-runner: removed member is skipped, files untouched` |
| **changed** | Member `path` repointed to a different subfolder | Engine uses the new path | `org-config: repointed path resolves to new config` |
| **unchanged** | Member entry identical run-to-run | No spurious action; identical result | `org-runner: idempotent on unchanged members` |
| **defaults added** | `defaults.publish_options` set | Merged in memory; member file on disk **unchanged** | `org-runner: defaults never written to member yaml` |
| **defaults removed** | `defaults` block deleted | Members fall back to their own `publish_options`; no residue | `org-runner: removing defaults restores member-only options` |
| **org_id changed** | Member `org_id` differs from `org.org_id` | Hard `OrgMismatchError` in **preflight** — whole run aborts, nothing mutated | `org-runner: org_id mismatch aborts in preflight` |
| **member config invalid** | Member `vocareum.yaml` missing/unparseable | **Preflight-abort** (structural error — §1): whole run fails before any mutation, exit non-zero | `org-runner: unparseable member aborts in preflight, no mutation` |
| **member API failure** | A member's API call fails mid-`execute` | **Runtime-isolate**: that member marked failed, others complete, exit non-zero | `org-runner: API failure isolated, run continues, exit != 0` |

## Adversarial-Input Contract (org file is untrusted, user-editable input)

| Attack / mistake | Defense |
|---|---|
| **Path traversal** in member `path` (`../../etc`) | `path-security.ts` guard — must resolve inside repo root; else `ConfigError`. |
| **Duplicate `name`** in `courses[]` | Reject at load with the offending name. |
| **Duplicate `path`** incl. aliases `a` / `./a` / `a/` / symlinks | Reject at load — uniqueness is checked on **canonical `fs.realpath`** paths, not strings (P1 #8). |
| **`org init` discovering fixtures/examples** | Scan excludes `test/`/`**/fixtures/**`/`examples/`/`node_modules/`/gitignored; includes only configs whose `org_id` matches; requires explicit confirmation (P1 #8). |
| **`defaults` with unknown keys** (e.g. `assignments:`) | `.strict()` on `defaults` → reject; Stage 1 allows only `publish_options`. |
| **Member `path: .` (root course)** | **Allowed** (review P2 #8): the loader targets the member's `vocareum.yaml`, never the `vocareum.org.yaml`, so a root course coexisting with the org file is valid and indexable. No loop exists — the org file is not a member config. Only reject a member whose dir has no `vocareum.yaml`. |
| **Secret smuggled into org file** (user pastes a token into `org:`) | Schema has no token field (`.strict()` on `org`); unknown key rejected. Reinforces "never persist secrets". |
| **`org_id` as number** (YAML `347` unquoted) | Zod `z.string()` rejects (no coercion) — matches the "all IDs are strings" discipline. |
| **Empty `courses: []`** | Min-length 1 → `ConfigError` with guidance to run `vocgit org init`. |
| **`--course` naming a nonexistent member** | Error listing available member names. |

## Scenario Contract (named acceptance tests)

1. *"Org file present, NO selector, `vocgit push` (or default `status`)"* → byte-for-byte identical to today's single-course behavior; org file ignored. **(Disruption guard — the most important test; this is the corrected P0 #1 activation rule.)**
2. *"No org file present, `--course x`"* → error (`--course requires vocareum.org.yaml`); no partial action.
3. *"Org file present, `vocgit push --all-courses`"* → all members preflighted, planned, one confirmation, executed via the service layer; one aggregated report; exit 0 iff all succeeded.
4. *"Org-wide push, one member's API call fails mid-execute"* → that member marked failed (runtime-isolate), others complete, exit non-zero, report names the failure.
5. *"`vocgit push --course cs201`"* → only cs201 pushed; others untouched.
6. *"Org file present, `--non-interactive --all-courses`"* → proceeds without prompts (the explicit selector is the consent); per-course isolation + aggregate exit code still apply.
7. *"`vocgit org init`, credential sees one course with an existing `vocareum.yaml`"* → manifest member created; rerun merges idempotently (diff + confirm, never clobber a hand-added member).
8. *"`vocgit org init`, credential sees multiple orgs"* → prompts for / requires `--org-id`.
9. *"`vocgit org status` with a visible-but-untracked course"* → reports it as drift; does not auto-add.
10. *"`defaults.publish_options.sync_settings: true`, member's file omits the key"* → member runs with `sync_settings` on; member's `vocareum.yaml` on disk unchanged after the run.
11. *"`defaults.publish_options.sync_settings: true`, member's file explicitly sets `sync_settings: false`"* → member's explicit `false` wins (precedence: member > org default); proves the raw-YAML merge runs **before** Zod defaults (P1 #3).
12. *"Member `org_id` mismatches `org.org_id`"* → `OrgMismatchError` in preflight; run aborts before any mutation.
13. *"Member `path` escapes repo root (`../x`)"* → `ConfigError` from the traversal guard; `path: .` is accepted.
14. *"Org-wide run against 3 members"* → all share one `RequestScheduler` (API budget) **and** the course-worker cap bounds concurrent member workflows; neither alone is claimed to bound the other (P1 #5).
15. *"Stage 1a: existing `push`/`status`/`validate` with NO org file"* → behavior byte-for-byte preserved after the service-layer refactor (regression guard for the refactor itself).
16. *"`vocgit pull --all-courses` with no policy"* → error requiring `--batch`/`--org-pull-policy` (no per-item prompting across N courses); `pull --course cs101` still prompts interactively (P0 #1/#3).
17. *"Org push, a member's plan goes stale and replans to a DIFFERENT change set"* → interactive: re-confirm that member's new delta; non-interactive: fail it stale, skip, exit non-zero (P0 #2).
18. *"Org push, member replans to the SAME `semanticFingerprint`"* → executes without re-confirmation (P0 #2).
19. *"Org push with `auto_commit` set on members"* → per-member commits suppressed; at most one serialized aggregate commit after all finish; none in CI (P1 #6).
20. *"`status --all-courses` with no credentials"* → succeeds offline; makes no `GET /courses` call (P0 #3 / Stage 1a offline contract).
21. *"`org init` in this repo"* → proposes no `test/fixtures` or `examples` member; symlinked/`./`-aliased duplicate paths rejected (P1 #8).
22. *"Org file sets `auth_mode: oauth`; Action `auth` input left empty"* → OAuth is honored (env no longer forces `token`); with no selector, falls back to `token` unchanged (P1 #7).

## System-Trace Checkpoint (per AGENTS.md)

Before merge, a dedicated reviewer traces scenarios 1, 3, 4, 11, 12, 14, 15 line-by-line through the cumulative code, focusing on the **seams**:
- **Activation seam** (Scenario 1): with an org file present but no selector, does any code path diverge from today's single-course flow? (The P0 #1 regression risk.)
- **Service-layer seam** (Scenario 15): after the Stage 1a refactor, do the existing commands behave identically? Does any service function still call `process.exit` or prompt?
- **org-runner → service layer** (Scenarios 3, 4): does each member truly run with its own resolved config, or does state leak between members (shared mutable config object, cached cwd, reused client carrying another member's base URL)?
- **Preflight vs. execute boundary** (Scenario 12): can an `org_id` mismatch or unparseable member ever slip past preflight and mutate one course before the bad one is reached?
- **defaults merge → member write path** (Scenarios 10, 11): does the merge run on raw YAML before Zod defaults, and does any write path persist merged defaults back into a member `vocareum.yaml`?
- **Shared scheduler** (Scenario 14): is exactly one `RequestScheduler` shared across all member clients, or does any member construct its own?

## Resolved Questions (were open in the draft; closed during review)

1. **Cross-course concurrency default:** aggregate cap of **2** in flight, enforced by the single shared org scheduler (§3 step 4). Conservative for API pressure; revisit if too slow.
2. **`org status` / membership `GET /courses` granularity:** **once per run** — the credential is org-scoped, so one call covers all members (§2).
3. **`validate --all-courses` on an unparseable member:** treated as a **validation failure** and, because an unparseable config is a structural error, it is a **preflight-abort** (§1).

## Remaining Open Questions (for the plan, not blocking)

- Whether Stage 1a ships as a separate released version before the org runner, or both land together behind the (inert-by-default) org feature. Lean: separate, so the refactor's regression surface is validated in production before org mode exists.
