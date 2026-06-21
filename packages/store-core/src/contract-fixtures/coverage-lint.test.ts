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
const PENDING_CONTRACT_TYPES = new Set<string>([
  'agent_idle',
  // agent_list — migrated to the shared dispatch table (#5618 Batch 2); now has
  // a DISPATCH_FIXTURES entry, so it leaves the both-clients-switch universe.
  'auth_bootstrap',
  'auth_fail',
  'auth_ok',
  'available_models',
  'checkpoint_created',
  'checkpoint_list',
  'checkpoint_restored',
  'claude_ready',
  'client_focus_changed',
  'client_joined',
  'client_left',
  'conversations_list',
  'cost_update',
  'history_replay_end',
  'key_exchange_ok',
  // multi_question_intervention — migrated to the shared dispatch table (#5618);
  // now has a DISPATCH_FIXTURES entry, so it leaves the both-clients-switch universe.
  'pair_fail',
  'permission_expired',
  'permission_mode_changed',
  // permission_resolved now has a both-clients SWITCH_FIXTURES entry (#6058).
  'permission_timeout',
  'plan_ready',
  'pong',
  'primary_changed',
  // provider_list — migrated to the shared dispatch table (#5618 Batch 2);
  // app/dashboard element-handling divergence locked by a divergent fixture.
  'raw',
  'raw_background',
  'search_results',
  'server_error',
  'server_mode',
  'server_shutdown',
  'server_status',
  'session_error',
  'session_list',
  'session_persist_failed',
  'session_restore_failed',
  'session_role',
  'session_stopped',
  'session_switched',
  'session_timeout',
  'session_warning',
  // slash_commands — migrated to the shared dispatch table (#5618 Batch 2); now
  // has a DISPATCH_FIXTURES entry, so it leaves the both-clients-switch universe.
  'stream_delta',
  'terminal_output',
  'token_rotated',
  'tool_input_delta',
  'tunnel_url_changed',
  'user_input',
  // user_question — migrated to the shared dispatch table (#5618); now has a
  // DISPATCH_FIXTURES entry, so it leaves the both-clients-switch universe.
  'web_task_error',
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
    // Pin the extraction to a band AROUND the real count (~64) so a parser
    // regression fails LOUDLY (#6032). The old `> 20` floor was so far under the
    // real universe that a parse dropping to ~25 passed vacuously — silently
    // shrinking `both` so the anti-drift assertions below stopped protecting the
    // types that fell out. The band ratchets: a real new both-clients switch type
    // (the universe grows past the ceiling) is a DELIBERATE bump — raise both
    // bounds in the same PR that adds its fixture / PENDING entry.
    expect(both.length).toBeGreaterThanOrEqual(55)
    expect(both.length).toBeLessThanOrEqual(80)
  })

  it('every both-clients switch type has a fixture or an explicit PENDING entry', () => {
    const undeclared = both.filter((t) => !covered.has(t) && !PENDING_CONTRACT_TYPES.has(t))
    expect(
      undeclared,
      'New both-clients switch type(s) with NO SWITCH_FIXTURES entry and not in ' +
        'PENDING_CONTRACT_TYPES. Add a behaviour-verified fixture to ' +
        'contract-fixtures/fixtures.ts (preferred), or — only when retro-fitting a ' +
        `pre-existing case — add it to the PENDING allowlist with a note:\n  ${undeclared.join('\n  ')}`,
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
