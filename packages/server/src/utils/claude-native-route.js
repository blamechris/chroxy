export const CLAUDE_NATIVE_FIRST_PARTY_BASE_URL = 'https://api.anthropic.com'

// Every non-OAuth selector that can move Claude Code away from the direct
// Claude.ai subscription route. CLAUDE_CODE_OAUTH_TOKEN is deliberately absent:
// it is a vendor-supported way to supply the same subscription credential that
// `claude auth status` classifies separately.
export const CLAUDE_NATIVE_ROUTE_FORBIDDEN_ENV = Object.freeze([
  'ANTHROPIC_API_HOST',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_LOCATION',
  'ANTHROPIC_GOOGLE_CLOUD_PROJECT',
  'ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLAUDE_CODE_API_BASE_URL',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
])

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function buildClaudeNativeRouteEnv(baseEnv = {}) {
  const env = { ...baseEnv }
  for (const key of CLAUDE_NATIVE_ROUTE_FORBIDDEN_ENV) delete env[key]
  env.ANTHROPIC_BASE_URL = CLAUDE_NATIVE_FIRST_PARTY_BASE_URL
  return env
}

export function claudeNativeRouteSettingsEnv() {
  return {
    ...Object.fromEntries(CLAUDE_NATIVE_ROUTE_FORBIDDEN_ENV.map((key) => [key, ''])),
    ANTHROPIC_BASE_URL: CLAUDE_NATIVE_FIRST_PARTY_BASE_URL,
  }
}

export function observeClaudeNativeRoute(env = {}) {
  let firstPartyEndpoint = false
  try {
    const url = new URL(env.ANTHROPIC_BASE_URL)
    firstPartyEndpoint = url.protocol === 'https:'
      && url.hostname === 'api.anthropic.com'
      && (url.port === '' || url.port === '443')
      && (url.pathname === '' || url.pathname === '/')
      && url.search === ''
      && url.hash === ''
  } catch {}
  const blockedKeys = CLAUDE_NATIVE_ROUTE_FORBIDDEN_ENV.filter((key) => hasValue(env[key]))
  return {
    firstPartyEndpoint,
    blockedKeys,
    safe: firstPartyEndpoint && blockedKeys.length === 0,
  }
}
