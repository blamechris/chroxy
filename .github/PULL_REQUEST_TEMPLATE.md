## Summary

<!-- One or two sentences: what changes and why. Describe behaviour, not the process. -->

## What changed

<!-- Concrete changes, by package or file where useful. -->

-

## Test plan

<!-- Commands run and their results: exit codes and pass/fail counts. -->

- [ ] Full suite for each touched package, exit 0 (`npm test -w <package>`)
- [ ] The package's own lint command where it has one (`npm run lint -w @chroxy/server`), plus `packages/server/scripts/lint-*.sh` for server changes
- [ ] Every new or changed guard proven to fail: break the thing it protects, confirm red, restore
- [ ] Red-then-green evidence for each new regression test, recorded before the fix

## Smoke

<!-- Smoke table row (step, verdict, head) for user-visible changes, or the line below. -->

smoke: not applicable — <reason>

## Related issues

<!-- One closing keyword per issue, each on its own line, e.g. "Closes" then the issue number.
A closing keyword followed by an issue number anywhere in the body closes that issue, even
inside a negated sentence, so never write one next to a number you mean to keep open.
Use "Refs" plus the number for an issue that must stay open. -->
