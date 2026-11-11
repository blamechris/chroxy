import { lstatSync, readlinkSync } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'
import path, { dirname, join, sep } from 'node:path'

/**
 * open(2)-faithful, component-by-component path resolver — the SINGLE SOURCE for
 * both security floors that need it:
 *   - the SYNCHRONOUS protected-path floor (`permission-manager.js`, #6921), which
 *     runs inside the sync `handlePermission` hot-path and cannot await; and
 *   - the ASYNC BYOK file-ops confinement (`ws-file-ops/common.js`, #6923), which
 *     walks a raw tool-supplied path before a subprocess write.
 *
 * Both were introduced as near-identical twins (a sync copy and an async copy) and
 * PROMPTLY DRIFTED: #6928 was a bug present in BOTH — a `target.split(path.sep)`
 * that, on Windows, left a forward-slash path as ONE component and fell back to a
 * lexical `join()`, reopening the exact `..`-after-symlink escape the walk exists to
 * close. It had to be patched in two places. This module exists so the drift-prone
 * logic — the separator-agnostic split, the per-component lexical classification,
 * and the symlink splice — lives ONCE; the sync and async entry points are thin fs
 * drivers over that shared core, and `componentwise-resolver.test.js` pins them to
 * IDENTICAL results across a battery of on-disk topologies so they cannot diverge
 * again.
 *
 * ---------------------------------------------------------------------------------
 * WHY A COMPONENT WALK (and not `realpath(resolve(base, target))`):
 *
 * BOTH `path.resolve()` AND Node's `fs.realpath` collapse `..` LEXICALLY — textually,
 * before/instead of following symlinks. `realpath('link/..')` yields the symlink's
 * LEXICAL parent; `open(2)` follows `link` to its TARGET and applies `..` from THERE.
 * So `work/agent-x/../../settings.local.json` (with `work -> .claude/worktrees`)
 * lexically cancels to a benign in-cwd `settings.local.json`, but a raw write really
 * lands on `.claude/settings.local.json`. Only a walk that applies `..` AFTER
 * resolving the symlinks so far — as the kernel does — sees the true destination.
 * ---------------------------------------------------------------------------------
 */

// #6921/#6923 — symlink-expansion cap, matching the kernel's typical MAXSYMLINKS.
// A chain deeper than this — or a cycle — THROWS `ELOOP`, which every caller's
// `catch` treats as protected / rejected (fail closed).
export const COMPONENTWISE_MAX_SYMLINKS = 40

// The most work one walk does: COMPONENTWISE_MAX_COMPONENTS components walked,
// those a symlink adds included, and a resolved path no longer than
// COMPONENTWISE_MAX_PATH_LENGTH characters. Past either, the walk THROWS
// `ENAMETOOLONG`, which every caller treats as a failure (fail closed). Each step
// builds and stats the full path so far, so these bound the walk's total cost.
// A real path is far below both: Linux's PATH_MAX is 4096 bytes, and even 40
// symlinks of a few dozen components each stay under the component bound.
export const COMPONENTWISE_MAX_COMPONENTS = 1024
export const COMPONENTWISE_MAX_PATH_LENGTH = 16384

/**
 * #6928 — split a raw path into the components BELOW its parsed root. The
 * separators are the platform's own: `/` and `\` on Windows (Node accepts forward
 * slashes there, so a `sep`-only split would leave a forward-slash path as ONE
 * component and the walk would fall back to a lexical `join()`), but `/` ALONE on
 * POSIX, where `\` is an ordinary filename character — splitting on it would walk
 * a different pathname than the one a consumer opens. `root` (already parsed by the
 * caller, which starts `resolved` there) is sliced off first so a drive/UNC/`/`
 * root is never walked as an ordinary component (a Windows `C:\` would otherwise
 * appear as a `C:` component and `join` straight back onto the drive root).
 * @param {string} p
 * @param {string} root  the already-`parse`d root of `p` (`''` for a relative path)
 * @param {typeof import('node:path')} [pathImpl]  `path.win32` / `path.posix` to
 *   drive the other platform's rules (tests); defaults to the host's `path`
 * @returns {string[]}
 */
export function splitPathBelowRoot(p, root, pathImpl = path) {
  const separators = pathImpl.sep === '\\' ? /[/\\]+/ : /\/+/
  return (root ? p.slice(root.length) : p).split(separators)
}

/**
 * Where a walk over the raw path `p` starts, and the components below that start.
 * `current` is the real path resolved so far (the session cwd for a target, the
 * link's parent for a link target).
 *   - a relative path starts where `current` is (`start` is `''`);
 *   - an absolute path starts at its own parsed root;
 *   - on Windows, a root-relative path (`\foo` or `/foo`, no drive) starts at the
 *     root of `current`'s drive (or share), exactly as `path.win32.resolve(current, p)`
 *     places it;
 *   - on Windows, a drive-relative path (`C:foo`) depends on that drive's current
 *     directory, which cannot be known here, so it throws EINVAL (callers fail
 *     closed). So does a root-relative path when `current` has no drive.
 * @param {string} p
 * @param {string} current  the real path resolved so far
 * @param {typeof import('node:path')} [pathImpl]  `path.win32` / `path.posix` to
 *   drive the other platform's rules (tests); defaults to the host's `path`
 * @returns {{ start: string, below: string[] }}
 */
export function walkStart(p, current, pathImpl = path) {
  const { root } = pathImpl.parse(p)
  if (pathImpl.sep === '\\') {
    if (/^[A-Za-z]:$/.test(root)) {
      throw Object.assign(new Error('componentwise resolver: a drive-relative path depends on the drive\'s current directory'), { code: 'EINVAL' })
    }
    if (root === '\\' || root === '/') {
      const driveRoot = pathImpl.parse(current).root
      if (!/^[A-Za-z]:[\\/]$/.test(driveRoot) && !/^[\\/]{2}[^\\/]/.test(driveRoot)) {
        throw Object.assign(new Error('componentwise resolver: a root-relative path has no drive to anchor to'), { code: 'EINVAL' })
      }
      return { start: driveRoot, below: splitPathBelowRoot(p, root, pathImpl) }
    }
  }
  const start = pathImpl.isAbsolute(p) ? root : ''
  return { start, below: splitPathBelowRoot(p, start, pathImpl) }
}

/**
 * Pure: initialise the walk. An absolute target ignores the base (as `open`/`resolve`
 * do) and starts at its parsed root so its own leading components are walked (and
 * symlink-resolved) too; a relative target (empty root) starts at `realBase`. The
 * root is stripped BEFORE splitting so it is never re-walked as an ordinary
 * component (#6928).
 * @param {string} realBase  the session cwd, already resolved to its real path
 * @param {string} target    a raw (NOT pre-`resolve`d — its `..` must survive) path
 * @returns {{ resolved: string, pending: string[] }}
 */
function beginWalk(realBase, target) {
  const { start, below } = walkStart(target, realBase)
  return { resolved: start || realBase, pending: below }
}

/**
 * Pure: resolve a single component AS FAR AS POSSIBLE without touching the
 * filesystem. This is the ordering that must never drift between the sync and async
 * drivers, so it lives here exactly once:
 *   - `''` / `.`  → skip (resolved unchanged, no stat).
 *   - `..`        → pop to the PARENT of the resolved-so-far real path (`dirname`),
 *                   i.e. apply `..` AFTER following symlinks so far — NOT lexically
 *                   on the pre-resolution path. No stat. When it pops a to-be-created
 *                   component, the tail shrinks by one; once the tail is empty the
 *                   resolved path is a directory that exists, and the driver goes
 *                   back to inspecting each component.
 *   - in a tail   → once a component was ENOENT, the components after it are a
 *                   to-be-created tail: append by `join` with no stat.
 *   - otherwise   → return the `candidate` to lstat; `resolved` is left UNCHANGED
 *                   (it is committed only after the driver confirms `candidate` is
 *                   not a symlink).
 * @param {string} resolved   resolved-so-far real path
 * @param {string} comp       the raw component
 * @param {number} tail       how many to-be-created components follow the last
 *   existing directory (0 when every component so far was inspected)
 * @returns {{ resolved: string, stat: string|null, tail: number }}  `stat` is the
 *   path to lstat, or `null` when the component was fully consumed lexically.
 */
function resolveComponentLexically(resolved, comp, tail) {
  if (comp === '' || comp === '.') return { resolved, stat: null, tail }
  if (comp === '..') return { resolved: dirname(resolved), stat: null, tail: tail > 0 ? tail - 1 : 0 }
  const candidate = join(resolved, comp)
  if (tail > 0) return { resolved: candidate, stat: null, tail: tail + 1 }
  return { resolved, stat: candidate, tail }
}

/**
 * Pure: a symlink was found at the cursor. Splice the link's own components (below
 * its root) into `pending` AT the cursor so they — and any `..` they contain — are
 * walked next, before the tail. Returns the resolved base to continue from: an
 * ABSOLUTE link restarts resolution from its parsed root; a RELATIVE link continues
 * from the symlink's PARENT (`resolved`, since the symlink component itself was not
 * appended). Mutates `pending`.
 * @param {string[]} pending
 * @param {number} i         cursor (index of the NEXT component to walk)
 * @param {string} resolved  resolved-so-far real path (the symlink's parent)
 * @param {string} link      the raw `readlink` target
 * @returns {string}
 */
function spliceSymlink(pending, i, resolved, link) {
  // On POSIX `\` is a name character, which the split below would read as a
  // separator; a link whose target holds one is not walked (callers fail closed).
  if (sep === '/' && link.includes('\\')) {
    throw Object.assign(new Error('componentwise resolver: link target holds a backslash'), { code: 'EINVAL' })
  }
  const { start, below } = walkStart(link, resolved)
  pending.splice(i, 0, ...below)
  return start || resolved
}

/**
 * Throw ENAMETOOLONG once a walk has consumed more than
 * COMPONENTWISE_MAX_COMPONENTS components or its resolved path is longer than
 * COMPONENTWISE_MAX_PATH_LENGTH characters. Called before each component and
 * after the last.
 * @param {number} walked    components consumed so far, the current one included
 * @param {string} resolved  the path resolved so far
 * @param {string} fnName    the driver, for the message
 */
function checkWalkBounds(walked, resolved, fnName) {
  if (walked > COMPONENTWISE_MAX_COMPONENTS || resolved.length > COMPONENTWISE_MAX_PATH_LENGTH) {
    throw Object.assign(
      new Error(`${fnName}: walk exceeds ${COMPONENTWISE_MAX_COMPONENTS} components or ${COMPONENTWISE_MAX_PATH_LENGTH} characters`),
      { code: 'ENAMETOOLONG' },
    )
  }
}

// A caller may share one walk budget across several walks (`{ left: n }`); each
// component walked spends one, and an exhausted budget fails like a long walk.
function spendWalkBudget(budget, fnName) {
  if (budget !== undefined && --budget.left < 0) {
    throw Object.assign(new Error(`${fnName}: the shared walk budget is spent`), { code: 'ENAMETOOLONG' })
  }
}

function symlinkBudgetError(fnName) {
  return Object.assign(
    new Error(`${fnName}: symlink depth exceeds ${COMPONENTWISE_MAX_SYMLINKS}`),
    { code: 'ELOOP' },
  )
}

/**
 * #6921 — SYNC open(2)-faithful resolver (protected-path floor hot-path). A thin
 * `lstatSync`/`readlinkSync` driver over the shared core above. A non-ENOENT
 * `lstat`/`readlink` error (EACCES, ELOOP) PROPAGATES so the caller's `catch` fails
 * closed; ENOENT stops filesystem resolution (nothing deeper can be a symlink) and
 * the remaining tail — INCLUDING any `..` — is applied against the resolved-so-far
 * REAL path by the same pop/append rules.
 * @param {string} realBase  the session cwd, already resolved to its real path
 * @param {string} target    a raw (NOT pre-`resolve`d — its `..` must survive) path
 * @param {{ left: number }} [budget]  a walk budget shared with other walks
 * @returns {string} the open(2)-faithful resolved absolute real path
 */
export function resolveTargetComponentwiseSync(realBase, target, budget) {
  const { resolved: base, pending } = beginWalk(realBase, target)
  let resolved = base
  let symlinks = 0
  let tail = 0
  let i = 0
  while (i < pending.length) {
    const comp = pending[i]
    i++
    checkWalkBounds(i, resolved, 'resolveTargetComponentwiseSync')
    spendWalkBudget(budget, 'resolveTargetComponentwiseSync')
    const step = resolveComponentLexically(resolved, comp, tail)
    resolved = step.resolved
    tail = step.tail
    if (step.stat === null) continue
    let st
    try {
      st = lstatSync(step.stat)
    } catch (err) {
      if (err.code === 'ENOENT') { tail = 1; resolved = step.stat; continue }
      throw err // EACCES etc. — fail closed via the caller's catch
    }
    if (st.isSymbolicLink()) {
      if (++symlinks > COMPONENTWISE_MAX_SYMLINKS) throw symlinkBudgetError('resolveTargetComponentwiseSync')
      resolved = spliceSymlink(pending, i, resolved, readlinkSync(step.stat))
    } else {
      resolved = step.stat
    }
  }
  checkWalkBounds(i, resolved, 'resolveTargetComponentwiseSync')
  return resolved
}

/**
 * #6923 — ASYNC open(2)-faithful resolver (BYOK file-ops confinement). The async
 * sibling of {@link resolveTargetComponentwiseSync} over the SAME shared core, so
 * the two cannot diverge (pinned by `componentwise-resolver.test.js`). Same
 * fail-closed contract: EACCES/ELOOP propagate; ENOENT applies the remaining tail
 * (including `..`) by pop/append.
 * @param {string} realBase  the session cwd, already resolved to its real path
 * @param {string} target    a raw (NOT pre-`resolve`d — its `..` must survive) path
 * @param {{ left: number }} [budget]  a walk budget shared with other walks
 * @returns {Promise<string>} the open(2)-faithful resolved absolute real path
 */
export async function resolveTargetComponentwiseAsync(realBase, target, budget) {
  const { resolved: base, pending } = beginWalk(realBase, target)
  let resolved = base
  let symlinks = 0
  let tail = 0
  let i = 0
  while (i < pending.length) {
    const comp = pending[i]
    i++
    checkWalkBounds(i, resolved, 'resolveTargetComponentwiseAsync')
    spendWalkBudget(budget, 'resolveTargetComponentwiseAsync')
    const step = resolveComponentLexically(resolved, comp, tail)
    resolved = step.resolved
    tail = step.tail
    if (step.stat === null) continue
    let st
    try {
      st = await lstat(step.stat)
    } catch (err) {
      if (err.code === 'ENOENT') { tail = 1; resolved = step.stat; continue }
      throw err // EACCES etc. — fail closed via the caller
    }
    if (st.isSymbolicLink()) {
      if (++symlinks > COMPONENTWISE_MAX_SYMLINKS) throw symlinkBudgetError('resolveTargetComponentwiseAsync')
      resolved = spliceSymlink(pending, i, resolved, await readlink(step.stat))
    } else {
      resolved = step.stat
    }
  }
  checkWalkBounds(i, resolved, 'resolveTargetComponentwiseAsync')
  return resolved
}
