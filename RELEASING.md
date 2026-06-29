# Releasing `vocareum-publisher`

Maintainer runbook. Releases are **maintainer-only** (npm publish requires 2FA).
Contributors must **not** bump the version in PRs.

## Background: tags vs. Releases (read once)

- A **git tag** (`v1.3.2`) is just a commit pointer. Pushing it does **not** create
  a GitHub *Release*.
- A **GitHub Release** is a separate object (shown in the repo's "Releases"
  sidebar). It must be created explicitly (`gh release create`, the API, or the UI).
- **Both** must happen each release, or the "Releases" page goes stale. (Historically
  `v1.3.0`/`v1.3.1` were published to npm but never tagged, and no Release was created
  — so the sidebar lagged at `v1.2.0`.)

## The `v1` moving tag

The composite Action is consumed as `uses: ddlin/vocareum-publisher@v1`. `v1` is a
**moving major tag** repointed to the latest `1.x` release **once you're confident**
in it. Keeping `v1` behind the newest version lets a release **soak as a canary**
(only `@v1.3.2`-pinned consumers get it) before all `@v1` users do.

## Versioning (semver)

- **patch** (`1.3.x`) — internal refactor / bug fix, no user-facing change.
- **minor** (`1.x.0`) — new backward-compatible feature/flag/config.
- **major** — breaking change (and move `v1` → `v2`, update the Action docs).

## Release steps

Order matters (the Action installs `vocareum-publisher@<package.json version>`, so the
tag must never precede the npm version). Run from a clean `master`.

1. **Pre-flight** — everything green:
   ```bash
   npm ci && npm run typecheck && npm run lint && npm run build && npx vitest run
   npm audit --omit=dev --audit-level=high   # CI gates on this
   ```
2. **CHANGELOG** — move the unreleased notes under a dated `## [x.y.z] — YYYY-MM-DD` heading.
3. **Bump** (lockfile + package.json, no tag yet):
   ```bash
   npm version <patch|minor|major> --no-git-tag-version
   ```
4. **Commit** the release:
   ```bash
   git commit -am "chore: release vX.Y.Z — <summary>"
   ```
5. **Publish to npm** (2FA OTP required — `ddlin`):
   ```bash
   npm publish            # or: npm publish --otp=<code>   (prepublishOnly runs the build)
   npm view vocareum-publisher version   # confirm X.Y.Z is live
   ```
6. **Push the branch, then the tag** (tag only *after* npm has the version):
   ```bash
   git push origin master
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
7. **Create the GitHub Release** (do **not** skip — this is what the sidebar shows):
   ```bash
   gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" \
     --notes "CLI \`vocareum-publisher@X.Y.Z\` ([npm](https://www.npmjs.com/package/vocareum-publisher)) — see CHANGELOG.md."
   ```
   The VS Code extension is distributed as a Release asset; attach the current build
   if you want it on this release:
   ```bash
   ( cd vscode-extension && npm ci --no-fund --no-audit && npm run package )
   gh release upload vX.Y.Z vscode-extension/vocgit-*.vsix
   ```
   > **`.github/workflows/release.yml`** is meant to do step 7 automatically on a
   > `v*.*.*` tag push (build the `.vsix` + create the Release). It is **currently
   > unreliable / has not produced a Release** — until it's fixed, create the Release
   > manually as above. (`v1.2.0`, the only existing Release, was hand-created.)
8. **Move `v1`** to this release **only when you're confident** (ends the canary):
   ```bash
   git tag -f v1 vX.Y.Z && git push -f origin v1
   ```

## After release

- The README no longer pins versions (npm/CHANGELOG/Releases are the source of truth),
  so there's nothing version-specific to bump there. If you reintroduce a hard-coded
  version anywhere user-facing, update it here in the checklist.
- Verify the "Releases" sidebar now shows the new version as **Latest**.

## Quick checklist

```
[ ] master clean + green (test/typecheck/lint/build/audit)
[ ] CHANGELOG dated
[ ] npm version --no-git-tag-version  → commit "chore: release vX.Y.Z"
[ ] npm publish (OTP) → npm view confirms vX.Y.Z
[ ] git push origin master
[ ] git tag vX.Y.Z && git push origin vX.Y.Z
[ ] gh release create vX.Y.Z (+ optional .vsix upload)
[ ] (when confident) move v1 → vX.Y.Z
[ ] Releases sidebar shows vX.Y.Z as Latest
```
