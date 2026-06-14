// doctor-billing.js — billing canary for the 2026-06-15 programmatic-credit cutover.
//
// rec #4 of docs/audit/june15-billing-strategy-2026-06-14.md. Early-warning that the
// `claude-tui` subscription-billing bet may have stopped holding, plus a
// datacenter-egress ban-signal warning. Every check here is PURE and injectable (pass
// `now`, the session list, the egress ip) so they unit-test without timers or network.
//
// Wiring status:
//   - detectSilentMeteredDefault — WIRED into `chroxy doctor` (doctor.js "Billing"
//     check). It needs only the resolved default provider + the clock, both available
//     in the standalone preflight.
//   - detectBillingReclassification — exported for the DAEMON / dashboard to call: it
//     needs live per-session `totalCostUsd`, which a standalone `chroxy doctor` (no
//     running daemon) does not have. Not wired into the CLI for that reason.
//   - classifyEgressIp — exported; needs the daemon's resolved public egress IP (a
//     network lookup), so it is consumed by the daemon/dashboard, not standalone doctor.
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
  // Only meaningful on/after the cutover: before it, claude-tui and the host
  // programmatic providers all bill as flat subscription, so a cost reading is
  // not a reclassification signal. Gating here keeps the behaviour matching the
  // docstring (no surprising pre-cutover warnings).
  if (!isProgrammaticCreditEra(now)) return warnings
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
 * @param {{ apiKeyAuth?: boolean }} [opts] - `apiKeyAuth: true` forwards billing-class's
 *   refinement: claude-sdk/claude-cli authed with an explicit ANTHROPIC_API_KEY bill the
 *   raw API account (api-key), NOT the credit pool — so a BYOK default must NOT trip this
 *   warning. The caller decides this (e.g. claude-sdk + ANTHROPIC_API_KEY set).
 * @returns {Array<{code:string, provider:string, message:string}>}
 */
export function detectSilentMeteredDefault(defaultProvider, now = Date.now(), { apiKeyAuth = false } = {}) {
  if (!isProgrammaticCreditEra(now)) return []
  if (billingClassForProvider(defaultProvider, now, { apiKeyAuth }) !== BILLING_CLASSES.PROGRAMMATIC_CREDIT) return []
  // Derive the boundary date from the shared constant so a moved cutover can't
  // leave a stale string here.
  const cutover = new Date(PROGRAMMATIC_CREDIT_ERA_START).toISOString().slice(0, 10)
  return [{
    code: 'SILENT_METERED_DEFAULT',
    provider: defaultProvider,
    message:
      `The default provider '${defaultProvider}' bills against the metered programmatic-credit pool ` +
      `since ${cutover}. New default sessions draw credits silently — switch with --provider claude-tui ` +
      `(subscription, best-effort) or set ANTHROPIC_API_KEY (BYOK).`,
  }]
}

// Datacenter-egress ban-signal. Cloud-hosted daemons behind a tunnel are a documented
// flag (the audit cites ~20-minute bans on Hetzner ranges). This is a pure classifier
// over a known-prefix list; the caller supplies the public egress ip.
//
// CONSERVATIVE BY DESIGN: only specific, documented datacenter /16-ish ranges are
// listed. Coarse /8 blocks (e.g. AWS/GCP `13.`, `34.`, `52.`) were deliberately
// REMOVED — they span large amounts of residential/ISP space too and would fire false
// positives, training users to ignore the warning. A comprehensive classifier needs a
// maintained cloud-IP dataset (e.g. the published AWS/GCP/Azure range JSON); until that
// is plumbed in, a precise-but-narrow list that never cries wolf beats a broad-but-noisy
// one. A missed datacenter IP is a silent non-warning; a false hit erodes trust.
const DATACENTER_IPV4_PREFIXES = [
  // Hetzner (cited in claude-code#21678) — specific allocated /16s.
  '5.9.', '88.99.', '95.216.', '116.202.', '135.181.', '167.235.', '168.119.',
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
 * @param {{sessions?:Array, defaultProvider?:string, egressIp?:string, now?:number, apiKeyAuth?:boolean}} input
 *   `apiKeyAuth: true` forwards billing-class's refinement to the silent-metered
 *   check so a BYOK (claude-sdk + ANTHROPIC_API_KEY) default isn't flagged.
 */
export function runBillingCanary({ sessions = [], defaultProvider, egressIp, now = Date.now(), apiKeyAuth = false } = {}) {
  const warnings = []
  warnings.push(...detectSilentMeteredDefault(defaultProvider, now, { apiKeyAuth }))
  warnings.push(...detectBillingReclassification(sessions, now))
  const egress = classifyEgressIp(egressIp)
  if (egress.datacenter) warnings.push({ code: egress.code, message: egress.message })
  return {
    eraStarted: isProgrammaticCreditEra(now),
    eraStart: PROGRAMMATIC_CREDIT_ERA_START,
    warnings,
  }
}
