/**
 * Era-aware billing classification (#5630 / #5629).
 *
 * Chroxy bills Claude usage three different ways depending on the provider
 * and (for the programmatic providers) whether an operator has declared the
 * programmatic-credit era in force. Historically the dashboard
 * labelled every dollar figure "Cost (BYOK)" — wrong for subscription and
 * programmatic-credit sessions (#5630) — and the provider copy still said
 * "subscription" for claude-cli / claude-sdk ahead of a metered
 * programmatic-credit pool Anthropic announced for 2026-06-15 (#5629). That
 * pool was PAUSED on the day it was due and never shipped, so subscription is
 * the correct copy after all; see `programmaticCreditEraEnabled` (#7333).
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
 *   - programmatic-credit — host claude-cli / claude-sdk when auth is the
 *                          OAuth/subscription pool AND an operator has declared
 *                          the era in force via CHROXY_PROGRAMMATIC_CREDIT_ERA=1.
 *                          NOT IN FORCE TODAY (#7333): Anthropic paused the
 *                          change on 2026-06-15 and it never shipped, so these
 *                          providers bill as flat `subscription`.
 *
 * Refinement: a claude-cli / claude-sdk session authed with an explicit
 * ANTHROPIC_API_KEY (the raw-API branch in resolveAuth, source === 'env') is
 * a real per-token API account, NOT the credit pool — it classifies as
 * `api-key` in BOTH eras.
 *
 * docker-cli / docker-sdk are NOT in the programmatic set: they forward the
 * host's ANTHROPIC_API_KEY into the container and have no OAuth fallback (the
 * container has no ~/.claude state), so they always bill the raw API account
 * (`api-key`), era-independent — the host's credit pool never applies inside
 * the container.
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

// Host providers whose OAuth/subscription auth flips from `subscription` to
// `programmatic-credit` at the era boundary. (When authed with an explicit
// API key, claude-cli / claude-sdk are reclassified to `api-key` by the
// caller via opts.apiKeyAuth — see billingClassForProvider.)
const PROGRAMMATIC_PROVIDERS = new Set([
  'claude-cli',
  'claude-sdk',
])

// Providers that always bill as a flat Claude subscription, era-independent.
const SUBSCRIPTION_PROVIDERS = new Set([
  'claude-tui',
  'claude-channel',
])

// Providers that always bill against your own key / per-token, era-independent.
// docker-cli / docker-sdk forward ANTHROPIC_API_KEY into the container with no
// OAuth fallback, so they bill the raw API account just like BYOK.
const API_KEY_PROVIDERS = new Set([
  'claude-byok',
  'docker-byok',
  'docker-cli',
  'docker-sdk',
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
  if (!programmaticCreditEraEnabled()) return false
  return now >= PROGRAMMATIC_CREDIT_ERA_START
}

/**
 * Has an operator declared the programmatic-credit era in force? (#7333)
 *
 * THE ERA NEVER STARTED. Anthropic paused the change on 2026-06-15, the day it
 * was due to take effect, and it has not shipped: `claude -p`, the Agent SDK
 * and third-party app usage still draw from the subscription's usage limits.
 * The date comparison above had no feature check, so it silently flipped true
 * on the announced date and chroxy has been asserting a billing regime that
 * does not exist every day since — telling users `claude-cli`/`claude-sdk`
 * bill against a "monthly metered credit pool", and showing a real dollar
 * figure where a subscription session should read "Included".
 *
 * That misdirects provider choice: it steers users away from `claude-cli`, at
 * present the best-working Claude provider, toward `claude-tui`, which can
 * neither report nor switch models (#7327), on the basis of a cost that is not
 * being charged.
 *
 * A date with no way to observe whether the event happened is the
 * "cannot check this, so assume it did" cause in docs/false-safety-guards.md.
 * The observable replaces it: an operator sets `CHROXY_PROGRAMMATIC_CREDIT_ERA=1`
 * when the regime actually arrives. The constant and every consumer stay wired
 * up, because the pause is explicitly "for now" — a revival is this flag plus,
 * if the announced date moves, one edit to PROGRAMMATIC_CREDIT_ERA_START.
 */
export function programmaticCreditEraEnabled() {
  return process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA === '1'
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
    // account, not the credit pool — bill as api-key in both eras. (docker-cli
    // / docker-sdk are already in API_KEY_PROVIDERS above and never reach here.)
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
