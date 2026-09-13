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

import { describe, it, expect, vi } from 'vitest'
import {
  DISPATCH_FIXTURES,
  CONTRACT_FIXED_NOW,
  type ContractFixture,
  type FixtureExpectation,
} from './fixtures'
import {
  makeClientEnv,
  DASHBOARD_FLAT_MIRROR_KEYS,
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

/**
 * Drive one fixture through BOTH client adapters under a PINNED clock (#7809).
 *
 * The two runs are separate invocations of the same handler, so a handler that
 * stamps `Date.now()` into flat state — `server_shutdown` writes
 * `restartingSince` (`handlers/error.ts`) — produced two values that matched
 * only when both runs landed inside the same millisecond. The flat-parity
 * assertion below is a deep compare, so on a loaded runner that straddled a
 * boundary and `Store Core Tests` went red on a PR that touched nothing near
 * store-core (observed on PR #7795).
 *
 * Pinning `Date.now` for the duration of the two runs removes the race at its
 * source and keeps every clock-derived field INSIDE the deep compare, for every
 * fixture at once — no roster of excluded keys to drift. It is a spy on
 * `Date.now` only, NOT `vi.useFakeTimers()`: nothing in this suite schedules a
 * timer, and a global timer mock would be a much larger blast radius than the
 * one function that actually races. The spy is torn down in a `finally` so a
 * throwing fixture cannot leak it into the next test.
 *
 * The `drives the flat-parity comparison apart` test below is the red-proof: it
 * advances the clock BETWEEN the two runs and asserts the unpinned comparison
 * fails while this pinned one holds, so deleting the pin goes red.
 */
function runBothClients(fx: ContractFixture): { app: AdapterResult; dash: AdapterResult } {
  const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(CONTRACT_FIXED_NOW)
  try {
    return { app: run('app', fx), dash: run('dashboard', fx) }
  } finally {
    nowSpy.mockRestore()
  }
}

/**
 * The flat surface the client-to-client parity assertion compares: the
 * dashboard's flat writes minus its documented active-session mirror.
 * Shared by the fixture loop and the #7809 red-proof below.
 */
function dashFlatOutsideMirror(dash: AdapterResult): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(dash.flat).filter(
      ([k]) => !(DASHBOARD_FLAT_MIRROR_KEYS as readonly string[]).includes(k),
    ),
  )
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
    expect(result.rotatedTunnelUrls, `${fx.name}: expected no applyRotatedTunnelUrl`).toHaveLength(0)
    expect(result.terminalWrites, `${fx.name}: expected no appendTerminalData`).toHaveLength(0)
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
  if (exp.rotatedTunnelUrls) {
    expect(result.rotatedTunnelUrls, `${fx.name}: rotatedTunnelUrls`).toEqual(exp.rotatedTunnelUrls)
  }
  if (exp.terminalWrites) {
    expect(result.terminalWrites, `${fx.name}: terminalWrites`).toEqual(exp.terminalWrites)
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
        const { app, dash } = runBothClients(fx)
        assertExpectation(app, fx.divergent!.app, fx)
        assertExpectation(dash, fx.divergent!.dashboard, fx)
      })
      continue
    }

    it(`${fx.name} — identical in both clients`, () => {
      const { app, dash } = runBothClients(fx)

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
      // 3. The FLAT writes are compared client-to-client, not merely each
      // against the fixture. `assertExpectation` uses toMatchObject for object
      // slices, so a client that writes an EXTRA flat field — exactly the
      // dashboard-only `extendModelsPatch` divergence #7728 removed — stays
      // green against the shared expectation while the two stores drift. Without
      // this, the guard against re-divergence is the deletion of that hook
      // rather than a test.
      //
      // The dashboard's active-session flat-mirror is the ONE documented flat
      // divergence (`DASHBOARD_FLAT_MIRROR_KEYS`, applied by its `updateSession`
      // and not by the app's), so those keys are excluded — from the DASHBOARD
      // side only, so an app handler that starts writing one of them directly
      // still goes red. Everything else must be byte-identical.
      //
      // Clock-derived flat fields stay IN this compare: `runBothClients` pins
      // `Date.now` across both runs (#7809), so a value like `restartingSince`
      // is deterministic rather than excluded.
      expect(app.flat, `${fx.name}: flat parity (outside the dashboard mirror)`).toEqual(
        dashFlatOutsideMirror(dash),
      )
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

// ---------------------------------------------------------------------------
// #7809 red-proof — the flat-parity comparison must not depend on the clock.
//
// The bug is a millisecond race and cannot be reproduced by running the suite
// repeatedly ("it passed 50 times" is the absence of evidence, not a proof), so
// these tests DRIVE it: `Date.now` is replaced by a counter that advances on
// every call, which GUARANTEES the two runs of a fixture disagree. Under that
// clock the unpinned comparison throws — the failure observed on PR #7795 — and
// the pinned runner the fixture loop actually uses still holds.
//
// This block is also what keeps the fix honest: delete the pin from
// `runBothClients` and the third test goes red.
// ---------------------------------------------------------------------------

describe('flat-parity is independent of the wall clock (#7809)', () => {
  // Select on the contract surface (`type`), not the human label — renaming a
  // fixture must not silently un-test the race. Asserting uniqueness is the
  // other half: `find` on a non-unique key would quietly take whichever row
  // came first, which is how a guard ends up pointed at the wrong subject.
  const shutdowns = DISPATCH_FIXTURES.filter((f) => f.type === 'server_shutdown')
  it('the red-proof below is pointed at exactly one fixture', () => {
    expect(shutdowns).toHaveLength(1)
  })
  const shutdown = shutdowns[0]!

  /**
   * Run `fn` with a `Date.now` that advances one millisecond per CALL.
   *
   * `vi.spyOn` rather than assigning the global directly (the shape
   * `chat-activity.test.ts` already uses, and what `runBothClients` uses): the
   * spy is tracked by vitest and `mockRestore` puts back the original
   * descriptor, so a leak is visible to `vi.isMockFunction` instead of being an
   * ordinary function that merely looks right.
   */
  function withAdvancingClock<T>(fn: () => T): T {
    let tick = CONTRACT_FIXED_NOW
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => ++tick)
    try {
      return fn()
    } finally {
      spy.mockRestore()
    }
  }

  it('the subject fixture really does stamp a clock-derived field into FLAT state', () => {
    // Without this, the two tests below could both pass on a fixture that had
    // quietly stopped writing `restartingSince` at all — the hole an
    // exclusion-based fix would have opened. `handlers/error.ts` owns the write.
    const { app, dash } = runBothClients(shutdown)
    expect(Object.keys(app.flat), 'server_shutdown must write restartingSince').toContain(
      'restartingSince',
    )
    expect(typeof app.flat.restartingSince).toBe('number')
    expect(app.flat.restartingSince).toBe(CONTRACT_FIXED_NOW)
    expect(dash.flat.restartingSince).toBe(CONTRACT_FIXED_NOW)
  })

  it('DRIVEN: two UNPINNED runs disagree, and the parity assertion throws', () => {
    const { app, dash } = withAdvancingClock(() => ({
      app: run('app', shutdown),
      dash: run('dashboard', shutdown),
    }))
    // The race, forced: the second run observed a later millisecond.
    expect(app.flat.restartingSince).not.toBe(dash.flat.restartingSince)
    // …and that is precisely the comparison the fixture loop makes.
    expect(() => {
      expect(app.flat).toEqual(dashFlatOutsideMirror(dash))
    }).toThrow()
  })

  it('PINNED: the runner the fixture loop uses holds under that SAME driven clock', () => {
    const { app, dash } = withAdvancingClock(() => runBothClients(shutdown))
    expect(app.flat.restartingSince).toBe(CONTRACT_FIXED_NOW)
    expect(app.flat).toEqual(dashFlatOutsideMirror(dash))
  })

  it('restores the real clock after a THROWING fixture run', () => {
    // A fixture whose adapter run blows up mid-way must not leak the pinned
    // clock into the next test — `runBothClients` tears it down in a `finally`.
    const exploding = {
      ...shutdown,
      get init(): never {
        throw new Error('boom')
      },
    } as unknown as ContractFixture
    expect(() => runBothClients(exploding)).toThrow('boom')
    // Assert the SPY is gone, not that the wall clock happens to differ from a
    // literal: a value comparison is a proxy that would also pass if the spy had
    // been swapped for a DIFFERENT mock, and it couples the assertion to the
    // real clock never being that instant.
    expect(vi.isMockFunction(Date.now)).toBe(false)
  })
})
