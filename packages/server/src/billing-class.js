/**
 * Era-aware billing classification (#5630 / #5629).
 *
 * Chroxy bills Claude usage three different ways depending on the provider
 * and (for the programmatic providers) the date. Historically the dashboard
 * labelled every dollar figure "Cost (BYOK)" — wrong for subscription and
 * programmatic-credit sessions (#5630) — and the provider copy still said
 * "subscription" for claude-cli / claude-sdk even though Anthropic moves
 * those onto a metered programmatic-credit pool on 2026-06-15 (#5629).
 *
 * This module is the single source of truth for "which billing class is
 * this session/provider in right now?" Every provider `resolveAuth()` and the
 * session-list builder route through it so the wire shape (`auth.billingClass`,
 * per-session `billingClass`) and the human copy (`detail`) stay consistent.
 *
 * Three classes:
 *   - api-key            — your own ANTHROPIC_API_KEY (claude-byok, docker-byok)
 *                          AND every non-Claude provider (codex/gemini/deepseek/
 *                          ollama/anthropic-compatible). Real per-token dollar
 *                          spend. Era-independent.
 *   - subscription       — flat Claude subscription billing (claude-tui,
 *                          claude-channel). No per-turn dollar figure. Era-
 *                          independent.
 *   - programmatic-credit — claude-cli / claude-sdk / docker-cli / docker-sdk
 *                          when auth is the OAuth/subscription pool. BEFORE
 *                          2026-06-15 these bill as flat `subscription`; ON/AFTER
 *                          they draw from Anthropic's monthly metered
 *                          programmatic-credit pool, so spend becomes a real
 *                          dollar figure.
 *
 * Refinement: a claude-cli / claude-sdk session authed with an explicit
 * ANTHROPIC_API_KEY (the raw-API branch in resolveAuth, source === 'env') is
 * a real per-token API account, NOT the credit pool — it classifies as
 * `api-key` in BOTH eras.
 */

export const BILLING_CLASSES = Object.freeze({
  API_KEY: 'api-key',
  SUBSCRIPTION: 'subscription',
  PROGRAMMATIC_CREDIT: 'programmatic-credit',
})

/**
 * The instant the programmatic-credit era begins.
 *
 * 2026-06-15 00:00:00 UTC. `Date.UTC(2026, 5, 15)` — the month arg is
 * 0-indexed, so `5` is June. We anchor to a UTC midnight boundary (NOT local
 * time) deliberately: the cutover is a single global instant for every
 * daemon regardless of the host's timezone, so a daemon in UTC-8 and one in
 * UTC+9 flip at the same wall-clock moment in UTC rather than 17 hours apart.
 * The dashboard mirrors this constant client-side (CreateSessionModal.tsx) —
 * keep the two in sync if this ever moves.
 */
export const PROGRAMMATIC_CREDIT_ERA_START = Date.UTC(2026, 5, 15)

// Providers whose OAuth/subscription auth flips from `subscription` to
// `programmatic-credit` at the era boundary. (When authed with an explicit
// API key, claude-cli / claude-sdk are reclassified to `api-key` by the
// caller via opts.apiKeyAuth — see billingClassForProvider.)
const PROGRAMMATIC_PROVIDERS = new Set([
  'claude-cli',
  'claude-sdk',
  'docker-cli',
  'docker-sdk',
])

// Providers that always bill as a flat Claude subscription, era-independent.
const SUBSCRIPTION_PROVIDERS = new Set([
  'claude-tui',
  'claude-channel',
])

// Providers that always bill against your own key / per-token, era-independent.
const API_KEY_PROVIDERS = new Set([
  'claude-byok',
  'docker-byok',
])

/**
 * Is the given instant on/after the programmatic-credit era boundary?
 *
 * The comparator takes an injectable `now` so tests pass explicit timestamps
 * (no fake timers). It NEVER calls Date.now() internally except as the default
 * argument value — pass a fixed timestamp to make the result deterministic.
 *
 * @param {number} [now] - Epoch millis. Defaults to Date.now() at call time.
 * @returns {boolean}
 */
export function isProgrammaticCreditEra(now = Date.now()) {
  return now >= PROGRAMMATIC_CREDIT_ERA_START
}

/**
 * Classify a provider into one of the three billing classes for a given
 * instant.
 *
 * @param {string} providerType - Provider id (e.g. 'claude-cli', 'codex').
 * @param {number} [now] - Epoch millis; defaults to Date.now(). Injectable
 *   for deterministic tests.
 * @param {{ apiKeyAuth?: boolean }} [opts] - `apiKeyAuth: true` forces the
 *   `api-key` class for claude-sdk / claude-cli when the session is authed
 *   with an explicit ANTHROPIC_API_KEY (the raw-API branch in resolveAuth).
 * @returns {'api-key'|'subscription'|'programmatic-credit'}
 */
export function billingClassForProvider(providerType, now = Date.now(), opts = {}) {
  if (API_KEY_PROVIDERS.has(providerType)) return BILLING_CLASSES.API_KEY
  if (SUBSCRIPTION_PROVIDERS.has(providerType)) return BILLING_CLASSES.SUBSCRIPTION
  if (PROGRAMMATIC_PROVIDERS.has(providerType)) {
    // claude-cli / claude-sdk authed via an explicit API key is a raw API
    // account, not the credit pool — bill as api-key in both eras. (docker-*
    // forward the key into the container and have no OAuth fallback, so they
    // are effectively always api-key too when a key is set; the caller passes
    // apiKeyAuth for those just the same.)
    if (opts.apiKeyAuth) return BILLING_CLASSES.API_KEY
    return isProgrammaticCreditEra(now)
      ? BILLING_CLASSES.PROGRAMMATIC_CREDIT
      : BILLING_CLASSES.SUBSCRIPTION
  }
  // Every other provider (codex/gemini/deepseek/ollama/anthropic-compatible,
  // plus any future custom provider) is per-token api-key billing.
  return BILLING_CLASSES.API_KEY
}

/**
 * Human-readable billing copy for a class. Used as the `detail` summary the
 * dashboard renders under the provider picker and in the cost tooltips.
 *
 * @param {string} billingClass
 * @param {{ providerLabel?: string }} [opts]
 * @returns {string}
 */
export function billingDetailForClass(billingClass, { providerLabel } = {}) {
  const who = providerLabel ? `${providerLabel}: ` : ''
  switch (billingClass) {
    case BILLING_CLASSES.API_KEY:
      return `${who}Your own API key — per-token billing`
    case BILLING_CLASSES.PROGRAMMATIC_CREDIT:
      return `${who}Programmatic credit pool — monthly metered credits`
    case BILLING_CLASSES.SUBSCRIPTION:
      return `${who}Included (subscription) — no per-turn dollar charge`
    default:
      return who || 'Unknown billing class'
  }
}
