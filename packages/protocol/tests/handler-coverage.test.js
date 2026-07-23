import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  extractAppHandlerTypes,
  extractDashboardHandlerTypes,
} from '@chroxy/protocol/handler-coverage'

/**
 * Handler coverage contract test
 *
 * Verifies that both the mobile app and web dashboard message handlers cover
 * all ServerMessageType values from @chroxy/protocol, or explicitly declare
 * types as platform-specific.
 *
 * Uses static analysis (regex on source files) — no runtime imports needed.
 *
 * RELATIONSHIP TO THE #5556.5 BEHAVIORAL-CONTRACT FIXTURES
 * --------------------------------------------------------
 * This guard is a SPELLING / EXHAUSTIVENESS check: it asserts that EVERY
 * ServerMessageType has *some* handler `case` (in a client switch, the shared
 * store-core dispatch table, or an explicit exclusion). It is RETAINED because
 * it covers an axis the fixtures do not: completeness across ALL ~95 message
 * types, catching a brand-new wire type that nobody wired up anywhere.
 *
 * It does NOT — and structurally cannot — assert that the two clients produce
 * the SAME store mutation for a given input; a case can exist in both and still
 * behave differently (the exact drift the #5556 swarm-audit found). That gap is
 * closed by the BEHAVIORAL-CONTRACT FIXTURES in
 * `packages/store-core/src/contract-fixtures/` (driven through both clients'
 * real dispatch table + switch in store-core / app jest / dashboard vitest).
 * The two are complementary: this guard = "a handler exists for every type";
 * the fixtures = "the handlers that exist agree on behaviour".
 */

// ---------------------------------------------------------------------------
// Synthetic / internal message types that the server injects locally or that
// are handled as protocol-level wrappers (not in ServerMessageType enum).
// These are valid handler cases but NOT part of the protocol enum.
// ---------------------------------------------------------------------------
const SYNTHETIC_TYPES = new Set([
  'raw',               // raw terminal output (server-internal)
  'raw_background',    // background agent raw output (server-internal)
  'user_input',        // echoed user input (server-internal)
  'permission_resolved', // permission outcome (server-internal)
  'subscriptions_updated', // subscription ack (server-internal)
  'conversations_list',    // legacy alias for list response
  'search_results',        // legacy alias for search response
  'budget_resumed',        // budget resume ack (server-internal)
  'budget_resume_ack',     // #5752 resume_budget positive ack — emitted from input-handlers.js (not the ws-server.js broadcast surface the extractor scans), handled by the shared store-core dispatch table
  'cancel_activity_ack',   // #5277 cancel correlation ack — emitted from input-handlers.js (not the ws-server.js broadcast surface the extractor scans), handled by the dashboard
  'billing_canary',        // #5821 live billing canary — broadcast from billing-canary-monitor.js (not the ws-server.js broadcast surface the extractor scans), handled by the dashboard; also seeded into auth_ok
  'thinking_level_changed', // thinking level change ack (server-internal)
  'permission_timeout',     // handled by both clients for the future permission timeout event (not yet in protocol; dashboard gained parity in #5454)
])

// ---------------------------------------------------------------------------
// Intentionally unhandled types — present in the protocol enum but handled
// at a different layer (connection/transport) or reserved for future use.
// Neither handler's switch/case needs to cover these.
// ---------------------------------------------------------------------------
const INTENTIONALLY_UNHANDLED = new Set([
  'encrypted',          // unwrapped at connection layer before dispatch to handleMessage
  'status',             // legacy/unused — server_status is the active equivalent
  // 'error' removed — both handlers now implement case 'error': (PR #2742)
  'session_created',    // ack handled via session_list refresh, no dedicated case needed
  'session_destroyed',  // ack handled via session_list refresh, no dedicated case needed
  'discovered_sessions', // multi-server discovery, handled at connection layer
  // rate_limited — now handled in both clients' switch (#6334): a system throttle notice.
  'extension_message',  // extension framework, routed to extension handlers not main switch
  'stdin_dropped_totals', // #3544 transient counter event — surface is the SessionInfo.stdinForwardingDisabled flag from session_list (#3567/#3593), not the wire event; live counter consumers tracked in #3573
  'pair_request_pending', // #5510 pairing-approval primitive — consumed by the dedicated requester panel (dashboard utils/request-pairing.ts, its own short-lived WS onmessage), NOT the main message-handler dispatch the extractor scans. Mobile requester side is an explicit out-of-scope fast-follow per epic #5509.
  'pair_result',          // #5510 pairing-approval primitive — same as pair_request_pending: terminal result for the requester, handled by utils/request-pairing.ts, not the main dispatch. Mobile requester side deferred per epic #5509.
  // 'activity_snapshot' / 'activity_delta' removed — the dashboard now handles
  // them (Control Room panel #5163); they moved to PLATFORM_SPECIFIC as
  // 'dashboard'. Mobile parity is a Phase-2 fast-follow per epic #5159.
  // 'wsl_status_snapshot' / 'wsl_action_ack' removed — the dashboard now handles
  // them (Control Room WSL panel #6138); they moved to PLATFORM_SPECIFIC as
  // 'dashboard'. Windows-host-only surface; the mobile app has no Control Room.
  // 'host_status_snapshot' removed — the dashboard now handles it (Control
  // Room Host/Repo Status section #5175); it moved to PLATFORM_SPECIFIC as
  // 'dashboard'. Mobile parity is a Phase-2 fast-follow per epic #5170.
  // 'session_stopped' removed — both handlers now implement case 'session_stopped': (dashboard #4878, mobile #4879)
  'prompt_evaluator_skip_pattern_changed', // #3639 server emits the broadcast; dashboard exposure (toggle UI + receipt handler) is a deferred follow-up — until then the surface is the per-session promptEvaluatorSkipPattern field on session_list. Pairs with the parent epic #3068.
  // 'session_usage' is now handled by both dashboard (#4073) and mobile
  // app (#4074); no PLATFORM_SPECIFIC entry needed. Coverage test passes
  // because each handler has a `case 'session_usage':` clause.
  // 'evaluator_rewrite' removed — dashboard now handles it (#3188)
  // 'evaluator_clarify' removed — dashboard now handles it (#3188)
  // 'skills_list' removed — dashboard now handles it (#3209)
  // 'skill_changed' removed — dashboard now handles it (#3205)
  // 'skill_trust_request' removed — dashboard now handles it (#3298)
  // 'skill_trust_granted' removed — dashboard now handles it (#3298)
  // 'skill_trust_grant_ok' removed — dashboard now handles it (#3298)
])

// ---------------------------------------------------------------------------
// Platform-specific types — handled by only ONE platform by design.
// Key = message type, Value = which handler covers it.
// ---------------------------------------------------------------------------
const PLATFORM_SPECIFIC = {
  // Mobile app only
  // (pair_fail is now handled by BOTH platforms — the dashboard gained
  //  paste-a-pairing-URL support in #5297 — so it's no longer platform-specific.)
  'push_token_error': 'app',    // push notifications are mobile-only
  'write_file_result': 'app',   // app file editing UI
  // git_branches_result / git_stage_result / git_unstage_result /
  // git_commit_result removed from PLATFORM_SPECIFIC — the dashboard now
  // handles them too (#6780: git stage + commit UI), so they are BOTH-CLIENTS.
  // Coverage passes because each handler covers them (the app via the shared
  // store-core dispatch-table git callbacks, the dashboard via its new
  // `case 'git_*_result':` clauses).

  // Dashboard only
  'pairing_refreshed': 'dashboard',  // QR display and auto-refresh is dashboard-only (#2916)
  'pair_pending': 'dashboard',       // #5510 pairing-approval primitive — host-level approval banner fan-out is dashboard-only for v1 (the mobile app has no approve surface yet); mobile/desktop-tray approve is an explicit out-of-scope fast-follow per epic #5509
  'pair_resolved': 'dashboard',      // #5510 pairing-approval primitive — banner retraction pairs with pair_pending; dashboard-only for v1, mobile parity deferred per epic #5509
  'shell_pending_approval': 'dashboard', // #6277 host-local user-shell approval — "waiting for host approval" banner; dashboard-only for v1, mobile parity deferred
  'monthly_budget': 'dashboard',     // #5665 monthly programmatic-credit meter renders in the dashboard sidebar; mobile parity tracked as a follow-up
  'log_entry': 'dashboard',          // console page is dashboard-only
  'file_list': 'dashboard',          // file explorer sidebar is dashboard-only
  'symbols_snapshot': 'dashboard',   // #6471 (epic #6469) opt-in IDE symbol table — dashboard symbol panel (#6472) is dashboard-only for v1; mobile parity is a tracked fast-follow
  'symbol_location': 'dashboard',    // #6475 (epic #6469) opt-in IDE go-to-definition result — dashboard file viewer cmd/ctrl+click jump; dashboard-only for v1, mobile parity deferred
  'code_search_results': 'dashboard', // #6474 (epic #6469) opt-in IDE find-in-project results — dashboard Cmd+Shift+F palette; distinct from cross-session `search_results`; dashboard-only for v1
  'references_result': 'dashboard',   // #6477 (epic #6469) opt-in IDE find-all-references — dashboard references palette (alt+click); dashboard-only for v1
  'environment_created': 'dashboard', // environment panel is dashboard-only
  'environment_list': 'dashboard',    // environment panel is dashboard-only
  'environment_destroyed': 'dashboard', // environment panel is dashboard-only
  'environment_info': 'dashboard',    // environment panel is dashboard-only
  'environment_error': 'dashboard',   // environment panel is dashboard-only
  'evaluate_draft_result': 'dashboard', // manual prompt evaluator (#3068) is dashboard-only for v1
  'prompt_evaluator_changed': 'dashboard', // per-session promptEvaluator toggle (#3185) is dashboard-only — same epic as evaluate_draft_result, mobile app exposure tracked in #3068
  'chroxy_context_hint_changed': 'dashboard', // per-session Chroxy context hint toggle (#3805) is dashboard-only for v1; mobile mirror tracked in the issue's non-goals
  'session_preamble_changed': 'dashboard', // per-session preamble (#4660) is dashboard-only for v1; mobile mirror tracked in the issue's out-of-scope section
  'evaluator_rewrite': 'dashboard',   // auto-evaluator rewrite broadcast (#3208 schema, #3186 emit, #3188 handler) — dashboard renders rewrite-explanation banner; mobile app exposure tracked under parent epic #3068
  'evaluator_clarify': 'dashboard',   // auto-evaluator clarify broadcast (#3208 schema, #3186 emit, #3188 handler) — dashboard renders inline clarify question with iteration counter; mobile app exposure tracked under parent epic #3068
  'skills_list': 'dashboard',       // skills list response (#3209) is dashboard-only for v1; mobile app exposure tracked under parent epic #2958
  'skill_changed': 'dashboard',     // skill content-hash mismatch event (#3234/#3205) is dashboard-only for v1; mobile app exposure tracked under parent epic #2959
  'skill_activated': 'dashboard',   // manual-skill runtime toggle (#3209) is dashboard-only for v1; mobile app exposure tracked under parent epic #2958
  'skill_deactivated': 'dashboard', // manual-skill runtime toggle (#3209) is dashboard-only for v1; mobile app exposure tracked under parent epic #2958
  'skill_trust_accepted': 'dashboard', // operator-confirmed re-trust (#3235) is dashboard-only for v1 — pairs with skill_changed; mobile app exposure tracked under parent epic #2959
  'skill_trust_request': 'dashboard',  // community skill awaiting first-activation grant (#3297) — dashboard-only for v1; mobile app exposure tracked under parent epic #2959
  'skill_trust_granted': 'dashboard',  // community trust granted broadcast (#3297) — dashboard-only for v1; mobile app exposure tracked under parent epic #2959
  'skill_trust_grant_ok': 'dashboard', // ack for skill_trust_grant handler (#3297) — dashboard-only for v1; mobile app exposure tracked under parent epic #2959
  'byok_credentials_status': 'dashboard', // paste-API-key form is dashboard-only (#4052); mobile app exposure tracked under the BYOK epic #4047
  'credentials_status': 'dashboard',   // Provider Credentials pane is dashboard-only (#3855); mobile app exposure tracked under the BYOK epic #4047
  'credential_test_result': 'dashboard', // Provider Credentials "Test" result is dashboard-only (#3855); mobile app exposure tracked under the BYOK epic #4047
  // 'multi_question_intervention' is now handled by both dashboard (#4758)
  // and mobile app (#4764 / PR #4862); no PLATFORM_SPECIFIC entry needed.
  // Coverage test passes because each handler has a
  // `case 'multi_question_intervention':` clause.
  // 'terminal_output' is now handled by both dashboard (#5835 PR2) and the
  // mobile app (#5987 — the user-shell read-only mirror routes it through the
  // same write-callback → xterm path as 'raw'); no PLATFORM_SPECIFIC entry
  // needed. Coverage passes because each handler has a `case 'terminal_output':`.
  'terminal_size': 'dashboard', // #5835 Phase 2 authoritative live-PTY grid size — the dashboard letterboxes the mirror to it (setTerminalSize); mobile applies resize from its own pane measurement (#5987) but does not yet consume the server's terminal_size echo, so still dashboard-only
  'session_activity': 'dashboard', // server-broadcast busy/idle flips (#4639) — dashboard syncs sessionStates[id].isIdle so the Working banner survives tab swap; mobile app exposure tracked alongside the rest of the dashboard-only handlers
  // 'activity_snapshot' / 'activity_delta' removed from PLATFORM_SPECIFIC — the
  // mobile app now feeds them too (#6246/#6247, the Phase-2 mobile-parity
  // fast-follow per epic #5159), so they are BOTH-CLIENTS and the coverage test
  // passes because each handler has a `case 'activity_snapshot'/'activity_delta':`.
  'host_status_snapshot': 'dashboard', // Control Room Host/Repo Status survey reply (#5171 schema / #5174 server emitter / #5175 dashboard section) — dashboard-only for v1; mobile parity is a Phase-2 fast-follow per epic #5170
  'permission_audit_result': 'dashboard', // #6772 reply to query_permission_audit — the dashboard SettingsPanel "Permission history" view is the first (and only, for v1) client caller; the mobile PermissionHistory screen derives its summary from the live chat transcript, not this wire query, so mobile parity is a fast-follow
  // 'permission_input' removed from PLATFORM_SPECIFIC — the mobile app now
  // handles it too (#6543 PR-4, the pre-write-diff mobile parity fast-follow),
  // so it is BOTH-CLIENTS. Coverage passes because the dashboard has a
  // `permission_input: handlePermissionInput` HANDLERS-map entry and the mobile
  // app has a `case 'permission_input':` clause.
  'repo_events_snapshot': 'dashboard', // Control Room repo-events survey reply (#5966, epic #5422 phase 5) — GitHub-webhook activity buffered by the daemon (#6468); host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'repo_events_delta': 'dashboard', // Control Room repo-events LIVE delta (#6536, PR-2 of #5966) — host-broadcast of a new webhook event so the pane updates without a Refresh; host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'github_webhook_config': 'dashboard', // Control Room repo-events webhook-secret config reply (#6540, item 3 of #6536) — set/rotate the HMAC secret + payload URL + delivery status; host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'runner_status_snapshot': 'dashboard', // Control Room self-hosted runner survey reply (#5253) — host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'containers_status_snapshot': 'dashboard', // Control Room containers & environments survey reply (#6133, epic #5530) — host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'repo_runtime_config_snapshot': 'dashboard', // Control Room per-repo runtime config survey reply (#6139, epic #5530) — host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'integration_status_snapshot': 'dashboard', // Control Room Integrations survey reply (#5499, epic #5498) — host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'integration_action_ack': 'dashboard', // Control Room Integrations Reindex action ack (#5500, epic #5498) — host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'containers_action_ack': 'dashboard', // Control Room container lifecycle action ack (#6134, epic #5530) — the dashboard consumes it to clear pending row state; host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'byok_pool_status_snapshot': 'dashboard', // Control Room BYOK pool stats survey reply (#6135, epic #5530) — host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'byok_pool_action_ack': 'dashboard', // Control Room BYOK pool mutating-action (drain/recycle/resize) ack (#6135, epic #5530) — the dashboard consumes it to clear pending target state; host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'host_prune_status_snapshot': 'dashboard', // Control Room host prune guardrails survey reply (#6140, epic #5530) — host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'host_prune_action_ack': 'dashboard', // Control Room host prune action ack (#6140, epic #5530) — the dashboard consumes it to clear pending kind state; host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'simulator_status_snapshot': 'dashboard', // Control Room iOS simulator survey reply (#6136, epic #5530) — the Device runtimes tab consumes it (devices + Ready-for-Maestro verdict); host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'simulator_action_ack': 'dashboard', // Control Room iOS simulator boot/shutdown action ack (#6136, epic #5530) — the dashboard consumes it to clear pending device state; host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'emulator_status_snapshot': 'dashboard', // Control Room Android emulator survey reply (#6137, epic #5530) — the Device runtimes Android panel consumes it (devices + Ready-for-Maestro verdict); host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'emulator_action_ack': 'dashboard', // Control Room Android emulator boot/kill action ack (#6137, epic #5530) — the dashboard consumes it to clear pending device state; host-level surface, dashboard-only; mobile parity would be a fast-follow
  'wsl_status_snapshot': 'dashboard', // Control Room WSL2 distro survey reply (#6138, epic #5530) — the Device runtimes WSL panel consumes it (handleWslStatusSnapshot). Windows-host-only surface; the mobile app has no Control Room.
  'wsl_action_ack': 'dashboard', // Control Room WSL2 start/terminate action ack (#6138, epic #5530) — the dashboard consumes it to clear pending + record the outcome (handleWslActionAck). Windows-host-only surface.
  'skills_inventory_snapshot': 'dashboard', // Control Room Skills inventory survey reply (#5554, epic #5159) — host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'mailbox_status_snapshot': 'dashboard', // Control Room "Mailbox" tab survey reply (#5914 follow-up) — host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity would be a fast-follow
  'external_sessions_snapshot': 'dashboard', // Control Room mission-control external-session survey reply (#5969, epic #5422) — host-level surface, dashboard-only (the mobile app has no Control Room); mobile parity is tracked by #5968
  'summarize_session_result': 'dashboard', // sidebar "Summarize & start new session" reply (#5547) — the sidebar context-menu idiom is dashboard-only; the mobile app is out of scope for v1 (the server endpoint is client-agnostic so the app can adopt later)
  'session_preset_snapshot': 'dashboard', // Control Room per-repo session-preset reply (#5553, epic #5159) — host-level surface (gear drawer + create-modal disclosure), dashboard-only; the server applies the preamble universally, so the mobile app needs no handler for v1 (explicitly out of scope per the issue)
  'orchestration_runs_snapshot': 'dashboard', // Control Room "Runs" tab list survey (#6691 S-3, epic #6702) — host-level surface, dashboard-only v1; mobile parity is an explicit fast-follow per the design's locked decisions
  'orchestration_run_snapshot': 'dashboard',  // one run's full detail (pull-only) for the Runs tab detail panel (#6691 S-3) — dashboard-only v1
  'orchestration_run_delta': 'dashboard',     // live run update for the Runs tab (seq===held+1 contract via store-core applyRunDelta) (#6691 S-3) — dashboard-only v1
  'orchestration_action_ack': 'dashboard',    // terminal success echo for mutating orchestration actions (#6691 S-3) — dashboard-only v1
  // 'agent_event' (#5016) is now handled by both dashboard and mobile
  // app (#5060 — mobile renders the same nested sub-bubbles inside the
  // parent Task tool_call). No PLATFORM_SPECIFIC entry needed; the
  // coverage test passes because both handlers have a
  // `case 'agent_event':` clause.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the message types owned by the SHARED store-core dispatch table
 * (epic #5556, sub-item 3). These cases were migrated OUT of both
 * clients' switches into `store-core/src/dispatch-table.ts`, so they no longer
 * appear as a `case` in app/dashboard source — but they ARE covered by both
 * clients (each routes through `runDispatch` before its own switch). The
 * coverage checks below union this set into BOTH client type sets so a
 * table-registered case counts as covered for both platforms.
 *
 * Source of truth is the `DISPATCH_TABLE_TYPES` array in dispatch-table.ts;
 * static-parse it (same approach as the rest of this test — no runtime import).
 */
function extractSharedDispatchTypes(dispatchSrc) {
  const block = dispatchSrc.match(
    /DISPATCH_TABLE_TYPES:\s*readonly\s+DispatchMessageType\[\]\s*=\s*\[([\s\S]*?)\]/,
  )
  assert.ok(block, 'Should find DISPATCH_TABLE_TYPES array in dispatch-table.ts')
  const types = [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assert.ok(types.length > 0, 'Should find shared dispatch-table types')
  return new Set(types)
}

function extractServerMessageTypes(wsServerSrc) {
  // Extract server message types from the Server -> Client doc comment in ws-server.js
  const serverSection = wsServerSrc.match(/\* Server -> Client:\n([\s\S]*?)\n \*\n \* Encrypted envelope/)?.[1]
  assert.ok(serverSection, 'Should find Server -> Client section in ws-server.js')

  const types = [...serverSection.matchAll(/type: '(\w+)'/g)].map(m => m[1])
  assert.ok(types.length > 0, 'Should find server message types')

  // 'encrypted' is documented in the Encrypted envelope section (bidirectional)
  const result = new Set(types)
  result.add('encrypted')
  return result
}

// extractAppHandlerTypes / extractDashboardHandlerTypes are imported from the
// shared @chroxy/protocol/handler-coverage module (#6021) so this guard and the
// store-core coverage lint can never diverge on how they parse the two clients'
// handler sources.

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handler coverage contract', () => {
  // Load all source files once
  const wsServerPath = resolve(import.meta.dirname, '../../server/src/ws-server.js')
  const appHandlerPath = resolve(import.meta.dirname, '../../app/src/store/message-handler.ts')
  const dashHandlerPath = resolve(import.meta.dirname, '../../dashboard/src/store/message-handler.ts')
  const dispatchTablePath = resolve(import.meta.dirname, '../../store-core/src/dispatch-table.ts')

  const wsServerSrc = readFileSync(wsServerPath, 'utf-8')
  const appSrc = readFileSync(appHandlerPath, 'utf-8')
  const dashSrc = readFileSync(dashHandlerPath, 'utf-8')
  const dispatchSrc = readFileSync(dispatchTablePath, 'utf-8')

  const allServerTypes = extractServerMessageTypes(wsServerSrc)
  // #5556 — cases owned by the shared store-core dispatch table count as
  // covered by BOTH clients (each routes through `runDispatch` first). Union
  // them into both per-client sets so a migrated case isn't reported missing.
  //
  // #5653 — EXCEPTION for decline-capable cases: some shared-table handlers
  // (the file-ops / git wrapper cases) require a client to opt its imperative
  // -callback registry into the table via `adapter.getCallback`; a client that
  // does not (the dashboard) DECLINES — `runDispatch` returns false and the
  // case falls through to that client's own switch. So a shared-table type that
  // is declared single-platform in PLATFORM_SPECIFIC is credited ONLY to its
  // declared platform, not blindly to both (the other platform really does NOT
  // handle it — it declines and has no local case). This keeps the
  // "PLATFORM_SPECIFIC matches actual coverage" guard honest.
  const platformSpecificSet = new Set(Object.keys(PLATFORM_SPECIFIC))
  const sharedDispatchTypes = extractSharedDispatchTypes(dispatchSrc)
  const sharedForApp = new Set(
    [...sharedDispatchTypes].filter(
      (t) => !platformSpecificSet.has(t) || PLATFORM_SPECIFIC[t] === 'app',
    ),
  )
  const sharedForDash = new Set(
    [...sharedDispatchTypes].filter(
      (t) => !platformSpecificSet.has(t) || PLATFORM_SPECIFIC[t] === 'dashboard',
    ),
  )
  const appTypes = new Set([...extractAppHandlerTypes(appSrc), ...sharedForApp])
  const dashTypes = new Set([...extractDashboardHandlerTypes(dashSrc), ...sharedForDash])

  it('every ServerMessageType is handled by at least one handler (or explicitly excluded)', () => {
    const unhandled = []

    for (const type of allServerTypes) {
      if (INTENTIONALLY_UNHANDLED.has(type)) continue

      const inApp = appTypes.has(type)
      const inDash = dashTypes.has(type)

      if (!inApp && !inDash) {
        unhandled.push(type)
      }
    }

    assert.equal(
      unhandled.length, 0,
      `The following ServerMessageType values are not handled by ANY handler:\n` +
      unhandled.map(t => `  - ${t}`).join('\n') +
      `\n\nEither add handling in app or dashboard message-handler.ts, ` +
      `add to PLATFORM_SPECIFIC if intentionally single-platform, ` +
      `or add to INTENTIONALLY_UNHANDLED with a justification comment.`,
    )
  })

  it('app handler covers all non-dashboard-specific ServerMessageTypes', () => {
    const dashOnly = new Set(
      Object.entries(PLATFORM_SPECIFIC)
        .filter(([, platform]) => platform === 'dashboard')
        .map(([type]) => type),
    )

    const missing = []
    for (const type of allServerTypes) {
      if (INTENTIONALLY_UNHANDLED.has(type)) continue
      if (dashOnly.has(type)) continue // intentionally dashboard-only
      if (!appTypes.has(type)) {
        missing.push(type)
      }
    }

    assert.equal(
      missing.length, 0,
      `App message handler is missing the following ServerMessageTypes:\n` +
      missing.map(t => `  - ${t}`).join('\n') +
      `\n\nEither handle in packages/app/src/store/message-handler.ts, ` +
      `add to PLATFORM_SPECIFIC as 'dashboard', ` +
      `or add to INTENTIONALLY_UNHANDLED with a justification comment.`,
    )
  })

  it('dashboard handler covers all non-app-specific ServerMessageTypes', () => {
    const appOnly = new Set(
      Object.entries(PLATFORM_SPECIFIC)
        .filter(([, platform]) => platform === 'app')
        .map(([type]) => type),
    )

    const missing = []
    for (const type of allServerTypes) {
      if (INTENTIONALLY_UNHANDLED.has(type)) continue
      if (appOnly.has(type)) continue // intentionally app-only
      if (!dashTypes.has(type)) {
        missing.push(type)
      }
    }

    assert.equal(
      missing.length, 0,
      `Dashboard message handler is missing the following ServerMessageTypes:\n` +
      missing.map(t => `  - ${t}`).join('\n') +
      `\n\nEither handle in packages/dashboard/src/store/message-handler.ts, ` +
      `add to PLATFORM_SPECIFIC as 'app', ` +
      `or add to INTENTIONALLY_UNHANDLED with a justification comment.`,
    )
  })

  it('PLATFORM_SPECIFIC entries are actual ServerMessageTypes', () => {
    const invalid = []
    for (const type of Object.keys(PLATFORM_SPECIFIC)) {
      if (!allServerTypes.has(type)) {
        invalid.push(type)
      }
    }

    assert.equal(
      invalid.length, 0,
      `PLATFORM_SPECIFIC contains types not in ServerMessageType:\n` +
      invalid.map(t => `  - ${t}`).join('\n') +
      `\n\nRemove stale entries from PLATFORM_SPECIFIC.`,
    )
  })

  it('PLATFORM_SPECIFIC entries are actually only handled by their declared platform', () => {
    const violations = []

    for (const [type, platform] of Object.entries(PLATFORM_SPECIFIC)) {
      const inApp = appTypes.has(type)
      const inDash = dashTypes.has(type)

      if (inApp && inDash) {
        violations.push(`${type}: declared ${platform}-only but handled by BOTH handlers`)
      } else if (platform === 'app' && !inApp) {
        violations.push(`${type}: declared app-only but NOT handled by app`)
      } else if (platform === 'dashboard' && !inDash) {
        violations.push(`${type}: declared dashboard-only but NOT handled by dashboard`)
      }
    }

    assert.equal(
      violations.length, 0,
      `PLATFORM_SPECIFIC declarations don't match actual handler coverage:\n` +
      violations.map(v => `  - ${v}`).join('\n') +
      `\n\nUpdate PLATFORM_SPECIFIC or add/remove handler cases to match.`,
    )
  })

  it('INTENTIONALLY_UNHANDLED entries are actual ServerMessageTypes', () => {
    const invalid = []
    for (const type of INTENTIONALLY_UNHANDLED) {
      if (!allServerTypes.has(type)) {
        invalid.push(type)
      }
    }

    assert.equal(
      invalid.length, 0,
      `INTENTIONALLY_UNHANDLED contains types not in ServerMessageType:\n` +
      invalid.map(t => `  - ${t}`).join('\n') +
      `\n\nRemove stale entries from INTENTIONALLY_UNHANDLED.`,
    )
  })

  it('INTENTIONALLY_UNHANDLED types are truly unhandled by both handlers', () => {
    const violations = []
    for (const type of INTENTIONALLY_UNHANDLED) {
      if (appTypes.has(type) || dashTypes.has(type)) {
        const where = [
          appTypes.has(type) && 'app',
          dashTypes.has(type) && 'dashboard',
        ].filter(Boolean).join(' and ')
        violations.push(`${type}: declared unhandled but found in ${where} handler`)
      }
    }

    assert.equal(
      violations.length, 0,
      `INTENTIONALLY_UNHANDLED entries are actually handled:\n` +
      violations.map(v => `  - ${v}`).join('\n') +
      `\n\nRemove from INTENTIONALLY_UNHANDLED and add to PLATFORM_SPECIFIC ` +
      `or remove from this set entirely if both handlers cover it.`,
    )
  })

  it('SYNTHETIC_TYPES are not in ServerMessageType', () => {
    const overlap = []
    for (const type of SYNTHETIC_TYPES) {
      if (allServerTypes.has(type)) {
        overlap.push(type)
      }
    }

    assert.equal(
      overlap.length, 0,
      `SYNTHETIC_TYPES contains types that ARE in ServerMessageType:\n` +
      overlap.map(t => `  - ${t}`).join('\n') +
      `\n\nRemove from SYNTHETIC_TYPES — these are real protocol types and should ` +
      `be tracked in the main coverage checks.`,
    )
  })

  it('handler case values that are not in ServerMessageType are accounted for in SYNTHETIC_TYPES', () => {
    // Combine all handler types
    const allHandled = new Set([...appTypes, ...dashTypes])
    const unaccounted = []

    for (const type of allHandled) {
      if (!allServerTypes.has(type) && !SYNTHETIC_TYPES.has(type)) {
        unaccounted.push(type)
      }
    }

    assert.equal(
      unaccounted.length, 0,
      `Handlers contain types not in ServerMessageType and not in SYNTHETIC_TYPES:\n` +
      unaccounted.map(t => `  - ${t}`).join('\n') +
      `\n\nEither add to ServerMessageType in @chroxy/protocol, ` +
      `or add to SYNTHETIC_TYPES in this test.`,
    )
  })
})
