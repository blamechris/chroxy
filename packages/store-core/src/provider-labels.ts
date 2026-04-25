/**
 * Canonical human-readable labels and display info for known providers.
 *
 * Shared between the mobile app (@chroxy/app) and web dashboard
 * (@chroxy/dashboard) so that provider names are consistent everywhere.
 */

export type ProviderType = 'sdk' | 'cli' | 'other'

export interface ProviderDisplayInfo {
  short: string
  label: string
  tooltip: string
  type: ProviderType
}

const KNOWN_PROVIDERS: Record<string, ProviderDisplayInfo> = {
  'claude-sdk': {
    short: 'SDK',
    label: 'Claude Code (SDK)',
    tooltip: 'Anthropic API — billed per token via ANTHROPIC_API_KEY',
    type: 'sdk',
  },
  'claude-cli': {
    short: 'CLI',
    label: 'Claude Code (CLI)',
    tooltip: 'Claude Code CLI — uses your claude.ai subscription',
    type: 'cli',
  },
  'docker-cli': {
    short: 'Docker CLI',
    label: 'Claude Code (Docker CLI)',
    tooltip: 'Docker-isolated CLI — uses your claude.ai subscription',
    type: 'cli',
  },
  'docker-sdk': {
    short: 'Docker SDK',
    label: 'Claude Code (Docker SDK)',
    tooltip: 'Docker-isolated SDK — billed per token via ANTHROPIC_API_KEY',
    type: 'sdk',
  },
  'docker': {
    short: 'Docker CLI',
    label: 'Claude Code (Docker CLI)',
    tooltip: 'Docker-isolated CLI — uses your claude.ai subscription (alias for docker-cli)',
    type: 'cli',
  },
  'gemini': {
    short: 'Gemini',
    label: 'Gemini (CLI)',
    tooltip: 'Gemini CLI — uses Google API credits',
    type: 'other',
  },
  'codex': {
    short: 'Codex',
    label: 'Codex (CLI)',
    tooltip: 'Codex CLI — uses OpenAI API credits',
    type: 'other',
  },
}

const FALLBACK: Omit<ProviderDisplayInfo, 'label'> = {
  short: 'API',
  tooltip: 'External provider — check your billing dashboard',
  type: 'other',
}

/**
 * Human-readable labels for known providers.
 * Derived from KNOWN_PROVIDERS so the label field is the single source of truth.
 */
export const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(KNOWN_PROVIDERS).map(([key, info]) => [key, info.label])
)

/** Get a human-readable label for a provider, falling back to the raw name. */
export function getProviderLabel(name: string): string {
  return KNOWN_PROVIDERS[name]?.label ?? name
}

/** Get display info for a provider string. Handles unknown providers gracefully. */
export function getProviderInfo(provider: string): ProviderDisplayInfo {
  if (KNOWN_PROVIDERS[provider]) return KNOWN_PROVIDERS[provider]
  // Heuristic fallback for unregistered providers containing 'sdk'
  if (provider.includes('sdk')) {
    const label = provider.replace(/^claude-/, '')
    return { short: 'SDK', label, tooltip: 'SDK provider — billed per token', type: 'sdk' }
  }
  const short = provider.replace(/^claude-/, '').toUpperCase()
  return { ...FALLBACK, label: short, short }
}
