/** Human-readable labels for known providers, shared across components. */
export const PROVIDER_LABELS: Record<string, string> = {
  'claude-sdk': 'Claude Code (SDK)',
  'claude-cli': 'Claude Code (CLI)',
  'docker-cli': 'Claude Code (Docker CLI)',
  'docker-sdk': 'Claude Code (Docker SDK)',
  'docker': 'Claude Code (Docker CLI)',
  'gemini': 'Gemini (CLI)',
  'codex': 'Codex (CLI)',
}

export type ProviderType = 'sdk' | 'cli' | 'other'

export interface ProviderInfo {
  short: string
  tooltip: string
  type: ProviderType
}

const KNOWN_PROVIDERS: Record<string, ProviderInfo> = {
  'claude-sdk': {
    short: 'SDK',
    tooltip: 'Anthropic API — billed per token via ANTHROPIC_API_KEY',
    type: 'sdk',
  },
  'claude-cli': {
    short: 'CLI',
    tooltip: 'Claude Code CLI — uses your claude.ai subscription',
    type: 'cli',
  },
  'docker-cli': {
    short: 'Docker CLI',
    tooltip: 'Docker-isolated CLI — uses your claude.ai subscription',
    type: 'cli',
  },
  'docker-sdk': {
    short: 'Docker SDK',
    tooltip: 'Docker-isolated SDK — billed per token via ANTHROPIC_API_KEY',
    type: 'sdk',
  },
  'docker': {
    short: 'Docker CLI',
    tooltip: 'Docker-isolated CLI — uses your claude.ai subscription (alias for docker-cli)',
    type: 'cli',
  },
  'gemini': {
    short: 'Gemini',
    tooltip: 'Gemini CLI — uses Google API credits',
    type: 'other',
  },
  'codex': {
    short: 'Codex',
    tooltip: 'Codex CLI — uses OpenAI API credits',
    type: 'other',
  },
}

const FALLBACK: ProviderInfo = {
  short: 'API',
  tooltip: 'External provider — check your billing dashboard',
  type: 'other',
}

/** Get display info for a provider string. Handles unknown providers gracefully. */
export function getProviderInfo(provider: string): ProviderInfo {
  if (KNOWN_PROVIDERS[provider]) return KNOWN_PROVIDERS[provider]
  // Heuristic fallback for unregistered providers containing 'sdk'
  if (provider.includes('sdk')) {
    return { short: 'SDK', tooltip: 'SDK provider — billed per token', type: 'sdk' }
  }
  return { ...FALLBACK, short: provider.replace(/^claude-/, '').toUpperCase() }
}
