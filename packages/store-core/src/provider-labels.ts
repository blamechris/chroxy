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
  'claude-tui': {
    short: 'TUI',
    label: 'Claude Code (TUI)',
    tooltip: 'Interactive Claude Code TUI under PTY — uses your claude.ai subscription, bypasses programmatic credit metering',
    type: 'cli',
  },
  'claude-byok': {
    short: 'BYOK',
    label: 'Claude (API key — BYOK)',
    tooltip: 'Direct Anthropic API via @anthropic-ai/sdk — per-token billing with your own ANTHROPIC_API_KEY. No claude binary required.',
    type: 'sdk',
  },
  'docker-byok': {
    short: 'Docker BYOK',
    label: 'Claude (BYOK — Docker container)',
    tooltip: 'BYOK agent loop on the host, tool execution (Read/Write/Edit/Bash/Glob/Grep) inside an isolated Docker container. Per-token billing with your own ANTHROPIC_API_KEY.',
    type: 'sdk',
  },
  'docker-cli': {
    short: 'Docker CLI',
    label: 'Claude Code (Docker CLI)',
    tooltip: 'Docker-isolated CLI — forwards your ANTHROPIC_API_KEY into the container (per-token billing, no OAuth fallback)',
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
    tooltip: 'Docker-isolated CLI — forwards your ANTHROPIC_API_KEY into the container (alias for docker-cli)',
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

// #5795 — single source of truth for "which AskUserQuestion render shapes can
// this provider's answer channel consume?". Previously these predicates were
// hand-rolled four times across the dashboard and app with two different
// spellings of the same boolean, which (a) drifts on the next provider and
// (b) silently mishandled docker-cli/docker (cli-type, single-text answer
// channel like claude-cli, yet they fell through the bare `!= claude-cli`
// checks and were treated as structured-capable). Keying off the registered
// `type` fixes both: cli-type providers take a single TEXT answer only.

/**
 * Can this provider render a multi-QUESTION AskUserQuestion form (several
 * questions at once, per-question answers incl. multi-select arrays)?
 *
 * Only providers with a structured answer channel can — i.e. NOT the
 * cli-type providers (claude-cli, claude-tui, docker-cli, docker), whose
 * respondToQuestion accepts a single text answer with no answersMap.
 */
export function providerSupportsMultiQuestion(provider: string | null | undefined): boolean {
  if (!provider) return false
  return getProviderInfo(provider).type !== 'cli'
}

/**
 * Can this provider render a SINGLE-question multi-select AskUserQuestion as a
 * checkbox form? True for every structured-channel provider PLUS claude-tui,
 * which re-injects the chosen labels as text via the #5776 reinject path.
 * The plain CLI providers (claude-cli, docker-cli, docker) cannot.
 *
 * Note: claude-tui's reinject is itself gated server-side by
 * CHROXY_TUI_MULTISELECT_REINJECT (default OFF). Wiring that capability to the
 * client so the form is only offered when the server will honor it is tracked
 * separately in #5791; this predicate preserves the existing name-based gate.
 */
export function providerSupportsSingleMultiSelect(provider: string | null | undefined): boolean {
  if (!provider) return false
  if (provider === 'claude-tui') return true
  return getProviderInfo(provider).type !== 'cli'
}
