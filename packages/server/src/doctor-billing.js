// doctor-billing.js — billing canary for the 2026-06-15 programmatic-credit cutover.
//
// DRAFT (rec #4 of docs/audit/june15-billing-strategy-2026-06-14.md). Early-warning
// that the `claude-tui` subscription-billing bet may have stopped holding, plus a
// datacenter-egress ban-signal warning. The checks here are PURE and injectable
// (pass `now`, the session list, the egress ip) so they unit-test without timers or
// network; a thin runner aggregates them for a future `chroxy doctor billing` command.
//
// Wiring left for review before shipping: (a) map live SessionManager sessions to the
// {id, provider, totalCostUsd} shape `runBillingCanary` expects, (b) fetch the daemon's
// public egress ip, (c) register the `doctor` subcommand in the CLI. None of that is
// done yet — this module is the reviewable core.
import {
  BILLING_CLASSES,
  PROGRAMMATIC_CREDIT_ERA_START,
  billingClassForProvider,
  isProgrammaticCreditEra,
} from './billing-class.js'

/**
 * Loophole-closed canary. A `claude-tui` session is nominally subscription-billed
 * (interactive allowance), so it should report no programmatic cost. If one reports
 * a non-zero cost on/after the cutover, the bet may have been reclassified to metered
 * credits — the single most important signal to surface.
 *
 * @param {Array<{id:string, provider:string, totalCostUsd?:number, apiKeyAuth?:boolean}>} sessions
 * @param {number} [now]
 * @returns {Array<{code:string, sessionId:string, costUsd:number, message:string}>}
 */
export function detectBillingReclassification(sessions = [], now = Date.now()) {
  const warnings = []
  for (const s of sessions || []) {
    if (!s || s.provider !== 'claude-tui') continue
    // claude-tui is always SUBSCRIPTION per billing-class; guard anyway so this
    // stays correct if that ever changes.
    if (billingClassForProvider('claude-tui', now) !== BILLING_CLASSES.SUBSCRIPTION) continue
    const cost = Number(s.totalCostUsd)
    if (Number.isFinite(cost) && cost > 0) {
      warnings.push({
        code: 'TUI_REPORTED_PROGRAMMATIC_COST',
        sessionId: s.id,
        costUsd: cost,
        message:
          `claude-tui session ${s.id} reported $${cost.toFixed(4)} of programmatic cost, but it ` +
          `should bill against your subscription's interactive allowance. The cutover may have ` +
          `reclassified it — verify in your Anthropic billing dashboard and consider BYOK (ANTHROPIC_API_KEY).`,
      })
    }
  }
  return warnings
}

/**
 * Silent-metered-default canary. On/after the era boundary, a daemon whose default
 * provider is a programmatic one meters credits with no prompt. (#5819.)
 *
 * @param {string} defaultProvider - the resolved default provider id
 * @param {number} [now]
 * @returns {Array<{code:string, provider:string, message:string}>}
 */
export function detectSilentMeteredDefault(defaultProvider, now = Date.now()) {
  if (!isProgrammaticCreditEra(now)) return []
  if (billingClassForProvider(defaultProvider, now) !== BILLING_CLASSES.PROGRAMMATIC_CREDIT) return []
  return [{
    code: 'SILENT_METERED_DEFAULT',
    provider: defaultProvider,
    message:
      `The default provider '${defaultProvider}' bills against the metered programmatic-credit pool ` +
      `since 2026-06-15. New default sessions draw credits silently — switch with --provider claude-tui ` +
      `(subscription, best-effort) or set ANTHROPIC_API_KEY (BYOK).`,
  }]
}

// Datacenter-egress ban-signal. Cloud-hosted daemons behind a tunnel are a documented
// flag (the audit cites ~20-minute bans on Hetzner/Cloudflare ranges). This is a pure
// classifier over a known-prefix list; the caller supplies the public egress ip.
// DRAFT: the prefix list is a starting point, not exhaustive — curate before shipping.
const DATACENTER_IPV4_PREFIXES = [
  // Hetzner (cited in claude-code#21678)
  '5.9.', '88.99.', '95.216.', '116.202.', '135.181.', '167.235.', '168.119.',
  // common cloud egress ranges (illustrative; expand from a real dataset)
  '13.', '18.', '34.', '35.', '52.', '54.', // AWS/GCP blocks (coarse — DRAFT)
]

/**
 * @param {string} ip - public egress IPv4
 * @returns {{datacenter:boolean, code?:string, message?:string}}
 */
export function classifyEgressIp(ip) {
  if (!ip || typeof ip !== 'string') return { datacenter: false }
  const hit = DATACENTER_IPV4_PREFIXES.some((p) => ip.startsWith(p))
  if (!hit) return { datacenter: false }
  return {
    datacenter: true,
    code: 'DATACENTER_EGRESS',
    message:
      `This daemon's public egress IP (${ip}) looks like a datacenter/cloud range. Driving a Claude ` +
      `subscription login from a cloud host is a documented ban signal — prefer a residential network ` +
      `for claude-tui, or use BYOK on cloud hosts.`,
  }
}

/**
 * Aggregate the canary. Returns a flat warnings array (empty = all clear).
 *
 * @param {{sessions?:Array, defaultProvider?:string, egressIp?:string, now?:number}} input
 */
export function runBillingCanary({ sessions = [], defaultProvider, egressIp, now = Date.now() } = {}) {
  const warnings = []
  warnings.push(...detectSilentMeteredDefault(defaultProvider, now))
  warnings.push(...detectBillingReclassification(sessions, now))
  const egress = classifyEgressIp(egressIp)
  if (egress.datacenter) warnings.push({ code: egress.code, message: egress.message })
  return {
    eraStarted: isProgrammaticCreditEra(now),
    eraStart: PROGRAMMATIC_CREDIT_ERA_START,
    warnings,
  }
}
