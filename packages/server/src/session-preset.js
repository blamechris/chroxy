/**
 * Per-repo session presets (#5553).
 *
 * Two channels, both optional, configured per repo:
 *
 *   1. PREAMBLE (system-prompt channel — model-facing, every turn): a per-repo
 *      string folded into the session's `sessionPreamble` ctor opt at create
 *      time. Concatenates with any caller-supplied session-level preamble —
 *      REPO FIRST — and the combined result is capped at
 *      SESSION_PREAMBLE_MAX_LENGTH (4000). The cap is checked at READ time and
 *      flagged (`capped: true`); we never silently truncate behind the
 *      operator's back.
 *   2. SEED (conversation channel — operator-facing, once): a per-repo template
 *      staged EDITABLE into the new session's composer on create. Never
 *      auto-sent — the client drains it through the existing seed path.
 *
 * Sources (walk-up + daemon override):
 *   - Repo-local: `.chroxy/session.json` at the repo root (sibling of
 *     `.chroxy/skills/`). Walk up from `session.cwd` like the skills loader
 *     (worktrees inherit the parent repo's preset via the same walk).
 *   - Daemon-side override: `repos: { "<repo-path>": { sessionPreset: {...} } }`
 *     in `~/.chroxy/config.json`. The daemon entry WINS over the repo file —
 *     explicit local intent beats a checked-in default.
 *
 * Trust (the prompt-injection gate — mirrors the skills trust model):
 *   A repo-local file that silently feeds the system prompt is a
 *   prompt-injection vector for cloned/collaborative repos. So the FIRST time a
 *   repo-local preset (or a CHANGED content hash) is seen it is INERT and
 *   surfaced as pending; an approval path (`approve`) marks the hash trusted.
 *   Daemon-side override entries are PRE-TRUSTED — the operator wrote them in
 *   their own config. Trust state lives in a sidecar
 *   `~/.chroxy/session-preset-trust.json` next to the skills trust ledger.
 *
 * Leak guard: errors NEVER echo preset contents. Failures fail closed (preset
 * treated as absent) and log only a sanitised path label.
 */
import { statSync, readFileSync, realpathSync } from 'fs'
import { dirname, join, resolve, basename } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { createLogger } from './logger.js'

const log = createLogger('session-preset')

// The preamble cap mirrors base-session.js's SESSION_PREAMBLE_MAX_LENGTH. The
// repo preamble counts toward this when CONCATENATED with any session-level
// preamble (repo first). Re-declared here (rather than imported) so this module
// stays loadable without pulling the whole BaseSession graph; the tests assert
// the two stay equal.
export const SESSION_PREAMBLE_MAX_LENGTH = 4000

// Hard cap on the seed length — generous (a templated first message), but
// bounded so a hostile/oversized file can't balloon the create payload.
export const SESSION_SEED_MAX_LENGTH = 8000

// The repo-local preset file, relative to a repo root.
export const PRESET_FILENAME = 'session.json'
export const PRESET_DIR = '.chroxy'

// Per-file size cap so a giant file is rejected before parse.
const MAX_PRESET_FILE_BYTES = 64 * 1024

// Cap walk-up iterations — a safety belt; real repos are nowhere near this deep.
const REPO_DISCOVERY_MAX_DEPTH = 100

export const DEFAULT_CONFIG_PATH = join(homedir(), '.chroxy', 'config.json')
export const DEFAULT_PRESET_TRUST_FILE = join(homedir(), '.chroxy', 'session-preset-trust.json')

const _PATH_COMPARE_CASE_INSENSITIVE =
  process.platform === 'darwin' || process.platform === 'win32'

function _sameAbsolutePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  let x = a
  let y = b
  if (_PATH_COMPARE_CASE_INSENSITIVE) {
    x = x.toLowerCase()
    y = y.toLowerCase()
  }
  return x === y
}

/**
 * Normalise a path key for the trust ledger / override-map lookup. Lower-cases
 * on case-insensitive filesystems (macOS/Windows) so the same repo resolves to
 * the same key regardless of the casing realpath returned.
 *
 * @param {string} p
 * @returns {string}
 */
export function _normalizePathKey(p) {
  if (typeof p !== 'string') return ''
  return _PATH_COMPARE_CASE_INSENSITIVE ? p.toLowerCase() : p
}

/**
 * SHA-256 hex digest of the canonical preset content (preamble + seed +
 * enabled). The hash is what the trust ledger pins — any change to the
 * model-facing or operator-facing text re-gates the preset.
 *
 * @param {{ preamble?: string, seed?: string, enabled?: boolean }} preset
 * @returns {string} 64-char lower-case hex
 */
export function presetContentHash(preset) {
  const canonical = JSON.stringify({
    preamble: typeof preset?.preamble === 'string' ? preset.preamble : '',
    seed: typeof preset?.seed === 'string' ? preset.seed : '',
    enabled: preset?.enabled !== false,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Sanitised path label for logs — basename plus an 8-char path hash so the
 * full absolute path never fans out to paired WS clients via log_entry (same
 * anti-leak pattern as the skills loader's `_pathLabel`).
 *
 * @param {string} absPath
 * @returns {string}
 */
function _pathLabel(absPath) {
  const name = (() => {
    try { return basename(absPath) } catch { return 'session.json' }
  })()
  const hash = createHash('sha256').update(String(absPath)).digest('hex').slice(0, 8)
  return `${name}#${hash}`
}

/**
 * Validate + coerce a raw preset object into the canonical shape. Returns
 * `{ preamble, seed, enabled, capped, preambleLength, seedLength }` or `null`
 * when the object is unusable (not an object, or has no usable channels).
 *
 * Caps: the preamble is checked against SESSION_PREAMBLE_MAX_LENGTH *here*, but
 * the authoritative cap is over the CONCATENATED (repo + session-level)
 * preamble — see `foldPreamble`. We flag `capped` when the repo preamble alone
 * already exceeds the cap so the read-time surface can warn; we do NOT truncate.
 *
 * Trimming policy mirrors base-session's `_coerceSessionPreambleOpt`: trim
 * whitespace; an all-whitespace value becomes empty.
 *
 * @param {unknown} raw
 * @returns {null | {
 *   preamble: string,
 *   seed: string,
 *   enabled: boolean,
 *   capped: boolean,
 *   preambleLength: number,
 *   seedLength: number,
 * }}
 */
export function validatePreset(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const preambleRaw = typeof raw.preamble === 'string' ? raw.preamble.trim() : ''
  const seedRaw = typeof raw.seed === 'string' ? raw.seed.trim() : ''
  // `enabled` defaults to true (an authored preset is on unless explicitly
  // disabled). Only an explicit `false` disables it.
  const enabled = raw.enabled !== false

  // A preset with neither channel is not usable.
  if (!preambleRaw && !seedRaw) return null

  let capped = false
  const preamble = preambleRaw
  if (preamble.length > SESSION_PREAMBLE_MAX_LENGTH) {
    // Flag — do NOT silently truncate. The fold step enforces the hard cap
    // over the concatenated result; here we only surface that the repo
    // preamble alone is over budget so the UI can warn before approval.
    capped = true
  }

  let seed = seedRaw
  if (seed.length > SESSION_SEED_MAX_LENGTH) {
    seed = seed.slice(0, SESSION_SEED_MAX_LENGTH)
    capped = true
  }

  return {
    preamble,
    seed,
    enabled,
    capped,
    preambleLength: preamble.length,
    seedLength: seed.length,
  }
}

/**
 * Concatenate a repo preamble with a caller-supplied session-level preamble —
 * REPO FIRST — and enforce the hard SESSION_PREAMBLE_MAX_LENGTH cap on the
 * combined result. Returns `{ value, capped }`. The cap is enforced at WRITE
 * time (session create) so the runtime never has to truncate. We truncate the
 * combined string here ONLY as a final defensive belt; the caller surfaces
 * `capped` to the operator so the truncation is never invisible.
 *
 * @param {string} repoPreamble
 * @param {string} sessionPreamble
 * @returns {{ value: string, capped: boolean }}
 */
export function foldPreamble(repoPreamble, sessionPreamble) {
  const repo = typeof repoPreamble === 'string' ? repoPreamble.trim() : ''
  const session = typeof sessionPreamble === 'string' ? sessionPreamble.trim() : ''
  let combined
  if (repo && session) combined = `${repo}\n\n${session}`
  else combined = repo || session
  let capped = false
  if (combined.length > SESSION_PREAMBLE_MAX_LENGTH) {
    combined = combined.slice(0, SESSION_PREAMBLE_MAX_LENGTH)
    capped = true
  }
  return { value: combined, capped }
}

/**
 * Walk up from `cwd` looking for the nearest `.chroxy/session.json` file
 * (#5553). Mirrors `findRepoSkillsDir` — same ergonomic walk so a session
 * whose cwd is a subfolder (or a worktree) of a repo still picks up the
 * repo-root preset. Stops at `$HOME`, the filesystem root, or after
 * REPO_DISCOVERY_MAX_DEPTH iterations.
 *
 * Returns the absolute path to the nearest file, or null when none is found.
 *
 * @param {string|null|undefined} cwd
 * @returns {string|null}
 */
export function findRepoPresetFile(cwd) {
  if (!cwd || typeof cwd !== 'string') return null

  let dir
  try {
    dir = resolve(cwd)
  } catch {
    return null
  }

  const home = (() => {
    try { return resolve(homedir()) } catch { return null }
  })()

  let prev = null
  let iterations = 0
  while (dir !== prev && iterations < REPO_DISCOVERY_MAX_DEPTH) {
    const candidate = join(dir, PRESET_DIR, PRESET_FILENAME)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not present at this level — keep walking.
    }
    // Stop the walk at $HOME so we never treat `~/.chroxy/session.json` as a
    // repo-scoped preset. Real repos don't live above $HOME.
    if (home && _sameAbsolutePath(dir, home)) return null
    prev = dir
    dir = dirname(dir)
    iterations++
  }
  return null
}

/**
 * Read + validate the repo-local preset file at `absPath`. Returns the
 * validated preset (with the realpath attached) or null on any failure. Fail
 * closed: a missing / malformed / oversized / non-text file is treated as no
 * preset, and the error NEVER echoes file content — only a sanitised label.
 *
 * @param {string} absPath
 * @returns {null | (ReturnType<typeof validatePreset> & { path: string })}
 */
export function readRepoPresetFile(absPath) {
  if (!absPath || typeof absPath !== 'string') return null

  let realPath
  try {
    realPath = realpathSync(absPath)
  } catch (err) {
    const code = (err && typeof err.code === 'string') ? err.code : 'UNKNOWN'
    if (code !== 'ENOENT') log.warn(`Session preset realpath failed (${code}) for ${_pathLabel(absPath)}`)
    return null
  }

  let st
  try {
    st = statSync(realPath)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  if (typeof st.size === 'number' && st.size > MAX_PRESET_FILE_BYTES) {
    log.warn(`Session preset ${_pathLabel(realPath)} exceeds size cap (${st.size} > ${MAX_PRESET_FILE_BYTES}); ignoring`)
    return null
  }

  let raw
  try {
    raw = readFileSync(realPath, 'utf8')
  } catch {
    return null
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Leak guard: do NOT include the parse error message — JSON parse errors
    // interpolate the offending bytes into the message.
    log.warn(`Session preset ${_pathLabel(realPath)} is malformed JSON; ignoring`)
    return null
  }

  const validated = validatePreset(parsed)
  if (!validated) return null
  return { ...validated, path: realPath }
}

/**
 * Locate the `repos[]` config entry whose `path` matches `repoPath`
 * (path-normalised). Returns the raw entry object or null. Exported (`_`
 * prefix) so the write path can read-modify-write the same array.
 *
 * @param {string} repoPath
 * @param {string} [configPath]
 * @returns {object|null}
 */
export function _findRepoConfigEntry(repoPath, configPath = DEFAULT_CONFIG_PATH) {
  if (!repoPath || typeof repoPath !== 'string') return null
  let raw
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.repos)) return null
  const wantKey = _normalizePathKey(_resolveSafe(repoPath))
  for (const r of raw.repos) {
    if (!r || typeof r !== 'object' || typeof r.path !== 'string') continue
    if (_normalizePathKey(_resolveSafe(r.path)) === wantKey) return r
  }
  return null
}

function _resolveSafe(p) {
  try { return resolve(p) } catch { return p }
}

/**
 * Read the daemon-side override preset for a single repo path from
 * `~/.chroxy/config.json`: `repos[].sessionPreset` keyed by repo path. Returns
 * the validated override preset for `repoPath` (path-normalised match), or null.
 *
 * @param {string} repoPath
 * @param {string} [configPath]
 * @returns {null | ReturnType<typeof validatePreset>}
 */
export function readDaemonOverride(repoPath, configPath = DEFAULT_CONFIG_PATH) {
  const entry = _findRepoConfigEntry(repoPath, configPath)
  if (!entry || !entry.sessionPreset) return null
  return validatePreset(entry.sessionPreset)
}

/**
 * Resolve the effective preset for a session cwd, applying source precedence
 * and the trust gate. Returns a descriptor the caller folds into the session
 * (or null when there is no preset at all).
 *
 * Precedence: the daemon-side override (pre-trusted) WINS over the repo-local
 * file. When only a repo-local file exists, the trust store decides whether it
 * is `trusted` (and therefore active) or `pending` (inert until approved).
 *
 * The returned descriptor's `active` flag is the single signal the caller uses
 * to decide whether to FOLD the preamble + stage the seed. A `pending` preset
 * is `active: false` — surfaced to the client for disclosure/approval, never
 * injected.
 *
 * @param {string|null|undefined} cwd
 * @param {{
 *   trustStore?: SessionPresetTrustStore | null,
 *   configPath?: string,
 * }} [opts]
 * @returns {null | {
 *   source: 'daemon' | 'repo',
 *   active: boolean,
 *   trustState: 'trusted' | 'pending',
 *   enabled: boolean,
 *   preamble: string,
 *   seed: string,
 *   preambleLength: number,
 *   seedLength: number,
 *   capped: boolean,
 *   hash: string,
 *   repoPath: string | null,
 *   path: string | null,
 * }}
 */
export function resolveSessionPreset(cwd, opts = {}) {
  const trustStore = opts.trustStore || null
  const configPath = opts.configPath || DEFAULT_CONFIG_PATH

  // 1. Locate the repo root (the dir holding `.chroxy/session.json`) via the
  //    walk-up. We need it for BOTH the repo-file read and the daemon override
  //    lookup key. When there's no repo-local file we still attempt a daemon
  //    override keyed by the walked-up repo root OR the raw cwd.
  const presetFile = findRepoPresetFile(cwd)
  const repoRoot = presetFile ? dirname(dirname(presetFile)) : (cwd ? _resolveSafe(cwd) : null)

  // 2. Daemon override wins. Look it up by the repo root first, then the raw
  //    cwd (operators key by the repo dir they pass to `chroxy`).
  let override = null
  let overrideKey = null
  if (repoRoot) {
    override = readDaemonOverride(repoRoot, configPath)
    if (override) overrideKey = _resolveSafe(repoRoot)
  }
  if (!override && cwd) {
    const byCwd = readDaemonOverride(cwd, configPath)
    if (byCwd) { override = byCwd; overrideKey = _resolveSafe(cwd) }
  }
  if (override) {
    return {
      source: 'daemon',
      active: override.enabled,
      trustState: 'trusted',
      enabled: override.enabled,
      preamble: override.preamble,
      seed: override.seed,
      preambleLength: override.preambleLength,
      seedLength: override.seedLength,
      capped: override.capped,
      hash: presetContentHash(override),
      repoPath: overrideKey,
      path: null,
    }
  }

  // 3. Repo-local file — trust-gated.
  if (!presetFile) return null
  const repoPreset = readRepoPresetFile(presetFile)
  if (!repoPreset) return null

  const hash = presetContentHash(repoPreset)
  const trusted = trustStore ? trustStore.isTrusted(repoPreset.path, hash) : false
  const trustState = trusted ? 'trusted' : 'pending'

  return {
    source: 'repo',
    // INERT until trusted — a pending preset never folds into the prompt.
    active: trusted && repoPreset.enabled,
    trustState,
    enabled: repoPreset.enabled,
    preamble: repoPreset.preamble,
    seed: repoPreset.seed,
    preambleLength: repoPreset.preambleLength,
    seedLength: repoPreset.seedLength,
    capped: repoPreset.capped,
    hash,
    repoPath: repoRoot,
    path: repoPreset.path,
  }
}
