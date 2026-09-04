# Changelog

All notable changes to `vocareum-publisher` (the `vocgit` CLI) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **`pull` no longer silently skips `scripts/` and `startercode/` on Elite
  courses.** `toApiDirPath` accepted an `architecture` argument and ignored it,
  routing only `asnlib`/`lib` to `/resource` and everything else to `/voc`.
  Elite workspaces have no `/voc` at all — their root is `['resource', 'work']` —
  so those directories were requested at paths that cannot exist, the API
  answered `"doesn't exist"`, and the missing-optional-directory branch turned
  that into an empty listing. Pulls reported success, wrote a `.gitkeep` into the
  empty local directory, and exited 0. On one course this left every
  `build.sh`/`grade.sh`/`run.sh`/`submit.sh` across 9 assignments on the server.
  Container courses are unaffected — their mapping is unchanged.
- **`push` now derives workspace architecture from `labtype` when the config does
  not set it**, matching what `pull` already did. `vocareum.architecture` is
  optional and in practice unset, so every Elite course was treated as Container
  on push: the `--sync-deletes` listing asked for `/voc/…`, got an empty result,
  and planned no deletions. Not destructive, but inert on exactly the courses the
  path fix targets. Both paths now share one `resolveArchitecture()` so they
  cannot drift apart again.
- **Large content directories now upload.** `uploadContent` zipped an entire
  directory into a single base64 `PUT`: a 108 MB `docs/` became a ~144 MB body
  against a fixed 60s timeout, and peak memory ran to several times the
  directory size. Uploads are
  now split into sequential size-bounded chunks — the first carrying `reset: 1`
  to clear the target, the rest `reset: 0` to append — and the request timeout
  and transaction poll ceiling scale with payload size. The zip, base64 string
  and request body are now bounded by the chunk size rather than the directory
  size. (The input `FileMap` is still read whole by `uploadDirectory`, so total
  peak memory falls but is not itself bounded by the chunk size.)

  Verified against live courses: a 74 MB directory (496 files, 3 chunks) and a
  110 MB directory (786 files, 4 chunks) both uploaded completely and matched
  local exactly, having previously failed every attempt. Note the earlier
  failures were **not** caused by payload size: the same
  `The previous corresponding API request is not yet complete` error was later
  reproduced on a 7 KB chunk, and those two parts turned out to be wedged
  server-side, rejecting every part-level write regardless of size. Deleting and
  recreating the assignments cleared it. Chunking is what let the content land
  once the parts were writable again; it is not a fix for a wedged part.
- **Part settings are no longer silently discarded.** `pull` returns
  `container_image`, `push` echoed it back, and the write API rejected it —
  sending the part into a fallback that kept only name, filters, session length
  and budget while dropping `max_points`, `lab_interface`, `instant_aws_access`
  and `tags`, and still reporting a green "Updated part". `labtype` and
  `container_image` are now stripped from every part-settings update
  unconditionally, not compared against remote state and omitted only when
  unchanged — the API rejected them in every combination tested, and the
  omission has to be deterministic so the payload `push` plans matches the one
  it sends. One consequence: changing a part's lab type or container image
  through `push` is no longer possible. In practice this is not a loss of a
  working path — the API rejected the round-tripped value regardless — but it
  is a capability gap worth knowing about. A rejection on the remaining fields
  still retries by removing just those two, and any settings still given up
  are named at `warn`.

  **This does not make `max_points` / `total_points` take effect.** Those are a
  separate, server-side problem: the API returns them on `GET`, accepts them on
  `PUT` with a 200 and no warning, and then does not persist them (Vocareum
  VOC-4003). Verified on a request that was otherwise fully applied — in the same
  `PUT` that successfully changed `instant_aws_access`, `max_points` was ignored
  and the part still read its old value. vocgit now reports what it *declines to
  send*; it cannot report what the server accepts and discards, because
  `updatePart` does not read the part back. So a course whose point values matter
  should be verified in the Vocareum UI after a push until VOC-4003 is fixed.

### Changed
- **A declared directory that the API reports absent is now a warning rather than
  silence.** Returning an empty listing stays correct — throwing would make
  `pull` read the absence as remote deletions — but the silence is what hid both
  this bug and the 1.3.8 depth truncation, each of which lost content with exit
  code 0. The warning names the exact path requested, so a wrong prefix is
  visible as a wrong prefix. It fires only for directories a part declares, not
  for the walk's speculative probes.

### Changed
- **Point totals are no longer round-tripped as unknown settings.** A part's `max_points`
  and an assignment's `total_points` are derived by Vocareum from rubric criteria — the sum
  of each criterion's `maxscore` where `exclude` is not true — and are not storable. Probing
  confirmed both halves: a part `PUT` setting `max_points` returns a successful
  *"Part updated"* transaction and changes nothing, and an assignment `PUT` setting
  `total_points` is rejected with *"No valid parameters to update the assignment"*. That is
  the whole of Vocareum VOC-4003 — the field was never there to write.

  vocgit previously captured both under `_unknown_settings`, sent them on every part-settings
  update that ran for other reasons, had them ignored, and nagged you to file an enhancement
  request for them. They now land in `_observed_settings` instead: still visible in
  `vocareum.yaml` so you can read a part's point total, never sent, and no longer reported as
  unsupported. `_unknown_settings.max_points` is now refused with a warning rather than
  quietly added to the payload.

  Existing configs migrate themselves — the next `pull` reports the change as settings drift
  and rewrites both fields into `_observed_settings`.

  To change a course's points, change its rubric criteria. vocgit reads rubrics but does not
  yet write them, so that remains a Vocareum UI operation for now.

### Added
- `VOCAREUM_MAX_UPLOAD_CHUNK_BYTES` to tune the upload chunk size
  (default 32 MB, range 1 KB–64 MB).
- `PartialUploadError`, raised when a multi-chunk upload fails partway, naming
  the chunk position and stating that a re-run rebuilds the directory.
- **`pull` now records grading rubrics.** Each part's rubric criteria are fetched
  from `/courses/{c}/assignments/{a}/parts/{p}/rubrics` and stored under
  `parts[].rubrics` in `vocareum.yaml`, with drift reported alongside part settings
  and captured on orphan import. Previously rubrics were invisible to vocgit
  entirely: a pull reported success and wrote nothing, and nothing warned that
  rubric data existed. In one migration this meant 425 criteria carrying 2,448
  points did not reach the target courses.

  Rubrics remain **read-only**: `push` does not create, update or delete rubric
  rows, so a migrated course still needs its rubrics entered by hand. The write
  API's payload shape is unverified and is being probed before push support is
  designed.

  The rubrics token permission is optional at token creation. A token without it
  logs a warning and pull continues normally — settings and content drift are
  unaffected. There are two independent fetchers (drift detection and orphan
  import), so a single run can log this at most twice. Set
  `publish_options.sync_rubrics: false` to skip the fetch entirely (it costs at
  least one API call per part — more if a part has over 100 criteria);
  `sync_settings: false` skips it too during drift detection,
  since rubrics are read during the settings pass — orphan import still records
  rubrics whenever `sync_rubrics` is on, the same way it records settings.

## [1.3.8] — 2026-09-02

### Fixed
- **`pull` now reaches locale-nested assets that were being silently dropped.**
  The download walk capped recursion at 4 levels below a part directory, which
  landed exactly one level short of the AWS Academy content layout: with the part
  root at depth 0, `asnlib/public/docs/lang/<locale>` is listed at depth 4, so its
  `images/` child needed a descent to depth 5 and was refused. The truncation was
  invisible because of where it fell — the `README.md`/`README.html` beside those
  directories were fetched normally, and the unrelated `asnlib/public/docs/images`
  sibling sits at depth 3 — so pulls reported success while every per-locale image
  directory in the course was missing. On one real course this left **all 138**
  image references across 8 assignments and 11 locales pointing at files that had
  never been downloaded. The cap is now 10, with headroom over the deepest known
  layout; runaway recursion is bounded by the download budget (`maxFiles`,
  `maxTotalBytes`), which is charged for every listed entry.

- **The download walk no longer grinds through symlink cycles.** Vocareum
  workspaces carry escaping symlinks such as `publicdata -> /mnt/worktest/<course>/data`,
  and the files API lists the same child under every level of one — so the walk
  saw `lib/publicdata/publicdata/publicdata/…` without end and only stopped when
  it exhausted the depth budget, spending roughly 22 API calls per part on a path
  that holds nothing. A repeat of three identical consecutive path segments is now
  recognized as a cycle and the descent stops there (a real file at such a path is
  still downloaded; only the descent is refused). This was pre-existing, and
  invisible while truncation was logged at `debug`.

### Changed
- **Depth-cap truncation is now a warning instead of a debug message.** Skipping a
  subtree drops files while the pull still reports success, so it is surfaced at
  `warn` and names what was not downloaded. Previously this was only visible under
  `--verbose`, which is why the truncation above went unnoticed. Cycles are
  deliberately *not* reported this way — nothing below them is lost, and mixing
  them in would bury the real signal.

### Security
- Bumped `axios` to 1.20.0 (NO_PROXY bypass for `0.0.0.0`; excessive recursion in
  `formDataToJSON`) and `js-yaml` to 4.3.2 (CVE-2026-59870, quadratic CPU in
  `!!omap` resolution). Both are lockfile-only updates within the existing semver
  ranges; CI gates on `npm audit --omit=dev --audit-level=high`.

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
