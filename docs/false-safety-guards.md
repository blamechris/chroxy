# False-Safety Guards

> A guard that cannot fail is worse than no guard. No guard leaves you cautious;
> a green one that never checks anything makes you confident and wrong.

Seven of these were found and fixed in a single day (2026-08-15). Every one had
passed unit tests, lint, typecheck, and CI continuously — in some cases for
months — because **the defect is invisible to any check that only asks "did it
report success?"**

This document exists because the seventh was found inside the fix for the sixth.
The pattern recurs faster than it gets recognised, so it is written down.

## The shape

A guard exhibits false safety when **success and not-checking are the same
observable outcome**. Four ways that happens:

| mode | what it looks like |
|---|---|
| **Never ran** | The guard's precondition is false, so its body is skipped. Exit 0. |
| **Checked the wrong thing** | It verifies something already known good, not the artifact that can break. |
| **Checked a subset** | It iterates a hardcoded list while the real set grows past it. |
| **Silently skipped an input** | An unrecognised shape is filtered out instead of raising. |

In all four, the check *emits* success. Nothing distinguishes "verified" from
"declined to verify".

## The seven

### 1. The gate that never ran — `#7184`

`auto-tag-on-release.yml` fires only on a merge subject matching
`^chore\(release\): cut vX.Y.Z`. Merge a release PR under any other subject and
the job's `if:` is false, the job never runs, **and the PR is green**. A
workflow that did not run is indistinguishable from one that passed.

Cost: two missed releases. `#4627` (v0.9.13–v0.9.19), then `0.10.0` merged as
`chore(release): 0.10.0 — codex controllable like Claude by default` — no
`cut v`, no tag, and a 463-commit untagged gap that went unnoticed for two
months. `#7156` is the general form: a non-required workflow can be dead for its
entire life and produce the same signal as a healthy repo.

### 2. The check that tested the source tree, never the artifact — `#7189`

Every check in the repo validated the working tree. None packed a tarball and
ran it. Three packaging defects reached the edge of an irreversible npm publish
with all of CI green, because each one only broke the *packed artifact*:
sibling ranges resolving a stale published version, `@chroxy/protocol` shipping
zero `dist/*.js` (no `files` field → npm fell back to `.gitignore`, which
ignores `dist/`), and `@chroxy/store-core` shipping raw `*.test.ts` with a root
export Node refuses to load. All three installed cleanly and failed on first
import.

### 3. The list that stopped growing — `#7192`

The fix for (2) verified a **hardcoded** list of four entry points. The
manifest declared six. `@chroxy/protocol/schemas` and `/handler-coverage` were
outside the gate, and the gate reported full coverage.

### 4. The rewrite that skipped what it could not find — `#7195`

`bump-version.sh` rewrote two version references in `CLAUDE.md`, and `continue`d
past any pattern that did not match. Reword either line and the rewrite becomes
a no-op that still exits 0 — a fail-open on precisely the drift it was added to
prevent.

### 5. The self-check that imported known-good paths — `#7197`

`build-publish-dir.mjs` proved its entry points load by importing a **hardcoded
literal list**, not the `exports` map it had just written. Point `exports` at a
typo and the check imports the correct file anyway, prints `✓`, and the break
surfaces only for the npm consumer resolving through `exports`.

### 6. The derivation that read one key — `#7210`

The fix for (5) read only `.import`. A `require`-only or nested-condition export
yielded no target, was dropped by a `.filter`, and never appeared in the output.
**Found inside the fix for the previous entry**, which had claimed "a
newly-added export is covered automatically".

### 7. The guard defeated by a symlink — `#7198`, `#7213`

Node's ESM loader resolves symlinks in `import.meta.url`; `process.argv[1]` is
whatever the caller typed. Neither `resolve()` nor `pathToFileURL()` follows
symlinks:

```
import.meta.url        : file:///private/tmp/x/probe.mjs
pathToFileURL(argv[1]) : file:///tmp/x/probe.mjs
guard would be         : false
```

Run through macOS's `/tmp` → `/private/tmp` symlink and the guard reads false,
`main()` never runs, and the process exits 0 having done nothing. Four files
across three spellings — including the `pathToFileURL` form, which *looks* more
careful than the others and is equally broken.

## Near-miss: the key that was silently ignored

Not one of the seven, but the same family. A Maestro `repeat` was written with
`maxRuns: 3`. `YamlRepeatCommand` has no such field — `javap` shows
`times`/`while`/`commands`/`label`/`optional`. The expectation was a parse
error. **Unknown keys are silently ignored**, so the flow ran, passed three
verification runs, and was bounded only by `while` — an unbounded retry that
looked exactly like a bounded one. A parse error would have been the safer
outcome.

The lesson generalises: *"it would have failed loudly"* is an assumption, not a
finding. Check.

## Detection: mutation testing is the only reliable method

**Every one of the seven passed all existing tests.** Test suites, lint,
typecheck, and CI cannot find this class, because the guard's output is correct
— it is the guard's *coverage* that is wrong.

The check that works is one question:

> **Break the thing this guard protects. Does it go red?**

If you cannot make it fail, it is not a guard.

```bash
# 1. Baseline — the guard passes on good input
node scripts/verify-publish-artifacts.mjs; echo "exit=$?"   # want 0

# 2. Break the protected property (cp a backup first, never `git checkout --`,
#    which eats unrelated uncommitted work)
cp packages/protocol/package.json /tmp/backup.json
# …remove the `files` field…

# 3. The guard MUST fail, and the message must name the real problem
node scripts/verify-publish-artifacts.mjs; echo "exit=$?"   # want non-zero

# 4. Restore from the backup and confirm baseline again
cp /tmp/backup.json packages/protocol/package.json
```

Check the **exit code**, not just the output. A script that prints `FAIL` and
exits 0 is still a false-safety guard, and `cmd | grep -c FAIL` reports `grep`'s
status, not the script's — that mistake was made twice while writing these
fixes.

## Writing guards that cannot lie

**Derive the set; never hardcode it.** Read entry points from the manifest,
targets from the config, flows from the runner's own inventory. A hardcoded
list is correct exactly once (`#7192`, `#7197`).

**Not-checkable must be an error, not a skip.** "I cannot verify this shape" and
"there is nothing to verify" are different outcomes. Conflating them is how
`#7195`, `#7210`, and `#7198` all read as success. Throw, and name what could
not be checked.

**Test the artifact, not the source.** Pack the tarball, install it into a
throwaway prefix, run it. The source tree resolves siblings through workspace
symlinks and never sees what a consumer sees (`#7189`).

**Prefer failing closed.** An unreachable base ref, an unresolvable path, a
missing argument — exit non-zero. `scripts/check-release-pr-subject.mjs` exits
`2` rather than passing when it cannot diff.

**Make "did not run" visibly different from "passed."** This is the hardest one
and the least solved here. `#7156` and `#7199`/`#7216` are open precisely
because a skipped job and a green job still look alike.

**Verify the mechanism you are relying on.** Before trusting an unknown flag,
an unfamiliar config key, or "this would fail loudly", confirm it — `--strict`
was checked against `--help` on the pinned version for exactly this reason.

## When reviewing a guard

1. Ask what it would take to make this pass while the protected property is
   broken. If there is an answer, that is the bug.
2. Look for hardcoded lists next to a set that can grow.
3. Look for `continue`, `.filter(Boolean)`, and `if (!x) return` on a path that
   means "could not check".
4. Ask whether it tests the source tree or the artifact that ships.
5. Ask what happens when its precondition is false — skip, or fail?

## Related

- `docs/release/npm-publish.md` — the publish runbook, and why the artifact
  gate exists
- `scripts/verify-publish-artifacts.mjs` — packs, installs, and runs; derives
  its entry points from the published manifests
- `scripts/check-release-pr-subject.mjs` — content-triggered, fails closed
- `packages/server/src/utils/is-entry-point.js` — the one implementation of the
  entry-point guard (lands with `#7217`; until then the four call sites still
  carry their own copies)
