/**
 * Human-readable labels for known providers.
 *
 * Keeping this local to the mobile app (rather than sharing with the
 * dashboard) avoids adding an extra cross-package dependency. If the server
 * reports an unknown provider name, callers should fall back to the raw name.
 */
export const PROVIDER_LABELS: Record<string, string> = {
  'claude-sdk': 'Claude Code (SDK)',
  'claude-cli': 'Claude Code (CLI)',
  'docker-cli': 'Claude Code (Docker CLI)',
  'docker-sdk': 'Claude Code (Docker SDK)',
  'docker': 'Claude Code (Docker CLI)',
  'gemini': 'Google Gemini',
  'codex': 'OpenAI Codex',
};

/** Get a human-readable label for a provider, falling back to the raw name. */
export function getProviderLabel(name: string): string {
  return PROVIDER_LABELS[name] || name;
}
