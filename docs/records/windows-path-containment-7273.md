# Windows path-containment measurement — #7273

Before/after for the containment fix. Companion to
`docs/records/windows-test-coverage-7270.md`, which established the exemption
manifest this narrows.

## Method

Each file run **in isolation**, with the flags the CI Windows job uses:

```
node --import ./tests/_setup.mjs --experimental-test-module-mocks --test <one file>
```

| | |
|---|---|
| date | 2026-08-20 |
| host | Windows 11 (10.0.26100), i9-9900K — the same physical box as the `chroxy-win` runner |
| node | 22.23.1 (the runner tool-cache build, matching `setup-node`'s `node-version: 22`) |
| base commit | `99f309e04` |
| files measured | the 15 rows tagged `issue: 7273` in `WINDOWS_EXEMPT` |

The measurement clone (`A:\measure\chroxy`) was verified byte-identical to
`99f309e04` for all 15 test files, all of `packages/server/src`, and
`tests/_setup.mjs` before the first run.

## Result

| | before | after |
|---|---|---|
| failing assertions | **63** | **12** |
| files fully green | 0 / 15 | **9 / 15** |

| file | before | after | disposition |
|---|---|---|---|
| `tests/append-memory.test.js` | 5 / 9 | **0** | un-exempted |
| `tests/claude-tui-attachments.test.js` | 2 / 19 | **0** | un-exempted |
| `tests/conversation-scope.test.js` | 1 / 8 | **0** | un-exempted |
| `tests/git-stage-commit.test.js` | 2 / 9 | **0** | un-exempted |
| `tests/handler-utils.test.js` | 5 / 142 | **0** / 144 | un-exempted |
| `tests/handlers/conversation-handlers.test.js` | 3 / 38 | **0** | un-exempted |
| `tests/security/path-traversal.test.js` | 1 / 14 | **0** | un-exempted |
| `tests/ws-file-ops-common.test.js` | 4 / 8 | **0** | un-exempted |
| `tests/ws-file-ops-git-paths.test.js` | 2 / 16 | **0** | un-exempted |
| `tests/ws-server-file-ops.test.js` | 18 / 53 | 1 | stays exempt → #7285 |
| `tests/list-files.test.js` | 4 / 18 | 4 | stays exempt → #7282 |
| `tests/memory-read.test.js` | 4 / 18 | 3 | stays exempt → #7283 |
| `tests/write-file.test.js` | 6 / 15 | 2 | stays exempt → #7284 |
| `tests/ws-file-ops-error-paths.test.js` | 5 / 12 | 1 | stays exempt → #7284 |
| `tests/handlers/checkpoint-handlers.test.js` | 1 / 37 | 1 | stays exempt → #7285 |

Windows run set: **481 → 491 files**. Exempt: 75 → 66 rows (11.8%, ceiling 20%).

## The 12 that remain, and why they are separate issues

Each is a distinct root cause that the containment failure was masking — none is
a containment bug, and all 12 were **unreachable** before the fix because the
check rejected every path before these code paths could run.

| cause | files | issue |
|---|---|---|
| `listFiles` emits backslash-separated relative paths on the wire | list-files (4) | #7282 |
| `encodeProjectPath` leaves backslashes + drive letter in the projects-dir key | memory-read (3) | #7283 |
| `open(O_WRONLY\|O_TRUNC)` fails EINVAL; ENOTDIR maps to the wrong error | write-file (2), ws-file-ops-error-paths (1) | #7284 |
| fixture premises: `tmpdir()` is inside `homedir()`; `core.autocrlf` | ws-server-file-ops (1), checkpoint-handlers (1) | #7285 |

## Windows facts established by direct probe

Measured on the runner box, not inferred:

```
homedir : C:\Users\chris
tmpdir  : C:\Users\chris\AppData\Local\Temp     <- tmpdir IS INSIDE homedir
O_NOFOLLOW : undefined                          <- the symlink guard silently no-ops (#7280)
open(existing, O_WRONLY|O_NOFOLLOW|O_TRUNC): EINVAL
open(existing, O_WRONLY|O_TRUNC)          : EINVAL   <- not an O_NOFOLLOW artifact
symlinkSync(dir) : OK                           <- symlink privilege is present on this host
```

`tmpdir` being inside `homedir` is the one worth remembering: it means every
fixture that builds an "outside home" path from `os.tmpdir()` is asserting a
true conclusion from a false premise on Windows.

## What the fix was

One root-aware predicate, `packages/server/src/utils/path-containment.js`,
routing **fifteen** hand-rolled call sites through a single implementation. They
used three spellings — `root + '/'`, `root + sep`, and `relative()` +
`startsWith('..')` — and all three are wrong; see
`docs/false-safety-guards.md` entry 11 for why, including why `root + sep` (the
one-character "obvious" fix, already present in two of the six copies) is also
wrong on both platforms.

The `relative()` spelling additionally failed **open** on Windows — across
differing roots `path.win32.relative()` returns the target verbatim, so a second
drive letter, a UNC share or the `\\?\` device namespace all read as "inside the
project". That seam is silent: no test failed for it, and it is not among the 15
files above. It is closed and covered by `tests/path-containment.test.js` and
new assertions in `tests/handler-utils.test.js`.

## Scope caveat

This converted the ws-file-ops, `file_ref` attachment, conversation-scope and IDE
surfaces. Hand-rolled copies survive in `docker-byok-session.js` (confirmed
broken on a Windows host), `devcontainer-config.js`, `pages-store.js`,
`permission-{floor,manager}.js` and `@chroxy/protocol`, and there is no lint
preventing a sixteenth. Tracked in #7287, with the evidence for each.
