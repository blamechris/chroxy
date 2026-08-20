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
observable outcome**. Five ways that happens:

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
first line, for the 45 modules under `src/` that import a write-side `fs`
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

### 9. The sandbox that guarded a named list, not a category — `#7267`

Found inside the fix for the eighth, which is how this document started.

Making the guard visible to named importers (`#7262`) turned its *reach* into
its only remaining problem — and its reach was a hand-written list of twelve
method names. Everything that deletes, copies, links or changes a mode was
outside it. Measured under the real harness, against the developer's live
`~/.chroxy`:

```
writeFileSync mkdirSync openSync   GUARDED
truncateSync                       GUARDED — but only because it opens 'r+'
                                             and trips openSync
unlinkSync rmSync rmdirSync        unguarded   (34 unlinkSync call sites in src/,
chmodSync symlinkSync linkSync     unguarded    more than openSync's 14)
cpSync copyFileSync                unguarded — and these CREATE
fs.writeFile(path, data, cb)       unguarded — the whole callback surface
```

`cpSync` is the one worth remembering. A probe aimed at a path whose parent
directory did **not** exist — chosen precisely so a failing measurement could
create nothing — left a real directory tree inside the developer's live
`~/.chroxy`, because `cpSync` creates the destination's parents before it fails.
The safety argument was sound for every other API and wrong for that one, and
nothing in the guard, the suite, lint or CI said a word.

The fix is one exported array (`scripts/lib/test-fs-sandbox.mjs`) that expands
to the patch list *and* to the probes asserting each patch fires, plus a
complement (`FS_EXEMPTIONS`) that classifies every remaining `fs` function with
a reason — so `GUARDED ∪ EXEMPT` must cover the live surface exactly, and a Node
release that adds a path-taking mutator turns the suite red instead of widening
the hole.

**The part that is not obvious: a derived assertion cannot test the parameter it
derives from.** Both lists expand from rows like `{ base: 'rename', paths: 2 }`,
so narrowing one to `paths: 1` deletes the guard on the second argument *and*
the probe that would have caught it — and the suite stays green while
`rename(tmp, '~/.chroxy/session-state.json')` walks through. That mutation was
run, and it passed. Which arguments are paths is therefore stated a second time,
deliberately, as a specification with a reason per row; it is the only thing in
the change written twice.

### 10. The list that lived in CI config — `#7270`

`Server Windows Tests` passed an explicit list of **eight** test files to
`node --test` while `packages/server/tests/` grew to **553**. The list was
curated on purpose — much of the suite needs node-pty or POSIX signals — but a
newly added, genuinely cross-platform test was never run on Windows and nobody
was told. `#7266` added `setup-sandbox-binding-forms.test.js`, which is entirely
about path handling and errno behaviour and is exactly what Windows coverage is
for; the job passed in 58 seconds without executing it.

Mode (3), "checked a subset" — but this is the first entry where the list lives
in **CI configuration** rather than in a script, which is why no test, lint or
review of the code could have found it. The green came from a job that was
working perfectly on everything it was pointed at.

The fix inverts it, per this document's own guidance: walk every `*.test.js`,
subtract a manifest of exemptions each carrying a reason category and a measured
symptom, run the rest. Coverage went from 8 files / 193 tests to 480 / 10,929.
There is no "unclassified" state to detect afterwards — an unclassified
POSIX-only file makes the job red in its own TAP output, naming itself.

**Two things it taught that the earlier entries did not.**

The measurement had to come first. Seeding the exemption list by grep would have
been wrong in *both* directions: `built-in-tools/bash-exec.test.js` contains no
`spawn(` at all while the module it tests spawns `bash -c`, and all 46 files
matching `/docker/i` drive fakes and pass fine. Every row was seeded from
running that file on a real Windows host.

And the fix's first real run contained the next instance, one level down. The
runner counted `# fail` and not `# cancelled`, and Windows reported **`# fail 0`
alongside `# cancelled 33`** — a cancelled test produced no result at all, so
"33 tests never ran" and "everything passed" were the same observable outcome.
That is now checked, along with a non-zero child exit the TAP summary cannot
account for. Note `assert-test-count.mjs` parses only `# tests` and `# fail`
too; it propagates node's exit code, so it is not necessarily blind, but it
cannot itself tell a cancelled test from a passing one.

### 11. The deny-everything check whose negative tests all passed — `#7273`

`validatePathWithinCwd` asked "is this path inside the project?" with
`realAbsPath.startsWith(cwdReal + '/')`. On Windows every path `realpath()`
returns is backslash-separated, so the prefix never matched and the answer was
**always no**. 63 assertions across 15 server test files failed with variants of
`Access denied: ... restricted to the project directory` for paths plainly
inside the project.

That part was noisy, and noisy bugs get fixed. The false safety is what the
noise hid.

A containment check that denies *everything* also denies traversal. So every
NEGATIVE test — the ones asserting that `../../etc/passwd` is refused, that a
symlink escaping the workspace is refused, that an out-of-home directory is
refused — **passed on Windows, for the wrong reason, and would have kept passing
with the check deleted outright**. `tests/ws-file-ops-git-paths.test.js` is the
clearest case: every negative assertion in it was green on Windows while the
function it tests was incapable of returning `true`.

This is mode (1), "reported success without checking", inverted: the guard was
so broken it satisfied its own adversarial tests. The tell is that the positive
and negative cases were not independent — one bug flipped both, and only one of
them complained.

**What it cost to find.** The direction is the whole finding, and grep cannot
give you it. Fixing the separator turned `rejects symlink inside home that points
outside home (#662)` from green to red — which read as a regression and was not
one: `os.tmpdir()` on Windows is `C:\Users\<u>\AppData\Local\Temp`, i.e.
INSIDE `os.homedir()`, so that fixture's "outside home" target had never been
outside home. The test had been asserting a true conclusion from a false premise,
and only a working containment check could reveal it (`#7285`).

**And the same expression failed OPEN elsewhere.** The `relative()`-based
spelling of the same question — `rel.startsWith('..')`, used for `file_ref`
attachment containment — is not merely wrong on Windows, it is exploitable.
`path.win32.relative()` returns a `..`-prefixed path only when both sides share
a ROOT; across roots it hands back the target verbatim, which does not start with
`..`. So `D:\secrets\x`, `\\host\share\x` and `\\?\C:\Users\<u>\.ssh\id_rsa`
all read as "inside the project". The paired round-trip guard,
`resolve(cwd, rel) !== absPath`, is a tautology for exactly those inputs and
caught nothing. **No test failed** — that seam is silent, not noisy, so it was
not among the 15 red files and no fixture ever asked the question.

The fix is one root-aware predicate — `packages/server/src/utils/path-containment.js`
— replacing six hand-rolled copies in three different spellings. Its test binds
the shipping implementation to `path.win32` and `path.posix` in turn, so a
POSIX-only CI run catches a Windows regression; that matters because
`Server Windows Tests` runs on a single self-hosted box, and a guard that can
only go red on one machine will eventually go quiet. All four historical
spellings were mutation-proved to fail it.

**The trap in the obvious fix.** `root + sep` — the one-character correction —
is also wrong, on both platforms: `'C:\Documents'.startsWith('C:\' + '\')` and
`'/tmp'.startsWith('/' + '/')` are both false, so any root that already ends in
a separator denies everything. Two of the six copies had already "fixed" it that
way.

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
