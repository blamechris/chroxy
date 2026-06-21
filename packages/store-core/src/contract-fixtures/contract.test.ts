/**
 * Behavioral-contract test (epic #5556, sub-item 5).
 *
 * Drives every {@link DISPATCH_FIXTURES} row through the SHARED dispatch table
 * via BOTH per-client adapters (`makeClientEnv('app' | 'dashboard')`) and asserts
 * the two clients produce the SAME store mutation for the same wire input — or,
 * when a fixture declares a `divergent` block, that each client matches its OWN
 * documented expectation.
 *
 * WHY THIS BEATS THE OLD PARITY GUARD
 * -----------------------------------
 * The static handler-coverage guard checked that a message TYPE has a `case` in
 * each client. It would stay GREEN even if, say, the app's `agent_busy` handler
 * forgot to also flip flat `isIdle` for the active session while the dashboard's
 * did — a real, user-visible drift the audit found in this exact family of cases.
 * Here that shows up as `app.flat.isIdle !== dashboard.flat.isIdle` → a RED test,
 * naming the field and both values. See the `parity guard could not have caught`
 * test below for a concrete encoded example.
 */

import { describe, it, expect } from 'vitest'
import { DISPATCH_FIXTURES, type ContractFixture, type FixtureExpectation } from './fixtures'
import {
  makeClientEnv,
  type AdapterResult,
  type ClientKind,
} from './client-adapters'
import { createDispatchTable, runDispatch, DISPATCH_TABLE_TYPES } from '../dispatch-table'
import type { FixtureSession } from './client-adapters'

// ---------------------------------------------------------------------------
// Runner — drive one fixture through one client's adapter
// ---------------------------------------------------------------------------

function run(kind: ClientKind, fx: ContractFixture): AdapterResult {
  const env = makeClientEnv(kind, fx.init)
  const table = createDispatchTable<FixtureSession>()
  runDispatch(table, fx.message, env.adapter)
  return env.result
}

// ---------------------------------------------------------------------------
// Assertion — check a result against an expectation slice
// ---------------------------------------------------------------------------

/**
 * Assert one field against its fixture expectation. Fixtures state the SLICE
 * they care about, so object/array expectations are partial (`toMatchObject`)
 * — the handlers legitimately attach extra fields (generated ids, timestamps,
 * normalised nulls). `undefined` means "must NOT be set"; primitives are exact.
 */
function assertField(actual: unknown, expected: unknown, label: string) {
  if (expected === undefined) {
    expect(actual, `${label} must be unset`).toBeUndefined()
    return
  }
  if (expected !== null && typeof expected === 'object') {
    // Partial deep-equal for objects and arrays-of-objects.
    expect(actual, label).toMatchObject(expected as Record<string, unknown> | unknown[])
    return
  }
  expect(actual, label).toEqual(expected)
}

function assertExpectation(result: AdapterResult, exp: FixtureExpectation, fx: ContractFixture) {
  if (exp.noop) {
    // No flat writes, no added messages, and no surfaced error / info toast…
    expect(Object.keys(result.flat), `${fx.name}: expected no flat writes`).toHaveLength(0)
    expect(result.added, `${fx.name}: expected no addMessage`).toHaveLength(0)
    expect(result.serverErrors, `${fx.name}: expected no addServerError`).toHaveLength(0)
    expect(result.infoNotifications, `${fx.name}: expected no addInfoNotification`).toHaveLength(0)
    expect(result.switchedSessions, `${fx.name}: expected no switchSession`).toHaveLength(0)
    // …and every seeded session is untouched beyond its shell: it must carry
    // only the keys it was seeded with (the `{ sessionId, messages }` shell plus
    // the fixture's own `init.sessions[id]` keys). A handler that wrote a NEW
    // field onto a session despite the no-op contract is caught here.
    const seeded = fx.init?.sessions ?? {}
    for (const [id, session] of Object.entries(result.sessions)) {
      const allowedKeys = new Set(['sessionId', 'messages', ...Object.keys(seeded[id] ?? {})])
      const extraKeys = Object.keys(session).filter((k) => !allowedKeys.has(k))
      expect(extraKeys, `${fx.name}: session ${id} mutated on a no-op`).toEqual([])
    }
    return
  }
  if (exp.sessions) {
    for (const [id, fields] of Object.entries(exp.sessions)) {
      const session = result.sessions[id]
      expect(session, `${fx.name}: session ${id} should exist`).toBeDefined()
      for (const [key, value] of Object.entries(fields)) {
        assertField(session[key], value, `${fx.name}: session ${id}.${key}`)
      }
    }
  }
  if (exp.flat) {
    for (const [key, value] of Object.entries(exp.flat)) {
      assertField(result.flat[key], value, `${fx.name}: flat.${key}`)
    }
  }
  if (exp.added) {
    expect(result.added.length, `${fx.name}: addMessage count`).toBe(exp.added.length)
    exp.added.forEach((m, i) => {
      expect(result.added[i], `${fx.name}: added[${i}]`).toMatchObject(m)
    })
  }
  if (exp.callbacks) {
    expect(result.callbacks.length, `${fx.name}: callback count`).toBe(exp.callbacks.length)
    exp.callbacks.forEach((cb, i) => {
      expect(result.callbacks[i].name, `${fx.name}: callbacks[${i}].name`).toBe(cb.name)
      expect(result.callbacks[i].payload, `${fx.name}: callbacks[${i}].payload`).toMatchObject(
        cb.payload,
      )
    })
  }
  if (exp.serverErrors) {
    expect(result.serverErrors.length, `${fx.name}: serverError count`).toBe(exp.serverErrors.length)
    exp.serverErrors.forEach((e, i) => {
      expect(result.serverErrors[i], `${fx.name}: serverErrors[${i}]`).toMatchObject(e)
    })
  }
  if (exp.infoNotifications) {
    expect(result.infoNotifications, `${fx.name}: infoNotifications`).toEqual(exp.infoNotifications)
  }
  if (exp.switchedSessions) {
    expect(result.switchedSessions, `${fx.name}: switchedSessions`).toEqual(exp.switchedSessions)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('behavioral-contract fixtures — shared dispatch table (#5556.5)', () => {
  it('every shared dispatch-table type is covered by at least one fixture', () => {
    const covered = new Set(DISPATCH_FIXTURES.map((f) => f.type))
    const missing = DISPATCH_TABLE_TYPES.filter((t) => !covered.has(t))
    expect(
      missing,
      `Dispatch-table types with NO contract fixture (add one to fixtures.ts):\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('all fixtures target a registered dispatch-table type (no stale fixtures)', () => {
    const tableTypes = new Set<string>(DISPATCH_TABLE_TYPES)
    const stale = DISPATCH_FIXTURES.filter((f) => !tableTypes.has(f.type)).map((f) => f.name)
    expect(stale, `Fixtures for non-table types:\n  ${stale.join('\n  ')}`).toEqual([])
  })

  for (const fx of DISPATCH_FIXTURES) {
    if (fx.divergent) {
      it(`${fx.name} — DIVERGENT (${fx.divergent.reason})`, () => {
        const app = run('app', fx)
        const dash = run('dashboard', fx)
        assertExpectation(app, fx.divergent!.app, fx)
        assertExpectation(dash, fx.divergent!.dashboard, fx)
      })
      continue
    }

    it(`${fx.name} — identical in both clients`, () => {
      const app = run('app', fx)
      const dash = run('dashboard', fx)

      // 1. Each client matches the shared expectation.
      assertExpectation(app, fx.expect!, fx)
      assertExpectation(dash, fx.expect!, fx)

      // 2. The two clients agree on the observable surface the table touches.
      // (This is the part the old parity guard could never assert.) Both
      // adapters are byte-identical except the dashboard's flat-mirror, so for
      // the dispatch surface they must produce equal `sessions` keys and the
      // same addMessage shape. Generated ids/timestamps differ between the two
      // separate runs, so compare the stable surface (type + content).
      const stable = (m: { type?: unknown; content?: unknown }) => ({ type: m.type, content: m.content })
      expect(app.added.map(stable), `${fx.name}: addMessage parity`).toEqual(dash.added.map(stable))
      expect(Object.keys(app.sessions).sort()).toEqual(Object.keys(dash.sessions).sort())
    })
  }
})

// ---------------------------------------------------------------------------
// A concrete demonstration of what the OLD static parity guard could not catch
// but THIS contract harness can. We synthesise a deliberately-drifted "client B"
// dispatch path that has the case (so the spelling guard passes) but mutates
// state differently, and prove the contract assertion fails on it.
// ---------------------------------------------------------------------------

describe('what the static parity guard could not catch (#5556.5)', () => {
  it('detects a same-cased-but-behaviourally-drifted handler that the spelling guard would pass', () => {
    const fx = DISPATCH_FIXTURES.find((f) => f.name.startsWith('agent_busy flips'))!
    // Real (shared) path.
    const correct = run('app', fx)
    expect(correct.sessions.s1.isIdle).toBe(false)

    // A hypothetical drifted client that HAS a `case 'agent_busy'` (so the old
    // guard's "case exists" check is satisfied) but forgets to flip the flag —
    // it sets some unrelated field instead. The contract assertion below catches
    // the behavioural mismatch the spelling guard never could.
    const driftedEnv = makeClientEnv('app', fx.init)
    const driftedTable = createDispatchTable<FixtureSession>()
    // Override the agent_busy entry with a drifted implementation.
    ;(driftedTable as Record<string, unknown>).agent_busy = (
      _msg: unknown,
      adapter: { hasSession(id: string): boolean; updateSession(id: string, u: (s: FixtureSession) => Partial<FixtureSession>): void },
    ) => {
      if (adapter.hasSession('s1')) adapter.updateSession('s1', () => ({ someUnrelatedFlag: true }))
    }
    runDispatch(driftedTable, fx.message, driftedEnv.adapter)
    const drifted = driftedEnv.result

    // Spelling guard would be GREEN (case present in both). Behaviour differs:
    expect(drifted.sessions.s1.isIdle).not.toBe(correct.sessions.s1.isIdle)
    // And the contract-style cross-client assertion catches it loudly:
    expect(() => {
      expect(drifted.sessions.s1.isIdle).toEqual(correct.sessions.s1.isIdle)
    }).toThrow()
  })
})
