/**
 * Both-clients SWITCH_FIXTURES coverage lint (#5619, epic #5556).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `SWITCH_FIXTURES` is the only suite that drives BOTH clients' production
 * `handleMessage` switches against one shared expectation (app jest +
 * dashboard vitest). It is the behavioural-contract guard for the message
 * types that still live in each client's own switch / HANDLERS map (i.e. the
 * cases NOT yet migrated to the shared store-core dispatch table — those are
 * covered+enforced separately by `contract.test.ts` against DISPATCH_FIXTURES).
 *
 * Before this lint, growing that coverage was unenforced: a contributor could
 * add a NEW both-clients switch case (a type handled by both the app and the
 * dashboard) and never add a contract fixture for it, silently widening the
 * exact behavioural-drift surface epic #5556 set out to close.
 *
 * WHAT THIS LINT ENFORCES
 * -----------------------
 * It derives the authoritative both-clients-SWITCH universe by static-parsing
 * the two clients' real `message-handler.ts` sources (the same technique the
 * protocol `handler-coverage.test.js` guard uses), intersecting them, and
 * subtracting the shared dispatch-table types (`DISPATCH_TABLE_TYPES`, which
 * are covered by DISPATCH_FIXTURES). Every remaining type MUST be either:
 *   - covered by a `SWITCH_FIXTURES` entry, OR
 *   - listed in the explicit `PENDING_CONTRACT_TYPES` allowlist below.
 *
 * A NEW both-clients switch type added without a fixture or a pending entry
 * FAILS this lint — that is the anti-drift guarantee. The allowlist absorbs the
 * pre-existing ~57-type backlog so the lint does not force all of them at once;
 * SHRINKING the allowlist (by adding genuine fixtures) is the tracked future
 * work (#5618 / #5619). The lint also fails on a STALE allowlist entry (a type
 * that is no longer a both-clients switch type, or that has since gained a
 * fixture) — so the allowlist can only shrink, never silently rot.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  extractAppHandlerTypes,
  extractDashboardHandlerTypes,
} from '@chroxy/protocol/handler-coverage'
import { SWITCH_FIXTURES } from './fixtures'
import { DISPATCH_TABLE_TYPES } from '../dispatch-table'

const here = dirname(fileURLToPath(import.meta.url))
const appHandlerPath = resolve(here, '../../../app/src/store/message-handler.ts')
const dashHandlerPath = resolve(here, '../../../dashboard/src/store/message-handler.ts')

// ---------------------------------------------------------------------------
// PENDING allowlist — both-clients switch types that do NOT yet have a
// SWITCH_FIXTURES entry. This is the pre-existing backlog (epic #5556 sub-item
// 5 covered only ~6 of these; #6032 pinned four hot types — permission_request,
// result, stream_end, error — leaving ~53; permission_resolved is deferred). The lint
// subtracts this set so it enforces NO-NEW-DRIFT without forcing all the
// remaining fixtures at once. Each removal here must be paired with a real,
// behaviour-verified fixture in fixtures.ts. SHRINKING this set toward empty is
// tracked under #5618 / #5619 / #6032.
//
// Do NOT add a new type here to silence the lint for a freshly-introduced
// both-clients case — add a real contract fixture instead. New entries are
// only legitimate when retro-fitting a pre-existing case, with a note.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// #5618 dispatch-table migration — PHASE COMPLETE (closed 2026-06-25).
//
// The cleanly-beneficial migrations are done (~67 types now route through the
// shared store-core dispatch table). The both-clients-switch types that REMAIN in
// the universe below are INTENTIONALLY switch-local — do NOT re-attempt migrating
// them onto the dispatch table without re-deciding (the triage map's "zero-change-
// via-hooks" rating is misleading for them). Their `handleX` PARSER already lives in
// store-core and both clients call it; what's left in each switch is genuinely
// per-client ORCHESTRATION, not incidental duplication — so migrating it would wrap
// that orchestration behind 2–4 new adapter hooks each, adding ~as much surface as
// the dedup removes, with real regression risk. Representative cases:
//   - permission_resolved / permission_timeout / permission_expired — thin shared
//     prompt-mark updater; thick divergence (all-sessions scan, dashboard flat-message
//     fallback, app `remove` vs dashboard #5008 `mark-read` notifications, app-only
//     ServerError banner).
//   - budget_exceeded — whole behaviour diverges by design (#5619): app manual Resume
//     button vs dashboard auto-resume + modified message + toast.
//   - server_status / server_mode / session_warning — thin shared core, thick divergence.
//   - message / server_error / web_task_error / tool_* / stream_* / session_switched /
//     session_timeout / client_joined / client_left / pair_fail, plus the hard four
//     (error / session_list / auth_ok / key_exchange_ok).
// These keep their SWITCH_FIXTURES (still behaviour-verified through each client's real
// handler), so they are NOT NO_SWITCH_CONTRACT_BY_DESIGN exemptions. See the #5618
// close comment for the full rationale.
// ---------------------------------------------------------------------------
const PENDING_CONTRACT_TYPES = new Set<string>([
  // EMPTY — the both-clients SWITCH_FIXTURES backlog is fully drained. Every
  // both-clients switch type now has a behaviour-verified fixture (incl. the last
  // two via the #6344 multi-message prelude: history_replay_end resolves against a
  // history_replay_start baseline; key_exchange_ok runs after an encryption auth_ok
  // stashes the pending key pair) OR is a documented NO_SWITCH_CONTRACT_BY_DESIGN
  // exemption. Re-add a type here ONLY when retro-fitting a pre-existing case that
  // genuinely can't be fixtured yet, with a note — prefer a real fixture.
  // agent_idle — now has a SWITCH_FIXTURES entry (#6325); the contract-switch
  // harness was extended to assert session-scalar fields (isIdle, …).
  // activity_snapshot / activity_delta — both clients now feed them through the
  // store-core ACTIVITY reducer (applyActivitySnapshot/applyActivityDelta) from
  // their own switch (#6246/#6247 added the mobile side; dashboard since #5163).
  // They are NOT on the shared dispatch table (the reducer write is platform-local
  // — each client owns its `activity` store field), so they stay PENDING rather
  // than carrying a DISPATCH_FIXTURES entry.
  // activity_snapshot — now has a SWITCH_FIXTURES entry (#6325 bucket-B flat-assert).
  // activity_delta — now has a SWITCH_FIXTURES entry (#6325; harness flat-seed/mock harden).
  // agent_list — migrated to the shared dispatch table (#5618 Batch 2); now has
  // a DISPATCH_FIXTURES entry, so it leaves the both-clients-switch universe.
  // auth_bootstrap — migrated to the shared dispatch table (#5618 Batch 5b).
  // auth_fail — now has a SWITCH_FIXTURES entry (#6325 close-out).
  // auth_ok — now has a SWITCH_FIXTURES entry (#6325 close-out).
  // available_models — migrated to the shared dispatch table (#5618 Batch 5a).
  // checkpoint_created / checkpoint_list — migrated to the shared dispatch table
  // (#5618 Batch 6); both now have DISPATCH_FIXTURES entries, so they leave the
  // both-clients-switch universe. checkpoint_restored is NOT migrated in this
  // batch (both clients still handle it platform-locally — the app via a switch
  // case, the dashboard via its HANDLERS map), so it remains pending.
  // checkpoint_restored — now has a SWITCH_FIXTURES entry (#6325 bucket-B flat-assert).
  // claude_ready — now has a SWITCH_FIXTURES entry (#6325, session-scalar assert).
  // client_focus_changed — migrated to the shared dispatch table (#5618 Batch 4).
  // client_joined — now has a SWITCH_FIXTURES entry (#6325; harness flat-seed/mock harden).
  // client_left — now has a SWITCH_FIXTURES entry (#6325 bucket-B flat-assert).
  // conversations_list — now has a SWITCH_FIXTURES entry (#6325 bucket-B flat-assert).
  // cost_update — migrated to the shared dispatch table (#5618 Batch 5a).
  // history_replay_end — now has a multi-message SWITCH_FIXTURES entry (#6344).
  // key_exchange_ok — now has a multi-message SWITCH_FIXTURES entry (#6344).
  // multi_question_intervention — migrated to the shared dispatch table (#5618);
  // now has a DISPATCH_FIXTURES entry, so it leaves the both-clients-switch universe.
  // pair_fail — now has a SWITCH_FIXTURES entry (#6325 close-out).
  // permission_expired — now has a SWITCH_FIXTURES entry (#6325).
  // permission_mode_changed — now has a SWITCH_FIXTURES entry (#6325, scalar assert).
  // permission_resolved now has a both-clients SWITCH_FIXTURES entry (#6058).
  // permission_timeout — now has a SWITCH_FIXTURES entry (#6325; harness flat-seed/mock harden).
  // plan_ready — now has a SWITCH_FIXTURES entry (#6325; harness flat-seed/mock harden).
  // pong — moved to NO_SWITCH_CONTRACT_BY_DESIGN (#6325): pure heartbeat ack.
  // primary_changed — migrated to the shared dispatch table (#5618 Batch 4).
  // provider_list — migrated to the shared dispatch table (#5618 Batch 2);
  // app/dashboard element-handling divergence locked by a divergent fixture.
  // raw — moved to NO_SWITCH_CONTRACT_BY_DESIGN (#6325): terminal-mirror only.
  // raw_background — moved to NO_SWITCH_CONTRACT_BY_DESIGN (#6325): terminal-mirror only.
  // search_results — now has a SWITCH_FIXTURES entry (#6325 bucket-B flat-assert).
  // server_error — now has a SWITCH_FIXTURES entry (#6325; harness flat-seed/mock harden).
  // server_mode — now has a SWITCH_FIXTURES entry (#6325 bucket-B flat-assert).
  // server_shutdown — now has a SWITCH_FIXTURES entry (#6325 bucket-B flat-assert).
  // server_status — now has a SWITCH_FIXTURES entry (#6325 batch A).
  // session_error — now has a SWITCH_FIXTURES entry (#6325 batch A).
  // session_list — now has a SWITCH_FIXTURES entry (#6325; harness flat-seed/mock harden).
  // session_persist_failed / session_restore_failed / session_stopped — migrated
  // to the shared dispatch table (#5618 Batch 3); now have DISPATCH_FIXTURES
  // entries, so they leave the both-clients-switch universe.
  // session_role — migrated to the shared dispatch table (#5618 Batch 4).
  // session_switched — now has a SWITCH_FIXTURES entry (#6325 bucket-B flat-assert).
  // session_timeout — now has a SWITCH_FIXTURES entry (#6325 bucket-B flat-assert).
  // session_warning — now has a SWITCH_FIXTURES entry (#6325; harness flat-seed/mock harden).
  // slash_commands — migrated to the shared dispatch table (#5618 Batch 2); now
  // has a DISPATCH_FIXTURES entry, so it leaves the both-clients-switch universe.
  // stream_delta — now has a SWITCH_FIXTURES entry (#6325 batch A).
  // terminal_output — moved to NO_SWITCH_CONTRACT_BY_DESIGN (#6325): terminal-mirror only.
  // token_rotated — moved to NO_SWITCH_CONTRACT_BY_DESIGN (#6325): no main-store effect.
  // tool_input_delta — now has a SWITCH_FIXTURES entry (#6325); the harness
  // normalize() was extended to assert its toolInputPartial accumulator.
  // tunnel_url_changed — migrated to the shared dispatch table (#5618 Batch 5b).
  // user_input — now has a SWITCH_FIXTURES entry (#6325), so it leaves the
  // pending backlog (both clients build it via the shared sharedUserInput path).
  // user_question — migrated to the shared dispatch table (#5618); now has a
  // DISPATCH_FIXTURES entry, so it leaves the both-clients-switch universe.
  // web_task_error — now has a SWITCH_FIXTURES entry (#5619), so it leaves the
  // pending allowlist (both clients append one identical `system` error bubble).
])

// ---------------------------------------------------------------------------
// By-design exemption (#6325) — both-clients switch types that will NEVER get a
// SWITCH_FIXTURES entry because they have NO observable mutation to the MAIN
// store (the only slice this harness asserts: sessions[id].messages, a session
// scalar, or a flat ConnectionState field). Unlike PENDING (a backlog awaiting a
// fixture), these are a terminal, documented state: their entire effect lands on
// a MOCKED secondary store or is a pure ack/teardown, so there is nothing the
// main-store contract harness can assert. Each is covered by its own dedicated
// tests where the effect IS observable (terminal-mirror suites, heartbeat tests).
//
// Adding here requires the same rigour as a fixture: prove (by reading the FULL
// both-client handler bodies) that NO main-store slice is written. A type that
// later gains a real main-store effect must move OUT of this set into a fixture.
// ---------------------------------------------------------------------------
const NO_SWITCH_CONTRACT_BY_DESIGN = new Set<string>([
  // raw / raw_background / terminal_output — MOVED OUT (#6345): now real
  // SWITCH_FIXTURES asserting their get().appendTerminalData write via the harness's
  // captured `_terminalWrites` (expect.terminalWrites). They were exempt only
  // because the harness stubbed appendTerminalData to a no-op; once captured, the
  // terminal-mirror write IS an observable both-clients contract.
  // pong — pure heartbeat ack: both clients only clear the pong-timeout timer
  // (scheduler.clearTimeout); the RTT/quality path is gated on a running ping loop
  // (lastPingSentAt > 0) unreachable from a single seeded pong, and the app routes
  // quality into the mocked connection-lifecycle store. No main-store write.
  'pong',
  // token_rotated — the dashboard rewrites the URL token query-param
  // (window.history.replaceState); the app persists via the mocked SecureStore +
  // the mocked connection-lifecycle store (setSavedConnection). No main-store set().
  'token_rotated',
])

// ---------------------------------------------------------------------------
// Static extraction — derive the both-clients-SWITCH universe from the two
// clients' real handler sources. The extractors are the SHARED helper from
// @chroxy/protocol/handler-coverage (#6021), the single source of truth this
// lint and the protocol handler-coverage guard both consume so they can never
// diverge on the parse (the previous local copy here was stricter and could
// miss HANDLERS-map keys in some formatting cases).
// ---------------------------------------------------------------------------

function bothClientsSwitchTypes(): string[] {
  const appSrc = readFileSync(appHandlerPath, 'utf-8')
  const dashSrc = readFileSync(dashHandlerPath, 'utf-8')
  const appTypes = extractAppHandlerTypes(appSrc)
  const dashTypes = extractDashboardHandlerTypes(dashSrc)
  const dispatchTableTypes = new Set<string>(DISPATCH_TABLE_TYPES)
  return [...appTypes]
    .filter((t) => dashTypes.has(t) && !dispatchTableTypes.has(t))
    .sort()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('both-clients SWITCH_FIXTURES coverage lint (#5619)', () => {
  const both = bothClientsSwitchTypes()
  const covered = new Set(SWITCH_FIXTURES.map((f) => f.type))

  it('derives a non-trivial both-clients switch universe (extraction sanity)', () => {
    // Pin the extraction to a band AROUND the real count (~52) so a parser
    // regression fails LOUDLY (#6032). The old `> 20` floor was so far under the
    // real universe that a parse dropping to ~25 passed vacuously — silently
    // shrinking `both` so the anti-drift assertions below stopped protecting the
    // types that fell out. The band ratchets BOTH ways: a real new both-clients
    // switch type (universe grows past the ceiling) is a DELIBERATE bump, and
    // migrating types OUT to the shared dispatch table (universe shrinks below
    // the floor) lowers it — adjust both bounds in the same PR. Keep the band
    // TIGHT around the real count so the "fail loudly" intent stays sharp. Band
    // last lowered for #6449 slice 1 (raw / raw_background / terminal_output
    // migrated out to the shared dispatch table; universe down to 37).
    expect(both.length).toBeGreaterThanOrEqual(35)
    expect(both.length).toBeLessThanOrEqual(45)
  })

  it('every both-clients switch type has a fixture, a PENDING entry, or a by-design exemption', () => {
    const undeclared = both.filter(
      (t) => !covered.has(t) && !PENDING_CONTRACT_TYPES.has(t) && !NO_SWITCH_CONTRACT_BY_DESIGN.has(t),
    )
    expect(
      undeclared,
      'New both-clients switch type(s) with NO SWITCH_FIXTURES entry, not in ' +
        'PENDING_CONTRACT_TYPES, and not in NO_SWITCH_CONTRACT_BY_DESIGN. Add a ' +
        'behaviour-verified fixture to contract-fixtures/fixtures.ts (preferred); or — ' +
        'only when retro-fitting a pre-existing case — add it to the PENDING allowlist ' +
        'with a note; or, if it provably has no main-store contract, to ' +
        `NO_SWITCH_CONTRACT_BY_DESIGN with a proof:\n  ${undeclared.join('\n  ')}`,
    ).toEqual([])
  })

  it('NO_SWITCH_CONTRACT_BY_DESIGN entries are real both-clients types, uncovered, and disjoint from PENDING', () => {
    const bothSet = new Set(both)
    // Stale = no longer a both-clients switch type, OR it gained a fixture (it
    // should then become a real fixture, not an exemption), OR it is ALSO listed
    // in PENDING (a type is one or the other, never both).
    const invalid = [...NO_SWITCH_CONTRACT_BY_DESIGN].filter(
      (t) => !bothSet.has(t) || covered.has(t) || PENDING_CONTRACT_TYPES.has(t),
    )
    expect(
      invalid,
      'NO_SWITCH_CONTRACT_BY_DESIGN contains invalid entries — a type here must be a ' +
        'current both-clients switch type with NO fixture and NOT in PENDING. Remove any ' +
        `that gained a fixture, stopped being a both-clients switch type, or are also pending:\n  ${invalid.join('\n  ')}`,
    ).toEqual([])
  })

  it('PENDING_CONTRACT_TYPES has no stale entries (allowlist only shrinks)', () => {
    const bothSet = new Set(both)
    const stale = [...PENDING_CONTRACT_TYPES].filter(
      // Stale = no longer a both-clients switch type, OR now has a fixture
      // (in which case it must be REMOVED from the allowlist, not left behind).
      (t) => !bothSet.has(t) || covered.has(t),
    )
    expect(
      stale,
      'PENDING_CONTRACT_TYPES contains stale entries — remove them. A type is ' +
        'stale once it gains a SWITCH_FIXTURES entry, or stops being a ' +
        `both-clients switch type:\n  ${stale.join('\n  ')}`,
    ).toEqual([])
  })

  it('SWITCH_FIXTURES only targets real both-clients switch types (no stale fixtures)', () => {
    const bothSet = new Set(both)
    const stale = SWITCH_FIXTURES.filter((f) => !bothSet.has(f.type)).map((f) => `${f.type} (${f.name})`)
    expect(
      stale,
      'SWITCH_FIXTURES entries whose type is not a both-clients switch case ' +
        '(migrated to the dispatch table, renamed, or single-platform). Move or ' +
        `remove them:\n  ${stale.join('\n  ')}`,
    ).toEqual([])
  })
})
