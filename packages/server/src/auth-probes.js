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
 *   - `cachedResolveCredentialFile(slot, envValue, resolve, envVarName)`:
 *     mtime+size+mode keyed cache around the BYOK / DeepSeek
 *     `~/.chroxy/credentials.json` resolvers — repeats reuse the parsed
 *     resolver result so the dashboard's list_providers poll doesn't re-read
 *     and re-JSON.parse the file on every call. Slots beyond the fixed
 *     byok/deepseek/discord trio are created lazily (#5461) so config-driven
 *     Anthropic-compatible entries can route their resolveAuth file reads
 *     through the same cache (one `compat:` slot per entry credential spec).
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
import { spawnSync } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import { configPath } from './config-dir.js'

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
 *                                          `claudeAiOauth` block (older) or an
 *                                          `oauthAccount` block (current) when
 *                                          the user has logged in
 *   4. macOS Keychain                   — the generic-password item
 *                                          `Claude Code-credentials`, which is
 *                                          where current Claude Code actually
 *                                          stores the credential on darwin
 *
 * #7331: checks 1-3 were file-only and keyed on `claudeAiOauth`, so on a
 * FULLY AUTHENTICATED current macOS install the probe returned false — both
 * files absent, `~/.claude.json` carrying `oauthAccount` instead, and the real
 * credential sitting in the Keychain the probe never looked at. That is not a
 * cosmetic label: `CreateSessionModal` disables the Create button on
 * `auth.ready === false`, so a correctly-logged-in user could not start an SDK
 * session at all, and was silently pushed onto `claude-tui` — the provider that
 * can neither report nor switch models (#7327).
 *
 * The Keychain check tests EXISTENCE ONLY. It never passes `-w`, so the secret
 * is never printed, and stdout/stderr are discarded rather than captured: the
 * daemon has no reason to hold the user's credential in its own memory, and
 * the question being asked is only "is there one".
 *
 * Override paths for tests / atypical installs:
 *   - `CHROXY_CLAUDE_HOME`     — overrides the directory for the first two
 *                                file checks AND the default location of
 *                                `.claude.json` (one level up from this dir).
 *   - `CHROXY_CLAUDE_CONFIG`   — overrides the global `.claude.json` path
 *                                directly. Wins over the `CHROXY_CLAUDE_HOME`-
 *                                derived default when both are set.
 *   - `CHROXY_CLAUDE_KEYCHAIN` — `0` forces the Keychain probe to report
 *                                absent, `1` forces present. A test cannot
 *                                delete the developer's real Keychain item, so
 *                                without this the logged-OUT direction could
 *                                not be proven on a developer machine — and a
 *                                probe only ever proven in the `true`
 *                                direction is exactly as broken as the one
 *                                this replaces (docs/false-safety-guards.md).
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
        // `claudeAiOauth` is the older shape; current Claude Code writes
        // `oauthAccount` here instead (#7331). Accept either.
        if (parsed && typeof parsed === 'object' && (parsed.claudeAiOauth || parsed.oauthAccount)) {
          return true
        }
      } catch {
        // Malformed JSON — treat as absent.
      }
    }
    if (probeClaudeKeychainCreds()) return true
  } catch {
    // Any unexpected fs error → behave as if no creds.
  }
  return false
}

/** The macOS Keychain generic-password service Claude Code stores its creds under. */
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

/**
 * Does the macOS Keychain hold a Claude Code credential? EXISTENCE ONLY.
 *
 * Deliberately never passes `-w` (which would print the secret) and discards
 * all output — the daemon has no reason to hold the user's credential, and the
 * exit code alone answers the question. Non-darwin returns false without
 * spawning anything.
 *
 * A spawn failure (no `security` binary, sandbox denial, a locked Keychain)
 * counts as ABSENT. That is the honest reading: we could not observe a
 * credential, so we must not claim one. It also keeps the failure mode the
 * same as it was before this probe existed.
 */
function probeClaudeKeychainCreds() {
  const override = process.env.CHROXY_CLAUDE_KEYCHAIN
  if (override === '0') return false
  if (override === '1') return true
  return keychainItemExists(CLAUDE_KEYCHAIN_SERVICE)
}

/**
 * The argv for the existence check, exported so a test can assert what this
 * module is about to hand to `security`.
 *
 * The absent flag is the point: `-w` makes `security` PRINT the password to
 * stdout. Nothing in a readiness probe should be able to do that, and a
 * source-level guard is the only thing standing between "we ask whether a
 * credential exists" and "we pipe the user's credential into the daemon". The
 * override that keeps the unit tests hermetic also means the spawn itself is
 * rarely executed under test, so this shape is pinned directly rather than
 * inferred from behaviour.
 */
export function claudeKeychainProbeArgv() {
  return ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE]
}

/**
 * Does a macOS Keychain generic-password item exist for `service`?
 * EXISTENCE ONLY — output is discarded, the secret is never requested.
 *
 * Non-darwin returns false without spawning — an optimisation, not a
 * correctness guard: on a host with no `security` binary the spawn below
 * reports absent anyway.
 *
 * Every failure counts as ABSENT — we could not observe a credential, so we
 * must not claim one. Note WHERE that is enforced, because the obvious reading
 * is wrong: `spawnSync` does NOT throw for a missing binary. MEASURED, it
 * returns `{ status: null, error: ENOENT }`, so it is the `status === 0`
 * comparison that rejects it, not the `catch`. The `catch` is an unreachable
 * backstop kept for a genuinely thrown error; it has no test because nothing
 * observable reaches it, and claiming otherwise would be the exact
 * comment-stronger-than-code shape catalogued in docs/false-safety-guards.md.
 */
export function keychainItemExists(service) {
  if (process.platform !== 'darwin') return false
  try {
    const result = spawnSync(
      'security',
      ['find-generic-password', '-s', service],
      { stdio: 'ignore', timeout: 5_000 },
    )
    return result.status === 0
  } catch {
    return false
  }
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
  // The Keychain override is part of the key: without it a test that flips
  // CHROXY_CLAUDE_KEYCHAIN inside the 5s TTL would silently read the previous
  // verdict, and the logged-out assertion would pass for the wrong reason.
  const key = `${process.env.CHROXY_CLAUDE_HOME ?? ''}|${process.env.CHROXY_CLAUDE_CONFIG ?? ''}`
    + `|${process.env.CHROXY_CLAUDE_KEYCHAIN ?? ''}`
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
  // #5461: config-driven Anthropic-compatible entries add dynamic
  // `compat:<JSON [apiKeyEnv, credentialsKey]>` slots lazily on first use
  // (#5486: JSON-encoded so the key is collision-proof for any charset) —
  // bounded by the configured entries, dropped by resetCachesForTest().
}

// Empty template for a slot that has never resolved (also the lazy seed for
// dynamic slots). Frozen — every cache write replaces the whole slot object.
const _EMPTY_CRED_FILE_SLOT = Object.freeze({
  envValue: null, path: null, mtimeMs: null, size: null, mode: null, result: null,
})

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
 * Fixed slots (byok/deepseek/discord) pre-exist; any other slot name is
 * created lazily on first use (#5461 — dynamic `compat:` slots for the
 * config-driven Anthropic-compatible entries). For dynamic slots the env var
 * named in the synthesized ENOENT reason comes from `envVarName` (pass null
 * for a file-only credential spec — the env clause is omitted); fixed slots
 * keep their `_SLOT_ENV_VAR` mapping and don't pass it.
 *
 * @param {string} slot - 'byok' | 'deepseek' | 'discord' | dynamic (e.g. 'compat:["ZAI_API_KEY","zaiApiKey"]')
 * @param {string | undefined} envValue - current value of the relevant env var
 * @param {() => object} resolve - the underlying *-credentials resolver
 * @param {string | null} [envVarName] - env var to name in the ENOENT reason (dynamic slots only)
 * @returns {object} resolver result
 */
export function cachedResolveCredentialFile(slot, envValue, resolve, envVarName) {
  const entry = _credFileCache[slot] || _EMPTY_CRED_FILE_SLOT
  const credPath = configPath('credentials.json')

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
      // The reason must match what the slot's own resolver would produce —
      // dynamic slots name their entry's env var (or none, for file-only
      // specs); fixed slots fall back to the static mapping.
      const label = envVarName ?? _SLOT_ENV_VAR[slot]
      return {
        key: null,
        source: 'none',
        reason: label
          ? `${label} not set and ${credPath} does not exist`
          : `${credPath} does not exist`,
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
 * write/delete files under them start from a clean slate. Replacing the whole
 * `_credFileCache` object also discards any dynamic `compat:` slots (#5461).
 * Production code should never call this — the env-var-keyed invalidation +
 * 5s TTL + mtime stat are what users see.
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
