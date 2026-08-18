# False-Safety Guards

> A guard that cannot fail is worse than no guard. No guard leaves you cautious;
> a green one that never checks anything makes you confident and wrong.

Seven of these were found in a single day (2026-08-15), and the catalogue has
kept growing since. Every one had passed unit tests, lint, typecheck, and CI
continuously — in some cases for months — because **the defect is invisible to
any check that only asks "did it report success?"**

Each entry below cites its issue, and the fix is the PR that closes it; consult
those rather than a tally here, which would be stale the moment one merges.

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
| **Never reached** | The guard is correct, but only some callers route through it. It passes every input it sees, and never sees the rest. |

In all five, the check *emits* success. Nothing distinguishes "verified" from
"declined to verify".

The fifth is the hardest to see, because the guard itself is not wrong — you can
read it line by line and find no defect. What is wrong is the wiring between it
and the callers it is supposed to cover, which is not visible from either end.

## The catalogue

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

`bump-version.sh` rewrote two version references in `CLAUDE.md`, and used
`continue` to skip past any pattern that did not match. Reword either line and
the rewrite becomes a no-op that still exits 0 — a fail-open on precisely the
drift it was added to prevent.

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

### 8. The sandbox that guarded two of four import forms — `#7262`

`packages/server/tests/_setup.mjs` patches the write-side of `node:fs` so a test
that forgets a temp path fails loudly instead of clobbering the developer's real
`~/.chroxy` (`#4633`). It patches the live CJS `module.exports`, and a comment
asserted that named importers therefore see the patch too. Measured under the
real harness, they did not:

```
CJS require        : patchedWriteFileSync
ESM default import : patchedWriteFileSync
ESM namespace      : writeFileSync      <-- UNPATCHED
ESM named import   : writeFileSync      <-- UNPATCHED
```

Node builds the `node:fs` synthetic ESM module lazily, snapshotting its named
exports off `module.exports` at the first ESM import of it. `_setup.mjs` opened
with `import { mkdtempSync } from 'node:fs'` — and ESM imports evaluate before
the module body, so that one line took the snapshot from the unpatched object
before the body could patch anything. **The guard disarmed itself, in its own
first line, for the 41 modules under `src/` that import a write-side `fs`
function by name.**

Nothing could see it. The guard still fired correctly for every caller that
reached it, so its output was right; only its reach was wrong. `node:fs/promises`
is the control that proves the mechanism — a separate synthetic module,
never ESM-imported by `_setup.mjs`, and all four of *its* binding forms were
guarded the whole time.

What the reach was hiding: `tests/http-routes.test.js` renamed the developer's
real `~/.chroxy/connection.json` aside in a `before` hook and moved it back in
`after` — so a crash, a test timeout, or a SIGKILL between the two left a
running daemon's connection info stranded under a `.test-backup` suffix. It had
also been unnecessary for some time, since `readConnectionInfo()` now resolves
through the `CHROXY_CONFIG_DIR` redirect that `_setup.mjs` already points at a
tmp dir. Arming the guard surfaced it on the first run.

Two lessons specific to this mode. **A binding is not a value**: patching an
object only reaches consumers who read through that object, and in ESM the
consumer's import form decides that — invisibly, at link time, from a different
file. And **the probe must use the same binding form as the code it vouches
for**: the first check of this sandbox during `#7254` used a default import,
reported the guard working, and was right about the only form it tested.

## The one that got me while writing this

A Maestro `repeat` was written with `maxRuns: 3`. `YamlRepeatCommand` has no
such field — `javap` shows `times`/`while`/`commands`/`label`/`optional`. The
flow was then run three times to verify the fix, each checked with:

```bash
maestro test … diff-comment.yaml 2>&1 | grep -c "FAILED"
# 0
```

Zero failures, three times. Except the flow never ran at all:

```
$ maestro test … /tmp/mr.yaml; echo "exit=$?"
Unknown Property: maxRuns at /tmp/mr.yaml:11:1
exit=1
$ maestro test … /tmp/mr.yaml 2>&1 | grep -c FAILED
0
```

Maestro **rejects** the unknown key and exits 1. But a parse error emits no
per-step `FAILED` lines, so `grep -c FAILED` reports `0` — indistinguishable
from a clean run. The verification was itself a false-safety guard: it could
report success while the thing it verified had not executed.

This is the highest-value entry in this document, for three reasons.

**The tool was not at fault.** Maestro did exactly the right thing — failed
loudly, at parse time, with the offending key and its line number. Every layer
worked except the one checking it.

**It happened to someone who had just written the rest of this page.** The rule
"check the exit code, not the output" is stated below and was still violated,
in the act of verifying a fix for this exact class. Knowing the pattern is not
protection.

**The wrong conclusion survived review.** From "the flow passed three times",
the mechanism was inferred to be *"unknown keys are silently ignored, so the
loop was unbounded"* — plausible, internally consistent, and wrong. It was
written into a PR description, a commit message that is now in `main`'s
history, and an earlier draft of this page, before a reviewer reproduced it and
found the opposite. A false-safety guard does not just hide a bug; it
manufactures a confident explanation for the wrong thing.

The generalisable rule: **`grep` on output is not a test result.** `grep`'s exit
status is its own, and absence of a failure string is not evidence of success —
a crash, a parse error, or a tool that never started all produce the same empty
match.

## Detection: mutation testing is the only reliable method

**Every one of these passed all existing tests.** Test suites, lint,
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

**When the set genuinely cannot be derived, invert the list instead.** Some sets
have no manifest to read — the entry-point guard exists in three files that
cannot import one another, and nothing in the repo declares that. A list of
things to CHECK fails silently when it falls behind; a list of things EXEMPT
from a walk over everything fails loudly, because the walk hits the missing
entry and complains. Same data structure, opposite failure direction. `#7222`
kept its three copies identical by iterating a hardcoded list, and `#7235` added
the walk that says there are only three — the second is what makes the first's
list safe to hardcode, and both now read the same list so they cannot disagree
about which files they mean.

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
- `packages/server/src/utils/is-entry-point.js` — the entry-point guard. It
  exists in three files that cannot import one another
  (`scripts/lib/entry-point-guard-copies.mjs` is the list, and says why), and
  two gates hold it: `scripts/__tests__/is-entry-point.test.mjs` fails if the
  three diverge (`#7222`), and
  `packages/server/scripts/lint-entry-point-guard.mjs` walks the tree and fails
  if a fourth appears (`#7235`). The two importable copies each have their own
  suite — `packages/server/tests/is-entry-point.test.js` and
  `scripts/__tests__/is-entry-point.test.mjs`; the sidecar's inline third copy
  is held only by the drift gate, since it cannot be imported to be tested.
