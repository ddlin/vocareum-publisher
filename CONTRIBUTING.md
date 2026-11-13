# Contributing to vocareum-publisher

Thanks for your interest in improving **vocareum-publisher** (the `vocgit` CLI and
its companion GitHub Action). It synchronizes assignment content **from GitHub to
Vocareum** — GitHub is always the source of truth.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — open a [Bug report](https://github.com/ddlin/vocareum-publisher/issues/new/choose).
- **Request a feature** — open a [Feature request](https://github.com/ddlin/vocareum-publisher/issues/new/choose).
- **Report a security issue** — do **not** open a public issue; follow the
  [Security Policy](SECURITY.md).
- **Send a pull request** — see the workflow below.

## Development setup

Requires **Node.js ≥ 18**.

```bash
git clone https://github.com/ddlin/vocareum-publisher.git
cd vocareum-publisher
npm install

npm run build       # compile TypeScript to dist/
npm test            # run the vitest suite
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint (must be 0 errors)
npm run dev -- ...  # run the CLI from source via tsx
```

Please run `npm test`, `npm run typecheck`, and `npm run lint` before opening a PR —
CI runs all three and will block on failures.

## Project conventions

These are enforced by tests, lint, and review. The most important:

- **All Vocareum IDs are strings**, never numbers (`assignment_id: "12345"`). Numeric
  comparison against API responses silently fails.
- **No `console.log` in `src/`** — user-facing output goes through the `logger`
  utility (or, in the service layer, through the injected event sink). A guard test
  enforces that services don't render directly.
- **No `process.exit` outside `src/index.ts`** — commands throw a typed
  `CommandFailureError`; the entrypoint owns the exit code. (A guard test enforces this.)
  Pick the failure category that tells a caller what to do (`usage`, `auth`,
  `transient`, `findings`, `partial`, `internal`) — it chooses the exit code.
- **Only `src/core/report.ts` writes to stdout.** stdout is the `--json` channel and
  carries exactly one document; human output goes through `logger`. (Guard test.)
- **Diagnostic codes are a public contract.** A new `code:` must be registered in
  `src/core/diagnostics.ts` with a severity, and the emit site must use that
  severity. Never remove a code or change its severity without a major version bump.
- **TypeScript strict**; avoid `any`. Prefer small, focused modules.
- **Tests are required.** The suite includes **golden / characterization tests**
  (`test/golden/`) that lock current CLI behavior — output, exit codes, and the
  **API-call sequence**. If your change alters one of these snapshots, that is a
  signal: confirm the behavior change is intended and explain it in the PR. Add unit
  tests for new logic.
- **Never commit secrets.** API tokens and OAuth credentials come from the
  environment / a secret manager, never from `vocareum.yaml` or source.

## Pull request workflow

1. Fork and branch from `master` (e.g. `fix/...`, `feat/...`).
2. Make focused commits with clear messages.
3. Add/adjust tests; keep the golden suite green (or justify any snapshot change).
4. Ensure `npm test`, `npm run typecheck`, and `npm run lint` all pass.
5. Update `README.md` / `CHANGELOG.md` if your change is user-facing.
6. Open a PR using the template; link any related issue.

**Do not bump the package version** in a PR. Releases are handled by the maintainer
(publishing requires npm 2FA) — see [RELEASING.md](RELEASING.md) for the process.

## Developer note: the shared zip object

Vocareum writes every directory zip of a part to one object per user and part
(`u<user>_p<part>.zip`). Pull works around the sharing with a stale-object check
and a settle check, and the README lists what is left. The proper fix is on
Vocareum's side: the zip request should return a unique object name per
transaction. We should ask Vocareum for per-transaction object names. Once they
exist, the shared-object checks in `src/api/zip-directory.ts` can go.

## Questions

For anything that isn't a bug or feature request, email **david@vocareum.com**.
