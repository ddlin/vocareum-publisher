# Security Policy

## Supported versions

Security fixes are released for the latest published `1.x` line. Please upgrade to
the most recent version before reporting.

| Version | Supported          |
| ------- | ------------------ |
| 1.3.x   | :white_check_mark: |
| < 1.3   | :x: (please upgrade) |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Report privately using either:

1. **GitHub private vulnerability reporting** — go to the repository's
   **Security** tab → **Report a vulnerability** (preferred), or
2. **Email** — **david@vocareum.com** with subject `SECURITY: vocareum-publisher`.

Please include:

- The version of `vocareum-publisher` (`vocgit --version`) and Node.js version.
- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- Any relevant logs **with secrets removed** (see below).

You can expect an acknowledgement within a few business days and a coordinated
disclosure once a fix is available. Best-effort timelines apply — this is an
open-source project maintained alongside other work.

## Handling secrets

`vocareum-publisher` authenticates to Vocareum with credentials supplied via the
**environment or a secret manager** (`VOCAREUM_API_KEY`, or the v3 OAuth
`VOCAREUM_OAUTH_CLIENT_ID` / `VOCAREUM_OAUTH_CLIENT_SECRET`):

- Credentials are **never** written to `vocareum.yaml` and must never be committed
  to source control.
- The API client **redacts credentials** from debug logs, and file operations are
  guarded against path traversal outside the workspace.

If you discover a case where a credential is logged, persisted, or otherwise
leaked — or where the path-confinement guards can be bypassed — please report it
privately as described above.
