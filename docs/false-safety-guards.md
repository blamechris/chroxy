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
throws from both `tests/_setup.mjs` files, so the run dies before a single test
executes. Nothing needed the flag any more: the leaked handles it papered over
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

**Guard against it:** a green that comes from the tooling is still a green you
have to earn. When a run reports a count, pin the count — and when a comment
tells you which flags a command carries, check the command. Both halves here
were readable in ten seconds by anyone who thought to look.
