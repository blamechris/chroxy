## Summary

<!-- One or two sentences: what changes and why. Describe behaviour, not the process. -->

## What changed

<!-- Concrete changes, by package or file where useful. -->

-

## Test plan

<!-- Commands run and their results: exit codes and pass/fail counts. -->

- [ ] Full suite for each touched package, exit 0 (`npm test -w <package>`)
- [ ] Lint for each touched package, plus `packages/server/scripts/lint-*.sh` for server changes
- [ ] Every new or changed guard proven to fail: break the thing it protects, confirm red, restore
- [ ] Red-then-green evidence for each new regression test, recorded before the fix

## Smoke

<!-- Smoke table row (step, verdict, head) for user-visible changes, or the line below. -->

smoke: not applicable — <reason>

## Related issues

<!-- One closing keyword per issue, each on its own line:
Closes #A
Closes #B
Negated phrasings such as "does not close #N" still auto-close. Use "Refs #N" for an issue that must stay open. -->

Closes #
