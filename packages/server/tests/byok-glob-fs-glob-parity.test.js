// #7910 review round 3 — a PERMANENT differential parity harness for the
// BYOK Glob tool's self-walked matcher (`walkGlob`/`runGlob` in
// `byok-tool-executor.js`).
//
// WHY THIS EXISTS: three consecutive review rounds of #7910 each found a new
// `fs.glob` parity regression via an AD-HOC scratch harness (a fixture tree
// and pattern table built by hand in /tmp, discarded after the round). Each
// round's regression would have been caught immediately had the previous
// round's harness stayed in the tree. This commits one, for good.
//
// METHOD: build a fixture tree once (nested dirs, dotfiles/dot-dirs, an
// in-workspace symlinked dir, a self-referential symlink, symlinks escaping
// the root, a file symlink, name collisions, unicode/space/bracket/brace
// names, an empty dir), then for every pattern in a >=120-pattern table,
// assert the REAL tool (`executeBuiltinTool({toolName:'Glob', ...})`, the
// same dispatch a live session uses) returns exactly the same relative paths
// as Node's own `fs.promises.glob(pattern, { cwd })`, independently filtered
// through the SAME confinement check the tool applies
// (`validateRawPathWithinCwd`) and sorted the same way (`Array.prototype.sort`
// on the relative-path strings — what `runGlob` itself does to `kept`).
//
// WHAT IS DELIBERATELY *NOT* IN THIS TABLE (each has its own dedicated,
// already-existing coverage elsewhere in this file, and asserting parity
// against raw `fs.glob` for these would assert the OPPOSITE of what #7910
// intentionally fixed):
//   - patterns that deliberately mismatch the real file's case ("SRC/*.ts"):
//     `fs.glob` is case-INSENSITIVE on macOS/Windows by its own internal
//     candidate generation; `walkGlob` is case-sensitive BY CONSTRUCTION
//     everywhere (#7355/#7899) — see the case-sensitivity tests above.
//   - a literal, non-wildcarded leading directory segment that resolves
//     OUTSIDE the workspace via a symlink (`outside-link/**`): `runGlob`'s
//     `literalDirPrefix` check (#7341) deliberately ERRORS for these instead
//     of silently walking through them, which `fs.glob` has no concept of —
//     see the confinement/"never returns a path outside the workspace"
//     tests above. Patterns that reach the same symlink only through a
//     WILDCARD (`*-link/*`, `**/outside*`) are kept below: both pipelines
//     silently discover-and-withhold there, so they DO agree.
//
// SKIP-LIST: the task that commissioned this harness named exactly one
// pre-known shape as exempt from strict equality, #7912. Running the full
// >=120-pattern table against that branch head surfaced THREE more,
// previously-undiscovered `fs.glob` parity gaps beyond it — the whole reason
// this harness exists is to catch exactly this, and it did. Each was filed
// as its own scoped, OPEN follow-up issue (matching #7912's own precedent)
// rather than patched in that same PR, because every one of them lives
// inside `walkGlob`'s symlink-descend/cycle logic or its pattern compiler —
// the exact surface three prior #7910 review rounds spent hardening against
// real, measured DoS and disclosure bugs. Every one of them was (and, for
// the one still open, still is) a pure UNDER-match (walkGlob is always a
// SUBSET of fs.glob's confinement-filtered result below, never a superset —
// a superset would be a real regression, not a filed gap), so there was no
// confinement or DoS exposure from any of them being open.
//
// CLOSED since, each with its own adversarial-round-equivalent (a fix
// derived from reading Node's actual `internal/fs/glob.js` GLOBSTAR
// algorithm directly, not guessed from probes, for #7912; a change proven
// not to weaken the round-2 DoS guard for #7916's partial fix; #7917 only
// WIDENS what already-passing patterns keep passing; #7918 was meant to, but
// its first expander also stripped a comma-less `{...}` that spans `/` and
// walked an absolute alternative as a workspace path — both caught in review
// and pinned by rows below, `{curly/dup}` and `{,x}/src/...`) — their
// patterns are in the main table above now:
//   - #7912: `**` refused to absorb ANY dot-prefixed entry while crossing
//     toward a deeper match. FIXED: `**` now absorbs a dot-named entry
//     exactly when the pattern segment immediately after it (skipping
//     further `**`s) explicitly matches that entry's name — see
//     `walkGlob`'s `nextNonGlobstar` doc.
//   - #7917: a directory-only (`pattern/`) match against a symlink checked
//     `dirent.isDirectory()` (always false for a symlink) even when the
//     entry was named by a fully determinate/literal segment, where
//     `fs.glob` applies no type check at all in that case. FIXED: reuses
//     the existing `detHandoff[m]` signal.
//   - #7918: a brace alternative could not span a path separator
//     (`{dup,nested/dup}`) — `walkGlob`'s pattern compiler split on `/`
//     BEFORE parsing braces, so a slash-crossing alternative had no
//     representation in the compiled matcher at all, a genuine CAPABILITY
//     LOSS versus pre-#7910 `main` (which called `fs.glob` directly and got
//     its native, slash-spanning brace expansion for free). FIXED: braces
//     are now expanded globally, across the whole raw pattern, before any
//     `/`-split — see `expandBraces`'s doc — ONLY when a brace group
//     actually spans a `/` (`hasSlashSpanningBrace`), so the far more common
//     non-spanning brace keeps the existing single-walk, per-segment `alt`
//     token path unchanged.
//
// STILL OPEN, PARTIALLY FIXED:
//   - #7916: `**` does not follow a symlinked directory reached via a
//     non-determinate trailing segment (`**/*` misses `src-link/index.ts`
//     even though `src-link -> src` is a real, in-workspace directory), and
//     the `visitedDirs` ancestor-cycle guard (added in round 2 for a real,
//     measured DoS) also refused a re-entry through a self-referencing
//     symlink that `fs.glob` allows. FIXED for the sub-case that is provably
//     safe without a new DoS-bounding mechanism: a fully `**`-free pattern
//     (`sub/selfloop/file.txt`, all-literal, no wildcards at all) can never
//     recurse deeper than its own segment count regardless of symlink
//     structure, so `visitedDirs`'s refusal is now skipped for such patterns
//     entirely (`openVerifiedDirForDescend`'s `enforceCycleGuard`). NOT
//     fixed: a `**` immediately followed by more pattern still refuses to
//     cross a symlink reached non-determinately, and a `**`-terminated
//     re-entry (`sub/selfloop/selfloop/**`) still refuses too — both need
//     the "bounded implicit-crossing budget" the issue itself calls out as
//     its own adversarial-review-worthy redesign, which this PR does not
//     attempt.
//
// A SECOND kind of known-difference bucket, added for #7899: `fs.glob`
// itself has a candidate-generation bug for a negated bracket class
// (`[^X]`, `[!x]`) that only manifests when it nocase-folds (a REAL runtime
// probe, `FS_GLOB_NOCASE`, near the top of this file — never a
// `process.platform` guess). `walkGlob` is case-sensitive by construction
// and does not share the bug, so on a folding host it returns a real file
// `fs.glob` wrongly excludes — the OPPOSITE direction from #7916 above (an
// OVER-match, never an under-match, and never a confinement concern: a real
// in-workspace file `fs.glob`'s own bug hides is strictly more correct to
// return, not a regression). See `KNOWN_DIFFERENCE_7899` below.
//
// A THIRD, added in #7951's review: brace-expansion shapes where `fs.glob`'s
// `brace-expansion` and this tool's expander still differ in BOTH
// directions. Those rows assert their exact missing and extra lists rather
// than a shape predicate. See `KNOWN_DIFFERENCE_7951` below.
//
// Each bucketed pattern below is asserted to diverge in EXACTLY its
// documented shape and direction (under-match OR over-match, per the
// bucket), not just "somehow differ" — a bare skip would let an
// unrelated regression hide behind one of these issue numbers.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { glob as fsGlob } from 'node:fs/promises'
import { mkdtempSync, symlinkSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { executeBuiltinTool } from '../src/byok-tool-executor.js'
import { validateRawPathWithinCwd } from '../src/ws-file-ops/common.js'

// This fixture leans heavily on symlinks (in-workspace, self-referential,
// escaping the workspace). `symlinkSync` needs a privilege the Windows CI
// runner lacks by default (#7288) — rather than a hardcoded
// `process.platform === 'win32'` check (which would also skip on a Windows
// host that DOES have the privilege, e.g. Developer Mode or an admin
// runner, and would NOT skip on some other, unanticipated platform that
// lacks it), this probes the actual capability once, synchronously, before
// any test registers, and skips the whole suite with the real error if it
// fails. Not a WINDOWS_EXEMPT-style static list — a real attempt and a real
// catch (docs/false-safety-guards.md: "cannot check" must never read as
// "nothing to check").
const SYMLINK_SKIP_REASON = (() => {
  let probeDir
  try {
    probeDir = mkdtempSync(join(tmpdir(), 'chroxy-glob-parity-symlink-probe-'))
    symlinkSync(probeDir, join(probeDir, 'self-probe-link'), 'dir')
    return null
  } catch (err) {
    return `symlink creation unavailable on this host (${err?.code || err?.message}) — #7288`
  } finally {
    if (probeDir) rmSync(probeDir, { recursive: true, force: true })
  }
})()

// #7899 — does `fs.glob` case-fold on THIS host? Measured directly (a
// REAL probe, not a `process.platform === 'darwin'` guess — the same
// "cannot check must never read as nothing to check" discipline as the
// symlink probe just above): create a mixed-case file and glob it with an
// all-lowercase pattern. `fs.glob` hard-codes `nocase: isWindows ||
// isMacOS` internally, which usually tracks `process.platform`, but a
// probe is what actually PROVES it on the machine the suite is running on
// (a case-sensitive APFS volume, an unanticipated future platform, ...).
// Negated-bracket-class rows below are registered into the strict
// main table when this is `false` (fs.glob behaves like an ordinary
// case-sensitive glob there, and already agrees with `walkGlob`) or into
// the `KNOWN_DIFFERENCE_7899` bucket when it's `true` (fs.glob's
// candidate-generation bug for a negated class only manifests under its
// own nocase folding — see that bucket's own comment).
//
// The probe pattern carries a `?` on purpose (#7951 review): a fully
// literal pattern can be answered by a plain `lstat`, which measures the
// FILESYSTEM's case sensitivity (a case-insensitive Linux directory would
// read `true` here while `fs.glob` does no folding at all), whereas a
// wildcard forces `fs.glob` to read the directory and run its own matcher —
// the thing the #7899 bucket actually depends on.
const FS_GLOB_NOCASE = (() => {
  let probeDir
  try {
    probeDir = mkdtempSync(join(tmpdir(), 'chroxy-glob-parity-nocase-probe-'))
    writeFileSync(join(probeDir, 'NoCaseProbe.tmp'), 'x')
    return globSync('nocaseprob?.tmp', { cwd: probeDir }).length > 0
  } finally {
    if (probeDir) rmSync(probeDir, { recursive: true, force: true })
  }
})()

let ROOT
let OUTSIDE

async function mk(p) { await mkdir(p, { recursive: true }) }
async function file(p, content = 'x') { await writeFile(p, content) }

// Mirrors the shape of the round-3 reviewer's own scratch fixture
// (fixture-root/, built by build-fixture.mjs) — kept close to it
// deliberately, so this permanent test exercises the same hazards that
// found real regressions across three rounds, not a re-imagined subset.
async function buildFixture() {
  ROOT = await mkdtemp(join(tmpdir(), 'chroxy-glob-parity-root-'))
  OUTSIDE = await mkdtemp(join(tmpdir(), 'chroxy-glob-parity-outside-'))
  await file(join(OUTSIDE, 'secret-outside.txt'), 'outside')

  // nested source tree
  await mk(join(ROOT, 'src', 'utils', 'deep'))
  await file(join(ROOT, 'src', 'index.ts'))
  await file(join(ROOT, 'src', 'a.js'))
  await file(join(ROOT, 'src', 'utils', 'helper.ts'))
  await file(join(ROOT, 'src', 'utils', 'deep', 'deeper.ts'))

  // in-workspace symlinked dir
  await symlink('src', join(ROOT, 'src-link'), 'dir')

  // dotfiles + dot-dirs, including a dotfile nested inside a dot-dir
  await file(join(ROOT, '.env'), 'ENV=1')
  await file(join(ROOT, '.env.local'), 'ENV=2')
  await file(join(ROOT, '.gitignore'), 'node_modules\n')
  await mk(join(ROOT, '.hidden'))
  await file(join(ROOT, '.hidden', '.deepdot'), 'deepdot')
  await file(join(ROOT, '.hidden', 'secret.txt'), 'secret')
  await mk(join(ROOT, '.hidden', 'inner'))
  await file(join(ROOT, '.hidden', 'inner', 'x.ts'))
  await file(join(ROOT, 'a.env'), 'A_ENV')

  // self-loop symlink: sub/selfloop -> . (points back at "sub" itself)
  await mk(join(ROOT, 'sub', 'deep', 'deep2'))
  await file(join(ROOT, 'sub', 'file.txt'))
  await file(join(ROOT, 'sub', 'deep', 'deep2', 'x.ts'))
  await symlink('.', join(ROOT, 'sub', 'selfloop'), 'dir')

  // symlinks escaping the workspace (dir + file)
  await symlink(OUTSIDE, join(ROOT, 'outside-link'), 'dir')
  await symlink(join(OUTSIDE, 'secret-outside.txt'), join(ROOT, 'outside-file-link'), 'file')

  // files vs dirs sharing a basename
  await mk(join(ROOT, 'dup'))
  await file(join(ROOT, 'dup', 'inner.txt'))
  await mk(join(ROOT, 'nested'))
  await file(join(ROOT, 'nested', 'dup'), 'file named dup')
  // #7918 review — a real path spelled like a comma-less brace group that
  // spans a `/` (`{curly/dup}`): fs.glob does not treat `{...}` without a
  // top-level comma as alternation, so the pattern `{curly/dup}` names
  // exactly this path.
  await mk(join(ROOT, '{curly'))
  await file(join(ROOT, '{curly', 'dup}'), 'literal braces')

  // names with spaces / unicode / brackets / braces
  await mk(join(ROOT, 'spaces and unicode'))
  await file(join(ROOT, 'spaces and unicode', 'my file.txt'))
  await file(join(ROOT, 'spaces and unicode', 'unicode-émoji.txt'))
  await mk(join(ROOT, 'brackets'))
  await file(join(ROOT, 'brackets', '[brackets].txt'))
  await file(join(ROOT, 'brackets', '{braces}.txt'))
  await file(join(ROOT, 'brackets', 'plain.txt'))

  // empty dir
  await mk(join(ROOT, 'empty-dir'))

  // a plain file / dir for trailing-** zero-width-close tests
  await file(join(ROOT, 'plainfile.txt'), 'plain')
  await mk(join(ROOT, 'plaindir'))
  await file(join(ROOT, 'plaindir', 'child.txt'))

  // a symlinked FILE (in-workspace) for */* etc symlink-file shapes
  await file(join(ROOT, 'realfile-for-link.txt'), 'real')
  await symlink('realfile-for-link.txt', join(ROOT, 'file-link.txt'), 'file')

  // deep/deep pattern targets
  await mk(join(ROOT, 'a', 'deep', 'b'))
  await file(join(ROOT, 'a', 'deep', 'b', 'y.ts'))
  await mk(join(ROOT, 'x', 'y', 'deep'))
  await file(join(ROOT, 'x', 'y', 'deep', 'z.ts'))

  // #7899 — negated bracket class, one real file per case so the two never
  // collide on a case-insensitive filesystem (this Mac): `negcase-lo/xyz.ts`
  // (lowercase only) and `negcase-up/Xyz.ts` (uppercase only), in SEPARATE
  // directories so the choice needs no runtime FS-case-sensitivity probe of
  // its own — two different directory names can never collide regardless of
  // how the host folds case.
  await mk(join(ROOT, 'negcase-lo'))
  await file(join(ROOT, 'negcase-lo', 'xyz.ts'))
  await mk(join(ROOT, 'negcase-up'))
  await file(join(ROOT, 'negcase-up', 'Xyz.ts'))

  // #7951 — range expansion (`{1..3}`, `{a..c}`, descending, zero-padded,
  // negative, stepped) and comma-less-brace-with-nested-wildcard fixtures.
  await mk(join(ROOT, 'range'))
  for (const n of ['1', '2', '3', '01', '02', '03', 'a', 'b', 'c', '-1', '-2', '0']) {
    await file(join(ROOT, 'range', `${n}.txt`))
  }
  // #7951 review — `range/q{Z..a}q`: the mixed-case letter range steps over
  // the backslash code point, which `brace-expansion` emits as an EMPTY
  // member, so `fs.glob` matches this real `qq`.
  await file(join(ROOT, 'range', 'qq'))

  // #7951 — bracket-in-brace comma splitting: real files named to match
  // fs.glob's OWN measured bracket-oblivious comma split of `{a[,]b,other}`
  // (three alternatives — `a[`, `]b`, `other` — not the two a bracket-aware
  // split would give). Slashes can't appear in a filename, so `/` stands in
  // for the run of ordinary characters split location doesn't depend on.
  await mk(join(ROOT, 'bracecomma'))
  await file(join(ROOT, 'bracecomma', 'p['))
  await file(join(ROOT, 'bracecomma', 'q]r'))
  await file(join(ROOT, 'bracecomma', 's'))
  // #7951 review — the positive control `bracecomma/{a[}]b,s}` lacked: its
  // first alternative `a[}]b` (a class matching a literal `}`) names this.
  await file(join(ROOT, 'bracecomma', 'a}b'))

  // #7951 review — shapes where `fs.glob`'s brace expansion and this tool's
  // still differ (see KNOWN_DIFFERENCE_7951). Every file either side can
  // return for those patterns exists, so each divergence is visible in BOTH
  // directions instead of being hidden by an absent file.
  await mk(join(ROOT, 'bracequirk'))
  for (const n of ['a', 'b', 'b}c', 'a]c}', 'b[]c}', 'a}', '{a},b}', '{x}1', '{x}2', '{x}{1..2}', '1', '2', '3', '{', '}']) {
    await file(join(ROOT, 'bracequirk', n))
  }
}

before(buildFixture, { timeout: 30_000 })
after(async () => {
  await rm(ROOT, { recursive: true, force: true })
  await rm(OUTSIDE, { recursive: true, force: true })
})

/** The real tool dispatch — the same path a live session takes. */
async function toolGlobList(pattern) {
  const result = await executeBuiltinTool({
    toolName: 'Glob',
    input: { pattern },
    cwd: ROOT,
    cwdRealCache: new Map(),
    cwdCacheTtl: 30_000,
  })
  if (result.isError) return { error: result.content }
  if (result.content.startsWith('No matches for')) return { list: [] }
  // The fixture is far below GLOB_MAX_MATCHES/GLOB_COLLECT_CEILING, so no
  // truncation marker is ever expected — a stray one would itself be a
  // divergence worth surfacing rather than silently stripping.
  return { list: result.content.split('\n') }
}

/**
 * Ground truth: Node's own `fs.promises.glob`, independently filtered
 * through the SAME confinement check `runGlob`/`walkGlob` apply
 * (`validateRawPathWithinCwd`) — not a re-implementation of confinement, the
 * actual production function, imported directly. This is deliberately the
 * ONLY transformation applied to `fs.glob`'s raw output: no case-folding
 * correction, no dot-guard correction, no determinate-segment gating — this
 * harness's job is to prove `walkGlob` matches `fs.glob`'s OWN real
 * behavior for the structural/confinement shapes that do not deliberately
 * diverge (see the file header for the shapes that are excluded because
 * they deliberately do).
 */
async function confinedRawGlobList(pattern) {
  const cache = new Map()
  const out = []
  for await (const entry of fsGlob(pattern, { cwd: ROOT, withFileTypes: true })) {
    const rel = relative(ROOT, join(entry.parentPath, entry.name))
    if (rel === '') continue
    let resolved
    try {
      resolved = await validateRawPathWithinCwd(rel, ROOT, cache, 30_000)
    } catch {
      continue // fail closed, same as the tool's own withholding
    }
    if (!resolved.valid) continue
    out.push(rel)
  }
  out.sort()
  return out
}

// >=120 ordinary patterns. Spaces in a REAL name are matched with `?` per
// character rather than a literal space — the tool rejects a literal space
// in the pattern outright (`globPatternEscapeReason`: "whitespace — use **
// or a wildcard"), a restriction `fs.glob` itself has no concept of, so a
// literal-space pattern would test the restriction, not glob parity.
const PATTERNS = [
  // ** / wildcard basics ('**/*' itself is #7916 — see the skip buckets below)
  '**', '**/*.ts', '**/*.js', '*/*', '*/*/*', '*/*/*/*', '*', '*.ts', '*.txt', '*.env',
  '**/deep/**', '**/deep/**/*.ts',

  // in-workspace symlinked dir: src-link -> src
  'src-link/**', 'src-link/*.ts', 'src-link/*', 'src-link/*/*.ts',
  '?rc-link/*', '?rc-link/**', '[s]rc-link/*', '[s]rc-link/**',
  '{src-link,x}/*', '{src-link,zzz}/**', 'src-lin?/*', 'src-link/utils/*.ts',
  'src-link/utils/deep/*.ts', '*-link/*', '*/utils/*.ts',

  // self-loop symlink: sub/selfloop -> . (crossing INTO selfloop via a `**`
  // is still #7916, see the skip buckets below — 'sub/*/file.txt' does not
  // cross it, since 'selfloop' is only reached by the second bare '*',
  // non-determinately). 'sub/selfloop/*' and 'sub/selfloop/file.txt' are
  // fully `**`-free (a literal segment chain re-entering the ancestor 'sub'
  // via 'selfloop'), which #7916's partial fix now allows — see that fix's
  // doc on `openVerifiedDirForDescend`'s `enforceCycleGuard`.
  'sub/**', 'sub/*', 'sub/*/file.txt', 'sub/selfloop/*', 'sub/selfloop/file.txt',

  // symlinks escaping the workspace — reached only via a WILDCARD, so no
  // `literalDirPrefix` early-error (see file header); both pipelines
  // silently discover-and-withhold, so parity holds.
  '?utside-link/*', '*-link/*.txt', 'outside*', '**/outside*', 'outside-file-link', '*-file-link',

  // dot handling, including the #7912 dot-CROSSING shapes ('**/.*',
  // '**/[.]*' — `**` crossing a dot-directory to reach a dot-named entry
  // below it, now fixed; see `walkGlob`'s `nextNonGlobstar` doc)
  '.env*', '.[a-z]*', '.env', '?env', '[.a]env', '[a.]env', '[.]env', '.gitignore',
  '.hidden/*', '.hidden/**', '.hidden/.*', '.hidden/.deepdot', '.hidden/inner/*.ts',
  '.hidden/*.txt', '**/.hidden/**', '**/.hidden/*', '**/.*', '**/[.]*',
  // NOT #7912-shaped despite appearances: fs.glob itself returns nothing for
  // these (a bare-literal or plain-extension trailing segment does not make
  // fs.glob cross .hidden either — including '**/*.ts' above) — verified
  // directly: `**` only crosses a dot-directory when the segment right after
  // it explicitly matches that dot name, which a plain literal tail like
  // '.deepdot' never does for a DIFFERENTLY-named dot directory ('.hidden').
  '**/.deepdot', '**/secret.txt',

  // *.env / trailing dot edge cases
  'a.env', '**/a.env', '?.env',

  // trailing ** after a FILE / DIR (round 2 review, determinate-segment gate)
  'plainfile.txt/**', '[p]lainfile.txt/**', 'pl?infile.txt/**', '*.txt/**',
  'plaindir/**', '[p]laindir/**', 'pl?indir/**', '*dir/**',
  'sub/file.txt/**', 'file-link.txt/**', '[f]ile-link.txt/**',

  // trailing slash / dir-only, including #7917's 'src-link/' (a symlinked
  // directory named by a DETERMINATE segment now follows fs.glob's own
  // "no type check for a literal segment" rule — see `detHandoff[m]`'s use
  // in the directoryOnly result-push gate)
  'src/', 'sub/', 'dup/', '**/', '*/', 'empty-dir/', 'empty-dir/*', 'empty-dir/**', 'plaindir/',
  'src-link/',
  // #7918 review — #7917's rule reaches a symlink to a FILE too: fs.glob's
  // trailing-slash filter applies no type check to a determinately-named
  // entry, so `file-link.txt/` matches the file symlink. (#7917's acceptance
  // offered "follow the target's real type" as one option; parity with
  // fs.glob is what this PR chose, and these rows pin that choice against
  // the oracle rather than leaving it to one comment.)
  'file-link.txt/', '[f]ile-link.txt/', '*-link.txt/',

  // ./x and normalization
  './src/*.ts', './src-link/*.ts', 'src/./*.ts', 'src//*.ts', './*.env', './**',

  // files vs dirs sharing names, including #7918's slash-spanning brace
  // alternative '{dup,nested/dup}' (now expanded globally before /-split —
  // see `expandBraces`'s doc)
  '**/dup', '**/dup/*', 'dup', 'nested/dup', '*/dup', '{dup,dup2}', '{dup,nested/dup}',
  // #7918 review — more slash-spanning shapes, each checked against fs.glob:
  // a comma-less group spanning `/` is LITERAL (`{curly/dup}` is a real path
  // in the fixture; the first #7918 expander stripped the braces and walked
  // `curly/dup` instead), an alternative that concatenates into an absolute
  // path contributes nothing (`{,x}/src/...` → `/src/index.ts`; the first
  // expander walked it as the workspace's `src/index.ts`), and the
  // expansion composes with directory-only (#7917), `**`, and siblings.
  '{curly/dup}', '{,x}/src/{index.ts,utils/helper.ts}', '{dup,nested/dup}/', '{src-link/,x/y}',
  '{src,x/y}/**', '{a,b}/{dup,nested/dup}', '{sub/selfloop,x/y}/file.txt', '{**/.*,x/y}',

  // spaces / unicode / brackets / braces in real names (space matched via `?`)
  'spaces?and?unicode/*', 'spaces?and?unicode/*.txt', 'spaces?and?unicode/my*.txt',
  'spaces?and?unicode/unicode*', 'brackets/*', 'brackets/plain.txt', '**/*.txt',

  // deep/deep pattern
  '**/x/**/*.ts', '*/deep/*/*.ts', '**/deep/*/*.ts', 'a/**', 'x/**', 'a/deep/b/*.ts',

  // misc/edge (well-formed — see file header for what's excluded and why)
  'nonexistent/**', 'nonexistent*', '**/nonexistent.ts', 'src/index.ts', 'file-link.txt',
  '*-for-link.txt', '**/*for*', '**/*deep*/**', '{,}src/*.ts', '**/**', '**/**/**',
  '*.[t][s]', 'src/*.[jt]s', '.*.local', '.env.*', '.env.local',
  'sub/file.tx?', '?????????.txt',

  // #7951 — a comma-less `{...}` is literal, never alternation: `{dup}`
  // does NOT match the real `dup` file/dir (both agree: no matches), and
  // `brackets/{braces}.txt` DOES match the real file whose name is spelled
  // with literal braces.
  '{dup}', 'brackets/{braces}.txt',

  // #7951 — range expansion: ascending/descending, zero-padded, negative,
  // stepped, and a non-slash-spanning range mixed with an ordinary
  // extension segment. A ZERO-step range (`{1..10..0}`) is deliberately NOT
  // in this table: real `fs.glob` THROWS a synchronous `RangeError: Invalid
  // array length` for it (measured directly — `confinedRawGlobList`'s own
  // oracle call would crash the harness itself, not merely disagree), so
  // there is no "confinement-filtered fs.glob" answer to compare against.
  // See byok-tool-executor.test.js's dedicated zero-step test instead,
  // which pins the documented divergence: this tool fails closed (treats
  // the group as literal) rather than reproducing the crash.
  'range/{1..3}.txt', 'range/{3..1}.txt', 'range/{01..03}.txt',
  'range/{a..c}.txt', 'range/{c..a}.txt', 'range/{-2..0}.txt',
  'range/{1..3..2}.txt',
  // #7951 review — a ONE-member range still expands (`{2..2}` → `2`; the
  // shipped code returned the pattern unexpanded whenever the whole count
  // was 1), a zero-padded STEP turns padding on (`{1..10..01}` → 01..10),
  // and the backslash inside a mixed-case letter range is an empty member.
  'range/{2..2}.txt', 'range/{1..3..5}.txt', 'range/{1..10..01}.txt', 'range/q{Z..a}q',

  // #7951 — bracket-in-brace comma splitting: `fs.glob`'s own measured
  // behavior splits `{p[,q]r,s}` into 3 alternatives ('p[', 'q]r', 's'),
  // bracket-OBLIVIOUS, not the 2 a bracket-aware split would give — see
  // `splitTopLevelCommas`'s doc. `{a[}]b,s}` agrees too, but NOT because
  // `fs.glob` pairs braces around brackets (it does not — see
  // `braceCloseTable`'s doc and KNOWN_DIFFERENCE_7951 below).
  'bracecomma/{p[,q]r,s}', 'bracecomma/{a[}]b,s}',

  // #7899 — negated bracket class shapes that agree with `fs.glob` on
  // EVERY platform regardless of its own nocase folding (see
  // `KNOWN_DIFFERENCE_7899` below for the two that do NOT).
  'negcase-lo/[!x]*.ts', 'negcase-up/[^X]*.ts',
]

// Each bucket below names a FILED, OPEN issue and a predicate the missing
// entries must satisfy — a bare "under-matches somehow" skip would let an
// unrelated regression hide behind the issue number, so every bucket proves
// its SPECIFIC documented shape, not just "differs".

// #7912, #7917, #7918 are FIXED (see byok-tool-executor.js's `walkGlob`
// dot-crossing/`nextNonGlobstar` doc, its directoryOnly `detHandoff[m]` gate,
// and `expandBraces` respectively) — their patterns moved to the main
// strict-equality table above and their buckets are gone from here.

// #7916 (PARTIAL fix): `**` still does not follow a symlinked directory
// reached via a non-determinate trailing segment, and `visitedDirs` still
// refuses a `**`-involving re-entry through a self-referencing symlink — see
// `openVerifiedDirForDescend`'s `enforceCycleGuard` doc for exactly what WAS
// fixed (a fully `**`-free literal-segment chain re-entering an ancestor,
// bounded by the pattern's own length — `sub/selfloop/*` and
// `sub/selfloop/file.txt` moved to the main table above) and why the
// remaining shapes below are deferred (both still involve `**`'s own
// open-ended absorption, the exact mechanism the round-2 DoS fix exists
// for). Missing entries are always beneath `src-link` (the in-workspace
// symlinked dir) or `sub/selfloop` (the self-referencing one). `allowExtra`
// (unlike every other bucket here): `**/selfloop/**` is the one pattern in
// this set where `walkGlob` reports MORE than `fs.glob`, not less — the
// trailing `**`'s zero-width closure lists the bare `sub/selfloop` match (a
// determinate literal segment named it, same rule that correctly closes
// `src-link/**` onto bare `src-link`), but `fs.glob` omits it specifically
// because the symlink is self-referential, a distinction `walkGlob`'s
// closure rule does not draw. Still the same root cause and the same filed
// issue — bounding BOTH directions to the documented shape (never something
// unrelated) is what matters, not which direction happens to be wrong for a
// given pattern.
const KNOWN_UNDERMATCH_7916 = {
  issue: '#7916',
  patterns: [
    '**/*', 'sub/selfloop/**', 'sub/selfloop/selfloop/**',
    '**/selfloop/**', '**/selfloop/*',
  ],
  missingShape: (p) => p.startsWith('src-link/') || p.startsWith('sub/selfloop'),
  missingShapeDesc: 'reached only beneath src-link or sub/selfloop',
  allowExtra: true,
}

// #7899 — the OPPOSITE direction from #7916: `walkGlob` returns MORE than
// `fs.glob`, never less, and only when `fs.glob` itself nocase-folds on this
// host (`FS_GLOB_NOCASE`, a REAL runtime probe — see its own comment near
// the top of this file — not a `process.platform === 'darwin'` guess).
// `fs.glob` hard-codes its own candidate-generation folding for a negated
// bracket class (`[^X]`, `[!x]`): measured directly, it produces ZERO
// candidates for `[^X]*.ts` OR `[!x]*.ts` against EITHER a real lowercase
// `xyz.ts` or a real uppercase `Xyz.ts`, regardless of which one is on disk
// — its own folding excludes BOTH cases of the named character from the
// candidate set it generates, not just the named one. `walkGlob` is
// case-sensitive BY CONSTRUCTION everywhere (#7355/#7901 — it compares
// pattern text to the real on-disk name directly, with no case-folding
// candidate-generation step to disagree with in the first place), so it
// correctly returns the real file `fs.glob` wrongly excludes. This is a
// pure OVER-match (never a confinement or DoS concern — `walkGlob` finding
// a REAL, in-workspace file that `fs.glob`'s own bug hides is strictly
// MORE correct, not a regression) — `allowExtra: true`, `missingShape`
// vacuously satisfied since `missing` is always empty here. When
// `FS_GLOB_NOCASE` is false (a case-sensitive host, or `fs.glob`'s own
// nocase folding not engaging), these two patterns already agree with
// `fs.glob` outright and are registered into the main strict-equality
// table above instead (see the block right after this bucket definition).
const KNOWN_DIFFERENCE_7899 = {
  issue: '#7899',
  patterns: ['negcase-lo/[^X]*.ts', 'negcase-up/[!x]*.ts'],
  // `missing` must always be empty for this bucket (checked below by the
  // SAME predicate the describe block applies to it — an empty array is
  // vacuously fine); `extra` must be EXACTLY the one real file each pattern
  // names, never something unrelated hiding behind the issue number.
  missingShape: (p) => p === 'negcase-lo/xyz.ts' || p === 'negcase-up/Xyz.ts',
  missingShapeDesc: 'exactly negcase-lo/xyz.ts or negcase-up/Xyz.ts',
  allowExtra: true,
}

// #7951 review — the brace-expansion shapes that still differ, recorded as
// #7951's documented known differences (its acceptance allows exactly this:
// "at parity, or explicitly documented as a known difference"). `fs.glob`
// expands braces with `brace-expansion` (Node 22 bundles it; read directly),
// which differs from this tool's expander in three ways, all rooted in its
// algorithm rather than in anything a Glob caller would write on purpose:
//   - it pairs braces with NO knowledge of bracket expressions, so in
//     `{a,b[}]c}` the `}` inside `[}]` closes the group (alternatives `a`,
//     `b[`, then the text `]c}`); this tool pairs bracket-aware (see
//     `braceCloseTable`'s doc) and reads `a`, `b[}]c`;
//   - a comma-less group followed by `,…}` has its `}` re-read as literal
//     and its `{` re-paired further on, so `{a},b}` becomes `a}`, `b`; this
//     tool keeps `{a}` literal and the rest literal too;
//   - a comma-less, non-range group with no `,…}` after it stops expansion
//     of EVERYTHING to its right, so `{x}{1..2}` stays one literal string;
//     this tool still expands the range;
//   - it expands a brace group INSIDE a bracket expression (`[{1..3}]` →
//     `[1]`,`[2]`,`[3]`); this tool reads `[{1..3}]` as one class.
// Exact emulation of that algorithm, bounded the way #7945 bounds this
// expander, is its own change. Every row asserts the EXACT missing/extra
// lists, not a shape predicate, so any other change to these patterns'
// results fails here instead of hiding behind the issue number.
const KNOWN_DIFFERENCE_7951 = {
  issue: '#7951',
  exact: {
    'bracequirk/{a,b[}]c}': {
      missing: ['bracequirk/a]c}', 'bracequirk/b[]c}'],
      extra: ['bracequirk/a', 'bracequirk/b}c'],
    },
    'bracequirk/{a},b}': {
      missing: ['bracequirk/a}', 'bracequirk/b'],
      extra: ['bracequirk/{a},b}'],
    },
    'bracequirk/{x}{1..2}': {
      missing: ['bracequirk/{x}{1..2}'],
      extra: ['bracequirk/{x}1', 'bracequirk/{x}2'],
    },
    'bracequirk/[{1..3}]': {
      missing: ['bracequirk/2'],
      extra: ['bracequirk/{', 'bracequirk/}'],
    },
  },
  allowExtra: true,
}
KNOWN_DIFFERENCE_7951.patterns = Object.keys(KNOWN_DIFFERENCE_7951.exact)
KNOWN_DIFFERENCE_7951.missingShape = (p) => Object.values(KNOWN_DIFFERENCE_7951.exact)
  .some(({ missing, extra }) => missing.includes(p) || extra.includes(p))
KNOWN_DIFFERENCE_7951.missingShapeDesc = 'one of the exact rows listed in KNOWN_DIFFERENCE_7951'

const KNOWN_DIFFERENCE_BUCKETS = [
  KNOWN_UNDERMATCH_7916,
  ...(FS_GLOB_NOCASE ? [KNOWN_DIFFERENCE_7899] : []),
  KNOWN_DIFFERENCE_7951,
]
// When `fs.glob` does not nocase-fold on this host, the #7899 shapes above
// already agree with it exactly — promote them into the strict-equality
// table so they still get exercised (never silently dropped).
if (!FS_GLOB_NOCASE) PATTERNS.push(...KNOWN_DIFFERENCE_7899.patterns)

describe('walkGlob/runGlob vs raw fs.glob — permanent differential parity (#7910 review round 3)', { skip: SYMLINK_SKIP_REASON || false }, () => {
  for (const pattern of PATTERNS) {
    it(`agrees with confinement-filtered fs.glob for ${JSON.stringify(pattern)}`, async () => {
      const actual = await toolGlobList(pattern)
      const expected = await confinedRawGlobList(pattern)
      assert.equal(actual.error, undefined, `tool errored for ${JSON.stringify(pattern)}: ${actual.error}`)
      assert.deepEqual(
        actual.list,
        expected,
        `mismatch for ${JSON.stringify(pattern)}\n  tool:     ${JSON.stringify(actual.list)}\n  fs.glob:  ${JSON.stringify(expected)}`,
      )
    })
  }

  for (const { issue, patterns, missingShape, missingShapeDesc, allowExtra, exact } of KNOWN_DIFFERENCE_BUCKETS) {
    for (const pattern of patterns) {
      it(`diverges from fs.glob EXACTLY per the filed ${issue} gap for ${JSON.stringify(pattern)}`, async () => {
        const actual = await toolGlobList(pattern)
        const expected = await confinedRawGlobList(pattern)
        assert.equal(actual.error, undefined, `tool errored for ${JSON.stringify(pattern)}: ${actual.error}`)
        const actualSet = new Set(actual.list)
        const expectedSet = new Set(expected)
        const missing = expected.filter((p) => !actualSet.has(p))
        const extra = actual.list.filter((p) => !expectedSet.has(p))
        if (exact) {
          // A bucket that knows its rows exactly asserts them exactly — in
          // both directions, sorted, so neither a new divergence nor a
          // partly-fixed one can pass as "still the documented gap".
          assert.deepEqual(
            { missing: [...missing].sort(), extra: [...extra].sort() },
            { missing: [...exact[pattern].missing].sort(), extra: [...exact[pattern].extra].sort() },
            `${issue} shape ${JSON.stringify(pattern)} diverged differently than recorded\n  tool:     ${JSON.stringify(actual.list)}\n  fs.glob:  ${JSON.stringify(expected)}`,
          )
        }
        if (!allowExtra) {
          assert.deepEqual(
            extra,
            [],
            `${issue} shape ${JSON.stringify(pattern)} must never return MORE than fs.glob — extra: ${JSON.stringify(extra)} (a superset here would be a real regression, not the filed gap)`,
          )
        } else {
          assert.ok(
            extra.every(missingShape),
            `${issue} shape ${JSON.stringify(pattern)}'s extra entries must be ${missingShapeDesc}: ${JSON.stringify(extra)}`,
          )
        }
        assert.ok(
          missing.length > 0 || extra.length > 0,
          `${issue} shape ${JSON.stringify(pattern)} matched fs.glob exactly — the filed gap is gone, promote this pattern to the main table instead of the skip-list`,
        )
        assert.ok(
          missing.every(missingShape),
          `${issue} shape ${JSON.stringify(pattern)}'s missing entries must be ${missingShapeDesc}: ${JSON.stringify(missing)}`,
        )
      })
    }
  }
})
