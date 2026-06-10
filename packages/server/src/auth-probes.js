/**
 * Shared on-disk credential probes and short-lived caching for the per-provider
 * `static resolveAuth(env)` methods (#4769).
 *
 * Each provider class declares its own auth resolution strategy in
 * `static resolveAuth(env, helpers)` so the dispatcher in providers.js no
 * longer has to switch on a provider name string. The helpers below are the
 * pieces that need to be shared:
 *
 *   - `hasClaudeOAuthCreds()` / `hasCodexOAuthCreds()` / `hasGeminiOAuthCreds()`:
 *     5s-TTL cached existence checks for the OAuth files written by the
 *     respective `claude login` / `codex login` / `gemini login` flows.
 *   - `cachedResolveCredentialFile(slot, envValue, resolve)`:
 *     mtime+size+mode keyed cache around the BYOK / DeepSeek
 *     `~/.chroxy/credentials.json` resolvers — repeats reuse the parsed
 *     resolver result so the dashboard's list_providers poll doesn't re-read
 *     and re-JSON.parse the file on every call.
 *   - `resetCachesForTest()`: drops both caches so tests can isolate runs
 *     under temporary `CHROXY_*_HOME` overrides without flakiness.
 *
 * History: these helpers used to live as private (`_`-prefixed) functions
 * inside providers.js. They are not changed semantically by this extraction —
 * the cache keys, TTLs, and probe details are byte-for-byte identical to the
 * pre-#4769 originals. See the prior comments in providers.js for the
 * file-by-file rationale.
 */
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * Best-effort probe for `claude login` OAuth state on disk (#3674).
 *
 * Different versions of the Claude Agent SDK and Claude Code CLI cache
 * subscription credentials in different files; we cover the three known
 * locations and return true if any of them looks plausibly populated:
 *
 *   1. `~/.claude/auth.json`            — current SDK auth file
 *   2. `~/.claude/.credentials.json`    — older Claude Code CLI keystore
 *   3. `~/.claude.json`                 — global config; contains a
 *                                          `claudeAiOauth` block when the
 *                                          user has logged in via subscription
 *
 * Override paths for tests / atypical installs:
 *   - `CHROXY_CLAUDE_HOME`   — overrides the directory for the first two
 *                              file checks AND the default location of
 *                              `.claude.json` (one level up from this dir).
 *   - `CHROXY_CLAUDE_CONFIG` — overrides the global `.claude.json` path
 *                              directly. Wins over the `CHROXY_CLAUDE_HOME`-
 *                              derived default when both are set.
 */
function probeClaudeOAuthCreds() {
  try {
    const claudeHome = process.env.CHROXY_CLAUDE_HOME || join(homedir(), '.claude')
    if (existsSync(join(claudeHome, 'auth.json'))) return true
    if (existsSync(join(claudeHome, '.credentials.json'))) return true
    const globalConfig = process.env.CHROXY_CLAUDE_CONFIG
      || (process.env.CHROXY_CLAUDE_HOME
            ? join(process.env.CHROXY_CLAUDE_HOME, '..', '.claude.json')
            : join(homedir(), '.claude.json'))
    if (existsSync(globalConfig)) {
      try {
        const parsed = JSON.parse(readFileSync(globalConfig, 'utf-8'))
        if (parsed && typeof parsed === 'object' && parsed.claudeAiOauth) {
          return true
        }
      } catch {
        // Malformed JSON — treat as absent.
      }
    }
  } catch {
    // Any unexpected fs error → behave as if no creds.
  }
  return false
}

/**
 * Best-effort probe for `codex login` OAuth state on disk (#4301).
 *
 * Override path for tests / atypical installs:
 *   - `CHROXY_CODEX_HOME` — overrides the directory used to locate auth.json
 */
function probeCodexOAuthCreds() {
  try {
    const codexHome = process.env.CHROXY_CODEX_HOME || join(homedir(), '.codex')
    const authPath = join(codexHome, 'auth.json')
    if (!existsSync(authPath)) return false
    try {
      const parsed = JSON.parse(readFileSync(authPath, 'utf-8'))
      if (!parsed || typeof parsed !== 'object') return false
      if (parsed.tokens && typeof parsed.tokens === 'object') {
        const t = parsed.tokens
        if (typeof t.access_token === 'string' && t.access_token.length > 0) return true
        if (typeof t.refresh_token === 'string' && t.refresh_token.length > 0) return true
        if (typeof t.id_token === 'string' && t.id_token.length > 0) return true
      }
      if (typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.length > 0) {
        return true
      }
    } catch {
      // Malformed JSON — treat as absent.
    }
  } catch {
    // Any unexpected fs error → behave as if no creds.
  }
  return false
}

/**
 * Best-effort probe for `gemini login` OAuth state on disk (#4301).
 *
 * Override path for tests / atypical installs:
 *   - `CHROXY_GEMINI_HOME` — overrides the directory used for the lookups
 */
function probeGeminiOAuthCreds() {
  try {
    const geminiHome = process.env.CHROXY_GEMINI_HOME || join(homedir(), '.gemini')
    if (existsSync(join(geminiHome, 'oauth_creds.json'))) return true
    if (existsSync(join(geminiHome, 'google_accounts.json'))) return true
  } catch {
    // Any unexpected fs error → behave as if no creds.
  }
  return false
}

/**
 * 5s TTL cache around the on-disk creds probes (#3678).
 *
 * `listProviders()` is called from `handleListProviders` on every dashboard
 * `list_providers` WS request and once per `auth_ok` from `ws-history.js`.
 * The cache is keyed on the override env vars so a test (or a runtime tweak)
 * that changes any of the `CHROXY_*_HOME` variables naturally invalidates the
 * previous result.
 */
let _credsCache = {
  claude: { value: null, expiresAt: 0, key: null },
  codex: { value: null, expiresAt: 0, key: null },
  gemini: { value: null, expiresAt: 0, key: null },
}

function _cachedProbe(slot, key, probe) {
  const now = Date.now()
  const entry = _credsCache[slot]
  if (entry.key === key && entry.expiresAt > now) {
    return entry.value
  }
  const value = probe()
  _credsCache[slot] = { value, expiresAt: now + 5_000, key }
  return value
}

export function hasClaudeOAuthCreds() {
  const key = `${process.env.CHROXY_CLAUDE_HOME ?? ''}|${process.env.CHROXY_CLAUDE_CONFIG ?? ''}`
  return _cachedProbe('claude', key, probeClaudeOAuthCreds)
}

export function hasCodexOAuthCreds() {
  const key = `${process.env.CHROXY_CODEX_HOME ?? ''}`
  return _cachedProbe('codex', key, probeCodexOAuthCreds)
}

export function hasGeminiOAuthCreds() {
  const key = `${process.env.CHROXY_GEMINI_HOME ?? ''}`
  return _cachedProbe('gemini', key, probeGeminiOAuthCreds)
}

/**
 * mtime+size+mode keyed cache for the BYOK + DeepSeek credential file reads
 * (#4658, #4728). See providers.js' previous header for the long-form
 * rationale — moved verbatim here without behavioural changes.
 */
let _credFileCache = {
  byok: { envValue: null, path: null, mtimeMs: null, size: null, mode: null, result: null },
  deepseek: { envValue: null, path: null, mtimeMs: null, size: null, mode: null, result: null },
  // #5427: Discord webhook URL — same credentials.json, different key. The
  // sink's isConfigured() is probed on every notification, so the resolver
  // must not re-stat/re-parse the file per probe.
  discord: { envValue: null, path: null, mtimeMs: null, size: null, mode: null, result: null },
}

const _SLOT_ENV_VAR = {
  byok: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  discord: 'CHROXY_DISCORD_WEBHOOK_URL',
}

/**
 * Cache wrapper around a credential-file resolver. The resolver itself does
 * the file read; this helper short-circuits to the cached resolver result when
 * the env var is unchanged AND either (env-var path was taken last time) or
 * (the file's stat-mtime+size+mode still matches what we cached).
 *
 * @param {'byok' | 'deepseek' | 'discord'} slot
 * @param {string | undefined} envValue - current value of the relevant env var
 * @param {() => object} resolve - the underlying *-credentials resolver
 * @returns {object} resolver result
 */
export function cachedResolveCredentialFile(slot, envValue, resolve) {
  const entry = _credFileCache[slot]
  const credPath = join(homedir(), '.chroxy', 'credentials.json')

  if (typeof envValue === 'string' && envValue.length > 0) {
    if (entry.envValue === envValue && entry.path === null && entry.result) {
      return entry.result
    }
    const result = resolve()
    _credFileCache[slot] = { envValue, path: null, mtimeMs: null, size: null, mode: null, result }
    return result
  }

  let stat
  try {
    stat = statSync(credPath)
  } catch (err) {
    _credFileCache[slot] = { envValue: null, path: null, mtimeMs: null, size: null, mode: null, result: null }
    if (err.code === 'ENOENT') {
      return {
        key: null,
        source: 'none',
        reason: `${_SLOT_ENV_VAR[slot]} not set and ${credPath} does not exist`,
      }
    }
    return resolve()
  }

  const mode = stat.mode & 0o777
  if (
    entry.envValue === null
    && entry.path === credPath
    && entry.mtimeMs === stat.mtimeMs
    && entry.size === stat.size
    && entry.mode === mode
    && entry.result
  ) {
    return entry.result
  }

  const result = resolve()
  _credFileCache[slot] = {
    envValue: null,
    path: credPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    mode,
    result,
  }
  return result
}

/**
 * Test-only hook: drop both cached probe results and the cached credential-
 * file resolver entries so suites that mutate the `CHROXY_*_HOME` overrides or
 * write/delete files under them start from a clean slate. Production code
 * should never call this — the env-var-keyed invalidation + 5s TTL + mtime
 * stat are what users see.
 */
export function resetCachesForTest() {
  _credsCache = {
    claude: { value: null, expiresAt: 0, key: null },
    codex: { value: null, expiresAt: 0, key: null },
    gemini: { value: null, expiresAt: 0, key: null },
  }
  _credFileCache = {
    byok: { envValue: null, path: null, mtimeMs: null, size: null, mode: null, result: null },
    deepseek: { envValue: null, path: null, mtimeMs: null, size: null, mode: null, result: null },
    discord: { envValue: null, path: null, mtimeMs: null, size: null, mode: null, result: null },
  }
}
