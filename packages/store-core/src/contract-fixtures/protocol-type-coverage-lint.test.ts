/**
 * Protocol server→client TYPE coverage lint — the dashboard-first drift guard
 * (#6033, from the 2026-06-18 SOLID/DRY swarm-audit).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Two guards already exist and neither catches a server→client message type
 * that lands DASHBOARD-FIRST (the mailbox / billing-canary / user-shell /
 * PTY-mirror pattern — added to the dashboard switch + the protocol schema, but
 * never wired into the app):
 *
 *   1. `coverage-lint.test.ts` (#5619) — the both-clients SWITCH_FIXTURES lint.
 *      Its universe is the INTERSECTION of the two clients' handler switches, so
 *      a type only ONE client handles is, by construction, never in scope. A
 *      dashboard-only type is invisible to it.
 *
 *   2. `protocol/tests/handler-coverage.test.js` — the exhaustiveness guard.
 *      It DOES assert "every server→client type is in app OR declared
 *      dashboard-only", which is the right shape — but its source of truth is the
 *      hand-maintained `Server -> Client:` DOC COMMENT in `ws-server.js`, not the
 *      protocol schema. That comment is incomplete: three real `z.literal(...)`
 *      server→client types in `schemas/server.ts` (`billing_canary`,
 *      `budget_resume_ack`, `cancel_activity_ack`) are NOT in it, so they are
 *      worked around in that test's `SYNTHETIC_TYPES` ("not the ws-server.js
 *      broadcast surface the extractor scans") rather than coverage-checked. A
 *      future schema-first type added the same way inherits the same blind spot.
 *
 * WHAT THIS LINT ENFORCES
 * -----------------------
 * It takes the PROTOCOL SCHEMA as the source of truth: every `type:
 * z.literal('<type>')` discriminator declared in `packages/protocol/src/schemas/
 * server.ts` is a server→client message type. For each one it asserts the type
 * is HANDLED BY BOTH CLIENTS — present in the app handler switch AND the
 * dashboard handler switch (a shared store-core dispatch-table entry counts as
 * covering BOTH, since each client routes through `runDispatch` before its own
 * switch) — OR is on an explicit asymmetry allowlist:
 *
 *   - `DASHBOARD_ONLY` — handled by the dashboard by design (the app has no
 *     surface for it yet); mobile parity is a tracked follow-up.
 *   - `APP_ONLY` — handled by the app by design (no dashboard surface).
 *   - `UNHANDLED_BY_DESIGN` — handled at a different layer (connection /
 *     transport / a dedicated short-lived socket), not the main dispatch.
 *
 * A new schema-declared server→client type added to one client (or to neither)
 * without an allowlist entry FAILS this lint — that is the anti-drift guarantee:
 * intentional asymmetry must be DECLARED, accidental asymmetry fails CI.
 *
 * The allowlists are also kept HONEST: a stale entry (a type that no longer
 * exists in the schema, or that has since gained both-client coverage, or whose
 * declared single platform no longer matches reality) fails too — so the
 * allowlists can only describe real, current asymmetries.
 *
 * RELATIONSHIP TO THE OTHER GUARDS
 * --------------------------------
 *   - vs `coverage-lint.test.ts` (#5619): that lint checks FIXTURE coverage of
 *     the both-clients switch INTERSECTION (behavioural-contract drift). THIS
 *     lint checks HANDLER coverage of the protocol's full DECLARED type union
 *     (existence + declared asymmetry). Different universe, different question.
 *   - vs `handler-coverage.test.js`: same shape, but THIS lint's source of truth
 *     is the protocol schema, not the ws-server.js doc comment — so it catches
 *     the schema-first types that guard structurally misses.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  extractAppHandlerTypes,
  extractDashboardHandlerTypes,
} from '@chroxy/protocol/handler-coverage'
import { DISPATCH_TABLE_TYPES } from '../dispatch-table'

const here = dirname(fileURLToPath(import.meta.url))
const serverSchemaDir = resolve(here, '../../../protocol/src/schemas/server')
const appHandlerPath = resolve(here, '../../../app/src/store/message-handler.ts')
const dashHandlerPath = resolve(here, '../../../dashboard/src/store/message-handler.ts')

// ---------------------------------------------------------------------------
// Source of truth — the protocol's server→client message-type union.
//
// The server schemas are individual `z.object({ type: z.literal('<type>'), … })`
// shapes, not one discriminated union we can introspect (see the note in
// dispatch-table.ts). The discriminator literal IS the per-type identity, so we
// static-parse every `type: z.literal('<type>')` from the schemas/server/ domain
// files (server.ts is a thin barrel since #6201 Tier-3 — the literals live in
// the per-domain slices it re-exports). Static text analysis (not a runtime
// import) keeps this cheap and matches how the handler universes are extracted,
// so the comparison is apples-to-apples.
//
// The read is RECURSIVE: #6272 sub-split `control-room.ts` into
// `control-room/<tab>.ts` behind a sub-barrel, so ~22 of the literals now live
// one level down. A non-recursive read would silently miss the whole
// control-room surface (tsc stays green — only this lint catches it), so we walk
// the tree and keep every nested `.ts`.
// ---------------------------------------------------------------------------
function serverSchemaTypes(): string[] {
  const src = readdirSync(serverSchemaDir, { recursive: true })
    .map((f) => f.toString())
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(resolve(serverSchemaDir, f), 'utf-8'))
    .join('\n')
  const types = new Set(
    // Permissive on quote style, identifier chars (digits/caps), and whitespace
    // so a reformat / double-quote / digit-bearing type can't silently slip the
    // drift guard (#6033 review). The `type:` anchor still excludes non-message
    // literals (e.g. serverMode: z.literal('cli'), reason: z.literal(...)).
    [...src.matchAll(/type:\s*z\.literal\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g)].map((m) => m[1]),
  )
  return [...types].sort()
}

// ---------------------------------------------------------------------------
// Per-client handler universes. A type is covered by a client when it has a
// `case`/HANDLERS-map entry in that client's source (via the shared
// @chroxy/protocol/handler-coverage extractors, #6021) OR is registered in the
// shared store-core dispatch table — a dispatch-table case is routed through
// `runDispatch` by BOTH clients before their own switch, so it counts as
// covering both. (The file-ops/git decline nuance from #5653 does not apply to
// the schema-literal universe: none of those decline-capable types are declared
// as `z.literal` server→client schemas here.)
// ---------------------------------------------------------------------------
function clientCoverage(): { inApp: (t: string) => boolean; inDash: (t: string) => boolean } {
  const appTypes = extractAppHandlerTypes(readFileSync(appHandlerPath, 'utf-8'))
  const dashTypes = extractDashboardHandlerTypes(readFileSync(dashHandlerPath, 'utf-8'))
  const dispatch = new Set<string>(DISPATCH_TABLE_TYPES)
  return {
    inApp: (t) => appTypes.has(t) || dispatch.has(t),
    inDash: (t) => dashTypes.has(t) || dispatch.has(t),
  }
}

// ---------------------------------------------------------------------------
// Asymmetry allowlists — DECLARED, intentional single-platform / unhandled
// coverage. Mirrors the rationale recorded in protocol/tests/handler-coverage's
// PLATFORM_SPECIFIC + INTENTIONALLY_UNHANDLED sets (the existing source of those
// decisions); this lint re-states them against the SCHEMA universe so a
// schema-first type can no longer slip past unguarded.
//
// Adding a NEW entry to silence the lint for a freshly-introduced type is only
// legitimate when the asymmetry is genuinely intended (the other client has no
// surface for it yet) — pair it with a tracking note. The preferred fix for an
// accidental gap is to WIRE THE MISSING CLIENT, not to allowlist it.
// ---------------------------------------------------------------------------

// Handled by the DASHBOARD only — the app has no surface for these yet. Each is
// a host-level / desktop-only feature (Control Room, provider-credentials forms,
// pairing-approval banners, the prompt evaluator, the skills panel, the monthly
// budget meter); mobile parity is a tracked follow-up under the cited epic.
const DASHBOARD_ONLY = new Set<string>([
  'git_create_pr_result',       // #6876 in-app PR creation reply — GitPanel "Create PR" flow is dashboard-only for v1; mobile PR-creation UI is a tracked follow-up
  'shell_pending_approval',     // #6277 host-local user-shell approval — "waiting for host approval" banner; dashboard-only for v1, mobile parity deferred
  // activity_snapshot / activity_delta removed — the mobile app now feeds them
  // too (#6246/#6247, the Phase-2 mobile-parity fast-follow per epic #5159), so
  // they are no longer dashboard-only.
  // #6323 (batch 1 of #6314): schemaing these surfaced an existing asymmetry —
  // both are handled by the dashboard only today (the app has no `case`). Not
  // introduced here; the schema just made the lint see them.
  'session_activity',           // per-session busy/idle + cost ping — dashboard activity tree only
  'symbols_snapshot',           // #6471 (epic #6469) opt-in IDE workspace symbol table — dashboard symbol panel (#6472) only for v1; mobile parity is a tracked fast-follow
  'symbol_location',            // #6475 (epic #6469) opt-in IDE go-to-definition result — dashboard file viewer cmd/ctrl+click jump; dashboard-only for v1, mobile parity deferred
  'code_search_results',        // #6474 (epic #6469) opt-in IDE find-in-project results — dashboard Cmd+Shift+F palette; distinct from cross-session `search_results`; dashboard-only for v1
  'references_result',          // #6477 (epic #6469) opt-in IDE find-all-references — dashboard references palette (alt+click); dashboard-only for v1
  'terminal_size',              // authoritative PTY grid for letterboxing — app terminal parity is still partial (#5987)
  // #6332 (batch 2b of #6314): the container/worktree environment lifecycle —
  // dashboard-only by design (the app has no environment surface). Schemaing
  // them surfaced the existing asymmetry; not introduced here.
  'environment_created',        // env lifecycle (dashboard relies on the environment_list that follows)
  'environment_destroyed',      // env lifecycle (dashboard relies on the following environment_list)
  'environment_error',          // env op error — dashboard console-errors it; app has no env surface
  'environment_info',           // single-env descriptor — dashboard-only
  'environment_list',           // env survey — dashboard Control Room only
  'billing_canary',             // live billing-canary banner (#5821) — dashboard sidebar
  'byok_credentials_status',    // BYOK paste-API-key form (#4052) — dashboard-only for v1
  'cancel_activity_ack',        // Control Room cancel-click correlation ack (#5277)
  'containers_status_snapshot', // Control Room containers & environments survey (#6133, epic #5530) — dashboard-only
  'containers_action_ack',      // Control Room container lifecycle action ack (#6134, epic #5530) — dashboard-only
  'repo_runtime_config_snapshot', // Control Room per-repo runtime config survey (#6139, epic #5530) — dashboard-only
  'byok_pool_status_snapshot',  // Control Room BYOK pool survey (#6135, epic #5530) — dashboard-only
  'byok_pool_action_ack',       // Control Room BYOK pool action ack (#6135, epic #5530) — dashboard-only
  'host_prune_status_snapshot', // Control Room host prune guardrails survey (#6140, epic #5530) — dashboard-only
  'host_prune_action_ack',      // Control Room host prune action ack (#6140, epic #5530) — dashboard-only
  'simulator_status_snapshot',  // Control Room iOS simulator survey (#6136, epic #5530) — dashboard-only (Device runtimes tab)
  'simulator_action_ack',       // Control Room iOS simulator boot/shutdown action ack (#6136, epic #5530) — dashboard-only
  'emulator_status_snapshot',   // Control Room Android emulator survey (#6137, epic #5530) — dashboard-only (Device runtimes Android panel)
  'emulator_action_ack',        // Control Room Android emulator boot/kill action ack (#6137, epic #5530) — dashboard-only
  'wsl_status_snapshot',        // Control Room WSL2 distro survey (#6138, epic #5530) — dashboard-only (Device runtimes WSL panel)
  'wsl_action_ack',             // Control Room WSL2 start/terminate action ack (#6138, epic #5530) — dashboard-only
  'chroxy_context_hint_changed',// per-session context-hint toggle (#3805) — dashboard-only for v1
  'credential_test_result',     // Provider Credentials "Test" result (#3855) — dashboard-only
  'credentials_status',         // Provider Credentials pane (#3855) — dashboard-only
  'evaluate_draft_result',      // manual prompt evaluator (#3068) — dashboard-only for v1
  'evaluator_clarify',          // auto-evaluator clarify banner (#3188) — dashboard-only
  'evaluator_rewrite',          // auto-evaluator rewrite banner (#3188) — dashboard-only
  'host_status_snapshot',       // Control Room Host/Repo Status (#5170) — dashboard-only for v1
  'permission_audit_result',    // #6772 query_permission_audit reply — dashboard SettingsPanel "Permission history"; first client caller, dashboard-only for v1 (mobile PermissionHistory reads the chat transcript, not this wire query)
  // permission_input removed — the mobile app now handles it too (#6543 PR-4,
  // the pre-write-diff mobile parity fast-follow), so it is no longer
  // dashboard-only. Both clients dispatch it into `permissionInputs[requestId]`.
  'integration_action_ack',     // Control Room Integrations action ack (#5500) — dashboard-only
  'integration_status_snapshot',// Control Room Integrations survey (#5499) — dashboard-only
  'mailbox_status_snapshot',    // Control Room Mailbox tab survey (#5914) — dashboard-only
  'external_sessions_snapshot', // Control Room mission-control external-session survey (#5969, epic #5422) — dashboard-only (mobile parity tracked by #5968)
  'repo_events_snapshot',       // Control Room repo-events survey (#5966, epic #5422 phase 5) — GitHub-webhook activity, dashboard-only for v1; mobile parity deferred
  'repo_events_delta',          // Control Room repo-events LIVE delta (#6536, PR-2 of #5966) — host-broadcast of a new webhook event; dashboard-only for v1; mobile parity deferred
  'monthly_budget',             // monthly programmatic-credit meter (#5665) — dashboard sidebar
  'pair_pending',               // pairing-approval banner fan-out (#5510) — dashboard-only for v1
  'pair_resolved',              // pairing-approval banner retraction (#5510) — dashboard-only for v1
  'prompt_evaluator_changed',   // per-session promptEvaluator toggle (#3185) — dashboard-only
  'runner_status_snapshot',     // Control Room self-hosted runner survey (#5253) — dashboard-only
  'session_preamble_changed',   // per-session preamble (#4660) — dashboard-only for v1
  'session_preset_snapshot',    // Control Room per-repo session-preset survey (#5553) — dashboard-only
  'skill_activated',            // manual-skill runtime toggle (#3209) — dashboard-only for v1
  'skill_changed',              // skill content-hash mismatch (#3205) — dashboard-only for v1
  'skill_deactivated',          // manual-skill runtime toggle (#3209) — dashboard-only for v1
  'skill_trust_accepted',       // operator-confirmed re-trust (#3235) — dashboard-only for v1
  'skill_trust_grant_ok',       // skill_trust_grant ack (#3297) — dashboard-only for v1
  'skill_trust_granted',        // community trust granted broadcast (#3297) — dashboard-only for v1
  'skill_trust_request',        // community skill awaiting first-activation grant (#3297) — dashboard-only
  'skills_inventory_snapshot',  // Control Room Skills inventory survey (#5554) — dashboard-only
  'skills_list',                // skills list response (#3209) — dashboard-only for v1
  'summarize_session_result',   // sidebar "Summarize & start new session" reply (#5547) — dashboard-only
  // Orchestration harness (#6691, S-3 #6702): the Control Room Runs tab —
  // dashboard-only v1 per the design's locked decisions; mobile parity is an
  // explicit fast-follow. Moved here from UNHANDLED_BY_DESIGN when the
  // dashboard handlers landed.
  'orchestration_runs_snapshot', // Runs tab list survey
  'orchestration_run_snapshot',  // one run's full detail (pull-only)
  'orchestration_run_delta',     // live run update (store-core applyRunDelta, seq contract)
  'orchestration_action_ack',    // mutating-action success echo
])

// Handled by the APP only — no dashboard surface by design.
const APP_ONLY = new Set<string>([
  'push_token_error',           // push notifications are mobile-only
])

// Declared server→client schema types handled at a layer OTHER than the main
// client message-handler dispatch (connection/transport, or a dedicated
// short-lived socket), so neither client's main switch covers them. Mirrors
// handler-coverage's INTENTIONALLY_UNHANDLED.
const UNHANDLED_BY_DESIGN = new Set<string>([
  // rate_limited — now handled in both clients' switch (#6334): a system throttle
  // notice (handleRateLimited), with a both-clients SWITCH_FIXTURES entry. Removed
  // from this set (it has a real handler + contract fixture now).
  'extension_message',                    // routed to the extension framework, not the main switch
  'pair_request_pending',                 // pairing-approval primitive (#5510) — consumed by the requester's
                                          //   dedicated request-pairing socket, not the main dispatch
  'pair_result',                          // pairing-approval primitive (#5510) — terminal result for the
                                          //   requester, handled by request-pairing.ts, not the main dispatch
  'prompt_evaluator_skip_pattern_changed',// #3639 broadcast — surface is the per-session field on session_list;
                                          //   no dedicated handler yet (dashboard exposure is a deferred follow-up)
  'stdin_dropped_totals',                 // #3544 transient counter — surface is the SessionInfo flag on
                                          //   session_list, not a dedicated wire-event handler
])

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('protocol server→client type coverage lint (#6033)', () => {
  const types = serverSchemaTypes()
  const { inApp, inDash } = clientCoverage()

  it('derives a non-trivial server→client schema-type union (extraction sanity)', () => {
    // Floor-only guard (#6274). The only regression this protects against is a
    // PARSER fault that silently empties the universe — e.g. the schema being
    // reformatted, or barrel-split (#6272), so the `z.literal` regex stops
    // matching — which would make every coverage assertion below pass vacuously.
    // A generous floor well below the real count (~108) trips LOUDLY on that
    // collapse. The prior [80,120] band added a ceiling that policed legitimate
    // GROWTH (only ~12 headroom — a new server→client type or another tab-split
    // would have failed the lint spuriously) for no protective value: a parser
    // regression empties the universe, it does not inflate it. So: floor, no
    // ceiling — add new types freely; only a collapse-to-near-zero fails here.
    expect(types.length).toBeGreaterThanOrEqual(70)
  })

  it('every server→client schema type is handled by BOTH clients or explicitly declared asymmetric', () => {
    const undeclared = types
      .filter(
        (t) =>
          !(inApp(t) && inDash(t)) &&
          !DASHBOARD_ONLY.has(t) &&
          !APP_ONLY.has(t) &&
          !UNHANDLED_BY_DESIGN.has(t),
      )
      .map((t) => {
        const where = inApp(t) ? 'app only' : inDash(t) ? 'dashboard only' : 'NEITHER client'
        return `${t} (${where})`
      })
    expect(
      undeclared,
      'Server→client schema type(s) NOT handled by both clients and NOT on an ' +
        'asymmetry allowlist — the dashboard-first drift this lint guards. Wire ' +
        'the missing client (preferred), or — only if the asymmetry is intended ' +
        '— add the type to DASHBOARD_ONLY / APP_ONLY / UNHANDLED_BY_DESIGN with a ' +
        `tracking note:\n  ${undeclared.join('\n  ')}`,
    ).toEqual([])
  })

  it('DASHBOARD_ONLY entries are real schema types actually handled by the dashboard only', () => {
    const schemaSet = new Set(types)
    const violations: string[] = []
    for (const t of DASHBOARD_ONLY) {
      if (!schemaSet.has(t)) violations.push(`${t}: not a server→client schema type (stale)`)
      else if (!inDash(t)) violations.push(`${t}: declared dashboard-only but NOT handled by the dashboard`)
      else if (inApp(t)) violations.push(`${t}: now handled by the app too — remove from DASHBOARD_ONLY`)
    }
    expect(
      violations,
      'DASHBOARD_ONLY allowlist drifted from reality:\n  ' + violations.join('\n  '),
    ).toEqual([])
  })

  it('APP_ONLY entries are real schema types actually handled by the app only', () => {
    const schemaSet = new Set(types)
    const violations: string[] = []
    for (const t of APP_ONLY) {
      if (!schemaSet.has(t)) violations.push(`${t}: not a server→client schema type (stale)`)
      else if (!inApp(t)) violations.push(`${t}: declared app-only but NOT handled by the app`)
      else if (inDash(t)) violations.push(`${t}: now handled by the dashboard too — remove from APP_ONLY`)
    }
    expect(
      violations,
      'APP_ONLY allowlist drifted from reality:\n  ' + violations.join('\n  '),
    ).toEqual([])
  })

  it('UNHANDLED_BY_DESIGN entries are real schema types handled by neither client', () => {
    const schemaSet = new Set(types)
    const violations: string[] = []
    for (const t of UNHANDLED_BY_DESIGN) {
      if (!schemaSet.has(t)) violations.push(`${t}: not a server→client schema type (stale)`)
      else if (inApp(t) || inDash(t)) {
        const where = [inApp(t) && 'app', inDash(t) && 'dashboard'].filter(Boolean).join(' and ')
        violations.push(`${t}: declared unhandled but handled by ${where} — move to an ONLY allowlist or remove`)
      }
    }
    expect(
      violations,
      'UNHANDLED_BY_DESIGN allowlist drifted from reality:\n  ' + violations.join('\n  '),
    ).toEqual([])
  })
})
