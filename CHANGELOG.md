# Changelog

All notable changes to `vocareum-publisher` (the `vocgit` CLI) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### VS Code extension

- **Extension 1.2.0**, attached to the v1.5.0 GitHub Release as
  `vocgit-1.2.0.vsix`. It reads the CLI 1.5 `--json` envelope for the sidebar
  sync badges, and still reads the CLI 1.2–1.4 report. Extension 1.1.0 shows
  "unknown" badges against CLI 1.5.

## [1.5.0] — 2026-11-12

(A `[1.5.0]` section dated 2026-11-09 was written for the EU tenant work but
never published; it is folded in here.)

### Added
- **Zip download for content pull.** Each directory is fetched as one zip and
  unpacked locally, falling back to the file-by-file walk when the zip cannot be
  trusted. On by default; `VOCAREUM_PULL_ZIP=0` turns it off, and
  `VOCAREUM_ZIP_TIMEOUT_MS` (default 600000, range 1000-3600000) bounds one
  directory. An invalid value exits 2 before any request. A small directory can
  take up to about 8 s longer because of the settle check. Run one pull per part
  per user at a time; the README lists the remaining risk. Some symlinked files
  arrive through the zip as copies of their targets, so a directory holding only
  such links now pulls complete, and a later push uploads them as regular files.
  Measured on a 9,000-file venv directory: 50 minutes instead of 4 h 55 min, with
  identical bytes for every file both paths fetched.
- **`zip_not_used` (warn) and `directory_blocked` (error) diagnostics**, with
  closed reason sets. After a zip rejection that happens once the zip job has
  started, the rest of that part is pulled file by file, and each later
  directory reports `quarantined`. A directory whose zip is not used because of
  the checks before the job starts (`listing_failed`, `listing_over_budget`,
  `listed_size_over_limit`) is pulled file by file on its own.
- **`--json` on `pull`, `push`, `status`, `validate` and `fix`.** stdout carries
  exactly one versioned envelope; human output moves to stderr. `--json` implies
  `--non-interactive`.
- **A retryability-oriented exit-code taxonomy.** `0` success · `1` internal ·
  `2` usage/config · `3` auth · `4` transient (retry) · `5` findings outstanding ·
  `6` partial. The split that matters to an automated caller is retryable versus
  terminal, which a single `1` could not express.
- **Coded diagnostics.** A closed registry of stable codes (`directory_unreachable`,
  `upload_incomplete`, `delete_sync_failed`, `part_settings_fallback`, the rubric
  codes, and others) with structured data, deduplicated with a `count`. Branch on
  `code`, never on message text.
- **`vocgit --version --json`** reporting the version, the resolved binary path,
  git provenance from a build stamp, and a capability list.
- **Peer review settings are supported.** The twelve peer-review assignment fields
  (`peer_review_toggle`, `peer_schedule_mode`, `peer_review_start_date`,
  `peer_review_end_date`, `peer_hide_code`, `peer_gallery`, `peer_grading_toggle`,
  `reviews_number`, `reviewguide`, `reviewpenalty`, `reviewpenalty_percentrule`,
  `reviewcalc`) are now typed settings. Before, they were passed through untyped in
  `_unknown_settings`. Each was checked against the live API before being promoted: all
  twelve are stored. The config is checked against the API's own limits when it loads:
  - dates must be real `YYYY-MM-DD` dates, and `null` clears a date on push. YAML dates
    are no longer parsed as timestamps, so an unquoted `2026-02-30` is an error instead of
    silently becoming 2 March;
  - `reviews_number` is a whole number 1–10 and `reviewpenalty` a whole number 0–100;
  - the three enums accept only the values the API lists, in any case.
  While peer review is off (in the config, or in Vocareum when the config does not set the
  toggle), push sends the three peer options as `false` and warns: Vocareum rejects them as
  `true` then. Changes to these fields are detected by both pull and push. (Field report #5.)
- **Part `cleanup_time`** is a known setting: a whole number, 0 or more. Vocareum stores it
  on container labs only; on a Vocareum Standard (Elite) part, which reads it back as 0, push
  warns and does not send it.
- **`VOCAREUM_MAX_DOWNLOAD_FILES`** raises the per-part file-count cap for pull
  downloads (default 5,000, range 1 to 1,000,000). Courses that ship Python
  environments under `data/` list tens of thousands of files.

- **The Vocareum EU tenant is supported out of the box.**
  `https://api.eu.vocareum.com/api/v2` is now on the v2 allowlist next to the
  NA host. Previously an EU course needed `VOCAREUM_ALLOW_CUSTOM_BASE_URL=1`,
  which switched the credential-safety allowlist off entirely and printed a
  "credentials will be sent to this host" warning on every call. It also needed
  a hand edit of `api_base_url` after `vocgit init`. A user who forgot that edit
  sent their EU API key to the NA host.
  The allowlist is now built from a region table (`src/api/regions.ts`), and
  the token→v2 / OAuth→v3 host binding is unchanged. No EU v3/OAuth host is
  allowlisted: none is confirmed, so it is a marked TODO in the table, not an
  entry.
- **`vocgit init --region <na|eu>` and `--api-base-url <url>`.** `init` writes the
  chosen tenant's host to `vocareum.api_base_url`. When neither flag is given,
  `init` prompts for the region before the org ID, with NA as the default.
  `VOCAREUM_API_BASE_URL` also skips the prompt, whether it comes from the
  shell or from `.env` (which `init` now loads, as pull and push already do).
  `--api-base-url` goes through the same HTTPS + allowlist check that pull and
  push apply, so `init` never writes a host they would refuse.
- **`VOCAREUM_API_BASE_URL` and `--api-base-url` on `pull`/`push`.** These
  override the v2 host for one run. Precedence: flag > env > `vocareum.yaml` >
  NA default. Both still have to pass the allowlist. If an override points
  somewhere other than the host in `vocareum.yaml`, vocgit warns and names both
  hosts, so a stray shell export cannot quietly redirect a push to the other
  tenant. `--api-base-url` with `--auth oauth` is an error, not silently ignored.
- **`vocgit status` shows the API host, region, and source** (`vocareum.yaml`
  or `VOCAREUM_API_BASE_URL`). It also flags a host that is not allowlisted.
  `status --json` reports it in `payload.api`
  (`base_url`, `host`, `region`, `source`, `allowlisted`, `malformed`).

- **`fix` creates missing declared directories.** `fix --help` always listed
  them among what it repairs, but only missing assignment/part folders were
  acted on; a part declaring `directories: [startercode]` with no `startercode/`
  was reported unfixable. Paths that resolve outside the workspace are never
  created.
- **`part_settings_rejected` diagnostic** (severity `error`) for a part-settings
  update rejected at every fallback level. `part_settings_fallback` now means
  only the degrading case, where some settings were written.

### Changed
- **Pull keeps directory-alias content, and drift now compares `asnlib`.** On a
  Container course the zip delivers `asnlib/public/docs` and `asnlib/publicdata`,
  which file-by-file download could not fetch; they are kept, duplicating `docs`
  and `data` locally. Strict drift used to fail on those entries and skip the
  assignment, so `asnlib` was never compared. Now it is compared like any
  readable directory: a remote deletion is reported `deleted`, and a local file
  under `asnlib` that the remote lacks is also reported `deleted` and removed by
  apply (with no prompt under `--batch`). The README lists the other differences
  from file-by-file download.
- **Push refuses `asnlib` unless the course root is positively Elite.** On a
  Container course an upload could replace the `docs`/`data` aliases. A refused
  `asnlib` is marked `push-incomplete`, retried on the next push, and reported as
  `partial`. `vocgit status` does not check this. Vocareum's own template copy on
  create is not refused.
- **The incomplete-pull block now emits `directory_blocked`**, and the push plan
  summary always lists blocked directories with their reason.
- **`blockedDirectories` in the push `--json` plan is `{ dir, reason }[]`**, not
  `string[]`. Schema 1.0 is what 1.5.0 first publishes, so this is not a bump.
- **Exit codes are now categorized.** Every failure previously exited `1`; a
  caller matching `== 1` exactly will now see 2, 3, 4, 5 or 6. A caller testing
  `!= 0` is unaffected by the recategorization itself, **but some runs that used
  to exit 0 now fail**, because they were failures reported as success:
  - a pull that could not read an assignment's settings, or could not finish a
    `--content` check, exits 6 (it printed "No sync issues found" and exited 0);
  - a push whose settings update the API rejected at every fallback level, or
    whose `--sync-deletes` pass did not delete what it had to, exits 6;
  - `fix` exits 6 when it could not create a folder;
  - with `--json` only: outstanding findings exit 5, including `pull --batch
    --json` while a stale assignment (in `vocareum.yaml`, gone from Vocareum)
    is unresolved, and `push --dry-run --json` with planned changes. Without
    `--json`, findings still exit 0, as before.
  The GitHub Action runs `vocgit push` without `--json`, so findings never fail
  it; it fails on any non-zero exit, as before. What is new is the push
  failures above: a step that used to pass while deletions or settings were
  silently not applied now fails.
- **An unknown command exits 2.** `status` is the default command, so
  `vocgit bogus` used to print a status report and exit 0, and `vocgit pus --json`
  (a typo for `push`) emitted a successful status envelope while pushing nothing.
- **An unknown option exits 2** (previously 1), and under `--json` writes a
  failure envelope instead of leaving stdout empty.
- **`fix` keeps going after a folder it cannot create**, and reports it (exit 6
  under `--json`) instead of abandoning the remaining fixes. Warnings it cannot repair, such as
  orphan folders, are now reported as remaining (exit 5 under `--json`) rather
  than hidden behind "No issues found".
- **`status --json` emits the shared envelope.** Its former numeric top-level
  `schema_version: 1` is now `payload.payload_schema_version: 2`, under an
  envelope whose `schema_version` is the string `"1.0"`. Tools that parse the
  old top-level shape — including the VS Code extension's sync badges — must be
  updated to read `payload`.
- **A part-settings update the API rejects at every fallback level is now a
  failure.** It was recorded as "skipped", so a push that applied none of the
  requested settings still reported success and exited 0. Such a push now exits
  6 (partial) and names the part. If you have a chronically rejected settings
  payload, runs that used to look green will now report the failure they always
  were.
- **A rejected file deletion no longer counts as deleted.** `--sync-deletes`
  recorded every attempt and reported "Deleted N files" even when the API refused
  them; it now reports what actually happened and keeps the directory eligible
  for retry, which means such a push reports partial rather than success.
- **Dependencies upgraded to clear `npm audit`:** `zod` 3 → 4 (memory exhaustion
  advisory GHSA-mrhx-c7xc-m3w5), `simple-git` 3 → 4 (critical advisory
  GHSA-v5rq-49vh-5v5c), and `follow-redirects` (via axios) to 1.16.3. Config
  validation errors now use zod 4's wording, e.g. `Invalid input: expected string,
  received number` rather than `Expected string, received number`, and a missing
  field reads `expected string, received undefined` rather than `Required`.
  vocgit's hints follow the new wording: the object-vs-array hint now also
  covers record fields such as `content_state` and `_unknown_settings`, and the
  "quote your IDs" hint no longer appears for an ID that is missing.
  zod 4 also rejects two values zod 3 accepted, so a config holding either now
  fails to load: a non-finite number (YAML `.inf` in `exam_duration`), and a
  whole-number setting above 2^53 - 1 (`cleanup_time`).
  simple-git 4 strips inherited `GIT_*` variables from the git commands it
  runs. vocgit keeps passing through the identity (`GIT_AUTHOR_*`,
  `GIT_COMMITTER_*`) and repository/index location (`GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_INDEX_FILE`, ...) variables, so auto-commit behaves as before. Variables
  that run a program (`GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_CONFIG_*`, ...)
  stay blocked. The lockfile also picked up dev-only tooling updates.
- **Download safety limits keep what arrived.** When a pull hits the file-count
  or total-size cap, the download now stops and keeps the files already
  fetched. The import is saved, marked `INCOMPLETE` and exits 6 (partial), with the
  directory where the cap tripped and every directory not reached named as not
  downloaded. Before, the whole import was discarded. A single file over the
  per-file cap is skipped and reported, and the rest of the walk continues.
  Content drift (`--content`) still stops at any limit.
- **Vocareum's `publicdata` link no longer makes a pull incomplete.** The
  course-wide tree (`lib/` on Elite) holds a root-owned link, `publicdata`, to
  the course data mount. The API lists it but cannot fetch it, and a
  clear-and-replace upload of `lib/` leaves it in place (tested on an Elite
  course). Pull now skips that one entry instead of marking `lib/`
  incomplete and blocking every push of it. Any other unreadable entry still
  counts.
- **An upload target the course does not have is explained.** Vocareum rejects
  `lib` as a target in a Container course, which happens when a Vocareum
  Standard part sits in one. Push now says to remove `lib` (and `asnlib`) from
  that part's `directories` in `vocareum.yaml`, instead of passing the raw API
  error through.

- **API base URLs must be a plain `https://host[/api/vN]`.** vocgit now refuses
  a base URL or OAuth token URL that contains a query (`?`), fragment (`#`),
  credentials (`user@`), a backslash, whitespace or a control character, even
  with `VOCAREUM_ALLOW_CUSTOM_BASE_URL=1`. Before, the URL parser stripped these
  and the check passed on the clean host, but axios sent the raw string. So
  `…/api/v2?x=` turned every request path into query data, `#` moved it into a
  fragment that was never sent, and `user@` carried a credential. This applies
  to NA configs too; a config without these characters is unaffected.
- **`InsecureBaseUrlError` no longer echoes the raw URL.** It shows
  `scheme://host/path` only, so a token pasted into the URL cannot reach the
  terminal or CI logs.

### Fixed
- **Pull apply with a remote file that became a directory.** Deletions now run
  before writes, so the change applies. Known limitation: a remote directory
  replaced by a file makes drift skip that assignment with a reported error, as
  it does without zip.
- **A `--sync-deletes` pass that could not run is a failure.** Every CLI push
  with `--sync-deletes` lists the remote directory to find what to delete. When
  that listing failed (an overloaded server, a 5xx), push warned and still
  recorded the directory as synced, so the next push saw no change and never
  retried the deletions. It is now recorded as failed (exit 6) and retried by
  the next push. A deletion attempt that errors is recorded the same way.
- **A pull that could not read an assignment's settings no longer reports "No
  sync issues found."** It names the assignment and exits 6. A later push could
  otherwise overwrite a remote change the pull never saw.
- **`fix` repairs nested folders in one run.** It created a missing assignment
  folder and stopped, although the part folders and declared directories inside
  it were missing too; it now checks again after each round. `fix --help` no
  longer promises to add or remove `vocareum.yaml` entries, which it never did.
- **`push` no longer reports failures twice.** It logged the error and threw a
  plain `Error`, which the entrypoint logged again as `Unhandled error: …` —
  contrary to AGENTS.md constraint 14.
- **A bad or missing API token now exits 3 (auth) rather than 1.** Vocareum
  answers an invalid token with HTTP 400 and an in-band `"Invalid Token"` body
  rather than a 401, so it was classified as an internal error and the
  "generate a new token" hint never reached the user.
- **A nonexistent course id, an unresolvable workspace root, and invalid
  `--assignment`/`--part` selectors now exit 2** instead of 1.
- **`push` no longer claims updates it did not make.** An assignment whose only
  planned change failed still appeared in `updated` with an empty `parts` list.
- **An overloaded Vocareum no longer reads as an empty directory.** Under heavy
  traffic, Vocareum answers HTTP 200 with a text message ("VOCAREUM-ERROR: Sorry,
  your access to Vocareum is temporarily unavailable due to heavy traffic…")
  instead of a listing. vocgit read that answer as a listing with no names. On
  the first page, the directory looked empty; on a later page, the listing ended
  early. Pull then missed those files without marking the import incomplete, and
  `pull --content` read them as deleted on Vocareum, so `--batch` could delete
  the local copies. (Seen on 5 of 24 listing requests in one probe.)

  Such an answer is now an error, handled like an HTTP 503:
  - GET, PUT and DELETE requests are retried (3 attempts in all). A
    `Retry-After` header sent with it is honoured up to 60 seconds. A POST is
    not retried, because it may have taken effect.
  - Polls of a running job (upload, settings update, assignment copy) treat it
    as "no news yet": one request per check, then the poll's usual wait, as
    before. They do not retry it or wait for `Retry-After`, and they end at
    their usual limit instead of giving up on the job at the first busy answer.
  - A listing whose answer has no file list, or only entries without names,
    fails instead of reading as empty.

  If the retries run out on a listing, nothing is read as deleted. For a
  directory inside a part's folder, pull records a failure and marks that
  folder incomplete. For a part's top-level folder, the import of that
  assignment fails and is recorded as failed. `pull --content` skips the
  assignment rather than planning deletions.
- **Directories with more than 100 entries are read in full.** Vocareum's file
  listing returns at most 100 names per request and pages the rest, without
  saying so; vocgit read only the first page. In any directory with more than
  100 entries, every name after the 100th in listing order was missed, with no
  warning. Pull did not download those files and did not mark the import
  incomplete. `pull --content` read them as deleted on Vocareum, so `--batch`
  could delete the local copies. A push of that directory after it changed
  locally (a clear-and-replace upload) could then delete them from Vocareum.
  Listings now read page after page until an empty one. A listing fails,
  instead of coming back short, when a page repeats names already read (a
  server ignoring the page request), when the directory vanishes partway
  through, or past 10,000 pages. Each directory costs one extra request to
  confirm the end. Files changed on Vocareum while a listing is being read can
  still be missed. **If a repo was pulled from a course with large
  directories, run `vocgit pull --batch --content` before pushing those
  directories**, to bring back files that were missed. Files that a push
  already removed from Vocareum cannot be brought back this way.
- **Signed download URLs no longer reach logs or error messages.** With
  `VOCAREUM_LOG_LEVEL=DEBUG`, API responses were logged with signed
  file-download URLs intact, credentials included. API error messages, which
  appear in warnings at every log level, could carry them too. Log output and
  error text now drop the query string and any user-info of absolute URLs
  (including JSON-escaped ones), and redact signed-URL credential parameters
  (`X-Amz-*`, `Signature`, `Policy`, `Key-Pair-Id`) wherever they appear.
- **A pulled container image ID is no longer pushed back.** `container_image_id` and
  `container_image_label` used to ride in `_unknown_settings` and were sent on every part
  update. That included a push to a different tenant, where an NA image ID means nothing.
  They are now observed only: kept for reference and never sent. Probing showed the
  part-update API ignores both fields anyway, and that image IDs are tenant-scoped. No push
  actually changed an image this way. (Field report #3.)
- **Fields an older pull left in `_unknown_settings` keep working.** When a newer vocgit
  recognizes such a field, loading the config moves it where it now belongs. Known fields
  become top-level settings, observed fields move to `_observed_settings`, and server-only
  fields are dropped. This replaces a warning-and-drop on every push. A top-level value
  always wins over a leftover copy, and raw API spellings such as `"1"` or `median` are
  normalized first. A leftover value that is still invalid stays where it is, so it cannot
  stop the config from loading. It is not pushed, and vocgit warns about it. The file is
  written in the new layout the next time any command saves `vocareum.yaml`.
- **A peer-review value that vocgit does not recognize is kept.** If Vocareum returns a
  value this release cannot read (a newer enum value, an out-of-range number, a date in
  another format), pull keeps it in `_unknown_settings` in place of the local typed value,
  and reports it. It is not pushed.
- **`pull` now downloads subdirectories.** For a path that is a directory, the
  v2 files API returns HTTP 400 `specified file does not exist <path>`, not the
  `status:"error"` body vocgit checked for. Each subdirectory was therefore
  logged as "Failed to download" and skipped, so its files were never fetched.
  On one course a pull lost 1,386 of 1,393 files and still printed
  `✓ Imported`. That 400 (and the `specified source does not exist` form) now
  means "not a file", so vocgit lists the path as a directory and walks into it.
- **A pull that loses files says so, and exits 6 (partial).** An import that cannot
  download some files still writes what arrived and saves the assignment, but
  is reported `INCOMPLETE` instead of imported. The summary gains a
  `Not downloaded` count. An entry that is neither a downloadable file nor a
  listable directory (for example a dangling link), a subdirectory that cannot
  be listed, and anything past the 10-level nesting limit are each recorded as
  a failure. Before, they were dropped silently or ended the download early.
  An import that fails outright is counted under `Import failed` instead of
  `Skipped`, and also exits 6.
- **`push` no longer deletes files that a pull missed.** An incomplete pull used
  to be recorded in `publish_history` as a successful sync, with the hash of
  the partial directory. The next push then uploaded that directory, and since
  an upload first clears the directory on Vocareum (`reset: 1`), it deleted
  every remote file the pull had not downloaded. This happened on 1.5.0 and
  earlier: pulling a course whose subdirectories failed, then pushing any edit,
  removed those subdirectories from the course. An incomplete pull is now
  recorded as `failed`, with the missed paths listed. Its directories carry an
  `incomplete-pull` marker instead of a hash. `push`, including `--force-all`,
  refuses those directories and reports them as failed. A complete
  `vocgit pull --batch --content --assignment <name>` replaces the marker with
  a real hash, even when no file differs. The marker stays if a remote file in
  that directory still cannot be written locally, such as when the local path
  is a symlink. `vocgit status` lists marked directories, and `status --json`
  reports them as `error`, not `synced`.
- **Failed imports are recorded in `publish_history`.** An import that failed
  outright left no record. A run in which one import failed and another
  succeeded was recorded as `success`. Both are now recorded as `failed`, naming
  the assignment and the reason, and the earlier `content_state` is kept.
- **Directory walking no longer drops real folders or keeps placeholders as
  files.** A path whose last three names repeat (such as `data/a/a/a`) used to
  be skipped as a symlink cycle by name alone. It is now skipped only when it
  lists exactly the same entries as its parent. A zero-byte directory
  placeholder deeper than the nesting limit used to be saved as an empty file.
  It is now recorded as a failure. Placeholder folders are also listed once,
  not twice.
- **`pull --content` no longer reports a skipped drift check as clean.** The
  first subdirectory used to abort the drift check for the whole assignment,
  and the run still printed `✓ No sync issues found.` Subdirectories are now
  walked. Any assignment whose check still cannot finish is named, and the pull
  exits 6 (partial): the check is unknown, not clean.
- **`fix --non-interactive` help no longer says "report issues only".** That
  mode has always created folders; the help now says it applies every fix and
  has no dry-run.
- **`validate --strict` help** said it exits 1; it exits 5 (findings).

### Unchanged
- Existing configs, including ones with no `api_base_url`, still resolve to
  `https://api.vocareum.com`. Non-HTTPS URLs and unknown or look-alike hosts are
  still refused unless `VOCAREUM_ALLOW_CUSTOM_BASE_URL=1`.

## [1.4.0] — 2026-09-04

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
- **`push --part` now requires exactly one `--assignment`.** It was documented as
  requiring one and did not enforce it, so `push --part part1` filtered *every*
  assignment down to parts at that path and wrote to all of them. Harmless-ish while
  push only sent content and settings; not harmless once it writes rubrics, since a
  part path shared across ten assignments would have changed ten courses' worth of
  points. `pull` already enforced this exact rule and threw the same error; push now
  matches it.

- **A declared directory that the API reports absent is now a warning rather than
  silence.** Returning an empty listing stays correct — throwing would make
  `pull` read the absence as remote deletions — but the silence is what hid both
  this bug and the 1.3.8 depth truncation, each of which lost content with exit
  code 0. The warning names the exact path requested, so a wrong prefix is
  visible as a wrong prefix. It fires only for directories a part declares, not
  for the walk's speculative probes.
- **Point totals are no longer round-tripped as unknown settings.** A part's `max_points`
  and an assignment's `total_points` are derived by Vocareum from rubric criteria — the sum
  of each criterion's `maxscore` where `exclude` is not true — and are not storable. Probing
  confirmed both halves: a part `PUT` setting `max_points` returns a successful
  *"Part updated"* transaction and changes nothing, and an assignment `PUT` setting
  `total_points` is rejected with *"No valid parameters to update the assignment"*. That is
  the whole of Vocareum VOC-4003 — the field was never there to write.

  vocgit previously captured both under `_unknown_settings` and nagged you to file an
  enhancement request for them. `max_points` additionally rode along in any part-settings
  `PUT` that was already being sent for other reasons, where the server ignored it;
  `total_points` is assignment-scoped and would have ridden an assignment update the same
  way. They now land in `_observed_settings` instead: still visible in
  `vocareum.yaml` so you can read a part's point total, never sent, and no longer reported as
  unsupported. `_unknown_settings.max_points` is now refused with a warning rather than
  quietly added to the payload.

  Existing configs migrate themselves — the next `pull` reports the change as settings drift
  and rewrites both fields into `_observed_settings`.

  To change a course's points, edit `parts[].rubrics` in `vocareum.yaml` and push — `push`
  now creates and updates rubric criteria to match (see below); this is the *only* way vocgit
  can change a course's points, since both derived fields are otherwise read-only.

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

  The rubrics **read** token permission is optional at token creation. A token
  without it logs a warning and pull continues normally — settings and content
  drift are unaffected. There are two independent fetchers (drift detection and
  orphan import), so a single run can log this at most twice.
  `publish_options.sync_settings: false` skips rubric drift detection too,
  since rubrics are read during the settings pass — orphan import still records
  rubrics whenever `sync_rubrics` is on, the same way it records settings. See
  the next entry for `sync_rubrics` and the push-side write.

- **`push` now creates and updates rubric criteria to match `vocareum.yaml`.**
  This is the feature the previous entry's rubric *reads* were building toward,
  and it's the only way vocgit can change a course's points — `max_points` and
  `total_points` are derived from rubric criteria and otherwise read-only (see
  the "Point totals" entry above). For each rubric-bearing part, `push` diffs
  local `parts[].rubrics` against the remote list by criterion **name**: a local
  name with no remote match is created; a matched pair whose `maxscore`/`auto`/
  `exclude` differs is updated.

  **`push` never deletes a rubric criterion.** A remote row with no local
  counterpart is reported as an orphan — named, with the resulting point total
  — and left in place. This matters because Vocareum has no rename operation for
  rubric rows: renaming a criterion in `vocareum.yaml` reads as "delete one, add
  another," so it creates a duplicate and inflates the part's points rather than
  renaming in place. The push confirmation shows the projected point change
  (e.g. "points would go from 25 to 30") specifically so this is visible before
  it's applied, not after. A part whose rubric names collide (locally or
  remotely) is refused entirely, since matching against duplicates is
  ambiguous. In `--non-interactive` mode, a part with both creates and orphans
  has its creates held back and is recorded as a failure, rather than risk
  silently duplicating a rename unattended.

  Rubric sync does not run for a newly created assignment in the same push that
  creates it — the assignment is copied from a template that already carries
  the template's rubrics. A second `push` reconciles it like any other part.

  Every rubric write lands in `publish_history[].changes.rubrics`: which
  criteria were created and updated by name, the point delta, and — for a held
  part — why nothing was written.

  On by default; disabled by `publish_options.sync_rubrics: false` or
  `sync_settings: false` (same precedence as the pull-side read). Requires the
  rubrics token's POST and PUT permissions in addition to the existing GET —
  without them, `push` fails the run with an explanatory error rather than
  silently leaving points unmigrated. Unlike `pull`, where a missing GET scope
  only logs a warning, `push` needs that same read to diff local criteria
  against remote before it can write: a failed read (missing scope, a 403, or
  a malformed response) now fails the run and records a `held: 'read-failed'`
  entry, rather than reporting success having migrated no points.

  `pull`'s own inspection never reads this plan, so `push`'s reconcile pass is
  the only one that fetches rubrics during reconciliation — `pull` continues to
  read them through its own two fetchers described above, unaffected by this.

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
