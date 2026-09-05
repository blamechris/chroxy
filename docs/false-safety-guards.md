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

### 12. The guard that validated one language and executed another — `#7281`

`gitStage` resolved the client's string to an absolute path, asked
`validatePathWithinCwd` whether that path was inside the project, and — having
been told yes — handed **the client's original string** to `git add`.

The check was correct. The path it checked was never the thing that ran.
`git add` takes a *pathspec*, not a path, and a pathspec has its own grammar.
`:/` resolves, as a filesystem path, to a harmless `<cwd>/:` that is plainly
inside the project; to git it means "from the repository root". From a session
confined to a subdirectory, one WebSocket message staged files above the
workspace root, and the server replied `error: null`.

Two grammars, two mechanisms: root-anchoring (`:/`, `:(top)`, `:/*`,
`:(top,glob)**`) re-bases the pathspec on the repo root, and exclusion-only
(`:!x`, `:(exclude)x`) means "everything except", resolved repo-wide.

**Why no test caught it.** Every fixture in `ws-file-ops-git-paths.test.js` and
`git-stage-commit.test.js` used the repo root as the session cwd — the one
topology in which `:/` has nothing to reach. The suite tested the escape
mechanism it knew about (`../`, correctly refused) and never asked about the
one that worked. Fixture *geometry*, not payload, was what made the bug
invisible; a reviewer scanning six adversarial payloads in a describe block
named "path validation" would reasonably conclude the surface was covered.

**The fix has two halves and needs both.** `--literal-pathspecs` disables the
magic; handing git the validated path restores "what is checked is what runs".
Re-deriving the path alone is *not* sufficient — `relative()` leaves
`:/etc/shadow` byte-identical.

**Two traps inside the fix**, both found by review after the first cut shipped:

- Deriving the pathspec from the validator's `realPath` stages a symlink's
  TARGET. Deriving it from the lexical `absPath` can point *out* of the cwd,
  because containment is decided on `realPath` — so it says yes to a path that
  merely reaches the cwd through a symlink or an aliased prefix (the ordinary
  macOS `/var` → `/private/var` case, not an attack). Neither alone is right.
- Falling back to `realPath` then re-introduces the original sin in miniature:
  when the fallback yields an empty relative path, answering `'.'` turns a
  one-path request into a whole-cwd stage. Measured: `['../aliasdir']` staged
  every file in the cwd, `error: null`.

**And the flag is silent on half the surface.** `git reset` does not error on a
non-matching pathspec the way `git add` does, so deleting `--literal-pathspecs`
from the unstage invocation left all 31 tests green. The guard needed its own
positive control: a file whose name begins with `:` is unstageable *without* the
flag and unstageable *with* it, so the assertion goes red the moment the flag is
dropped. The stage half has the mirror control.

**Environment can refuse the fix outright.** git rejects `--literal-pathspecs`
when the environment also selects another global pathspec mode, so an inherited
`GIT_GLOB_PATHSPECS=1` or `GIT_ICASE_PATHSPECS=1` would make *every* stage die
with `fatal: global 'literal' pathspec setting is incompatible with all other
global pathspec settings`. The daemon inherits the user's shell environment;
those variables are dropped for our own invocations.

The generalisation is worth more than the instance: **whenever a validated value
is handed to something that parses it under a different grammar — a pathspec, a
revision, a glob, a shell word, a URL — the validation proves nothing.** The
sibling instances that audit turned up are `#7290` (a revision allowlist whose
comment claims it blocks flags, while `-` is inside its character class) and
`#7291` (client prompts in positional argv slots with no `--`) — both
now catalogued as entry 13.

### 13. The allowlist that permitted what its comment forbade — `#7290`, `#7291` (partial)

`#7290` is closed. `#7291` is **not** — its `codex-session.js` half is still
open, because fixing it needs an argv reorder around a documented
`--sandbox`-before-`resume` invariant that only the repo's spawn-and-assert
clap harness can verify, and that harness needs a working codex binary. This
entry describes the half that landed; do not read it as closing `#7291`.

Entry 12 predicted these two as its siblings. Both are the same shape: a guard
whose *comment* describes a stronger check than its *code* performs.

`getDiff` validated a client-controlled revision with

```js
// Validate ref name to prevent git flag injection
const diffBase = /^[a-zA-Z0-9._\-\/~^@{}:]+$/.test(rawBase) ? rawBase : 'HEAD'
```

`-` is inside the character class, so it is a permitted *character*, and the
regex has nothing to say about *position*. Measured against git 2.54.0, every
single-token option passed and was then parsed as an option: `--stat`, `-p`,
`--raw`, `--exit-code`, `--ext-diff`, `--word-diff`, `-U99999`, `-O<path>`.
Only forms containing `=` were blocked, and only because `=` is absent from the
class — an accident, not a defence.

**The impact was larger than "git errors out".** `git diff -O<file>` reads
`<file>` as a diff orderfile, and `getDiff` forwards raw git stderr to the
client (`error: err.message`). So `-O` is a file existence/readability oracle
over the entire filesystem, as the daemon user, escaping the session cwd
completely, with the answer returned on the wire:

```
-O/etc/passwd                        -> (silent: readable)
-O/etc/shadow                        -> fatal: failed to read orderfile … No such file or directory
-O/Users/<you>/.ssh                  -> fatal: … Is a directory
-O/Users/<you>/.chroxy/config.json   -> (silent: readable — outside the workspace)
```

Absolute paths, deliberately. git receives these as one argv element with no
shell anywhere on the path, so a `~` is never expanded — `-O~/.ssh` only ever
reports "No such file". A tilde in a table like this turns a reproducible
measurement into a claim nobody can re-run, which is the failure mode this
document is about.

The field is unconstrained on the wire: `GetDiffSchema` is
`z.object({ type: z.literal('get_diff') }).passthrough()`, so nothing upstream
narrows it either.

**The fix closes the leading-dash route and only that.** Said plainly because
the first draft of this entry did not: `:` and `/` are both in the charset
allowlist, and git's stderr is still forwarded verbatim, so a path oracle
needing no dash at all survives —

```
base='HEAD:/etc/passwd'  -> fatal: path '/etc/passwd' exists on disk, but not in 'HEAD'
base='HEAD:absent'       -> fatal: path 'absent' does not exist in 'HEAD'
base='/etc/passwd'       -> fatal: '/etc/passwd' is outside repository
base='/no/such/file'     -> fatal: ambiguous argument …
```

— which is pre-existing, tracked separately, and needs `rev-parse --verify`
plus not forwarding raw git stderr. A guard entry that overstates its own
reach is the same defect in miniature, which is why it is corrected here
rather than left to read as sealed.

**The obvious fix does not work, and the issue itself proposed it.** Appending
a `--` separator — `['diff', diffBase, '--']` — is ineffective, because `--`
ends option parsing at *its own position* and `diffBase` precedes it:

```
git diff --stat --        still applies --stat
git diff --exit-code --   still exits 1
git diff -O/etc/nope --   still reads the orderfile
```

`--literal-pathspecs` (entry 12's fix) does not help either: it constrains the
*pathspec* language, and a revision is not a pathspec. Rejecting the leading
dash is the only thing that works here.

**Which fix applies is decided by whether a leading `-` is legitimate**, and
this is the part that is easy to get backwards. A git revision can never begin
with `-`, so rejection is right. A user's chat message legitimately can
("- first point"), so rejecting a prompt would break normal use — there, a
`--` separator is the fix, with every flag moved before it. `#7291`'s
`_spawnRemoteTask` needed the second treatment, not the first.

**But "use `--`" is not a rule either — it depends on the flag's arity, and
against a required-argument flag it is worse than doing nothing.** Measured
against commander 12.1.0 with a prompt of `--dangerously-skip-permissions`:

| `--remote` declared as | `['--remote', prompt]` | `['--remote', '--', prompt]` |
|---|---|---|
| boolean | **injects** | safe |
| `[name]` optional | **injects** | safe |
| `<name>` **required** | safe — swallowed as the flag's value | **injects** |

For a required-argument flag the `--` becomes the flag's own value, which frees
the prompt to be option-parsed. No single argv is correct under both arities,
so the caller must know which it faces: `detectFeatures` reads the advertised
arity and refuses the feature when it cannot use a separator safely. gemini-cli
is the third variant again — its `requiresArg` flags reject `--` outright, and
need `--flag=value`. The generalisation is that **the fix shape is a property
of the target CLI's parser and has to be measured per CLI**; a repo-wide "add
`--` everywhere" sweep would have broken two of the three.

**And the gate that was supposed to keep the prompt out of that argv reported
success without checking.** Feature detection was `help.includes('--remote')`,
a substring match. Measured against the installed CLI, whose help text carries
`--remote-control` and `--remote-control-session-name-prefix` and no `--remote`
at all:

```
help.includes('--remote')      -> true    (gate opens)
/--remote(?![\w-])/.test(help) -> false   (correct)
```

The existing test for this gate fed a help text containing no `--remote`
substring *at all*, so the naive check already answered it correctly. It passed
before and after the fix — the recurring test shape in this document: a case
the guard already handles proves nothing about the case it does not.

**The generalisation.** `execFile` with an array argv stops *shell* injection —
no shell ever sees the string — and it is easy to write a comment claiming that
covers injection generally. It does not stop *argument* injection: the spawned
program still runs its own option parser over that array. The two are different
classes with different fixes, and "we use execFile, not exec" is an answer to
only one of them.

### 14. The quoting that stopped the wrong injection — `#7295`

Entry 13 closed with a generalisation: `execFile` with an array argv stops
*shell* injection, not *argument* injection. `#7295` is the same sentence with
one word swapped, in a subsystem that does use a shell.

The `Grep` built-in built its command as a bash string and quoted the
model-controlled pattern:

```js
const rgCmd = `rg ${ci} ${ln} --no-heading${globArg} ${shellQuote(pattern)} ${shellQuote(root)}`
```

`shellQuote` is a real defence and it works: bash consumes the quotes, so no
metacharacter in the pattern is ever interpreted. What it cannot do is change
what the quoted argv element *is*. `rg` then runs its own option parser over a
string that still begins with `-`, and rg has options that execute programs.
Measured against ripgrep 15.1.0, with a marker-writing script:

```
rg -i -n --no-heading '--pre=/tmp/pre.sh' <root>      rc=1, marker WRITTEN
rg -i -n --no-heading -e '--pre=/tmp/pre.sh' <root>   rc=1, marker absent
```

A second, quieter effect, and the two are **alternatives rather than a pair** —
which the first draft of this entry got wrong. `--pre=` self-terminates, so
`<root>` slides into the pattern slot and rg is left with zero paths. What
happens next is decided by the child's stdin, measured on the unfixed builder:

```
child stdin = 'ignore'  (what the host sink uses)  rc=1,    marker WRITTEN, no hang
child stdin = 'pipe', held open                    hangs,   marker absent
```

`/dev/null` is a chardev, so rg's `is_readable_stdin` heuristic returns false and
it falls back to searching `./` — executing the preprocessor without hanging.
Give it a pipe or a file and it blocks on stdin until EOF instead, and
`maskExit: true` cannot save that: the process never exits to have its code
masked. So the host sink (`bash-exec.js`, `stdio: ['ignore', …]`) gets the
EXECUTION, and the hang is what a caller with a piped stdin gets. Both are
tested; only one can happen per call.

**Why it was worse than an ordinary argv bug.** `Grep` is classified read-only
everywhere in the permission system — `SECRET_READ_FLOOR_TOOLS`,
`ACCEPT_EDITS_TOOLS`, `ELIGIBLE_TOOLS` — so it is auto-approved in `acceptEdits`
mode and can carry a standing auto-allow rule. `Bash` and `shell` are in
`NEVER_AUTO_ALLOW`, refused a whitelist as too dangerous. The bug reached the
`Bash` capability through the tool exempted for not having it.

**The guard was wired to one of two siblings.** `runGlob` — the function
immediately preceding `runGrep` in `byok-tool-executor.js` — validates its
pattern against `GLOB_PATTERN_SHELL_METACHARS` and says so in a comment. Two
adjacent functions, same file, same class of input, same kind of sink — one
checked, one not.

**But the cover the neighbour had would not have helped**, and saying "one
checked, one not" without that caveat reproduces entry 13's defect inside this
very entry. `GLOB_PATTERN_SHELL_METACHARS` is ``/[$`;|&><()\\\n\r]/`` — a
*shell*-metachar whitelist, guarding an interpolation that `buildGlobCommand`
deliberately leaves UNQUOTED so the shell expands the glob. Measured, it rejects
none of the exploit shapes:

```
--pre=/tmp/pre.sh  -> rejected? false
-Wall              -> rejected? false
--force            -> rejected? false
-f/etc/passwd      -> rejected? false
```

`runGrep` faced an *argv* problem behind `shellQuote`; its neighbour solved a
*shell* problem in front of a bare interpolation. Different classes, different
fixes. So what was missing was not the guard — it was the **question**. A
sibling with an explicit input check, sitting next to one with none, should have
prompted "what is `runGrep`'s pattern protected against?", and nobody asked.
That is the `#7262` cause seen from the other side: there a guard existed and
missed callers; here a guard existed on the neighbour and was never interrogated.

**The fix is `-e <pattern>`, not a leading-dash rejection.** `-Wall` and
`--force` are legitimate search patterns; rejecting them is a functional
regression, and on the unfixed builder `-Wall` was *already* one
(`rg: unrecognized flag -W`, exit 2). This is fix shape (3) in
`packages/server/src/utils/argv-safety.js` — bind the value to a named flag the
CLI declares as requiring an argument.

Shape (3) as written there prescribes the `=`-joined SINGLE-token form
(`--flag=<value>`), because gemini-cli's yargs `requiresArg` rejects the
two-token one. `rg` and `grep` accept the two-token `-e <pattern>` (measured
against ripgrep 15.1.0 and BSD grep: marker absent, rc=1; `-e '-Wall'` matches,
rc=0), so it is sufficient here — which is that section's own point, that the
form is a per-CLI question answered by measuring rather than assumed. Shape (2),
a `--` separator, also works (measured: rc=1, marker absent) — unlike `#7290`'s
revision slot, because the pattern *follows* the separator — but `-e` survives
future flag additions and needs no ordering argument.

**Two more slots the first fix walked past.** Binding the pattern left the
builder's OTHER interpolation, `root`, in a bare positional slot — the
adjacent-field shape, fixing the field in the report and not its neighbour. It
is not exploitable today (both callers hand over an absolute path, via
`safeResolveRoot` and `remapToContainerPath`), but the builder should not rest
on an invariant it neither states nor tests. Measured:

```
rg -e TODO    '--pre=/tmp/pre.sh'   rc=0, marker WRITTEN
rg -e TODO -- '--pre=/tmp/pre.sh'   rc=2, marker absent
```

And rg reads `RIPGREP_CONFIG_PATH` as flags — including `--pre`, reinstating
execution *around* the argv fix entirely. Not client-reachable here, but it is
also a live CORRECTNESS bug, which is the more useful half: a config containing
`--pre=/bin/echo` silently turns a matching search into `rc=1` no-match. Output
that gets machine-parsed must not depend on a developer's personal rg config.
`--no-config` closes both.

**What the test had to do.** `tests/built-in-tools/grep-argv-injection.test.js`
spawns the built command rather than asserting on its text, because a string
assertion is only as strong as the reviewer's model of rg's parser. Every test
was confirmed red on the unfixed builder first; the full mutant now kills 12 of
13 (the survivor is the armed positive control below, which deliberately does
not go through the builder). Each guard was then mutated alone: dropping `-e`
from the rg branch kills 5, from the `grep -r` fallback 3, dropping `--` before
the root 3, dropping `--no-config` 3.

**Three ways the tests were themselves false-safe, found by review.** All three
are this document's own catalogued causes, reproduced inside the change that
adds an entry to it:

- **A negative control with no positive control.** "The marker was not written"
  passes for free the moment the fixture stops taking effect. Demonstrated by
  reverting the fix *and* dropping the script to mode `0o644`: the vulnerability
  was live and the test went GREEN. The file now runs `--pre` as a genuine flag
  first and asserts the marker IS written, so an inert fixture fails loudly.
- **A skip that CI reads as a pass.** The three rg tests carried the whole
  execution proof and `t.skip`ped when ripgrep was absent — and no CI job
  installed it, which the Windows job's log proved in the literal form
  `ok 1 - … # SKIP ripgrep is not installed`. `node:test` counts a skip in
  `# tests` and not in `# fail`, so what CI actually enforced was the string
  assertion the file argues is insufficient. Now: a hard failure when
  `process.env.CI` is set, and a step that installs ripgrep.
- **An assertion whose name outran its code.** The permission-coupling test
  matched `-e '<pattern>'` against the whole `if … then rg …; else grep …; fi`
  string, so EITHER branch satisfied it; it stayed green under each
  single-branch mutant while that branch was fully exploitable. It now splits on
  `'; else '` and asserts per branch.

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

### 15. The denylist for the neighbouring threat, mistaken for containment — `#7341`

**Entry 14 examined this exact guard and did not ask the symmetric question.** It
asked what `runGrep`'s pattern was protected against. The answer for `runGlob`'s
pattern turned out to be: nothing, for containment.

`Glob { pattern }` was validated only against `GLOB_PATTERN_SHELL_METACHARS` — a
*shell-injection* denylist. It permits `~`, `/` and `..`, so
`Glob {"pattern":"~/.ssh/*"}` returned the user's SSH private keys and
`{"pattern":"/etc/pass*"}` returned `/etc/passwd`, measured end-to-end through the
real dispatcher. The sibling field `path` was fully realpath-confined, one function
away. The permission floor could not catch it either: `PROTECTED_PATH_INPUT_FIELDS`
is `['file_path','path','notebook_path']`, and `pattern` is not a member — so the
tool read as *covered* while being an unrestricted read primitive that is
auto-approved in `acceptEdits`.

The shape: **a real defence against an adjacent class, sitting where containment
should be, with a comment that says it is validated.** Entry 14 is the same family
(#7295, shell quoting stopping the shell while the spawned program ran its own
option parser). Here it is one layer further out — the guard stops injection, and
injection was never how this tool leaked.

**Three things the fix taught, all of which cost a review round:**

1. *Predicting a shell is not winnable.* The first fix inspected the pattern to
   work out where it would expand. Six bypasses followed across two rounds:
   whitespace word-splitting, brace expansion, a glob matching the `..` entry,
   quote removal, a brace body with no top-level comma, and POSIX bracket
   sub-expressions. Every one is invisible in the pattern text and plainly visible
   in the **output**. Confining results needs no model of the shell.
2. *The more "correct" model was worse.* Replacing the regexes with a real brace
   expander and a glob-to-regex segment matcher produced **46 wrong answers out of
   515** enumerated bracket segments — and a denial of service: 4 KB of pattern
   backtracked for **12.9 seconds** of blocked event loop, returning `null`
   (accepted), on a tool callable in a loop. Deleting the model fixed both.
3. *A guard's own escape hatch needs a test.* `catch { return false }` in the
   confinement had no coverage — flipping it to `return true` passed all 341 tests.
   A second fail-closed `catch`, added in the same commit whose message boasted
   about testing the first, was also untested.

**And the test that was itself the defect.** A case written *specifically* as a
positive control against entry 11's deny-everything shape, and labelled
`(positive control)`, globbed `*/pass*` and asserted `esc/passwd` was absent — but
`fs.glob` does not descend a wildcard-matched symlinked directory, so that pattern
never yields `esc/passwd` under any implementation. It asserted the absence of
something that was never there and passed with the entire fix deleted. A negative
assertion needs a **precondition proving the dangerous thing is produced**, or it is
indistinguishable from a pattern that matched nothing.

**Guard against it:** when a field decides what a tool reads, confine what the tool
**returns**, not what it was asked for. And when auditing a floor, ask what the tool
reads — not which of its fields the list happens to scan.

### 16. The guard scoped to one file, and the value it could not spell — `#7386`

Two instances, one PR, both in the same guard.

**The file.** `ci-cache-key.test.js` enforced that setup-node's
`cache-dependency-path` is `**/package-lock.json` — this is a three-lockfile
monorepo, and the default key is the root file alone, so a bare key means a
dependency change under `packages/` restores a stale cache. It read `ci.yml`
and nothing else. `maestro-nightly.yml` carried the bare key (found while fixing
`#7383`, not by this guard) and `release.yml` carried it **four times** — so a
*release* build could be cut from a stale cache, which is the worst place in the
repo for it. Cause #1 again, in its purest form: a guard whose roster is a
hardcoded list of one file, beside a directory that grows.

The fix is the same one that worked in `#7383`: **scope to the defect, not the
file.** Discovery is `readdir`, so a workflow that does not exist yet is covered.

**And the value it could not spell — found in review of that fix.** The reader
took `runs-on` as a single line. GitHub accepts two spellings of one label set:

```yaml
runs-on: [self-hosted, macOS, ARM64]   # flow — the value is on the line
runs-on:                               # block — the line holds NOTHING
  - self-hosted
```

The block form yielded the literal string `"runs-on:"`, so `/self-hosted/` never
matched and every self-hosted rule `continue`d past the job. A workflow pinned to
`[self-hosted, macOS, ARM64]` in block form while hardcoding `cache: npm` —
`#7383`'s defect verbatim — passed **all 14 tests green**. Reproduced before
fixing.

This is a variant worth naming on its own: **two spellings of identical config,
one of them invisible to the guard.** The repo happens to use only the flow form,
so no amount of scanning the real workflows could have revealed it — which is why
the reader now has unit tests driven by *synthetic* YAML. A guard that only ever
sees the inputs the repo currently produces is untested against the inputs it
exists to catch.

**Guard against it:** when a reader becomes shared infrastructure, test the
reader, with inputs the repo does not currently contain. A consumer's positive
control catches a reader that finds *nothing*; nothing catches a reader that
finds *most things*.

### 17. The mutation harness that accepted a hang as red — `#7340`

The guard here was fine. **The thing checking the guard was not** — and it is a
textbook instance of the shape at the top of this file, one level up: for the
harness, "the mutant was caught" and "the harness never found out" were the same
observable outcome.

The harness was a shell wrapper: apply a mutant, run `node --test`, and report.
Its verdict was one line.

```sh
if [ $rc -ne 0 ]; then echo "RED as required (exit $rc)"; else echo "STILL GREEN"; fi
```

`!= 0` is not "the guard caught it". It also covers **hung and killed**,
**crashed before the first test ran**, **out of memory**, and **wrong CLI flag**.
Every one of those prints `RED as required` and moves on, and a mutation pass is
precisely the situation where you have deliberately broken the tree — so the
run *failing to run* is not a remote possibility, it is a live one.

It fired here. Fifteen mutants were confirmed with that line. Two of them never
executed a single assertion: `node --test` ran past **two minutes with an empty
TAP stream** and had to be killed by hand. They were recorded as caught. The
guard's real states were **pass → green, fail → hang**, and nothing in that
mapping is a red build.

The mechanism, since it is a decent hazard in its own right: a failing
`assert.match(subject, re)` carries **the entire subject as the error's
`actual`**, and these guards match against multi-kilobyte source slices. The fix
is to collapse to a boolean *before* asserting, so the subject never rides on the
assertion —

```js
assert.match(branch, /authoritative: true/)          // fail → 124 KB of TAP
assert.ok(/authoritative: true/.test(branch), msg)   // fail → red, in ~0.3s
```

— and `assert.deepEqual(bigArrayOfPaths, [])` wants the same treatment: map to
the short field you actually care about first.

**The sweep landed in `#7401`, and it is now backed by a runtime cap.** Every
assertion whose subject was a large checked-in file was converted; the ~10 that
remain read a file the test itself just wrote and carry a note saying so. The
conversion is a LIST, though, and a list beside a growing set is the first
recurring cause on this page — so `scripts/lib/assert-match-payload-guard.mjs`
(installed from `packages/server/tests/_setup.mjs`) bounds the failure payload
for any site the list missed or that lands later. It never changes a verdict,
only how much of the subject rides along.

A static lint was written first and rejected on evidence: deciding "is this
subject large file text?" from the syntax proved unsound in BOTH directions —
tight enough to avoid false positives, it missed three real sites (a multi-line
`await readFile()`, a subject derived through `.split().filter().join()`, and a
call whose subject sat on the next line); loose enough to catch those, it went
from 26 hits to 61, mostly small in-test strings. That is worth remembering
before writing the next source-scanning guard: **a predicate that is not
soundly decidable from the syntax should not be enforced from the syntax.**

**Do not treat the wedge itself as an established mechanism.** Two reviewers
tried independently to reproduce it and could not: one from a standalone script
against a 101 KB subject (failed in ~1.2 s, emitting 124 KB of TAP), one by
reverting the fix in-tree and re-running the original mutant (exit 1 in 289 ms;
still 287 ms with every slice widened to the whole file and five simultaneous
failures). Both were node v22.22.3 / darwin-arm64. So whatever produced a
two-minute empty stream needs something neither reproduction had — `c8`, the
`assert-test-count.mjs` wrapper that spawns the runner and parses its stdout,
concurrent test processes, or something not yet identified.

What IS established: the wedge was observed three times in-tree, at 0.33 s once
the subject stopped riding on the assertion, and 124 KB of TAP for a one-line
assertion is a bad idea regardless of whether it hangs. Keep the style fix; treat
the cause as open.

And note that the uncertainty does not touch the entry. The harness defect stands
on its own — it was found by reading the harness, not by explaining the hang, and
it would have accepted a crash, an OOM or a bad CLI flag just as happily.

**Guard against it:** a mutation test is not finished when the suite stops being
green. **Check that it went red, with a legible message, and how long it took.**
Assert the shape of the failure — the expected test name in the output, a
non-empty TAP stream, a duration in the range a real failure takes — not merely
that the exit code was non-zero. The same applies to any wrapper that decides
pass/fail from an exit status alone: `cmd | grep -c FAIL` reporting `grep`'s
status is the identical defect one pipe further along, and it is already
catalogued above.

### 18. The guard falsified by the loop it was meant to interrupt — `#7399`

The dashboard's chat view has, and had for months, a correct-looking guard
against yanking a reader who has scrolled up to read history (`#4652` / AC3).
It classifies each `scroll` event and bails out of the auto-follow when the
viewport is no longer at the bottom:

```js
if (programmaticScrollRef.current && atBottom) return   // our own write — ignore
setUserScrolledUp(!atBottom)
```

Nothing is wrong with those two lines. They were never reached.

Twenty lines below sits a streaming re-pin loop that re-arms every frame for the
whole duration of a stream. Each tick writes `scrollTop = scrollHeight` and marks
the write programmatic until the *next* frame — so a loop that re-arms every
frame holds that flag **continuously**. And the position it restores is the
bottom. Both halves of `programmaticScrollRef.current && atBottom` are therefore
true for the entire stream, by construction, and every scroll event is discarded
as self-induced.

The second half is the part worth internalising, because the flag alone would
not have done it. `atBottom` is not "at the bottom" — it is "within 100px of the
bottom". A trackpad flick moves 10-40px per frame. So the user's gesture had to
clear 100px **in a single frame**, because the next tick threw away everything
they had gained. Two individually reasonable choices — a wide "still following"
band and a per-frame pin — composed into a guard whose precondition its
neighbour falsified sixty times a second.

**Tests could not see it, and neither could review.** The guard has unit tests
and they pass; they scroll up while idle, when no loop is running. Reviewers read
the two lines, which are correct in isolation. What was needed was to read them
*against* the effect twenty lines down — and the comment above that effect
actively discouraged it, ending with the claim that "a genuine user scroll-up
(`atBottom` false) is still honored" when `atBottom false` is precisely the state
the loop made unreachable. That is entry 13's shape (a comment describing a
stronger property than the code delivers) sitting on top of this one, and it is
why the bug survived a dogfooding report long enough to be filed against a
specific line number.

**What the fix had to change** is not the guard but the *evidence*: intent now
comes from the gesture (`wheel` / `touchmove` / key, direction-checked), which is
unambiguously the user whatever position the loop leaves behind. A position the
loop itself controls cannot be evidence about the user, and no amount of
threshold tuning changes that.

Two of the fix's own first-cut tests then repeated the original mistake at
one remove: they supplied *both* a gesture and a scroll event landing outside the
threshold, so the position path satisfied them and they passed with the gesture
handler unwired entirely. Mutation testing caught it. A test for a
gesture-derived guard must withhold every other source of evidence.

**Guard against it:** when a check reads shared mutable state, find every writer
of that state and ask what value it holds *while the check runs* — not what it
holds in the test. A flag set-and-cleared across frames is continuously set if
anything re-arms it per frame. And a threshold band is a precondition too: a
guard that needs N pixels of movement is unreachable if something else resets the
movement more often than the user can produce N.

### 19. The test runner that reported fewer tests than it ran — `#7400`

Every other entry here is a guard inside the repo. This one is the *instrument*:
`--test-force-exit`, the flag the local test command carried for a year.

Same file, same command, five consecutive runs of `base-session.test.js`
(192 tests):

```
WITH --test-force-exit:   192 / 165 / 173 / 162 / 154   (every run `# fail 0`, exit 0)
WITHOUT:                  192 / 192 / 192               (exit 0)
```

Up to 38 tests missing from the summary, non-deterministically, with nothing in
the output saying so. And the tests were not skipped — a root `beforeEach`
appending one line per test to a side file recorded **all 192** on a run whose
summary said 168. What the flag drops is the *results*, on their way from the
child process to the runner: under the default process isolation the child
inherits the flag, `process.exit()`s the moment its own root test settles, and
whatever it had queued for the parent goes with it. Run the same file
in-process (`--experimental-test-isolation=none`) and the flag is harmless —
192, three times out of three.

**What makes it the worst instance in this catalogue** is not the size of the
drop, it is *what* it corrupts. This document's own answer to false safety is
mutation testing: break the thing, confirm the test goes red. Do that through a
runner that silently omits a fifth of its results and "the mutant survived" and
"the test that kills it never reported" become the same reading — the exact
equivalence the whole document is about, now sitting underneath the method used
to detect it.

Two things kept it invisible for a year, and both are entries in their own right:

- **The floor could not see a targeted run.** `assert-test-count.mjs` does floor
  the total — but only for the whole suite, in CI, which never passed the flag.
  The runs that carried the flag were the local, single-file ones, which have no
  floor at all.
- **The docblock said the flag was in use.** It had not been since `#6042`, and
  the stale sentence was load-bearing in the wrong direction: it is what
  re-derived, for the next reader, that typing the flag locally was normal and
  safe.

The honest limit of the damage: a *failing* test still turns the run red. A
deliberate failure planted mid-file and at the tail exited 1 on 14 of 14 runs,
truncated or not, because the child's non-zero exit reaches the parent whatever
happened to its output. So RED was always trustworthy. It is GREEN that was
worth less than it looked — which is the shape of every entry above.

**The fix is refusal, not a louder green.** `scripts/lib/no-test-force-exit.mjs`
is installed in every package that runs `node --test` — server and claude-hooks
call it from `tests/_setup.mjs`, protocol and design-tokens `--import` the hook
next door — so every file fails before a single test in it executes. (`--import` loads in the per-file children, not in the
runner parent — measured — so the red comes from the files, and the exit code is
what to trust.) Nothing needed the flag any more: the leaked handles it papered over
were fixed in `#6027`/`#6042`, all eight files on that leak map now exit on
their own, and the flag buys no wall clock (byok-session 66.5s → 63.9s,
byok-mcp-client 74.9s → 74.9s). A file that hangs after its summary is a leaked
handle to tear down — the same leak CI will hit, which force-exiting locally
hides.

**Its own tests nearly repeated the pattern.** The call-site tests spawn a real
`node --test` from inside a test, and a child that inherits `NODE_TEST_CONTEXT`
refuses to run files at all — exits 0, reports nothing. The refusal cases would
have been satisfied by a child that never ran, for a reason having nothing to do
with the guard. The positive control is what named it: the same spawn without
the flag has to go green *with the probe reported*, and it did not.

The Windows job then produced the same shape a second time, from a different
cause: `--import` takes a module *specifier*, so the absolute path
`A:\runners\...\_setup.mjs` parses as protocol `a:` and node refuses to load it
(`ERR_UNSUPPORTED_ESM_URL_SCHEME`). Every child died before running anything —
and "refuses before the probe runs" passed, because a child that never loads
satisfies a negative assertion perfectly. The control failed, as it should have.
Twice in one change, a negative assertion was satisfied by a child that did
nothing; the fix is `pathToFileURL()`, and a case pinning the specifier's shape
so the next occurrence is caught on Linux instead of only on Windows.

**Guard against it:** a green that comes from the tooling is still a green you
have to earn. When a run reports a count, pin the count — and when a comment
tells you which flags a command carries, check the command. Both halves here
were readable in ten seconds by anyone who thought to look.
### 20. Two guards pinned at the source text, not the behaviour — `#7374`

Both guards were **honest** about being source-level greps, and both were still
bypassable. That is the point of this entry: "it says it is a source grep" is a
disclosure, not a defence, and the residual belongs here rather than in a
comment that only the next editor of that file will read.

**The reaper nobody proved was called.** `cli-permission-mode-sidecar.test.js`
asserted that `server-cli.js` contained `sweepStaleSinkDirs(log)` inside an
anchored `import(...)` slice, and its docstring claimed the anchoring meant the
assertion "cannot be satisfied by the explanatory comment beside it". Two
mutants said otherwise, both **GREEN**:

- wrap the whole boot block in `if (process.env.__NEVER_SET__) { … }`
- replace the call with `.then(({CliSession}) => void CliSession)` and put the
  expected string in a comment *inside* the anchored window

Entry 1 verbatim: a source grep cannot tell a call reached at boot from the same
characters behind a false condition, and anchoring only excludes comments
*outside* the window it happens to choose.

**The allowlist that was not the only way in.** The same file asserted that
`FORWARDED_ENV_KEYS` in `docker-session.js` does not contain
`CHROXY_PERMISSION_MODE_FILE` — a host path that names nothing inside the
container. Adding the key to the array went red, which is why the guard felt
solid. But pushing `dockerArgs.push('--env', 'CHROXY_PERMISSION_MODE_FILE=…')`
*outside* the allowlist loop stayed **GREEN**, and two explicit single-key
pushes already sit immediately below that loop. The guard pinned one syntactic
route into `dockerArgs`, not the property.

**The fix, in both cases, was to make the work observable rather than to write a
cleverer grep.** The boot block moved into `sweep-stale-provider-dirs.js` with
injectable loaders, so tests RUN it; all three of its mutants now die.
`DockerSession` gained a one-line `_spawnDocker` seam so a test can capture the
argv the real `_spawnPersistentProcess` actually builds; the outside-the-loop
mutant fails 2 tests there and **0** against the old grep — the two were run
side by side under the same mutant to confirm it.

The negative assertion also needed a positive control it did not have: the child
env emits `CHROXY_PERMISSION_MODE_FILE` as `''` when no sidecar exists, so
"the key is absent from argv" would have passed on a session that never had a
path to leak. The behavioural test sets a real host path first and asserts an
allowlisted key *does* get forwarded, so the machinery is proven to have run.

**What is still source-level, stated plainly:** that `server-cli.js` calls
`sweepStaleProviderDirs(log)` at boot. Short of booting the daemon nothing
distinguishes that call from the same characters behind a false condition.

**And the first version of that residual grep was itself bypassable**, which is
the part worth keeping. It read `/^\s*sweepStaleProviderDirs\(log\)/m` and its
comment claimed "line-anchored, so a mention inside a comment does not count".
`\s` matches newlines. Review deleted the real call, left
`/*\nsweepStaleProviderDirs(log)\n*/` in its place, and got **20/20 green** —
the boot sweep gone and the guard satisfied. It rejected `//` and ` * ` lines
only, which is exactly what made it look anchored. It now strips block comments
first and matches with `[ \t]`, and the bypass goes red.

That is causes #7290/#7291 — a guard whose comment describes a stronger check
than its code performs — occurring *inside the entry written to catalogue them*,
in the same change, by someone who had just read them. Treat "line-anchored" as
a claim to test, not a property to assert: `\s`, `.` under `/s`, and any
`[\s\S]` window all cross line boundaries.

**Guard against it:** when a guard's subject is "does this code RUN", extract
the body until a test can call it. A grep answers "do these characters exist",
which is a different question, and the gap between them is exactly where these
two lived.

### 21. The coverage test that derived its expectation from its subject — `#7424`

`notification-prefs.js` carries an explicit contract in its header: `ALL_CATEGORIES`
**"MUST stay in sync with the keys of `RATE_LIMITS` in `push.js`"**, followed by
"the schema-coverage test asserts every category has a default." A test with
that name existed:

```js
it('enumerates every RATE_LIMITS category', () => {
  for (const cat of ALL_CATEGORIES) {
    assert.equal(typeof CATEGORY_DEFAULTS[cat], 'boolean', `missing default for ${cat}`)
  }
})
```

It never imported `push.js`. And `CATEGORY_DEFAULTS` is *built from* the list it
iterates —

```js
export const CATEGORY_DEFAULTS = Object.freeze(
  Object.fromEntries(ALL_CATEGORIES.map((c) => [c, true]))
)
```

— so the assertion is `Object.fromEntries(xs)[x] !== undefined` for `x` drawn
from `xs`. It cannot fail. Deleting `RATE_LIMITS` outright would not have
failed it; nor would deleting the entire body of `push.js`. Eight categories
were added between #4541 and #7424 (`session_online`, `session_offline`,
`session_activity`, `billing_warning`, `mailbox`, …), each touching both files,
and the "parity test" was green for all of them because it was never comparing
the two lists in the first place.

Both directions of the real drift have consequences, and neither is loud:

- a `RATE_LIMITS` key missing from `ALL_CATEGORIES` is a push the per-category
  UI **cannot mute** — `sanitizeCategoryMap` strips it as unknown, so the toggle
  silently does nothing (this is why #5432's review added the external-session
  categories by hand);
- a category missing from `RATE_LIMITS` silently inherits `send()`'s
  `?? 30_000` fallback, so a category documented as "immediate" is quietly
  throttled to once per 30 seconds.

**The distinguishing feature is that the expectation was *derived* rather than
independent.** Entry 3 ("the list that stopped growing") is a hardcoded list
beside a growing set — visibly stale once you look. This one looks *better* than
a hardcoded list: it iterates, so it appears to adapt. What it adapts to is
itself. `RATE_LIMITS` is now exported and the two rosters are compared with a
single `deepEqual` on both sorted key sets, which dies on either direction;
deleting the new category from `ALL_CATEGORIES` fails it, and so does deleting
the corresponding `RATE_LIMITS` entry.

**Guard against it:** when a test asserts that two things agree, read what it
imports. If the expected value and the actual value can be traced back to the
same expression, the test has one input and proves nothing about agreement. The
question to ask of any coverage or parity test is not "does it iterate the right
list" but **"which file would I have to break for this to go red?"** — and if
the answer is "the one it iterates", the other file is unguarded.

### 22. The merge gate whose check names matched nothing — `#7503`

`/batch-merge` is the skill that merges a queue of reviewed PRs unattended. Its
Step 2a was the CI gate, and it read:

```bash
REQUIRED_CHECKS=("Run Tests" "Validate Project")
CHECKS=$(gh pr checks ${PR_NUM} --json name,state)
```

followed by the prose "All required checks must be `SUCCESS` or `SKIPPED`."
Neither name exists in this repo — not in CONTRIBUTING.md's roster of 13
required contexts, not as any `name:` in `ci.yml`. They are leftovers from the
registry template's original repo.

Walking the shipped fence against a captured `gh pr checks --json name,state`
payload from PR #7530 (23 real contexts) makes the arithmetic explicit: the
filter selects **zero rows**, so "no required check is failing" is true by
construction. The same verdict comes back on a payload with
`Server Tests=FAILURE` in it. The gate said PASS on all three fixtures — green,
red, and one with a required context deleted entirely.

Two things make this worse than a stale constant. First, the *neighbouring*
expression is correct: Phase 1's pre-flight counts non-green checks across the
whole payload — but it is explicitly labelled informational and does not block,
so the honest check is the one that cannot stop a merge. Second, truing the
names up would have fixed only half of it. `filter by name, then check states`
still passes when the filter matches nothing, so a **renamed `ci.yml` job**
(the `#7191` family) produces the identical false green: verified by running the
old shape with the *real* names against a payload with `Server Tests` removed —
`rows-matched=1` of 2, `non-green=0`, PASS.

The roster is now derived from `scripts/lib/contributing-roster.mjs` — the one
parse of CONTRIBUTING.md that `contributing-required-checks.test.js` pins
against `ci.yml` and `check-required-contexts.sh` diffs against live branch
protection — and a required context ABSENT from the payload is classified
`MISSING` and blocks. Re-run against the same three fixtures: PASS / BLOCK
(`Server Tests=FAILURE`) / BLOCK (`Server Tests=MISSING`). Feeding the old
phantom `Run Tests` back in through the roster now yields
`Run Tests=MISSING` → BLOCK, where before it yielded PASS.

**And the first fix put it back, one layer down.** The replacement classified
the payload with an external `jq`, checked `node`'s exit status and the
payload's emptiness — and not `jq`'s. `BLOCKERS=$(jq ... )` yields the empty
string when `jq` is missing or the input will not parse, against a rule that
read "an empty `BLOCKERS` is the only pass". Review reproduced it four ways:
with `jq` unavailable the gate returned PASS on a payload carrying
`Server Tests=FAILURE`, and with `jq` present but the response non-JSON it
returned PASS again. macOS ships no `jq`, and every other extraction in the same
playbook already used `gh --jq` — gh's built-in gojq, no external binary — so
the dependency arrived *with the fix*. The extraction now goes through `gh --jq`
like its siblings and the comparison is pure shell, which removes the third
binary rather than guarding it; the pass is a positive signal (a count of
contexts actually classified) instead of an empty list.

**`MISSING` is not automatically terminal, either.** "Nothing produced this
context, so waiting cannot help" is true for a renamed job and false for the
window in which a run does not yet exist — and this repo has that instance:
on PR #7023 a run wedged on an offline runner never freed its concurrency
group, the next push created **zero** runs, and every tool rendered the absence
as "pending" (`ci-run-absent-reads-as-pending`). The operator guidance now
re-polls once and asserts a run exists for the head SHA before calling it, and
marks the PR `Skipped` rather than aborting the batch.

**Guard against it:** a filter-then-assert gate has two failure modes, and the
loud one is the states. Ask what the gate does when the filter matches **zero
rows**, and make that answer BLOCK. Then ask where the filter's terms came
from — if they were typed into the file rather than derived from the thing they
describe, they are already drifting. Then ask the same question of every tool
the gate shells out to: if that tool failing produces the same output as
"nothing to report", the gate is fail-open no matter how good its logic is.

### 23. The suite that ran in no workflow — `#7504`

`scripts/__tests__/merge-updater-feeds.test.sh` was mode 100755, passed 14
assertions, and appeared in **no workflow step** for its entire life. Its
subject is not incidental: `release.yml`'s `github-release` job runs
`scripts/merge-updater-feeds.mjs` to fold the per-platform Tauri updater feeds
into the single `latest.json` the auto-updater serves, so a regression there
breaks updates for installed desktop clients and surfaces only after a release.
This is the plainest form of the whole class — a test that never runs and a
passing test emit the same signal — and it is the one that needs no cleverness
to produce.

The cause is structural rather than an oversight: `scripts-tests` names each
suite in its own hand-written step, which is entry 3's hardcoded list beside a
growing directory. Registering the orphan alone would leave the next one exactly
as invisible, so `ci-scripts-tests-registration.test.js` now quantifies over the
FILESYSTEM — every suite CI can only invoke by name must be named by some
workflow step.

That guard's first version claimed to match "against step bodies with comments
stripped", because ci.yml discusses these files by name and a guard that reads
prose as configuration is satisfiable by prose. It was satisfiable by prose
anyway, and its subject was one directory wide. **See entry 27** — the fix for
this entry is itself the next entry in this catalogue.

Found alongside it: **nothing in `.github/` had ever parsed a shell script.**
Every tracked `*.sh` file is invoked from a workflow step, a git hook or by
hand; none is imported by a test suite, so a syntax error in one ships green and
is discovered by the next person to run it. A `bash -n` step now
covers them, enumerated by `git ls-files -z '*.sh'` rather than a glob typed
into CI config — the pathspec is the property, and narrowing it to `scripts/*.sh`
drops packages/server/scripts/, packages/desktop/scripts/ and
packages/app/.maestro/scripts/ while staying green — 13 of the 30 files present
when that was measured. The step
fails **closed** below a floor of 20 files, because a `for f in glob` loop over
an unmatched glob iterates zero times and exits 0. It is parse-level and claims
no more: `bash -n` reports syntax errors without executing anything, and catches
none of the semantic class (unset variables, word splitting, quoting) that
shellcheck covers — adopting shellcheck across 30 files is a separate decision
with a real baseline behind it.

**Guard against it:** when you add a test file, the question is not "does it
pass" but "which job runs it, and have I seen that job's log?" For a directory
of them, put the answer in a guard that reads the directory, because the step
list in CI config is a hand-maintained roster and rosters stop growing.

### 24. The rule that recovered its bucket for half the members — `#7537`

`scripts/lint-write-only-ctx-fields.mjs` fails module-level state that is
written and never read. Its `module-bindings` target ran into a problem the
author saw and solved: a `const` binding cannot be reassigned, so with only
`=`, `++` and `delete` as write shapes, **every `const` in the roster has zero
writes by construction** and can never reach the failure bucket — clean, on
state the lint structurally cannot judge. The fix (#7467, PR #7530) was a
MUTATOR rule: `m.set(k, v);`, `m.clear();`, `arr.push(x);` at statement
position count as writes.

That rule is correct, and it recovered the bucket for containers mutated by a
METHOD CALL. It did not recover it for the other in-place mutation shape:

```ts
const o: Record<string, number> = {};
o[k] = v;      // classified as a READ of `o`
o.field = v;   // classified as a READ of `o`
```

`isWriteAt()` tested its assignment regex against the text immediately
following the identifier, which for these starts with `[` or `.`, so the `=`
was never seen. Every mutation contributed a READ — so a `const` object or
`Record` could only ever be reported **clean**, which is the exact property the
mutator rule had been added to eliminate, surviving for a different mutation
shape. Mode: *checked a subset* — but the subset is a shape of syntax, not a
hardcoded list, which is why reading the rule cannot reveal it. 34 of the 78
roster members were `const` with zero writes at the time.

The live instance, on the real file: `gitOneshotTimers`
(`packages/dashboard/src/store/connection.ts`) had six references, four of them
`gitOneshotTimers[key] = …`, and reported **6 reads / 0 writes**. Replacing its
two genuine readers with locals — the #7421 regression verbatim, a guard
deleted and its writes left behind — left the lint at `4r 0w`, no error, no
warning, **exit 0**. It reports `2r/4w` now, and that same mutation exits 1 and
names all four write sites.

What makes this entry worth reading is that **the gap was documented before it
was fixed**. PR #7530's review pinned both shapes as deliberate READs, in a test
whose comment said in as many words that widening the rule would turn the pin
red and that the header must be updated with it. When #7537 landed, exactly
those two pins went red and nothing else did — running the old suite against the
new classifier failed 2 of 125, both of them the pins. That is what a documented
limit is for: a written-down gap costs one comment and turns the next change
into a *conversation with the pin*, where an undocumented one is rediscovered by
someone auditing a green run.

**Guard against it:** when you add a rule because a class of subject was
otherwise unfailable, the question is not "does the rule work" but **"which
members of that class does it reach, and what do the rest look like?"** Count
them. `const` bindings with zero writes was a number the lint could already
print; nobody had asked it. And when the answer is "not all of them", pin the
remainder as an explicit decision — a limit that cannot change silently is worth
more than a limit that does not exist.

**Addendum — it had a third spelling, and the pin caught that too (`#7553`,
`#7554`).** The fix above taught `isWriteAt` to step over one accessor before
testing the ASSIGNMENT operator. The INCREMENT test one line above it kept
reading the unstepped text, so `o[k] = v`, `o[k] += 1` and `++o[k]` were writes
while **`o[k]++` was a read** — one mutation, three spellings, two
classifications, and a `const counts: Record<string, number> = {}` mutated only
by `counts[k]++` still unfailable by construction. Same rule, same function, one
operator over. PR #7548's review pinned all four spellings at their then-current
answers with the same instruction attached, and #7553 turned exactly the two
`read` rows red and nothing else — the arrangement paying off a **second** time,
which is the argument for it. The fix routes both operators through one shared
scan (`accessorStepEnd`) rather than a second bracket matcher, because a second
hand-written copy is how the first gap survived being fixed.

`#7554` is the neighbouring cause on the same rule: statement position was
decided by `STATEMENT_BOUNDARY`, five hardcoded characters, and #7537 had just
routed a **second** predicate through it — a hardcoded set beside a growing set
of *callers*. It lost in-place writes in a semicolon-free module (the character
before the statement is whatever ended the previous expression) and after a
braceless `else`. What made that one tractable was **counting before choosing**:
a sweep of every in-place-shaped reference on both rosters returned exactly two
misses, and each candidate widening was measured against all ~950 classified
references before adoption. The keyword arm (`else`, `do`) is closed by the
grammar and moved one reference; the ASI arm restricted to characters that close
a primary expression moved one; the identifier arm — which would need a
hand-maintained list of TypeScript's operator keywords, cause #1 in this
document — moved **zero**, and was refused and pinned as a residual on that
evidence rather than on taste.

**And the review of that PR found the failure mode this document is about,
three times, in the fix itself.** All three ran in the ACCUSE direction — a read
filed as a write — which every other gap in the lint is careful not to do. (a)
`INCDEC_AHEAD` used `\s*`, so it crossed a line terminator; but postfix `++` is
a RESTRICTED PRODUCTION, so `o[k]` ⏎ `++x` is two statements and `o[k]` is a
read. The new rule filed it as a write, and the defect was in the *shared*
regex, so the bare form `n` ⏎ `++x` had been wrong since long before. (b) The
`.`-lookback that keeps `o.else` a member access only fired when the dot sat
hard against the keyword, so `o.` ⏎ `else` *and* `o. else` invented a statement
boundary. (c) Sharpest, and the reason it belongs here rather than in a
changelog: adding `/` to the ASI character set **passed all 243 tests and moved
zero references in the tree**, while flipping `const a = b /` ⏎ `m.delete(k)` —
one division spanning two lines — from read to write. A guard's *exclusions*
were unpinned, so the set was free to grow into a false accusation with nothing
to stop it. The lesson generalises past this lint: when a rule is a membership
test, pin **what is not in the set**, because that is the half a passing suite
cannot see. The set is now pinned in both directions, 26 characters, and a
`SURVIVED` mutant on the line-terminator class was answered by naming its
differing inputs (`\r`, `\u2028`, `\u2029`) rather than by deleting the
refinement.

### 25. The safety gate whose precondition nothing could ever set — `#7552`

`EnvironmentPanel.tsx` gates the Destroy button on the environment's session
count:

```tsx
disabled={env.sessions.length > 0}
title={env.sessions.length > 0 ? 'Disconnect all sessions first' : 'Destroy environment'}
```

`EnvironmentInfo.sessions` was declared, persisted to `environments.json`, typed
on the dashboard's `ConnectionState`, and carried by the `environment_list` wire
schema. **Nothing ever put a session id in it.** Its only writers —
`EnvironmentManager.addSession` / `removeSession` — had zero production callers;
the only call sites in the repo were five lines of
`tests/environment-manager.test.js`. Everything else only emptied it (`sessions: []`
at creation, `env.sessions = []` on boot reconnect).

So the tag was `[]` at runtime, permanently, `length > 0` was false forever, and
the button was **always enabled** — including for an environment with live
sessions running inside it, which is the one case the guard was written for.
Mode: *never ran*, and this is its UI form: no job, no exit code, nothing to be
green. The signal was a control that renders exactly as it would if it had
checked and approved.

Two things made it survive. The guard's own display was consistent with itself —
"0 connected" beside an enabled Destroy button is not a contradiction, it is
what an empty environment looks like — so no screenshot, no manual pass and no
component test could distinguish "no sessions" from "cannot see sessions".
And every test that existed *did* exercise the writers: `addSession` had five
callers, all in a test file, which is enough to make a coverage report and a
`grep` for the method both look healthy. The evidence that the surface was alive
was manufactured by the tests written to check it.

It was caught, finally, by a classification: #7551 needed to say why the
dashboard does not prune `environments` on session death, and its first draft
invented a mechanism to justify it ("`environment_list` replaces the whole array
on every change, so the server is the authority"). Review checked the four emit
sites, found none on session lifecycle, and the search for the real reason found
the dead surface instead. A field nothing writes is an invitation to reason
about behaviour that does not exist, and someone eventually accepts it.

The fix (#7552) wired the association that already existed — `create_session`
takes an `environmentId` and resolves the container from it — attaching in
`SessionManager.createSession` and detaching in `_cleanupSessionMaps`, the sole
funnel out of `_sessions`, plus `destroyAll()`. The detach placement is the
load-bearing choice: hanging it off the `session_destroyed` EVENT would have
missed `_handleAsyncStartFailure`'s restore-rebind branch, which leaves
`_sessions` and emits `session_restore_failed` instead — and a missed detach is
the *inverse* false safety, a stale id that disables the button forever and
makes the environment undestroyable.

**Guard against it:** a guard that reads a *field* is only as alive as the
field's writers, and "the type declares it" is not a writer. When a check's
precondition comes from data rather than from a computation, ask who writes that
data **in production** — and answer it with a grep that excludes tests, because
a surface kept alive exclusively by its own tests presents every symptom of a
healthy one. The generalisation of "prove the guard can fail" for data-driven
guards is: **construct the state the guard is supposed to refuse, through the
production path, and watch it refuse.** Setting the field by hand in a test
proves the branch, not the wiring.

### 26. The guard that only one client honoured — `#7562`, `#7561`

Entry 25 fixed the Destroy button's precondition. It did not make the button
**authoritative**, and nobody checked whether anything else needed to be.

`EnvironmentPanel.tsx` disables Destroy while `env.sessions.length > 0`. Two
server paths never looked at `env.sessions` at all:

- `destroy_environment` (`feature-handlers.js`) → `EnvironmentManager.destroy()`
- `containers_action` with `action: 'destroy'` (`control-room-handlers.js`) →
  the same call, from a surface with **no UI guard whatsoever**

and `EnvironmentManager.destroy()` — the one function both reach — had no check
either. So a stale dashboard tab, a script, or the Control Room's own container
controls could `docker rm -f` the container while sessions were running inside
it. (Not the mobile app — it can create a session INTO an environment but ships
no destroy surface. Naming it here in an earlier draft was the ordinary way an
impact claim inflates: the reachable-caller set is the one you can enumerate in
the code, not the one that sounds complete.) Measured on both paths before the fix: `environment_destroyed`
/ `containers_action_ack status:"destroyed"` returned, `docker rm -f` ran, and the
session was **still live in `SessionManager._sessions`** — pointing at a container
that no longer existed.

Mode: *ran, and was bypassable*. This is the sibling of entry 25 rather than a
repeat of it. There the guard's precondition could never be true; here the
precondition works perfectly and the guard is simply not in the path of most
callers. Both present identically from the dashboard — the operator clicks
Destroy, it is disabled, the system looks protected — because the only client
that can *observe* the guard is the only client that *has* it.

What kept it invisible is that the fix for entry 25 made the button start working,
which is exactly the moment a reviewer stops asking about it. A guard that just
went from broken to functional reads as *finished*.

The related persistence half (`#7561`) is why the obvious lenient answer was not
available. "Detach the sessions and let them keep running" sounds like the kind
answer until you check what a detached `docker-sdk` session does: it was
persisting `provider: 'docker-sdk'` with **no** `containerId`, and
`DockerSdkSession`'s constructor reads that absence as `_containerOwned = true`,
so `start()` launches a **fresh default `node:22-slim` container** with the cwd
bind-mounted. Not an escape to the host — an escape from the containment the
operator *configured* (image, devcontainer mounts, sanitised env, resource
limits), reported as a successful restore. So the lenient branch was not lenient,
it was a silent downgrade, and the policy had to be refuse-or-destroy-cleanly.

**Guard against it:** when you fix a guard, ask **who else can perform the
guarded action** before you call it done — enumerate the callers of the operation,
not the renderers of the control. A client-side check is an affordance; only the
server-side one is a guard. And put the server-side check at the **single**
chokepoint every caller reaches (here `EnvironmentManager.destroy()`), because a
copy per handler is how `containers_action` came to have none: the second caller
was written after the first check and never learned about it. When an operator
override is genuinely wanted, make it an **explicit field on the request**
(`force: true`, strictly boolean) rather than a property of which handler the
client happened to reach — an override you cannot see in the message is one you
cannot audit, and one nobody can tell apart from a client that did not know.

### 27. The anti-orphan guard that was satisfiable by a step doing nothing — `#7637`

Entry 23 closed with "put the answer in a guard that reads the directory". The
guard that advice produced —
`packages/server/tests/ci-scripts-tests-registration.test.js` — read the
directory correctly and then answered the wrong question, in the direction that
lets a real orphan through. Both halves were found by review, and both were live
on `main`.

**It read the whole step, not the command.** The rule matched
`code(step).join('\n')` — every line of a step block bar whole-line comments.
Two shapes were reproduced against the real tree, each with the
release-critical suite running in no step, each **green**:

```yaml
- name: Run scripts/__tests__/merge-updater-feeds.test.sh tests
  run: true

- name: Run merge-updater-feeds.mjs tests
  run: true  # was bash scripts/__tests__/merge-updater-feeds.test.sh
```

The second is the realistic regression — a `run:` is deleted and the
explanatory comment above or beside it survives — and `code()` structurally
cannot catch it, because it drops whole-line comments and that is a trailing
one. The file's own header said "a guard that reads prose as configuration is
satisfiable by prose" *while being satisfiable by prose*: entry 13's shape,
produced inside the catalogue that names it. The reader module already exported
`stepRun()`, which reproduces YAML's reading of `run:` and yields only the shell
the runner is handed. The guard imported `code` and not `stepRun` and nothing
noticed for the guard's whole life.

**It looked in one directory.** The subject was `readdir` over
`scripts/__tests__/`, so `packages/desktop/scripts/verify-entitlements.test.sh`
— wired only by name, one directory over — was exactly as exposed as
merge-updater-feeds had been. Widening it needed a measurement, not a
generalisation: the tempting rule "a `*.test.mjs` under `packages/` is
discovered by that package's runner" is true of **two** of this repo's eight
packages. Six cannot discover a `.mjs` at all — server and claude-hooks pin
`./tests/**/*.test.js`, protocol pins `tests/*.test.js`, dashboard's vitest
include is `src/**/*.test.{ts,tsx}`, app's jest default `testMatch` is
`[jt]s?(x)`, and desktop has no `test` script whatsoever. Stated as a property
of "packages" rather than of two specific runner configurations, that exclusion
would have been a **hole with a template already sitting in the tree**, beside
nine server lint scripts whose golden suites are the obvious thing to mirror.

The one real exemption is now a table carrying the package's exact `test`
script and the measurement behind it, asserted EQUAL to reality on every run —
so the runner changing is what the guard *reports*, not what it hides — plus a
check that the exempt tree still contains a file the exemption does work for. A
roster line no evidence can contradict is how a roster rots.

**Guard against it:** a guard is two questions, and passing the first is not
passing the second. *What set does it quantify over* — and does that set come
from the filesystem or from a roster? *What text does it match against* — and is
that text the thing that EXECUTES, or merely the thing that mentions? The second
question is the one this repo keeps getting wrong, because the mentioning text
always contains the executing text, so the weaker match is green on every
correct tree and diverges only on the broken one. Ten single-line mutants,
applied one at a time with `cp` restore, are what established that the new rule
is load-bearing; one of them — unbounding the interpreter alternation so `sh`
matches inside `refresh` — **survived** the first pass and cost one more case.
The mutant that survives is the assertion you did not write.
