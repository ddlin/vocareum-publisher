# Changelog

All notable changes to `vocareum-publisher` (the `vocgit` CLI) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **v3 OAuth client-credentials auth** (`--auth oauth` / `VOCAREUM_AUTH_MODE=oauth`) alongside the existing v2 token auth (default unchanged). Introduces an `AuthProvider` seam, lazy OAuth token exchange with caching and a single 401 refresh-retry, path-aware base-URL and token-URL validation, and recursive log redaction of secrets. The auth mode is bound to its host (token→v2, oauth→v3), so a crossed base-URL override (e.g. `VOCAREUM_API_V3_BASE_URL` pointed at the v2 host) is rejected rather than sending a `Bearer` token to the wrong host. A 401 error message is tailored to the active mode (personal token vs OAuth client credentials), and `vocgit status` reports the configured auth mode and its credentials. New env vars: `VOCAREUM_AUTH_MODE`, `VOCAREUM_OAUTH_CLIENT_ID`, `VOCAREUM_OAUTH_CLIENT_SECRET`, `VOCAREUM_API_V3_BASE_URL`, `VOCAREUM_OAUTH_TOKEN_URL`.

### Changed
- **GitHub Action is now a composite action** that installs the published `vocgit` CLI (pinned to the action's version) and runs `vocgit push`, replacing the prior unbuilt `node20` JS action (`dist/action/` was never produced and `build:action` failed). It now supports v3 OAuth via new `auth`/`client-id`/`client-secret` inputs; `api-key` is optional. Outputs are reduced to `success` (the job fails on error).

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
