/**
 * #8944 — which registered providers report token usage.
 *
 * The Tokens panel must never render a provider that reports nothing as a
 * measured 0 (#8255). That needs a classification per provider, and a
 * classification kept beside a growing provider set drifts silently: a new
 * provider that never reports usage would read as a measured zero again.
 *
 * So the roster is EXPLICIT — one row per registered provider name — and
 * `provider-usage-roster.test.ts` compares it with the server's registry in
 * both directions (every registered name is classified, every classified name
 * is registered). Adding a provider to the server registry turns that test
 * red until a row is added here.
 *
 * Names the registry only learns at runtime (config-driven Anthropic- or
 * OpenAI-compatible endpoints, ACP agents) cannot be listed; they fall back
 * to `true`, and the Tokens panel's `turnsBilled > 0` gate keeps a provider
 * that never reports from reading as measured.
 *
 * `claude-tui` is the only `false` row: the TUI runs under a PTY and exposes
 * no token counts. `claude-cli` DOES report, via stream-json `result.usage`,
 * even on a subscription.
 */
export const PROVIDER_REPORTS_USAGE: Readonly<Record<string, boolean>> = {
  'claude-sdk': true,
  'claude-cli': true,
  'claude-tui': false,
  'claude-channel': true,
  'claude-byok': true,
  'deepseek': true,
  'ollama': true,
  'gemini': true,
  'codex': true,
  'codex-appserver': true,
  'user-shell': true,
  'docker-cli': true,
  'docker-sdk': true,
  'docker-byok': true,
  'docker': true,
}

/** True unless the provider is classified as not reporting usage. */
export function providerReportsUsage(provider: string): boolean {
  // Own-property check: a provider named like an Object.prototype member
  // must not read as classified.
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_REPORTS_USAGE, provider)) return true
  return PROVIDER_REPORTS_USAGE[provider] !== false
}
