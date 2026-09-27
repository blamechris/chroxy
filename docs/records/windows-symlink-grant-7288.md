# Windows symlink-grant re-measurement — #7288

Before/after for the three `symlink-create` rows in `WINDOWS_EXEMPT`, once the
`chroxy-win-01` runner's service SID held `SeCreateSymbolicLinkPrivilege`
(applied 2026-09-27; the host record is in `blamechris/github-runners`).
Companion to `docs/records/windows-test-coverage-7270.md` and
`docs/records/windows-path-containment-7273.md`.

## Method

Each file run **in isolation**, with the flags the CI Windows job uses:

```
node --import ./tests/_setup.mjs --experimental-test-module-mocks --test <one file>
```

| | |
|---|---|
| date | 2026-09-27 |
| host | the physical box that runs `chroxy-win-01` |
| node | 22.23.1 (the runner tool-cache build) |
| base commit | `9126d5aa1`, a fresh worktree with its own `npm ci` |
| account | `chris` over SSH. It holds the privilege, as the runner's service SID now does, so for symlink creation the two accounts agree. The authoritative run is this change's `Server Windows Tests`, which executes as the runner account. |

## Result

Once the grant was in place, no failure was about *creating* a symlink. All six
were about what happens after the link exists.

| file | before | after | disposition |
|---|---|---|---|
| `tests/file-ref-attachments.test.js` | 1 / 16 fail | 16 / 16 pass | un-exempted |
| `tests/permission-manager-floor-symlink-evasion.test.js` | 2 / 21 fail | 21 pass, 2 skip | un-exempted |
| `tests/ws-file-ops-raw-path-symlink-evasion.test.js` | 3 / 13 fail | 13 pass, 2 skip | un-exempted |

Windows run set: 591 → **594** files. Exempt: 66 → **63** rows (9.6%, ceiling 20%).

The three per-test skips that the rollout listed — in `append-memory`,
`ws-file-ops-common` and `security/path-traversal` — needed no change. They are
`SKIP_NO_SYMLINK` capability probes (`tests/helpers/symlink-support.js`), so the
grant turned them on by itself. On the same host all three files pass with no
symlink skip (append-memory's one remaining skip is the unrelated FIFO test).

## The three causes

**1. A dangling link: `file-ref-attachments`.** The test linked to `/etc/hosts`.
On Windows that is a link to `<drive>:\etc\hosts`, which does not exist, so the
resolver answered "file not found" and never reached the containment check the
test is about. It also sat behind `try { symlinkSync(…) } catch { return }`,
which reported a PASS on any host that could not create the link. The test now
links to a real file in a sibling temp directory and takes
`{ skip: SKIP_NO_SYMLINK }`.

**2. A separator: `ws-file-ops-raw-path-symlink-evasion`, two assertions.** Both
were `startsWith(dir + '/')` against a `path.resolve` result, which uses `\` on
Windows. This is the same shape #7995 fixed in the glob-parity rows; both now
use `path.sep`.

**3. The attack does not exist on Windows: the raw-write premise, four
assertions across both evasion suites.** The #6921 / #6923 PoCs *prove* the
attack by writing through `<cwd>/link/../x` and checking that the write landed
beside the link's **target**. That is open(2) order, where the kernel follows
`link` first and then applies `..`. Node on Windows never gets that far. Its fs
layer calls `path.toNamespacedPath()`, which on win32 is `path.resolve()` plus a
`\\?\` prefix, so the `..` is collapsed as text before any syscall:

| | Windows (node 22.23.1) | macOS (node 22) |
|---|---|---|
| `toNamespacedPath('<root>/link/../target.txt')` | `\\?\<root>\target.txt` | unchanged |
| `real/target.txt` after the raw write | `ORIGINAL` | `PWNED` |
| `<root>/target.txt` created | yes | no |

Each PoC was split in two. The **premise** test (the raw write) takes
`{ skip: SKIP_WIN32_LEXICAL_DOTDOT }`, a platform check rather than a probe: the
behaviour belongs to Node's win32 path layer on every account, and a probe could
only add a way to skip the proof silently on the Linux job where it matters. The
**flag** test (the floor or validator rejects the path) runs everywhere.

Both guards stay correct on Windows. The permission floor scans the lexical
target before it walks the path component by component, so the target Windows
actually writes to is always one of the two it checks. The BYOK executor writes
to the walker's validated `realPath` and never to the raw path, so the two
platforms cannot disagree about where the write lands. On Windows the walker
still reports the POSIX destination and flags it. That is the conservative
direction: at worst an extra prompt or rejection, never a missed escape.

## Proof the split tests still bite

Mutations on macOS, restored with `cp` from a backup:

| mutation | result |
|---|---|
| floor: component walk → `path.resolve` | 8 red, including both PoC flag tests |
| BYOK: component walk → `path.resolve` | 6 red, including both PoC flag tests |
| file-ref: drop the realpath containment check | the escape test red |
| `SKIP_WIN32_LEXICAL_DOTDOT` forced on | the 4 premise tests reported `# SKIP`, none silently absent |
| `SKIP_NO_SYMLINK` forced on | skills-loader and file-ref pass, reporting `# SKIP` |

## Also in this change

The five silent `catch { return }` symlink sites in `tests/skills-loader.test.js`
now use `SKIP_NO_SYMLINK`. Their comment cited the file-ref line above as
precedent for the pattern.
