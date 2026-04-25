/**
 * buildSpawnEnv — construct the environment object for a child CLI process.
 *
 * Each provider is either:
 *   - "allowlist" mode: only explicitly allowed keys are forwarded. Used for
 *     third-party providers (codex, gemini) so operator secrets
 *     (ANTHROPIC_API_KEY, CHROXY_HOOK_SECRET, arbitrary DB creds, etc.) never
 *     leak into their subprocess environment.
 *   - "denylist" mode: the full parent env is forwarded minus a small set of
 *     keys that would be harmful (ANTHROPIC_API_KEY). Used for the Claude CLI
 *     where the user's full environment is expected to be available.
 *
 * Centralising the pattern here means future providers get safe-by-default
 * env handling automatically.
 */

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
      }
    }
    return { ...env, ...extras }
  }

  // denylist mode: start from full parent env, remove sensitive keys
  const parentEnv = { ...process.env }
  for (const key of config.denylist) {
    delete parentEnv[key]
  }
  return { ...parentEnv, ...extras }
}
