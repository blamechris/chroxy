import { realpath, lstat, readlink } from 'fs/promises'
import { resolve, dirname, basename, join, isAbsolute, parse, sep } from 'path'

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
 *   - O_NOFOLLOW only checks the FINAL component → the kernel happily
 *     follows the `.venv` symlink to `/etc` and writes there
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
 * @param {string} absPath - Absolute path to resolve (may not exist)
 * @returns {Promise<string>} Real path with all symlink ancestors resolved
 */
export async function realpathOfDeepestAncestor(absPath) {
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
  // dozen components, but guard against pathological inputs.
  const MAX_DEPTH = 256
  for (let i = 0; i < MAX_DEPTH; i++) {
    try {
      const realAncestor = await realpath(cursor)
      if (segments.length === 0) return realAncestor
      // Rebuild: realAncestor + segments in the order they were stripped.
      // `segments` was pushed leaf-first (cursor kept moving up), so
      // reverse to get ancestor→leaf order for join().
      return join(realAncestor, ...segments.slice().reverse())
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
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

// #6923 — symlink-expansion cap for the async component-wise resolver below,
// matching the kernel's typical MAXSYMLINKS (40) and the sync floor's
// _FLOOR_MAX_SYMLINKS in permission-manager.js. A chain deeper than this — or a
// cycle — throws ELOOP, which the raw-path validator's caller treats as a reject
// (fail closed).
const _COMPONENTWISE_MAX_SYMLINKS = 40

// #6928 — split a raw path into the components BELOW its parsed root, separating
// on BOTH `/` and `\` regardless of platform. Node accepts forward slashes on
// Windows, so a platform-`sep`-only split (`\` on Windows) would leave a
// forward-slash path as ONE component — the component walk would then break and
// fall back to a lexical `join()`, reopening the exact `..`-after-symlink escape
// this resolver exists to close. `root` (already parsed by the caller, which
// starts `resolved` there) is sliced off first so a drive/UNC/`/` root is never
// walked as an ordinary component (a Windows `C:\` would otherwise appear as a
// `C:` component and `join` straight back onto the drive root).
function splitPathBelowRoot(p, root) {
  return (root ? p.slice(root.length) : p).split(/[/\\]+/)
}

/**
 * #6923 — resolve `target` against a REAL base by walking it COMPONENT BY
 * COMPONENT, mirroring the kernel's `open(2)` path traversal. This is the ASYNC
 * sibling of `resolveTargetComponentwiseSync` in `permission-manager.js` (#6921),
 * and the replacement — on the BYOK confinement path — for the
 * `realpathOfDeepestAncestor(resolve(base, target))` shape above, which could NOT
 * honour a `..` that FOLLOWS a symlinked component: BOTH `path.resolve()` (in the
 * caller) AND Node's `realpath` collapse `..` LEXICALLY, so `link/..` cancels the
 * symlink textually before it is ever followed, whereas `open(2)` follows `link`
 * to its TARGET and applies `..` from THERE. So `work/agent-x/../../x` (with
 * `work -> .claude/worktrees`) lexically cancels to a benign in-cwd `x`, but
 * really lands on `.claude/x`. Only a component walk that applies `..` AFTER
 * resolving symlinks-so-far (as the kernel does) sees the real destination.
 *
 * The walk starts from `realBase` (the session cwd already resolved to its real
 * path) for a relative target, or from the filesystem root for an absolute
 * target, and for each remaining component:
 *   - `''` / `.`      → skip.
 *   - `..`            → pop to the PARENT of the resolved-so-far real path
 *                       (`dirname`), i.e. apply `..` AFTER following symlinks so
 *                       far — NOT lexically on the pre-resolution path.
 *   - a SYMLINK       → `readlink` it; if the link is absolute, reset the resolved
 *                       path to the fs root; splice the link's own components into
 *                       the walk at the current position and keep going (so a
 *                       relative link resolves from the symlink's parent, and any
 *                       `..` inside the link is honoured too). Bounded by
 *                       {@link _COMPONENTWISE_MAX_SYMLINKS} — a deeper chain or a
 *                       cycle THROWS `ELOOP` (→ fail closed).
 *   - a NON-symlink   → append it.
 *   - a NON-EXISTENT tail component (`ENOENT` on the `lstat`) → stop filesystem
 *                       resolution (nothing deeper can exist, so nothing deeper
 *                       can be a symlink) and apply the REMAINING components —
 *                       INCLUDING any `..` — against the resolved-so-far real path
 *                       by the same pop/append rules. Models a to-be-created file:
 *                       a `..` in the tail still pops the RESOLVED real path, never
 *                       the unresolved lexical one.
 *
 * A non-ENOENT `lstat`/`readlink` error (EACCES, ELOOP) propagates so the caller
 * fails closed. Returns the fully resolved absolute real path.
 * @param {string} realBase  the session cwd, already resolved to its real path
 * @param {string} target    a raw (NOT pre-`resolve`d — its `..` must survive) path value
 * @returns {Promise<string>} the open(2)-faithful resolved absolute real path
 */
export async function resolveTargetComponentwiseAsync(realBase, target) {
  // Absolute target ignores the base (as `open`/`resolve` do); start at its
  // parsed root so its own leading components are walked (and symlink-resolved)
  // too. A relative target (empty root) starts at the base. The root is stripped
  // BEFORE splitting so it is never re-walked as an ordinary component (#6928).
  const targetRoot = isAbsolute(target) ? parse(target).root : ''
  let resolved = targetRoot || realBase
  const pending = splitPathBelowRoot(target, targetRoot)
  let symlinks = 0
  // Once a component doesn't exist, the rest is a to-be-created tail: no deeper
  // component can be a symlink, so stop lstat-ing and apply pop/append only.
  let tailOnly = false
  let i = 0
  while (i < pending.length) {
    const comp = pending[i]
    i++
    if (comp === '' || comp === '.') continue
    if (comp === '..') { resolved = dirname(resolved); continue }
    const candidate = join(resolved, comp)
    if (tailOnly) { resolved = candidate; continue }
    let st
    try {
      st = await lstat(candidate)
    } catch (err) {
      if (err.code === 'ENOENT') { tailOnly = true; resolved = candidate; continue }
      throw err // EACCES etc. — fail closed via the caller
    }
    if (st.isSymbolicLink()) {
      if (++symlinks > _COMPONENTWISE_MAX_SYMLINKS) {
        throw Object.assign(new Error(`resolveTargetComponentwiseAsync: symlink depth exceeds ${_COMPONENTWISE_MAX_SYMLINKS}`), { code: 'ELOOP' })
      }
      const link = await readlink(candidate)
      // An absolute link restarts resolution from its parsed root; a relative
      // link resolves from the symlink's PARENT (`resolved`, since `comp` was not
      // appended). Splice the link's components (below its root) in at the cursor
      // so they — and any `..` they contain — are walked next, before the tail.
      const linkRoot = isAbsolute(link) ? parse(link).root : ''
      if (linkRoot) resolved = linkRoot
      pending.splice(i, 0, ...splitPathBelowRoot(link, linkRoot))
    } else {
      resolved = candidate
    }
  }
  return resolved
}

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
  const valid = realPath.startsWith(cwdReal + sep) || realPath === cwdReal
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
  const valid = realAbsPath.startsWith(cwdReal + '/') || realAbsPath === cwdReal
  return { valid, realPath: realAbsPath, cwdReal }
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
  if (!resolvedRepo.startsWith(resolvedRoot + '/') && resolvedRepo !== resolvedRoot) {
    throw Object.assign(
      new Error(`Access denied: git operations are restricted to the workspace directory`),
      { code: 'EACCES' }
    )
  }
  return resolvedRepo
}
