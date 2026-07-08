# Changelog

All notable changes to `vocareum-publisher` (the `vocgit` CLI) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.7] — 2026-07-08

### Security
- **Directory scaffolding no longer writes `.gitkeep` through a symlink.** The
  configured-directory scaffolding added in 1.3.6 (`pull --content` and orphan
  import) used an unguarded write, so a configured directory that was a symlink
  escaping the workspace (e.g. `docs -> /outside`) would get its `.gitkeep` written
  outside the repository. Scaffolding now skips — with a warning — any configured
  directory whose final path component is a symlink, matching the confinement the
  content read/restore paths already enforce (the part base is realpath-confined by
  the caller, so guarding the final segment closes the escape).

## [1.3.6] — 2026-07-08

### Fixed
- **`pull --content` now restores an entirely-deleted assignment/part directory.**
  When the whole part directory was gone, the per-file confinement check ran
  `realpath()` on the missing base, threw `ENOENT`, and returned "not confined" —
  so *every* remote file was mislabeled as an escaping symlink and skipped, and
  nothing was restored (`writeFileUnderBase` had already worked around this same
  ENOENT trap on the write side; the read/detection path had not). Detection now
  recognizes a missing base — there are no local files or symlinks to read
  through — and treats every remote file as a fresh add; apply recreates the base
  and confines each individual write.

### Added
- **`pull --content` scaffolds the part's configured directories** after a content
  restore, matching a fresh import: any declared directory that is empty on the
  remote is recreated with a `.gitkeep`, while directories that received content
  are left untouched. Note: deleting an *already-empty* subdirectory is not
  restored, because it produces no content drift to trigger the pull.

## [1.3.5] — 2026-07-07

### Fixed
- **`pull --content` can again restore a deleted directory in an assignment that
  also contains a symlink.** Previously, a single remote file whose local path was
  (or resolved through) a symlink aborted the content drift check for the **entire
  assignment** — so a separately-deleted directory in that same assignment was
  never detected or re-pulled, and the only recovery was to drop `vocareum.yaml`
  and re-init. This affected both symlinks **escaping** the part directory (e.g.
  `docs/README.html` pointing into the shared `course/`≡`lib/` tree) and **in-part**
  symlinks, which `writeFileUnderBase` refuses to overwrite regardless of target.
  vocgit now skips just the symlinked file (with a per-file warning) and still
  compares/restores the rest of the part.

### Security
- Hardened the content-drift scan and the stored remote-file map against symlinks.
  The remote-file map persisted for apply now excludes any file whose local path
  escapes the part directory **or** is itself a symlink, so a restore is never
  aborted by `writeFileUnderBase` rejecting the path. The **deleted-file** detector
  additionally skips any directory or nested entry whose path resolves outside the
  part directory, so apply's `unlink` can never follow a symlink and delete a file
  outside the workspace.

## [1.3.4] — 2026-07-07

### Changed
- Push settings-update fallbacks now log the Vocareum API's **actual 400 message**
  (`[API: …]`) when a part or assignment settings `PUT` is rejected and vocgit retries
  with a reduced payload. Previously the warning only said "rejected", hiding *which*
  field the API objected to (e.g. re-sending create-only lab fields like `labtype` /
  `container_image` / `lab_interface` on Databricks/cloud parts). Diagnostic only — the
  retry ladder's behavior is unchanged.

## [1.3.3] — 2026-07-02

### Fixed
- **Orphan import no longer fails with a bogus symlink error**: `vocgit pull`
  imports failed with `Invalid path: "..." escapes base directory through a
  symlink` for every orphaned assignment because the symlink-hardened write
  path treated a not-yet-created import directory as an escape (`realpath` on
  the missing base). `writeFileUnderBase` now creates the trusted base
  directory before running its confinement checks, restoring fresh imports
  while keeping all symlink-escape rejections intact.
- **`lti_url` classified as a non-setting**: Vocareum returns a server-derived
  LTI launch URL on assignment reads. It is identity metadata (encodes the
  course/assignment IDs), not an instructor-configurable setting, so it is now
  dropped like `part_url` instead of being preserved under `_unknown_settings`
  and flagged in the end-of-run unsupported-fields report.

### Security
- The user-typed import directory name is now confined to the workspace with
  realpath-based validation (`assertConfinedToWorkspace`) before any directory
  creation. A lexical-only check was insufficient: a name beneath an
  in-workspace symlink that points outside the workspace would pass the lexical
  test and let the import write outside the working tree.
- Removed an accidental self-dependency (`vocareum-publisher` listed in its own
  `dependencies`) that caused a nested copy of the package to be installed.

## [1.3.2] — 2026-06-28 — Stage 1a: internal service layer

### Internal / non-user-facing

This release contains a behaviour-preserving internal refactor only. No CLI
flags, config keys, output formats, exit codes, or API contracts have changed.

- **Service layer** (`src/core/services/`): `push`, `pull`, `status`, and
  `validate` commands now delegate their core logic through a dedicated service
  layer rather than invoking API and filesystem helpers inline in the command
  handlers. This decouples command-line parsing from business logic and makes
  each operation independently testable without spawning a subprocess.
- **Centralised process exit**: a single `CommandFailureError` path owns all
  non-zero exits; command handlers rethrow rather than catching and
  `process.exit`-ing independently, eliminating the double-log risk.
- **Injected `RequestScheduler` capability**: the Vocareum API client now
  accepts an optional `RequestScheduler` at construction time (defaults to the
  existing throttle implementation). This seam supports deterministic testing
  and future per-operation rate-limit overrides without changing the public
  `throttle` config surface.
- **Composite-action smoke test** (`test/integration/action-smoke.test.ts`):
  first concrete end-to-end subprocess test that builds the CLI and invokes the
  published-entry binary (`dist/index.js`) against the sample fixture, proving
  that install + invoke works headlessly (addresses P2 #11).

## [1.3.1] - 2026-06-20

### Security
- Hardened pull/download handling: remote file writes now reject symlink escapes
  (lexical + realpath confinement, `O_NOFOLLOW` where supported), content-drift
  reads reject symlinked paths that escape the part directory, remote content
  downloads enforce file-count and per-file/cumulative byte limits (oversize
  responses abort instead of being silently skipped), directory hashing streams
  file contents instead of buffering whole trees, and exclude-pattern matching
  no longer builds dynamic regexes (closes a ReDoS vector on attacker-supplied
  `exclude_patterns`).

### Behavior changes
- Windows hashing now normalizes path separators before applying exclude
  patterns. This correctly excludes nested `.gitkeep` files on Windows; Windows
  repositories with content hashes computed by older vocgit versions may see a
  one-time resync as hashes self-heal.
- Exclude pattern matching now treats `**` as zero or more path segments, so a
  custom pattern such as `**/x` also matches a top-level `x`.

## [1.3.0] - 2026-06-20

### Behavior changes
- `vocgit pull` no longer downloads remote content by default. Content-drift
  detection is now opt-in via `--content`, optionally scoped with
  `--assignment <name|id>` (repeatable) and `--part <part_id>` (requires exactly
  one `--assignment`). Orphan-import behavior and `--skip-content` are unchanged.

### Added
- Proactive request throttle for the Vocareum API client: `vocareum.throttle`
  config block (`max_concurrency` 1..5, default 1; `min_interval_ms` 0..60000,
  default 300; `jitter`, default true) plus env overrides
  `VOCAREUM_MAX_CONCURRENCY`, `VOCAREUM_MIN_REQUEST_INTERVAL_MS`,
  `VOCAREUM_THROTTLE_JITTER`. Requests are FIFO-scheduled with a concurrency cap
  and jittered minimum spacing.

## [1.2.0] - 2026-06-11

### Added
- `vocgit status --json`: versioned machine-readable report (schema_version 1) with
  per-assignment/part/directory CONTENT sync status, computed with the same change
  detection push uses. Offline — settings drift is not included. Consumed by the
  VS Code extension for sidebar badges.
- `--root <path>` option on `status`, `push`, `pull`, `validate`, and `fix`: the
  workspace root that assignment/part paths resolve against.

### Changed
- **Workspace root resolution (migration note).** Commands now resolve a workspace
  root explicitly instead of silently using the current directory:
  - Running from the repository root (the config next to you): **no change**.
    The VS Code extension is unaffected. The GitHub Action gained a `root`
    input defaulting to `.` and always passes it, so Action users — including
    those with a nested `config-file` — keep their previous path semantics.
  - `vocgit --config ../repo/vocareum.yaml` from another directory now **fails**
    with an actionable error until you add `--root ../repo`. Previously this
    silently recorded wrong state (every directory hashed as empty) and, with
    `--sync-deletes`, could wipe remote content.
  - A config stored below the root (e.g. `configs/vocareum.yaml`) requires
    `--root .` to preserve the previous cwd-relative path semantics.
  - Git operations, `.env` loading, and auto-commit now run against the
    workspace root rather than the process cwd.

### Security
- Workspace confinement: assignment/part paths from `vocareum.yaml` (and the
  directories under them, including symlinks) can no longer cause reads,
  uploads, writes, or deletions outside the workspace root. Enforced in the
  validator/fixer, change detector, uploader, publisher, pull drift
  detection/apply, and the status scanner; `status --json` reports escaping
  paths as `error` statuses.
  Syncing files outside the workspace was never supported and is contrary to
  the Git-source-of-truth model.

## [1.1.1] - 2026-06-11

### Fixed
- Return schema-parsed configuration data so defaults, transforms, and coercions do not cause false drift.
- Fail closed when remote file listing or strict pull downloads fail.
- Serialize config writers with ownership-checked locks and durable atomic writes.
- Retry transient failures only for idempotent requests and honor valid `Retry-After` values.
- Move the composite GitHub Action metadata to the repository root and add CI smoke coverage.

### Security
- Update production and development dependency locks to resolve reported npm audit vulnerabilities.

## [1.1.0] - 2026-06-01

### Added
- **v3 OAuth client-credentials auth** (`--auth oauth` / `VOCAREUM_AUTH_MODE=oauth`) alongside the existing v2 token auth (default unchanged). Introduces an `AuthProvider` seam, lazy OAuth token exchange with caching and a single 401 refresh-retry, path-aware base-URL and token-URL validation, and recursive log redaction of secrets. The auth mode is bound to its host (token→v2, oauth→v3), so a crossed base-URL override (e.g. `VOCAREUM_API_V3_BASE_URL` pointed at the v2 host) is rejected rather than sending a `Bearer` token to the wrong host. A 401 error message is tailored to the active mode (personal token vs OAuth client credentials), and `vocgit status` reports the configured auth mode and its credentials. New env vars: `VOCAREUM_AUTH_MODE`, `VOCAREUM_OAUTH_CLIENT_ID`, `VOCAREUM_OAUTH_CLIENT_SECRET`, `VOCAREUM_API_V3_BASE_URL`, `VOCAREUM_OAUTH_TOKEN_URL`.

### Changed
- **GitHub Action is now a composite action** that installs the published `vocgit` CLI (pinned to the action's version) and runs `vocgit push`, replacing the prior unbuilt `node20` JS action (`dist/action/` was never produced and `build:action` failed). It now supports v3 OAuth via new `auth`/`client-id`/`client-secret` inputs; `api-key` is optional. Outputs are reduced to `success` (the job fails on error).

### Fixed
- Cleared all ESLint errors (`no-constant-condition`, `require-await`, redundant `no-unnecessary-type-assertion` casts); `npm run lint` now exits with no errors.

## [1.0.23]

### Added
- **README "Understanding Settings Sync" section** explaining the settings model:
  top-level (writable) settings, `_observed_settings` (read-only), `_unknown_settings`
  (preserved/passed-through), the "accepted but not confirmed" fields, and the
  `sync_settings` opt-out with its part → assignment → global precedence.
- This `CHANGELOG.md`.

## [1.0.22]

### Added
- **`sync_settings` opt-out.** Set `publish_options.sync_settings: false` to sync files
  only and leave Vocareum settings untouched. Overridable per assignment and per part
  (precedence: part → assignment → global → default `true`). When disabled, vocgit skips
  both pushing settings and reporting settings drift on pull, and skips the related API
  reads.

### Changed
- **Applied the Vocareum API capability report.** Corrected the `exam_mode` enum to
  `NO_EXAM | SCHEDULED | TIMED | TIMED_UNRESTRICTED` (was `TIMED_SCHEDULED`). Promoted
  `late_penalty_percent`, `late_penalty_percent_rule`, `deadlinedate`, and
  `number_of_submissions` (part) to writable settings — previously read-only — using
  write-and-trust semantics for fields the API accepts but does not echo on read.

### Fixed
- Content upload/sync transactions now treat `error` as a terminal failure state (not
  only `failed`), so a failed content transaction fails fast instead of polling until
  timeout.

## [1.0.21]

### Changed
- **Aligned settings handling with live API probes.** Classified server-managed fields
  (`create_method`, `groupid`, `groupdisplayorder`, `masterid`, `num_parts`, `part_ids`,
  `gradespublished`, …) as non-settings so they are no longer surfaced as drift or written
  back. Added the `_observed_settings` bucket for fields Vocareum reports on read but does
  not accept on write. Normalized `exam_mode`/`grading_visibility` to uppercase enums and
  coalesced the read-side `gradespublished` field into the writable `publish_grades`.

## [1.0.20]

### Added
- **Forward-compatible settings.** Unrecognized Vocareum settings fields returned by the
  API are preserved under `_unknown_settings` in `vocareum.yaml` and passed back through
  unchanged on push, so new platform features are never silently dropped. An end-of-run
  summary lists any unknown fields seen and points to the issue tracker so they can be
  promoted to supported settings.

## [1.0.19]

### Changed
- Use customer-facing part names for imported directories on pull.

## [1.0.18]

### Fixed
- API pagination, zero-byte directory placeholders, and per-part download planning.

## [1.0.17]

### Added
- `--skip-content` flag for `pull` to reuse existing local files when retrying after a
  failed pull.

## [1.0.16]

### Fixed
- Coerce Vocareum's `lti_on` `"1"`/`"0"` string values to booleans.

## [1.0.15]

### Fixed
- Handle non-file entries in Vocareum file listings.
