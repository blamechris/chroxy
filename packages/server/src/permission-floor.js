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
// The env-file family: exactly `.env`, or `.env.` followed by anything. Named so
// the #7978 glob analysis below builds its templates from the same two spellings
// isSecretFileSegment tests, rather than from a second copy of them.
const ENV_FILE_NAME = '.env'
const ENV_FILE_PREFIX = '.env.'

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
  if (seg === ENV_FILE_NAME || seg.startsWith(ENV_FILE_PREFIX)) return true
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
  // .git/config (PAT-embedded remote URLs), .git/credentials (git store), and
  // the XDG equivalents under .config/git/.
  for (const sequence of CREDENTIAL_CONFIG_SEQUENCES) {
    if (sequence.every((name, k) => segments[i + k] === name)) return true
  }
  // .claude/settings*.json (settings.json / settings.local.json — may hold keys).
  const child = segments[i + 1]
  if (segments[i] === CLAUDE_SETTINGS_DIR && typeof child === 'string' &&
      child.startsWith(CLAUDE_SETTINGS_PREFIX) && child.endsWith(CLAUDE_SETTINGS_SUFFIX)) return true
  return false
}

// The credential-dense config files above, as data (#7978) so the Grep glob
// analysis derives its templates from the same spellings this matcher uses.
const CREDENTIAL_CONFIG_SEQUENCES = [
  ['.git', 'config'], ['.git', 'credentials'],
  ['.config', 'git', 'config'], ['.config', 'git', 'credentials'],
]
const CLAUDE_SETTINGS_DIR = '.claude'
const CLAUDE_SETTINGS_PREFIX = 'settings'
const CLAUDE_SETTINGS_SUFFIX = '.json'

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

// ---------------------------------------------------------------------------
// #7978 — Grep's FILE-SELECTING `glob` field.
//
// The path fields above say WHERE a Grep searches; `glob` says WHICH FILES in
// there it reads, and it is the stronger of the two. Every Grep implementation
// Chroxy fronts runs ripgrep, and an include glob OVERRIDES ripgrep's ignore
// rules: `rg --glob=.env -e X -- .` reads a gitignored `.env`, and so do `*`,
// `**`, `sub/*`, `.e?v` and `*env*`. Claude Code's own Grep always passes
// `--hidden`, so ripgrep's hidden-file filter is no barrier there; `.gitignore`
// is the only one, and a glob walks straight through it. `*.json` is the
// ordinary case, not the exotic one: it reads the `.claude/settings.local.json`
// that Claude Code gitignores by default. Measured with ripgrep 15.2.0.
//
// Scanning only `path` therefore let `Grep({path: '.', glob: '.env'})` read
// secrets while the floor answered "not floored", and a lenient mode then
// auto-approved it.
//
// WHAT FLOORS. First, anything outside a small grammar floors unanalyzed:
// ASCII letters, digits, `. _ - / !`, whitespace, `*`, `**`, `?`, and `{a,b}`
// groups that hold at least one comma. A class, an escape, a single-alternative
// or empty brace, or any non-ASCII character floors (GLOB_FLOOR_ANALYZABLE
// says why). A glob inside the grammar is taken apart the way ripgrep takes it
// (a pattern without a `/` matches a basename at any depth) and intersected with
// TEMPLATES built from the floor's own name sets above. It floors when it can
// match:
//   (a) an EXACT secret path, however it gets there: `.env`, SECRET_FILE_EXACT,
//       the CREDENTIAL_CONFIG_SEQUENCES, `.claude/settings{,.local}.json`, plus
//       the common real-world names in the two witness lists below. `*`, `**`,
//       `sub/*`, `*.json` and `*test*` all floor here;
//   (b) a member of a secret FAMILY — `.env.<tail>`, `<stem><secret ext>`,
//       `.claude/settings<mid>.json` — PROVIDED at least one character of the
//       family's defining part (`.env`, the extension, the settings skeleton) is
//       matched by something other than `*`/`**`. `.e?v.*`, `.env.????`,
//       `?.pem` and `*v.*` floor here.
//
// THE ONE ACCEPTED RESIDUAL, stated because (b) is where it lives. `*.ts` can
// match `.env.ts`, a name the floor counts as a secret. It does so only by
// letting `*` swallow the whole of `.env`, so it does not floor: a strictly
// sound rule would floor every extension filter (`*.ts`, `*.py`) and prompt on
// nearly every globbed Grep in a lenient mode. What still gets through is an
// extension or stem filter aimed at a GITIGNORED secret whose name is none of
// the witnesses — `*.ts` reading a gitignored `.env.ts`. The witness lists
// exist to keep that set to unusual names. The same mechanism applies to a
// DIRECTORY: `{*.d,*.conf}` can re-include a gitignored `.env.d/` and read its
// `app.conf`, because `*` swallowed the `.env`.
//
// NOT COVERED, and not this field's job: a Grep with no glob reads every file
// the ignore rules let through, secrets included when they are not gitignored.
// That is the directory-grep limit of a path floor, unchanged here. Grep's
// `type` field is not inspected because ripgrep's type filters RESPECT
// `.gitignore` (measured: `-t sh` does not read a gitignored `.env`, though the
// `sh` type lists it), so they select nothing a plain Grep does not. Glob's
// `pattern` is not inspected either: it returns names, never contents.

/**
 * Tools whose input carries a file-selecting `glob` the floor inspects. The
 * shell hook's negative pre-filter keys on these NAMES (a `"Grep"` payload must
 * reach the daemon even with no path field) — tests/permission-hook-floor.test.js
 * asserts the hook matches every member.
 */
export const GLOB_SELECTOR_FLOOR_TOOLS = new Set(['Grep'])

// Common real-world secret names that only a (b)-exempt glob — one that
// constrains the tail or the stem, not the defining part — could otherwise
// reach. Each must be a secret by the floor's OWN predicate (asserted in
// tests/permission-floor-grep-glob.test.js), so this list can only ever add
// floors to names the floor already protects; it cannot widen what counts as a
// secret. Missing a name here reopens only the residual described above.
const ENV_TAIL_WITNESSES = [
  'local', 'development', 'production', 'test', 'staging', 'dev', 'prod',
  'example', 'sample', 'ci', 'qa', 'uat', 'preview', 'backup', 'bak', 'old',
  'secret', 'secrets', 'docker', 'development.local', 'production.local', 'test.local',
]
const KEY_STEM_WITNESSES = ['server', 'private', 'privkey', 'key', 'cert', 'fullchain', 'tls', 'client', 'ca', 'id']

/**
 * The floor's secret-name sets, read-only, so tests can derive their corpus
 * from the floor instead of restating it (tests/permission-floor-grep-glob.test.js).
 */
export const FLOOR_SECRET_NAMES = Object.freeze({
  envName: ENV_FILE_NAME,
  envPrefix: ENV_FILE_PREFIX,
  exact: Object.freeze([...SECRET_FILE_EXACT]),
  extensions: Object.freeze([...SECRET_FILE_EXTENSIONS]),
  credentialConfigPaths: Object.freeze(CREDENTIAL_CONFIG_SEQUENCES.map((sequence) => sequence.join('/'))),
  claudeSettings: Object.freeze({ dir: CLAUDE_SETTINGS_DIR, prefix: CLAUDE_SETTINGS_PREFIX, suffix: CLAUDE_SETTINGS_SUFFIX }),
  envTailWitnesses: Object.freeze([...ENV_TAIL_WITNESSES]),
  keyStemWitnesses: Object.freeze([...KEY_STEM_WITNESSES]),
})

// Bounds on the analysis. Past any one the glob FLOORS (fail closed): a
// pathological glob is not something to analyze at length on the hot path.
// An ordinary glob visits ~10K search states (~1ms); the largest legitimate
// shapes the caps allow visit ~450K (~9ms). A crafted glob can still multiply
// states — `(**q)` repeated 330 times visited 5.8M (71ms, synchronous on the
// daemon's event loop) — so one Grep call gets a shared STATE budget, and
// running out of it floors (PR #7980 review).
const GLOB_FLOOR_MAX_LENGTH = 1024
const GLOB_FLOOR_MAX_ALTERNATIVES = 64
const GLOB_FLOOR_MAX_EXPANDED_LENGTH = 4096
const GLOB_FLOOR_MAX_STATES = 1_000_000

let _globFloorTemplates = null

/**
 * The templates a Grep glob is intersected with, built once from the floor's
 * own sets. A template is a list of elements over a lowercased path:
 *   { kind: 'lit', ch, core }  one fixed character (`core`: part of a family's
 *                               defining text, see (b) above)
 *   { kind: 'one' }            exactly one non-`/` character
 *   { kind: 'star', slash }    any run of characters (`/` too when `slash`)
 * Every template also gets an any-directory-prefix variant, because a secret can
 * sit at any depth under the searched root.
 * @returns {{ elems: object[], requireCore: boolean }[]}
 */
function globFloorTemplates() {
  if (_globFloorTemplates) return _globFloorTemplates
  const lit = (text, core) => [...text].map((ch) => ({ kind: 'lit', ch, core }))
  const oneOrMore = [{ kind: 'one' }, { kind: 'star', slash: false }]
  const base = []
  const exact = (path) => base.push({ elems: lit(path, false), requireCore: false })

  exact(ENV_FILE_NAME)
  for (const name of SECRET_FILE_EXACT) exact(name)
  for (const sequence of CREDENTIAL_CONFIG_SEQUENCES) exact(sequence.join('/'))
  for (const name of ['', '.local']) {
    exact(`${CLAUDE_SETTINGS_DIR}/${CLAUDE_SETTINGS_PREFIX}${name}${CLAUDE_SETTINGS_SUFFIX}`)
  }
  for (const tail of ENV_TAIL_WITNESSES) exact(ENV_FILE_PREFIX + tail)
  for (const stem of KEY_STEM_WITNESSES) {
    for (const ext of SECRET_FILE_EXTENSIONS) exact(stem + ext)
  }

  // Families. The `.` that ends ENV_FILE_PREFIX is a separator, not part of the
  // env-ness, so it is NOT core — otherwise `*.ts` would spell it and floor.
  base.push({
    elems: [...lit(ENV_FILE_NAME, true), ...lit('.', false), ...oneOrMore],
    requireCore: true,
  })
  for (const ext of SECRET_FILE_EXTENSIONS) {
    base.push({ elems: [...oneOrMore, ...lit(ext, true)], requireCore: true })
  }
  base.push({
    elems: [
      ...lit(`${CLAUDE_SETTINGS_DIR}/${CLAUDE_SETTINGS_PREFIX}`, true),
      { kind: 'star', slash: false },
      ...lit(CLAUDE_SETTINGS_SUFFIX, true),
    ],
    requireCore: true,
  })

  const anyDirectory = [{ kind: 'star', slash: true }, { kind: 'lit', ch: '/', core: false }]
  _globFloorTemplates = base.flatMap((t) => [t, { elems: [...anyDirectory, ...t.elems], requireCore: t.requireCore }])
  return _globFloorTemplates
}

// The only characters the analysis models (PR #7980 review). Anything else in a
// glob — a `[...]` class, a `\` escape, any non-ASCII character
// (ripgrep trims trailing Unicode whitespace such as U+0085 that `\s` does not
// match) — FLOORS without analysis. Four independent mismatches with ripgrep's
// globset were found in exactly those constructs (a class matching `/`, `\`
// being literal inside a class, chained ranges, a `,` inside a class inside a
// brace group), so the parser does not try to be globset: it recognizes a small
// grammar and refuses the rest. The ordinary filters (`*.ts`, `*.{ts,tsx}`,
// `src/**/*.py`) are all inside it.
// A `!` past the first character is a literal to ripgrep (only a LEADING `!`
// negates, and classes are excluded), so it is kept.
const GLOB_FLOOR_ANALYZABLE = /^[A-Za-z0-9._/*?{},!\- \t\n\r\v\f]*$/
// Claude Code passes each whitespace/comma piece as its own --glob; past this
// many pieces the call floors rather than analyze each one.
const GLOB_FLOOR_MAX_PIECES = 32

/**
 * Expand `{a,b}` alternatives (nested too). Every `{` must close and hold at
 * least one top-level comma: ripgrep treats `{x}` and `{}` as a real
 * alternation (`{.env}` reads `.env`), so a brace this function cannot expand
 * is not "literal text" — the caller floors it. Returns null for an unmatched
 * or comma-less brace, a stray `}`, or past {@link GLOB_FLOOR_MAX_ALTERNATIVES}.
 * Runs only on {@link GLOB_FLOOR_ANALYZABLE} input, so there is no `[` or `\`
 * that could hide a brace or a comma.
 * @param {string} glob
 * @returns {string[] | null}
 */
function expandGlobBraces(glob) {
  const open = glob.indexOf('{')
  if (open === -1) return glob.includes('}') ? null : [glob]
  if (glob.slice(0, open).includes('}')) return null
  let depth = 0
  const commas = []
  let close = -1
  for (let i = open; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { close = i; break }
    } else if (ch === ',' && depth === 1) commas.push(i)
  }
  if (close === -1 || commas.length === 0) return null
  const head = glob.slice(0, open)
  const tail = glob.slice(close + 1)
  const bounds = [open, ...commas, close]
  const out = []
  for (let k = 0; k < bounds.length - 1; k++) {
    const expanded = expandGlobBraces(head + glob.slice(bounds[k] + 1, bounds[k + 1]) + tail)
    if (expanded === null) return null
    out.push(...expanded)
    if (out.length > GLOB_FLOOR_MAX_ALTERNATIVES) return null
  }
  return out
}

/**
 * Tokenize one brace-free alternative of an analyzable glob: `*`, `**`, `?`
 * and literals. `**` anywhere is a cross-directory wildcard and swallows a
 * following `/` (so `a/**\/b` still matches `a/b`); treating a non-segment `**`
 * that way only ever admits more, i.e. floors more.
 * @param {string} glob
 * @returns {object[]}
 */
function tokenizeGlob(glob) {
  const tokens = []
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        while (glob[i + 1] === '*') i++
        if (glob[i + 1] === '/') i++
        // `**/**/` matches exactly what `**/` does; collapsing the run keeps a
        // 330-deep repetition from costing 20ms of search (PR #7980 review).
        if (tokens.length === 0 || tokens[tokens.length - 1].kind !== 'globstar') tokens.push({ kind: 'globstar' })
      } else {
        tokens.push({ kind: 'star' })
      }
    } else if (ch === '?') {
      tokens.push({ kind: 'any' })
    } else {
      tokens.push({ kind: 'lit', ch })
    }
  }
  return tokens
}

/**
 * Can glob token `tok` consume the (lowercase) template character `ch`? The
 * floor lowercases names, so a literal admits `ch` when it lowercases to it.
 */
function _tokenAdmits(tok, ch) {
  switch (tok.kind) {
    case 'lit': return tok.ch.toLowerCase() === ch
    case 'any': case 'star': return ch !== '/'
    case 'globstar': return true
    default: return true
  }
}

/**
 * Is there a string that both the glob `tokens` and template `t` match — and,
 * when `t.requireCore`, one where some `core` character is consumed by a token
 * other than `*`/`**`? A search over (glob position, template position, core
 * seen) — at most (|tokens|+1) x (|template|+1) x 2 states. Every state visited
 * is charged to `budget`; past it the answer is null, which the caller floors.
 * @returns {boolean | null}
 */
function _globMatchesTemplate(tokens, t, budget) {
  const elems = t.elems
  const G = tokens.length
  const T = elems.length
  const seen = new Uint8Array((G + 1) * (T + 1) * 2)
  const stack = [0, 0, 0]
  while (stack.length > 0) {
    const core = stack.pop()
    const ti = stack.pop()
    const gi = stack.pop()
    const key = (gi * (T + 1) + ti) * 2 + core
    if (seen[key]) continue
    seen[key] = 1
    if (--budget.left < 0) return null
    if (gi === G && ti === T && (core === 1 || !t.requireCore)) return true
    const g = gi < G ? tokens[gi] : null
    const e = ti < T ? elems[ti] : null
    const gRepeats = g !== null && (g.kind === 'star' || g.kind === 'globstar')
    // A wildcard on either side may match nothing.
    if (gRepeats) stack.push(gi + 1, ti, core)
    if (e !== null && e.kind === 'star') stack.push(gi, ti + 1, core)
    if (g === null || e === null) continue
    // Or both consume one character.
    let joint
    if (e.kind === 'lit') joint = _tokenAdmits(g, e.ch)
    else if (e.kind === 'star' && e.slash) joint = true
    else joint = g.kind !== 'lit' || g.ch !== '/'
    if (!joint) continue
    const nextCore = (core === 1 || (e.kind === 'lit' && e.core && !gRepeats)) ? 1 : 0
    stack.push(gRepeats ? gi : gi + 1, e.kind === 'star' ? ti : ti + 1, nextCore)
  }
  return false
}

/**
 * #7978 — can a single ripgrep glob select a secret file? See the section
 * comment above for exactly what floors and the one accepted residual. Trailing
 * ASCII whitespace is trimmed, as ripgrep trims it; LEADING whitespace is kept,
 * because ripgrep keeps it (` !x` is a literal include, not an exclusion). A
 * leading `!` only excludes, so it never floors. Outside
 * {@link GLOB_FLOOR_ANALYZABLE}, with a brace that does not expand, past a size
 * cap, or once `budget` runs out, the glob floors without a full analysis.
 * @param {string} glob
 * @param {{ left: number }} [budget]  search states left; shared across one Grep call
 * @returns {boolean}
 */
export function globSelectsSecret(glob, budget = { left: GLOB_FLOOR_MAX_STATES }) {
  if (typeof glob !== 'string') return true
  if (glob.length > GLOB_FLOOR_MAX_LENGTH) return true
  const trimmed = glob.replace(/[ \t\n\r\v\f]+$/, '')
  if (trimmed.length === 0) return false
  if (trimmed.startsWith('!')) return false
  if (!GLOB_FLOOR_ANALYZABLE.test(trimmed)) return true
  const alternatives = expandGlobBraces(trimmed)
  if (alternatives === null) return true
  if (alternatives.reduce((sum, alt) => sum + alt.length, 0) > GLOB_FLOOR_MAX_EXPANDED_LENGTH) return true
  const templates = globFloorTemplates()
  for (let alt of alternatives) {
    // Anchors: ripgrep roots a leading `/` at the search root, and `./` names
    // the same place. Both only narrow where a match can sit; drop them.
    while (alt.startsWith('/') || alt.startsWith('./')) alt = alt.startsWith('/') ? alt.slice(1) : alt.slice(2)
    // A trailing `/` means "directories only", and ripgrep drops it BEFORE it
    // decides whether the glob is anchored: `.env/` behaves as `**/.env` and
    // re-includes a gitignored `.env/` directory for another piece to read
    // from (PR #7980 review). Drop it here too, before the same decision.
    while (alt.endsWith('/')) alt = alt.slice(0, -1)
    if (alt.length === 0) continue
    const tokens = tokenizeGlob(alt)
    // Without a `/`, ripgrep matches the basename at any depth: try the glob
    // both against a top-level name and behind an arbitrary directory.
    const variants = alt.includes('/')
      ? [tokens]
      : [tokens, [{ kind: 'globstar' }, { kind: 'lit', ch: '/' }, ...tokens]]
    for (const variant of variants) {
      for (const t of templates) {
        const hit = _globMatchesTemplate(variant, t, budget)
        if (hit !== false) return true
      }
    }
  }
  return false
}

/**
 * #7978 — do a Grep input's `glob` values select a secret? Claude Code splits
 * the field on whitespace and then on commas (unless the piece holds a `{...}`
 * group) and passes each piece as its own `--glob`; the BYOK executor passes
 * the whole string as ONE `--glob`. Both readings are checked, and either one
 * flooring floors the input. A `glob` that is present but not a string floors:
 * the floor cannot say what an executor would make of it. So does one too long
 * to split, or one that splits into more than {@link GLOB_FLOOR_MAX_PIECES}.
 * @param {object} input
 * @returns {boolean}
 */
function grepGlobFloored(input) {
  const glob = input.glob
  if (glob === undefined || glob === null) return false
  if (typeof glob !== 'string') return true
  if (glob.length > GLOB_FLOOR_MAX_LENGTH) return true
  const readings = new Set([glob])
  for (const piece of glob.split(/\s+/)) {
    if (piece.includes('{') && piece.includes('}')) readings.add(piece)
    else for (const part of piece.split(',')) readings.add(part)
    if (readings.size > GLOB_FLOOR_MAX_PIECES) return true
  }
  const budget = { left: GLOB_FLOOR_MAX_STATES }
  for (const reading of readings) {
    if (globSelectsSecret(reading, budget)) return true
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
  if (!SECRET_READ_FLOOR_TOOLS.has(toolName)) return isProtectedPathTarget(input, cwd)
  if (isSecretReadTarget(input, cwd)) return true
  // #7978 — Grep's `glob` picks WHICH files it reads, overriding .gitignore.
  return GLOB_SELECTOR_FLOOR_TOOLS.has(toolName) &&
    input !== null && typeof input === 'object' && grepGlobFloored(input)
}
