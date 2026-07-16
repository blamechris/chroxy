/**
 * buildSpawnEnv — construct the environment object for a child CLI process.
 *
 * Each provider is either:
 *   - "allowlist" mode: only explicitly allowed keys are forwarded. Used for
 *     third-party providers (codex, gemini) so operator secrets
 *     (ANTHROPIC_API_KEY, CHROXY_HOOK_SECRET, arbitrary DB creds, etc.) never
 *     leak into their subprocess environment.
 *   - "denylist" mode: the full parent env is forwarded minus a small set of
 *     keys that would be harmful (ANTHROPIC_API_KEY, plus the chroxy-owned
 *     daemon secrets in CHROXY_SECRET_DENYLIST). Used for the Claude CLI where
 *     the user's full environment is expected to be available.
 *
 * Centralising the pattern here means future providers get safe-by-default
 * env handling automatically.
 *
 * Credential-store fallback (#3855): for provider credential env vars the
 * operator's shell has NOT exported, the value is sourced from the credential
 * store (~/.chroxy/credentials.json, mode 0600). This is what lets a
 * Tauri/launchd GUI launch (cwd=/, minimal PATH, no rc file sourced) spawn a
 * working session from stored credentials alone. Process env always wins, so a
 * shell export overrides the store. The Claude denylist still strips
 * ANTHROPIC_API_KEY (subscription-default behaviour is preserved); only the
 * non-denylisted credential keys are eligible for store injection.
 */
import { resolveCredential, isKnownCredentialKey } from '../credential-store.js'
import { getChroxyHostEnv } from '../chroxy-host-metadata.js'

// Standard vars every child process needs for its runtime to function.
// Shell PATH, locale, TERM, TMPDIR, user/home identity.
const STANDARD_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'PWD',
  'OLDPWD',
  'COLUMNS',
  'LINES',
  'COLORTERM',
  'DISPLAY',
  'SSH_AUTH_SOCK',
  'NODE_EXTRA_CA_CERTS',
  // HTTP proxy vars — needed for corporate/enterprise environments where
  // outbound traffic is routed through a forward proxy. Values are typically
  // infrastructure URLs; note that proxy URLs can legally embed credentials
  // (http://user:pass@proxy:8080) — avoid logging these values.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
]

// Chroxy-owned daemon secrets that must NEVER reach any spawned child process,
// regardless of provider or mode (#6311). API_TOKEN is the full-authority
// primary bearer token (docs/security/bearer-token-authority.md §1/§3): a tool,
// MCP server, subagent, or shell command the agent runs could read it from
// process.env and gain full control of the daemon — every session's history,
// input, model switching and settings — over the WebSocket/HTTP control surface.
// The narrowly-scoped per-session CHROXY_HOOK_SECRET is passed explicitly via
// `extras` instead; it only authorises POST /permission, so it is safe to hand
// to the child.
//
// Allowlist-mode providers (codex, gemini) already exclude these by omission;
// this set is the belt-and-braces guarantee for denylist-mode providers (claude)
// and is re-used by the claude-tui PTY spawn path (claude-tui-session.js).
export const CHROXY_SECRET_DENYLIST = [
  'API_TOKEN',
]

const PROVIDERS = {
  codex: {
    mode: 'allowlist',
    // OpenAI credentials + endpoint overrides only. No cross-provider keys.
    providerAllowlist: [
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_ORG_ID',
      'OPENAI_ORGANIZATION',
      'OPENAI_PROJECT',
      'OPENAI_PROJECT_ID',
    ],
  },
  gemini: {
    mode: 'allowlist',
    // Google/Gemini credentials only.
    providerAllowlist: [
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_CLOUD_LOCATION',
    ],
  },
  claude: {
    mode: 'denylist',
    // Strip the API key so the CLI uses OAuth/subscription auth instead of
    // burning API credits. All other parent env keys pass through so the
    // user's shell environment is available to Claude Code tools.
    denylist: [
      'ANTHROPIC_API_KEY',
    ],
    // #3855: credential-store keys this provider may pull from the store when
    // the shell hasn't exported them. Scoped to the Claude provider's OWN
    // credential only — never other providers' keys (cross-provider isolation:
    // an OpenAI/Gemini key stored for those providers must not leak into the
    // Claude subprocess env). ANTHROPIC_API_KEY is deliberately excluded so
    // the CLI keeps using subscription/OAuth auth.
    storeInjectKeys: [
      'CLAUDE_CODE_OAUTH_TOKEN',
    ],
  },
}

/**
 * Build the env object to pass to child_process.spawn().
 *
 * @param {'codex'|'gemini'|'claude'} provider
 * @param {Record<string, string>} [extras] - provider-specific additions that
 *   override any env passthrough (e.g. CHROXY_HOOK_SECRET for claude,
 *   CI=1 for headless mode, etc.).
 * @returns {Record<string, string>} env object suitable for spawn()
 */
export function buildSpawnEnv(provider, extras = {}) {
  const config = PROVIDERS[provider]
  if (!config) {
    throw new Error(`buildSpawnEnv: unknown provider "${provider}"`)
  }

  if (config.mode === 'allowlist') {
    const env = {}
    const allowed = [...STANDARD_ALLOWLIST, ...config.providerAllowlist]
    for (const key of allowed) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key]
        continue
      }
      // #3855: env var not exported — fall back to the credential store for
      // the credential keys it manages. resolveCredential() already enforces
      // env > store precedence; here process.env was undefined so a non-null
      // result is necessarily store-sourced.
      if (isKnownCredentialKey(key)) {
        const resolved = resolveCredential(key)
        if (resolved.value) env[key] = resolved.value
      }
    }
    // #6633: inject Chroxy's own host identity (version/channel/git/platform).
    // These are COMPUTED (not passed through from process.env), so they are
    // authoritative and safe for allowlist-mode providers — non-sensitive
    // metadata, never an operator secret. `extras` still wins on any collision.
    return { ...env, ...getChroxyHostEnv(), ...extras }
  }

  // denylist mode: start from full parent env, remove sensitive keys.
  // #6311: always strip the chroxy-owned daemon secrets in addition to the
  // provider's own denylist, so the full-authority API_TOKEN never reaches a
  // denylist-mode child (the parent env is otherwise forwarded wholesale).
  const effectiveDenylist = [...config.denylist, ...CHROXY_SECRET_DENYLIST]
  const parentEnv = { ...process.env }
  for (const key of effectiveDenylist) {
    delete parentEnv[key]
  }
  // #3855: inject ONLY this provider's own credential-store keys that the
  // shell did not export (e.g. CLAUDE_CODE_OAUTH_TOKEN for claude). Scoped via
  // the per-provider `storeInjectKeys` allowlist so other providers' stored
  // secrets (OPENAI_API_KEY, GEMINI_API_KEY) never leak into this subprocess.
  // ANTHROPIC_API_KEY is excluded from storeInjectKeys AND denylisted, so the
  // CLI keeps using subscription/OAuth auth.
  const denySet = new Set(effectiveDenylist)
  for (const key of config.storeInjectKeys || []) {
    if (denySet.has(key)) continue
    if (!isKnownCredentialKey(key)) continue
    if (parentEnv[key] !== undefined) continue
    const resolved = resolveCredential(key)
    if (resolved.value) parentEnv[key] = resolved.value
  }
  // #6633: Chroxy host identity, computed and authoritative (see allowlist branch).
  return { ...parentEnv, ...getChroxyHostEnv(), ...extras }
}
