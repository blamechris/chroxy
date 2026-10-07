import { realpath, lstat, readlink } from 'fs/promises'
import { resolve, dirname, basename, join, isAbsolute } from 'path'
import { resolveTargetComponentwiseAsync, COMPONENTWISE_MAX_SYMLINKS } from '../utils/componentwise-resolver.js'
import { isPathWithin } from '../utils/path-containment.js'
import { configDir } from '../config-dir.js'

/**
 * Shared utilities for file operations: CWD resolution, path validation, exec helpers.
 *
 * @param {Map} cwdRealCache - Shared cache for resolved CWD real paths
 * @param {number} cwdCacheTtl - TTL in milliseconds for cache entries
 */

/** Resolve a session CWD to its real path, caching with TTL */
export async function resolveSessionCwd(sessionCwd, cwdRealCache, cwdCacheTtl) {
  const key = resolve(sessionCwd)
  const cached = cwdRealCache.get(key)
  if (cached && Date.now() - cached.ts < cwdCacheTtl) {
    return cached.resolved
  }
  const resolved = await realpath(key)
  cwdRealCache.set(key, { resolved, ts: Date.now() })
  return resolved
}

/**
 * Resolve the real path of a (possibly-nonexistent) target by walking up
 * to the deepest existing ancestor, `realpath()`-ing that, and then
 * re-appending the unresolved tail components.
 *
 * Why this exists: the naive "realpath the target, fall back to lexical
 * on ENOENT" pattern has a symlink-escape bug on new-file paths. If
 * `packages/app/.venv/bin/evil.sh` doesn't exist but `.venv` is a
 * symlink to `/etc`, then:
 *   - realpath('.venv/bin/evil.sh') → ENOENT (bin/evil.sh doesn't exist)
 *   - fallback uses the lexical path → looks like it stays in workspace
 *   - the symlink-refusing open (`openNoFollow`, and O_NOFOLLOW before it)
 *     only checks the FINAL component → the `.venv` symlink is followed to
 *     `/etc` and the write lands there. True on every platform: O_NOFOLLOW is
 *     a final-component flag, and the win32 lstat + fd-identity emulation
 *     added in #7280 inspects exactly the same one component.
 *
 * Walking up to the deepest existing ancestor closes the gap: realpath
 * on `.venv/` yields `/etc`, we reconstruct the target as `/etc/bin/
 * evil.sh`, and it's then obviously outside the workspace.
 *
 * Found in the 2026-04-11 production readiness audit (blocker 4) —
 * defeats the otherwise-correct 04a2fbbb1 realpath-TOCTOU fix on the
 * new-file code path.
 *
 * #6921/#6923 — RESIDUAL LIMITATION (shared with the pre-#6921 protected-path
 * floor): this resolves the deepest EXISTING ancestor via `realpath()`, then
 * re-appends the unresolved tail LEXICALLY. It therefore cannot honour a `..`
 * that FOLLOWS a symlinked component the way `open(2)` does — both this helper's
 * `realpath` step AND its callers (which pre-compute `absPath = resolve(...)`,
 * collapsing `..` textually before calling in) discard the ordering the kernel
 * uses (follow symlink, THEN apply `..`). The floor closed the same gap by
 * switching to a COMPONENT-BY-COMPONENT walk (`permission-manager.js`
 * `resolveTargetComponentwiseSync`, #6921); the BYOK confinement path was brought
 * to parity in #6923 via the async {@link resolveTargetComponentwiseAsync} +
 * {@link validateRawPathWithinCwd} (raw target, walked componentwise), which the
 * BYOK executor now uses instead of this helper. This helper is retained for the
 * ws-file-ops (dashboard) callers, which hand in paths they have already
 * `resolve()`d / `normalize()`d (no surviving `..`), so the evasion cannot reach
 * it there. Impact of the limitation is narrower than the floor's — the
 * containment check only asks "does it escape the workspace?", and the common
 * chroxy topology (`.claude`/`.git` under the workspace) stays inside it.
 *
 * #8013 — a DANGLING symlink is followed, not walked past. `realpath()` throws
 * ENOENT at a dangling link as well as at a missing name, and stepping up past
 * the link re-appended its NAME lexically, so `project/link -> /outside/missing`
 * was judged a missing file inside the project until `/outside/missing` was
 * created — an existence oracle keyed on the outside. On ENOENT the walk now
 * `lstat`s the cursor; a symlink there restarts the walk at the link's target,
 * keeping the tail stripped so far. The link TEXT is resolved with
 * {@link resolveTargetComponentwiseAsync} from the link's real parent directory,
 * so a `..` in it is applied after the symlinks before it, as the kernel does:
 * link text is not normalized by any caller, so the lexical residual above
 * would otherwise reach the dashboard through it (`dangling -> sub/../probe`
 * with `sub` pointing outside). More than COMPONENTWISE_MAX_SYMLINKS restarts
 * throws ELOOP: text can lead straight back to its own link
 * (`self -> missing/../self`), which the kernel reports as ENOENT, not a loop.
 *
 * @param {string} absPath - Absolute path to resolve (may not exist)
 * @returns {Promise<string>} Real path with all symlink ancestors resolved
 */
export async function realpathOfDeepestAncestor(absPath) {
  return deepestAncestorWalk(absPath, STEP_OVER_MISSING)
}

// The ONLY code `realpathOfDeepestAncestor` steps over. Anything else — EACCES
// on an ancestor, ELOOP on a cycle — propagates so the caller fails closed.
const STEP_OVER_MISSING = new Set(['ENOENT'])

// #8012 — the codes `isUnresolvablePathWithin` steps over as well: each one
// means "the server cannot see below here", and the answer it feeds is only
// which error message to send. ELOOP is absent: a cycle has no visible end, so
// it is answered at once instead of after spending the whole step budget.
const STEP_OVER_UNSEEABLE = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'])

async function deepestAncestorWalk(absPath, stepOver) {
  // Defensive: require an absolute path. If a caller accidentally passes
  // a relative path, node's realpath() would resolve it against
  // process.cwd() — which is the SERVER process's cwd, not the session
  // cwd — producing a path that has nothing to do with the intended
  // workspace boundary. Fail loudly rather than silently resolving to
  // a location the caller didn't ask for.
  if (!isAbsolute(absPath)) {
    throw Object.assign(
      new Error(`realpathOfDeepestAncestor requires an absolute path, got: ${absPath}`),
      { code: 'EINVAL' }
    )
  }
  const segments = []
  let cursor = absPath
  // Safety ceiling — absolute paths should never nest more than a few
  // dozen components, but guard against pathological inputs. A restart
  // through a dangling link (#8013) spends a step too.
  const MAX_DEPTH = 256
  let restarts = 0
  for (let i = 0; i < MAX_DEPTH; i++) {
    try {
      const realAncestor = await realpath(cursor)
      if (segments.length === 0) return realAncestor
      // Rebuild: realAncestor + segments in the order they were stripped.
      // `segments` was pushed leaf-first (cursor kept moving up), so
      // reverse to get ancestor→leaf order for join().
      return join(realAncestor, ...segments.slice().reverse())
    } catch (err) {
      if (!stepOver.has(err.code)) throw err
      // #8013 — a failure AT a symlink (dangling, or its target unseeable):
      // follow the link rather than treating its name as an in-place segment.
      const linkTarget = await unresolvedLinkTarget(cursor, stepOver)
      if (linkTarget !== null) {
        if (++restarts > COMPONENTWISE_MAX_SYMLINKS) {
          throw Object.assign(
            new Error(`realpathOfDeepestAncestor: more than ${COMPONENTWISE_MAX_SYMLINKS} dangling symlinks followed`),
            { code: 'ELOOP' }
          )
        }
        cursor = linkTarget
        continue
      }
      const parent = dirname(cursor)
      if (parent === cursor) {
        // Reached the filesystem root without finding any existing
        // ancestor. On any real OS this is unreachable because `/`
        // always exists and realpath('/') succeeds. If we somehow
        // get here, FAIL CLOSED — do NOT fall back to the lexical
        // path because a lexical fallback re-opens the exact bypass
        // this helper exists to close.
        throw Object.assign(
          new Error(`realpathOfDeepestAncestor: could not resolve any existing ancestor for ${absPath}`),
          { code: 'ENOENT' }
        )
      }
      segments.push(basename(cursor))
      cursor = parent
    }
  }
  // Depth ceiling hit — FAIL CLOSED. Returning the lexical path here
  // would bypass the symlink-escape check for an attacker who crafted
  // a path with MAX_DEPTH+ nonexistent tail components under a
  // symlinked parent (Copilot review on PR #2807). Throwing forces the
  // caller's error branch to reject the operation instead.
  throw Object.assign(
    new Error(`realpathOfDeepestAncestor: path depth exceeds ${MAX_DEPTH} (got ${absPath.split('/').length} components)`),
    { code: 'ENAMETOOLONG' }
  )
}

/**
 * #8013 — after `realpath(cursor)` threw a code the walk steps over: if
 * `cursor` is itself a symlink (so the failure came from its TARGET, not from
 * its own name), return the absolute path the link points at; otherwise `null`.
 * The link text is walked component by component from the link's REAL parent
 * directory, which exists because `lstat` just found the link in it, so a `..`
 * in the text follows the symlinks before it. An `lstat` error the walk would
 * not step over (the path changed under us), or any error from the text walk
 * itself (EACCES, ELOOP), propagates, and the caller fails closed.
 * @param {string} cursor
 * @param {Set<string>} stepOver
 * @returns {Promise<string|null>}
 */
async function unresolvedLinkTarget(cursor, stepOver) {
  let st
  try {
    st = await lstat(cursor)
  } catch (err) {
    if (stepOver.has(err.code)) return null
    throw err
  }
  if (!st.isSymbolicLink()) return null
  const link = await readlink(cursor)
  return resolveTargetComponentwiseAsync(await realpath(dirname(cursor)), link)
}

/**
 * #8012 — FOR CHOOSING AN ERROR MESSAGE ONLY; never for granting access.
 *
 * `realpath(absPath)` failed with something other than ENOENT (EACCES, EPERM,
 * ENOTDIR, ELOOP, …). Before a handler sends a specific message such as
 * "Permission denied", it must know the path is inside its boundary: for a
 * path outside it, telling "blocked" apart from "readable" or "missing" is an
 * existence oracle. This answers whether the part of the path the server CAN
 * see lies within `rootReal`: it walks up to the deepest ancestor `realpath()`
 * resolves, stepping over any component it cannot see into, and follows a
 * symlink at the stopping point to its target, exactly as
 * {@link realpathOfDeepestAncestor} follows a dangling one.
 *
 * Whatever lies below the stopping point is invisible to the server as well,
 * so the answer can only depend on state the boundary already exposes. A
 * cycle (ELOOP), or any walk that cannot finish, answers `false`.
 *
 * @param {string} absPath - Absolute path whose `realpath()` failed
 * @param {string|null} rootReal - The boundary, already a real path; `null`
 *   (it could not be resolved) is never "within"
 * @returns {Promise<boolean>}
 */
export async function isUnresolvablePathWithin(absPath, rootReal) {
  if (!rootReal) return false
  try {
    return isPathWithin(await deepestAncestorWalk(absPath, STEP_OVER_UNSEEABLE), rootReal)
  } catch {
    return false
  }
}

/**
 * #8012 — the error text a handler sends when `realpath(absPath)` failed with
 * `err` (not ENOENT). Inside the boundary it is the handler's short reason for
 * `err.code`, when it has one; anywhere else — outside, a cycle, a check that
 * cannot finish, a code with no reason — it is `denial`, the same text every
 * outside path gets. `err.message` is never used: it carries Node's code and
 * the server's absolute path.
 *
 * @param {NodeJS.ErrnoException} err - The failure from the first `realpath()`
 * @param {string} absPath - The path that failed to resolve
 * @param {string|null} rootReal - The handler's boundary, already a real path
 * @param {Record<string, string>} reasons - In-boundary text by error code
 * @param {string} denial - The handler's usual "Access denied: …" text
 * @returns {Promise<string>}
 */
export async function unresolvablePathError(err, absPath, rootReal, reasons, denial) {
  if (!Object.hasOwn(reasons, err?.code)) return denial
  return (await isUnresolvablePathWithin(absPath, rootReal)) ? reasons[err.code] : denial
}

// #6923/#6928 — the async component-wise resolver (and its separator-agnostic
// split + MAXSYMLINKS cap) moved to `utils/componentwise-resolver.js`, the SINGLE
// SOURCE shared with the sync protected-path floor (`permission-manager.js`), so
// the two open(2)-faithful walks can no longer drift (#6928 was a bug present in
// BOTH copies). Re-exported here so existing importers of the async resolver from
// this module keep working.
export { resolveTargetComponentwiseAsync }

/**
 * #6923 — validate that a RAW (un-`resolve`d) target stays within the session
 * CWD, resolving it `open(2)`-faithfully via {@link resolveTargetComponentwiseAsync}.
 *
 * The async sibling / hardened replacement of {@link validatePathWithinCwd} for
 * the BYOK file-ops confinement path. The old path had the caller pre-compute
 * `absPath = resolve(cwd, filePath)` and then ran {@link realpathOfDeepestAncestor}
 * over it — but `resolve()` collapses `..` LEXICALLY, so a `..` that follows a
 * symlinked component was cancelled before any symlink was followed (the #6921
 * evasion, on the sync floor). Handing the RAW target (its `..` intact) to a
 * component-by-component walk closes it: a symlink-out-of-workspace followed by
 * `..` that lexically looks in-bounds now RESOLVES to its true (escaping)
 * destination and is rejected.
 *
 * FAIL-CLOSED: any error resolving the real target (EACCES on a directory, ELOOP
 * on a symlink cycle / depth bomb) propagates to the caller, whose own catch
 * turns it into a rejected tool call — never a silent allow.
 *
 * @param {string} rawTarget - The RAW tool-supplied path (relative or absolute; `..` intact)
 * @param {string} sessionCwd - Session working directory
 * @param {Map} cwdRealCache - Shared cache
 * @param {number} cwdCacheTtl - Cache TTL
 * @returns {Promise<{ valid: boolean, realPath: string, cwdReal: string }>}
 */
export async function validateRawPathWithinCwd(rawTarget, sessionCwd, cwdRealCache, cwdCacheTtl) {
  const cwdReal = await resolveSessionCwd(sessionCwd, cwdRealCache, cwdCacheTtl)
  const realPath = await resolveTargetComponentwiseAsync(cwdReal, rawTarget)
  const valid = isPathWithin(realPath, cwdReal)
  return { valid, realPath, cwdReal }
}

/**
 * Validate that a resolved path is within the session CWD.
 * Follows symlinks to prevent symlink escape.
 *
 * For targets that don't exist yet (new-file writes), walks up to the
 * deepest existing ancestor so symlinks in the parent chain still get
 * resolved — see realpathOfDeepestAncestor above for the failure mode
 * this closes.
 *
 * NOTE (#6923): this variant takes an already-ABSOLUTE path and resolves via the
 * deepest-existing-ancestor + lexical-tail helper, so a `..` that follows a
 * symlinked component is collapsed lexically before the symlink is followed. The
 * BYOK file-ops path now uses {@link validateRawPathWithinCwd} (raw target +
 * component-wise walk) to close that evasion; the ws-file-ops (dashboard) callers
 * still route here with paths they have already `resolve()`d/`normalize()`d (no
 * surviving `..`), so this function's contract — and its ENAMETOOLONG
 * depth-ceiling fail-closed — is preserved for them unchanged.
 *
 * @param {string} absPath - Absolute path to validate
 * @param {string} sessionCwd - Session working directory
 * @param {Map} cwdRealCache - Shared cache
 * @param {number} cwdCacheTtl - Cache TTL
 * @returns {Promise<{ valid: boolean, realPath: string, cwdReal: string }>}
 */
export async function validatePathWithinCwd(absPath, sessionCwd, cwdRealCache, cwdCacheTtl) {
  const cwdReal = await resolveSessionCwd(sessionCwd, cwdRealCache, cwdCacheTtl)
  const realAbsPath = await realpathOfDeepestAncestor(absPath)
  const valid = isPathWithin(realAbsPath, cwdReal)
  return { valid, realPath: realAbsPath, cwdReal }
}

/**
 * The refusal text for a generic file mutation aimed at the daemon's config
 * directory (#8331). Shared so every mutation path says the same thing.
 */
export const CONFIG_DIR_REFUSAL = 'Access denied: the chroxy config directory is managed by the daemon'

const sameDir = (a, b) => isPathWithin(a, b) && isPathWithin(b, a)

/**
 * Is `absPath` the daemon's config directory itself, or a FILE DIRECTLY IN it?
 *
 * Generic file writes refuse exactly that, so the deploy control files
 * (`deploy-request.json`, `deploy-postpone.json`) and the rest of the daemon's
 * top-level state can only be written through the daemon's own paths
 * (`daemon_update_action` applies the primary-token gate and the busy-session
 * confirmation). Subtrees stay writable on purpose: chroxy's own session worktrees
 * live at `<configDir>/worktrees/<id>` and orchestration worktrees at
 * `<configDir>/orchestration/worktrees`, and ordinary editing inside them must work.
 *
 * BOTH sides are resolved with `realpathOfDeepestAncestor` (an existing path by
 * `realpath`, a new one by its deepest existing ancestor), so the answer is the same
 * whether the session cwd is the config directory itself, one of its ancestors, a
 * worktree reaching the root through `../..`, a relocated `CHROXY_CONFIG_DIR`, or a
 * symlinked parent or dangling link. The config dir is read per call
 * (`configDir()`), never cached, so a relocation applies at once.
 *
 * FAILS CLOSED: a path that cannot be resolved (EACCES on an ancestor, a link
 * cycle) is reported as protected, never as outside.
 *
 * @param {string} absPath - Absolute path of the mutation target
 * @returns {Promise<boolean>}
 */
export async function isConfigDirOrDirectChild(absPath) {
  try {
    const [target, root] = await Promise.all([
      realpathOfDeepestAncestor(absPath),
      realpathOfDeepestAncestor(configDir()),
    ])
    return sameDir(target, root) || sameDir(dirname(target), root)
  } catch {
    return true
  }
}

/** Cache for resolved workspaceRoot realpaths (key: raw path, value: resolved) */
const _workspaceRootCache = new Map()

/**
 * Validate that a git repo path is within the workspace root.
 * Uses realpath() to resolve symlinks, preventing symlink traversal outside the root.
 * Caches the workspaceRoot realpath since it doesn't change during a server's lifetime.
 *
 * @param {string} repoPath - The directory path for the git operation
 * @param {string} workspaceRoot - The allowed workspace root directory
 * @throws {Error} If repoPath resolves outside the workspace root
 * @returns {Promise<string>} The resolved real path of repoPath
 */
export async function validateGitPath(repoPath, workspaceRoot) {
  // Normalize cache key so relative paths and trailing-slash variants don't create duplicates
  const cacheKey = resolve(workspaceRoot)
  let resolvedRoot = _workspaceRootCache.get(cacheKey)
  if (!resolvedRoot) {
    resolvedRoot = await realpath(workspaceRoot)
    _workspaceRootCache.set(cacheKey, resolvedRoot)
  }
  // Resolve the repo path through realpathOfDeepestAncestor so parent
  // symlinks are chased even when the leaf doesn't exist yet. Pre-audit,
  // this function used a realpath-or-lexical fallback that had the same
  // shape of bug as validatePathWithinCwd — a non-existent leaf inside
  // a symlinked parent would fall back to the lexical path and escape
  // the workspace-prefix check. Fixed alongside blocker 4 because the
  // two functions share the exact same pattern 20 lines apart.
  const absRepoPath = resolve(repoPath)
  const resolvedRepo = await realpathOfDeepestAncestor(absRepoPath)
  if (!isPathWithin(resolvedRepo, resolvedRoot)) {
    throw Object.assign(
      new Error(`Access denied: git operations are restricted to the workspace directory`),
      { code: 'EACCES' }
    )
  }
  return resolvedRepo
}
