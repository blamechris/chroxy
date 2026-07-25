/**
 * The protected-path / secret-read PERMISSION FLOOR — the SINGLE source of truth,
 * shared by BOTH permission pipelines. #7004.
 *
 * Chroxy has two permission paths, and the floor must be identical on both:
 *   - IN-PROCESS (SDK / BYOK / codex app-server): `permission-manager.js`
 *     `handlePermission` calls {@link isFlooredTarget} before every lenient-mode
 *     short-circuit (auto / an `allow` rule / acceptEdits).
 *   - HOOK-ROUTED (claude-tui — the DEFAULT provider — and cli-session):
 *     `hooks/permission-hook.sh` decides auto / acceptEdits in SHELL, so it
 *     cannot import this module. It instead consults `POST /permission-floor`
 *     (`ws-permissions.js` `handlePermissionFloorCheck`), which calls the SAME
 *     {@link isFlooredTarget}, and routes a floored target to a real prompt.
 *
 * #7004 was exactly the drift this module exists to prevent: the floor lived
 * only in `permission-manager.js`, which hook-routed providers never traverse,
 * so `auto`/`acceptEdits` on claude-tui read `.env` / `id_rsa` ungated. Keep the
 * floor HERE — never reimplement it in the shell hook or a second JS call site
 * (the #6986/#7001 lesson: divergent copies of a security check are how these
 * bugs happen). A leaf module by design (no logger, no EventEmitter, no rule
 * store) so an HTTP handler can import it without pulling in PermissionManager
 * or joining its permission-rule-store import cycle — the same shape as
 * `redaction.js`, the sanitizer both paths already share.
 *
 * Everything here is PURE except the deliberate symlink resolution (realpath /
 * lstat), which FAILS CLOSED — see {@link isProtectedPathValue}.
 */
import { realpathSync } from 'node:fs'
import { resolve, relative, sep, isAbsolute, dirname, basename, join } from 'node:path'
import { resolveTargetComponentwiseSync } from './utils/componentwise-resolver.js'

// #6794 — hardcoded protected-path floor. Even under lenient settings (auto /
// acceptEdits / a broad `allow` rule) Chroxy must not SILENTLY auto-approve a
// path-carrying tool aimed at a repo-control / agent-config directory or a
// secret file. This mirrors Claude Code's own "always ask" floor (desktop
// parity): the target simply falls through to the interactive prompt instead
// of short-circuiting — a floor, never a hard deny.
//
// Protected DIRECTORY segment names, matched at any depth of the path the write
// RESOLVES into (see isProtectedPathValue for the relative-vs-absolute framing
// that keeps a session's own cwd from false-matching). `.config/git` (the XDG
// git-config dir) is a two-segment sequence handled separately, not a bare segment.
const PROTECTED_DIR_SEGMENTS = new Set(['.git', '.claude', '.vscode'])

// #6803 — SECRET FILE names. Distinct from the protected DIRECTORY segments
// above: these carry credentials / private keys, so their floor applies to
// READS as well as writes (mirrors Claude Code's "don't auto-read known
// secrets" floor). The write floor (isProtectedPathTarget) matches the config
// DIRS *and* these secret files; the read floor (isSecretReadTarget) matches
// ONLY these secret files — reading `.git/config` or `.claude/settings.json`
// is a common benign operation and must not prompt, but auto-reading a private
// key or an env file under a broad `allow Read` must not silently succeed.
//
// Matched (case-insensitively, see isProtectedPathValue) at ANY path segment:
//   - `.env` or `.env.*`                 → env files (.env / .env.local / …)
//   - one of SECRET_FILE_EXACT           → SSH keys, credential dotfiles
//   - a segment ending in an extension in SECRET_FILE_EXTENSIONS → PEM / keys /
//     PKCS#12 keystores
// A floor only ever forces a PROMPT (never a deny), so a rare false positive on
// an unrelated `.key`/`.pem` file is acceptable and conservative.
const SECRET_FILE_EXACT = new Set([
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', // SSH private keys
  '.npmrc', '.pgpass', '.netrc',                // credential dotfiles
])
const SECRET_FILE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx']

// Tool-input fields that name a filesystem target. Presence of one is what
// makes a tool "path-carrying" for the floor (Write/Edit → file_path,
// NotebookEdit → notebook_path, Read/Glob/Grep → file_path/path). A tool with
// none of these (Bash, Task, WebFetch, WebSearch) cannot be floored here —
// command-shaped access is out of scope for a path floor. Exported (#6773) so
// the editedInput whitelist guard test can assert no editable field is ever a
// path field (a path-redirect would let an edit slip past the protected floor).
export const PROTECTED_PATH_INPUT_FIELDS = ['file_path', 'path', 'notebook_path']

// #6803 — tools whose floor is SECRETS-ONLY (non-mutating reads). handlePermission
// routes these through isSecretReadTarget (env files + key material) instead of
// the full config-dir floor. EVERY OTHER path-carrying tool — the mutating ones
// (Write / Edit / NotebookEdit / apply_patch) and any future tool — gets the full
// isProtectedPathTarget floor. Defaulting the unknown/mutating case to the FULL
// floor is fail-safe: a new write-shaped tool inherits the stronger floor.
export const SECRET_READ_FLOOR_TOOLS = new Set(['Read', 'Glob', 'Grep'])

/**
 * #6803 — is a single (already-lowercased) path segment a known secret FILE?
 * Env files, SSH/credential dotfiles, and PEM/key/keystore extensions. Pure
 * string ops (no regex) so it can't be mangled by a later edit.
 * @param {string} seg  a lowercased path segment
 * @returns {boolean}
 */
function isSecretFileSegment(seg) {
  if (seg === '.env' || seg.startsWith('.env.')) return true
  if (SECRET_FILE_EXACT.has(seg)) return true
  for (const ext of SECRET_FILE_EXTENSIONS) {
    if (seg.length > ext.length && seg.endsWith(ext)) return true
  }
  return false
}

/**
 * #6803 (PR #6873 security review) — credential-DENSE config FILES that must be
 * floored for READS too (not just writes). These live INSIDE a config dir, so
 * the secret-file matcher above misses them, but they routinely carry secrets:
 *   - `.git/config`            — a remote URL can embed a PAT (`https://TOKEN@…`)
 *   - `.git/credentials`       — git's plaintext credential store
 *   - `.config/git/config` + `.config/git/credentials` — the XDG equivalents
 *   - `.claude/settings*.json` — may hold ANTHROPIC_API_KEY / env secrets
 * A broad `allow Read` / auto / bypass must not silently read these (Chroxy
 * streams tool-results to phone/Discord, amplifying any leak). OTHER files in
 * the config dirs (`.claude/skills/*.md`, a secret-free `.vscode/settings.json`)
 * stay un-floored for reads per #6803's intent.
 *
 * Matched as a 2-/3-segment sequence anchored at index `i` of the (lowercased,
 * `..`-stripped) segment array, so any depth prefix (`sub/.git/config`) matches.
 * Pure string ops (no regex) — consistent with the rest of the floor.
 * @param {string[]} segments  lowercased path segments
 * @param {number} i           the current segment index
 * @returns {boolean}
 */
function isCredentialConfigSegment(segments, i) {
  const seg = segments[i]
  // .git/config (PAT-embedded remote URLs) and .git/credentials (git store).
  if (seg === '.git' && (segments[i + 1] === 'config' || segments[i + 1] === 'credentials')) return true
  // XDG git: .config/git/config and .config/git/credentials.
  if (seg === '.config' && segments[i + 1] === 'git' &&
      (segments[i + 2] === 'config' || segments[i + 2] === 'credentials')) return true
  // .claude/settings*.json (settings.json / settings.local.json — may hold keys).
  const child = segments[i + 1]
  if (seg === '.claude' && typeof child === 'string' && child.startsWith('settings') && child.endsWith('.json')) return true
  return false
}

// #6851 — depth ceiling for the sync deepest-ancestor realpath walk. Absolute
// paths never legitimately nest this deep; the cap only guards a pathological /
// malicious tail (a to-be-created path with hundreds of nonexistent components
// under a symlinked parent), which FAILS CLOSED rather than trust a lexical guess.
const _FLOOR_REALPATH_MAX_DEPTH = 256

/**
 * #6851 — SYNC deepest-existing-ancestor realpath: the symlink-resolving core of
 * the floor's #6851 hardening, and the synchronous sibling of
 * {@link realpathOfDeepestAncestor} in `ws-file-ops/common.js` (BYOK's
 * post-approval confinement). The floor runs inside the SYNCHRONOUS
 * `handlePermission` hot-path, so it cannot await that async twin — it uses
 * `realpathSync` instead.
 *
 * Resolves every symlink in the EXISTING ancestor chain of a (possibly not-yet-
 * created) ABSOLUTE path, then re-appends the non-existent tail components. The
 * naive "realpath the whole target, fall back to the lexical path on ENOENT"
 * pattern has a symlink-escape hole on to-be-created files: a symlinked PARENT
 * plus a non-existent leaf makes the lexical fallback hide the parent symlink.
 * Walking up to the deepest EXISTING ancestor and realpath-ing THAT closes it.
 *
 * FAIL-CLOSED at every ambiguous edge — it THROWS (never returns a lexical
 * guess) when no ancestor resolves or the depth is pathological, and lets a
 * non-ENOENT error (EACCES on a directory, ELOOP on a symlink cycle) propagate,
 * so the floor's `catch` treats the target as protected.
 * @param {string} absPath  an absolute path (may not exist yet)
 * @returns {string} the real path with all symlink ancestors resolved
 */
function realpathDeepestAncestorSync(absPath) {
  if (!isAbsolute(absPath)) {
    // A relative path would resolve against the SERVER process cwd, not the
    // session cwd — fail loudly (and, via the caller's catch, closed).
    throw Object.assign(new Error(`realpathDeepestAncestorSync requires an absolute path, got: ${absPath}`), { code: 'EINVAL' })
  }
  const segments = []
  let cursor = absPath
  for (let i = 0; i < _FLOOR_REALPATH_MAX_DEPTH; i++) {
    try {
      const realAncestor = realpathSync(cursor)
      if (segments.length === 0) return realAncestor
      // `segments` was pushed leaf-first while cursor climbed, so reverse to
      // rebuild ancestor→leaf order for join().
      return join(realAncestor, ...segments.slice().reverse())
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      const parent = dirname(cursor)
      if (parent === cursor) {
        // Reached the fs root without resolving any ancestor — unreachable on a
        // real OS (`/` always realpaths). FAIL CLOSED: a lexical fallback here
        // would reopen the exact bypass this helper closes.
        throw Object.assign(new Error(`realpathDeepestAncestorSync: no existing ancestor for ${absPath}`), { code: 'ENOENT' })
      }
      segments.push(basename(cursor))
      cursor = parent
    }
  }
  // Depth ceiling hit — FAIL CLOSED rather than trust a pathological tail.
  throw Object.assign(new Error(`realpathDeepestAncestorSync: path depth exceeds ${_FLOOR_REALPATH_MAX_DEPTH}`), { code: 'ENAMETOOLONG' })
}

// #6921/#6928 — the SYNC open(2)-faithful component-wise resolver (the crux of the
// #6921 floor hardening: it applies `..` AFTER following each symlink, unlike the
// lexical `realpath(resolve(base, target))` shape it replaced) now lives in
// `utils/componentwise-resolver.js`, the SINGLE SOURCE shared with the async BYOK
// confinement path (`ws-file-ops/common.js`). Co-locating the two open(2)-faithful
// walks is what keeps them from drifting again — #6928 was a bug present in BOTH
// copies. Imported as `resolveTargetComponentwiseSync` at the top of this file.

/**
 * #6851 — the pure segment scan, factored out of {@link isProtectedPathValue} so
 * the lexical pass and the symlink-resolved pass share ONE matcher. Given a
 * resolution `base` and an already-resolved absolute `resolved` target, applies
 * the #6806 relative-vs-absolute framing (below) and tests each segment. No fs
 * access — string ops only.
 *
 * #6806 — the discriminator is whether the resolved target stays INSIDE base's
 * own subtree:
 *   - UNDER base → scan the path RELATIVE to base, so base's own prefix segments
 *     (its `.claude`) are excluded and a benign in-workspace write is never
 *     floored. Under-base relatives never contain `..`.
 *   - ESCAPES base (a `..`-traversal ABOVE it — itself suspicious) → scan the
 *     RESOLVED ABSOLUTE path, so a protected segment sitting in base's PREFIX
 *     (the very `.claude/` a worktree lives under, reached by `../../x`) is
 *     caught. The floor only ever forces a PROMPT, so over-flooring a sibling
 *     traversal (already escaping the workspace) is safe and conservative.
 * @param {string} base
 * @param {string} resolved  an absolute path already resolved against base
 * @param {boolean} secretsOnly
 * @returns {boolean}
 */
function _scanResolvedTarget(base, resolved, secretsOnly) {
  const rel = relative(base, resolved)
  // Target is inside base's own subtree when the relative path neither is nor
  // begins with `..` (and isn't a foreign absolute — a Windows cross-drive
  // `relative()` can return one). Empty rel = the target IS base (still "inside").
  const underCwd = rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
  const scanned = underCwd ? rel : resolved
  // Split on BOTH separators (#6928): `scanned` is a native-sep resolved path
  // here, but a separator-agnostic split keeps the segment scan robust to any
  // foreign `\`/`/` that survives (and can never wrongly merge two segments — a
  // filename cannot contain a separator on the platform that produced it).
  const segments = scanned.split(/[/\\]+/)
    .filter((s) => s.length > 0 && s !== '..')
    .map((s) => s.toLowerCase())
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    // Secret files, and credential-dense config files, are floored under BOTH
    // the read and the write floor (PR #6873 review — the read floor must not
    // silently auto-read .git/config, git credentials, or .claude/settings*.json).
    if (isSecretFileSegment(seg)) return true
    if (isCredentialConfigSegment(segments, i)) return true
    if (secretsOnly) continue
    // Config DIRS (any file within them) are floored only under the full (write)
    // floor; a read of a NON-credential config file stays un-prompted.
    if (PROTECTED_DIR_SEGMENTS.has(seg)) return true
    if (seg === '.config' && segments[i + 1] === 'git') return true
  }
  return false
}

/**
 * #6794 / #6806 / #6851 — is a single path value protected, resolved against
 * `base` (the session cwd)?
 *
 * TWO passes, ORed — a hit on EITHER floors the target:
 *   (1) LEXICAL (the pre-#6851 floor, unchanged). `resolve()` absorbs absolute
 *       paths, a leading `./`, and `..` traversal; the resolved path is scanned
 *       segment-by-segment ({@link _scanResolvedTarget}). Pure string ops, no fs
 *       access — fast, and every input the old floor flagged still flags.
 *   (2) #6851/#6921 SYMLINK. The lexical pass is symlink-BLIND: because
 *       `resolve()` collapses `..` textually, a symlink in cwd's PREFIX (the
 *       chroxy agent worktree can live under a *symlink* to a real `.claude/`),
 *       a symlinked COMPONENT of the target, OR a `..` that FOLLOWS a symlinked
 *       component can make a path that lexically looks OUTSIDE a protected dir
 *       RESOLVE INTO `.git`/`.claude`/`.vscode`/`.config/git` or a secret file
 *       (and vice-versa). Pass (2) resolves the base to its real path, then walks
 *       the target COMPONENT BY COMPONENT via
 *       {@link resolveTargetComponentwiseSync} — following each symlink and
 *       applying each `..` against the resolved-so-far REAL path, exactly as
 *       `open(2)` does — and re-runs the SAME segment scan. It only ADDS matches
 *       on top of (1); it never un-floors a lexical hit (pass (1) already
 *       returned). The raw (NOT pre-`resolve`d) target is handed to the walker so
 *       its `..` survives to be applied post-symlink — the #6921 fix. The earlier
 *       #6851 shape (`realpathDeepestAncestorSync(resolve(realBase, target))`)
 *       could not close this: both `resolve()` and Node's `realpathSync` collapse
 *       `..` LEXICALLY, so a `..` after a symlinked component was cancelled before
 *       any symlink was followed.
 *
 * FAIL-CLOSED: any error resolving the real paths (EACCES on a directory, ELOOP
 * on a symlink cycle/depth bomb, an unresolvable base) is treated as PROTECTED —
 * the floor forces the interactive prompt, never assumes the target is safe. The
 * floor only ever forces a PROMPT (never a hard deny), so over-flooring an
 * ambiguous resolution is conservative and correct.
 *
 * #6922 — TOCTOU: this resolution happens at permission-CHECK time and is NOT
 * atomic with the downstream read/write. A symlink anywhere in the path can be
 * swapped between this check and the executor's `open` (e.g. via an un-floored
 * `Bash` step interleaved with the write), so a benign realpath here does not
 * GUARANTEE a benign open later. This floor is defense-in-depth / prompt-only,
 * and chroxy does not own the downstream `open` for SDK/TUI/codex providers, so a
 * fully atomic guard (`openat2(RESOLVE_NO_SYMLINKS)` held across the write) is not
 * achievable at this layer. Do not over-trust the resolved path as an atomic
 * guarantee — see #6922.
 *
 * #6806 — WHICH segments each pass scans, and the #6794 worktree false-positive
 * guard it preserves, live in {@link _scanResolvedTarget}. #6803 —
 * `secretsOnly` narrows the match to SECRET / credential files (the read floor);
 * the full (write) floor passes `secretsOnly = false`.
 * @param {string} target  a path value from a tool input
 * @param {string} base    the resolution base (session cwd)
 * @param {boolean} [secretsOnly]  match only secret / credential files
 * @returns {boolean}
 */
function isProtectedPathValue(target, base, secretsOnly = false) {
  // (1) LEXICAL floor — pre-#6851 behavior, authoritative on a hit (no fs cost).
  const resolvedLexical = resolve(base, target)
  if (_scanResolvedTarget(base, resolvedLexical, secretsOnly)) return true
  // (2) #6851/#6921 SYMLINK floor — resolve the real base, then walk the RAW
  // target component-by-component (open(2) semantics) and re-scan. A resolution
  // error FAILS CLOSED (return true → force the prompt). Runs only on a
  // lexically-clean target (the common benign case), so the fs cost is a couple
  // of realpath/lstat walks per otherwise-auto-approved permission check.
  try {
    // Pass `base` DIRECTLY — never `resolve(base)`. `realpathDeepestAncestorSync`
    // REQUIRES an absolute path and THROWS on a relative one; that guard exists
    // precisely so a relative base can't be silently reframed against the SERVER
    // process cwd (`process.cwd()`) — the WRONG root (the floor must be anchored
    // on the SESSION's cwd). In normal operation `base` IS absolute (the session
    // cwd from the WS client / a worktree dir / the process.cwd() fallback), so
    // this is a no-op; a relative/malformed base hits the throw and FAILS CLOSED
    // (caught below → return true → force the prompt) instead of resolving
    // against process.cwd(). Wrapping in resolve() would defeat BOTH the guard
    // and the wrong-root framing it protects against.
    const realBase = realpathDeepestAncestorSync(base)
    // Pass the RAW `target` (its `..` intact) to the component walker, so a `..`
    // after a symlinked component climbs from the symlink's TARGET, not its
    // lexical parent. Do NOT pre-resolve() it — that would collapse the `..`.
    const realTarget = resolveTargetComponentwiseSync(realBase, target)
    return _scanResolvedTarget(realBase, realTarget, secretsOnly)
  } catch {
    return true
  }
}

/**
 * #6794 — does this tool input target a protected path? Inspects EVERY present
 * {@link PROTECTED_PATH_INPUT_FIELDS} value (a benign `file_path` must not
 * shadow a protected `path`), resolves each against the session cwd (so
 * absolute paths, a leading `./`, and `..` traversal all normalize), then
 * tests the resolved path segment-by-segment. ANY protected field floors the
 * input. See {@link isProtectedPathValue} for the #6806 relative-vs-absolute
 * framing that decides which segments are scanned.
 *
 * #6805/#6828 — codex `apply_patch` carries its per-file targets in an ARRAY:
 * `input.changes` is `FileUpdateChange[] = { path, kind, diff }` (see
 * codex-app-server-session.js `_describeApproval`), with the top-level
 * `file_path` set to the approval's `grantRoot` — typically the benign repo
 * root. Scanning only the flat fields therefore let a member edit under
 * `.git/`/`.env*` escape the floor (and, with a persisted `{apply_patch,
 * allow}` rule from #6771, be durably auto-approved). Every array entry's
 * `path` is now checked with the same matcher — ANY protected member floors
 * the WHOLE request. A string-shaped `changes` (codex's legacy unified-diff
 * `item.patch` passthrough) carries no parseable paths and is skipped, same
 * as any other non-array field.
 *
 * A benign in-workspace write is never floored — a git worktree that itself
 * lives under a real `.claude/` dir writing to `packages/…` stays UNfloored
 * because a target under cwd is scanned relative to cwd (its own `.claude`
 * prefix excluded). But a `..`-traversal back UP into that same `.claude`
 * (`../../settings.local.json` → the real agent config) IS floored, because an
 * above-cwd target is scanned as its resolved ABSOLUTE path (#6806). See
 * {@link isProtectedPathValue} for the full reconciliation.
 *
 * Segment rules (a match on ANY segment floors the write; see
 * {@link isProtectedPathValue} for the lowercase rationale):
 *   - a segment in {@link PROTECTED_DIR_SEGMENTS} (`.git` / `.claude` / `.vscode`)
 *   - a `.config` segment immediately followed by `git` (the XDG git-config dir)
 *   - a segment that is `.env` or starts with `.env.` (`.env` / `.env.local` / …)
 *
 * Returns false for any missing / non-string path field, so a command-shaped
 * tool (Bash, WebFetch) is never floored. Pure + side-effect-free (string ops
 * only — no regex, so the `.env.*` match can't be mangled by later edits).
 *
 * @param {object} input  the tool input
 * @param {string} [cwd]  the session cwd (falls back to process.cwd())
 * @returns {boolean}
 */
export function isProtectedPathTarget(input, cwd) {
  return _matchesFloor(input, cwd, false)
}

/**
 * #6803 — the READ floor: does this tool input target a known SECRET FILE
 * (env file or key material)? Same field-scanning as {@link isProtectedPathTarget}
 * (every present path field + `changes[]`, resolved against cwd) but matches
 * ONLY secret files — the config DIRS (.git/.claude/.vscode/.config/git) are a
 * WRITE concern and are deliberately NOT floored for reads, so a Read/Glob/Grep
 * of a config dir stays a normal, un-prompted operation. handlePermission uses
 * this for {@link SECRET_READ_FLOOR_TOOLS}; every other tool uses the full floor.
 * @param {object} input  the tool input
 * @param {string} [cwd]  the session cwd (falls back to process.cwd())
 * @returns {boolean}
 */
export function isSecretReadTarget(input, cwd) {
  return _matchesFloor(input, cwd, true)
}

/**
 * Shared floor matcher — inspects every present {@link PROTECTED_PATH_INPUT_FIELDS}
 * value AND every `changes[]` member path (codex apply_patch, #6805/#6828),
 * resolving each against the session cwd, and tests it with {@link isProtectedPathValue}.
 * `secretsOnly` selects the read floor (secret files) vs the full write floor
 * (config dirs + secret files). ANY protected field/member floors the input.
 * @param {object} input
 * @param {string} [cwd]
 * @param {boolean} secretsOnly
 * @returns {boolean}
 */
function _matchesFloor(input, cwd, secretsOnly) {
  if (!input || typeof input !== 'object') return false
  const base = (typeof cwd === 'string' && cwd.length > 0) ? cwd : process.cwd()
  for (const field of PROTECTED_PATH_INPUT_FIELDS) {
    if (typeof input[field] !== 'string' || input[field].length === 0) continue
    if (isProtectedPathValue(input[field], base, secretsOnly)) return true
  }
  // #6805/#6828 — walk the array-shaped per-file targets (codex apply_patch).
  if (Array.isArray(input.changes)) {
    for (const change of input.changes) {
      if (!change || typeof change.path !== 'string' || change.path.length === 0) continue
      if (isProtectedPathValue(change.path, base, secretsOnly)) return true
    }
  }
  return false
}

/**
 * #7004 — the floor decision for ONE (tool, input) pair: the tool-aware choice
 * between the read floor and the full write floor, plus the predicate itself.
 * This is the WHOLE floor semantic in one call, so both pipelines can share it
 * verbatim instead of re-deriving "which floor applies to which tool":
 *
 *   - {@link SECRET_READ_FLOOR_TOOLS} (Read / Glob / Grep — non-mutating) are
 *     floored ONLY on secret + credential files ({@link isSecretReadTarget});
 *     reading a config dir stays benign and un-prompted.
 *   - EVERY other tool (the mutating ones, and any future/unknown tool) gets the
 *     full config-dir + secret floor ({@link isProtectedPathTarget}) — defaulting
 *     the unknown case to the STRONGER floor is fail-safe.
 *
 * A `true` return means "must not be silently auto-approved" — it forces the
 * interactive PROMPT. It is never a deny: the floor only ever removes a
 * short-circuit, so a false positive costs one prompt, never access.
 *
 * @param {string} toolName  the tool requesting permission
 * @param {object} input     the tool input
 * @param {string} [cwd]     the session cwd (the floor's resolution base)
 * @returns {boolean} true when the target is floored (prompt required)
 */
export function isFlooredTarget(toolName, input, cwd) {
  return SECRET_READ_FLOOR_TOOLS.has(toolName)
    ? isSecretReadTarget(input, cwd)
    : isProtectedPathTarget(input, cwd)
}
