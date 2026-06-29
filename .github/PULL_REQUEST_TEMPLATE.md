<!--
Thanks for contributing! Please read CONTRIBUTING.md first.
Keep PRs focused. Do NOT bump the package version — releases are maintainer-handled.
-->

## Summary

What does this change and why?

Closes #<!-- issue number, if any -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change
- [ ] Docs / tooling / tests only

## How was this tested?

Describe what you ran and the result. Paste relevant output.

```
npm test
npm run typecheck
npm run lint
```

## Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes (0 errors)
- [ ] Added/updated tests for the change
- [ ] Golden snapshots (`test/golden/`) are unchanged, or the change is intended and explained above
- [ ] All Vocareum IDs are treated as strings; no `console.log` in `src/`
- [ ] No secrets (API tokens / OAuth credentials) committed
- [ ] `README.md` / `CHANGELOG.md` updated if the change is user-facing
- [ ] Did **not** bump the package version (maintainer handles releases)
