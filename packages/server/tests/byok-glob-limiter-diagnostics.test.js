import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { addLogListener, removeLogListener } from '../src/logger.js'
import { join } from 'node:path'
import {
  executeBuiltinTool,
  acquireGlobWalkSlot,
  globWalkSlotStats,
  warnIfGlobWalksStuck,
  __setGlobLimiterClockForTest,
  __setGlobWalkStartHookForTest,
} from '../src/byok-tool-executor.js'

// #8349 — a Glob that spends its deadline queued says so, and a limiter stuck
// at its cap is reported once instead of silently turning every Glob into a
// timeout. Timing is a fake clock for the stuck check and tiny real deadlines
// for the Glob calls; nothing waits on a real 30 s.
describe('Glob walk limiter diagnostics (#8349)', () => {
  let dir
  let savedEnv
  let keepAlive
  const ctx = () => ({ cwd: dir, cwdRealCache: new Map(), cwdCacheTtl: 30_000 })

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-glob-limiter-')))
    keepAlive = setInterval(() => {}, 1000)
    savedEnv = {
      max: process.env.CHROXY_GLOB_MAX_CONCURRENT,
      timeout: process.env.CHROXY_GLOB_TIMEOUT_MS,
    }
  })
  afterEach(() => {
    clearInterval(keepAlive)
    __setGlobLimiterClockForTest(null)
    __setGlobWalkStartHookForTest(null)
    for (const [k, v] of [['CHROXY_GLOB_MAX_CONCURRENT', savedEnv.max], ['CHROXY_GLOB_TIMEOUT_MS', savedEnv.timeout]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
    assert.deepEqual(globWalkSlotStats(), { active: 0, queued: 0 }, 'the limiter must be idle after each test')
  })

  it('a Glob that timed out without its walk ever starting says it waited for a slot', async () => {
    process.env.CHROXY_GLOB_MAX_CONCURRENT = '1'
    writeFileSync(join(dir, 'a.ts'), '')
    const held = acquireGlobWalkSlot(1)
    const releaseHeld = await held.granted
    process.env.CHROXY_GLOB_TIMEOUT_MS = '40'
    try {
      const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*.ts' }, ...ctx() })
      assert.equal(r.isError, true)
      assert.equal(r.content, 'Glob timed out after 40ms (waited 40ms for a free walk slot; 1 walk was busy)')
    } finally {
      releaseHeld()
    }
  })

  it('a Glob whose walk started and then ran out of time keeps the plain timeout message', async () => {
    process.env.CHROXY_GLOB_TIMEOUT_MS = '30'
    writeFileSync(join(dir, 'a.ts'), '')
    // Park the started walk until the deadline has fired: deterministic, no race.
    let unpark
    const parked = new Promise((res) => { unpark = res })
    __setGlobWalkStartHookForTest(() => parked)
    const call = executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**/*.ts' }, ...ctx() })
    try {
      const r = await call
      assert.equal(r.isError, true)
      assert.equal(r.content, 'Glob timed out after 30ms')
      assert.equal(globWalkSlotStats().active, 1, 'the parked walk still holds its slot')
    } finally {
      unpark()
    }
    const until = Date.now() + 5000
    while (globWalkSlotStats().active !== 0 && Date.now() < until) await new Promise((res) => setTimeout(res, 5))
  })

  it('says "walks were busy" when more than one walk holds the cap', async () => {
    process.env.CHROXY_GLOB_MAX_CONCURRENT = '2'
    const a = acquireGlobWalkSlot(2)
    const b = acquireGlobWalkSlot(2)
    const relA = await a.granted
    const relB = await b.granted
    process.env.CHROXY_GLOB_TIMEOUT_MS = '30'
    try {
      const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*' }, ...ctx() })
      assert.equal(r.content, 'Glob timed out after 30ms (waited 30ms for a free walk slot; 2 walks were busy)')
    } finally {
      relA()
      relB()
    }
  })

  describe('stuck-at-cap warning', () => {
    const DEADLINE = 30_000
    let t
    let lines
    const warn = (m) => lines.push(m)
    beforeEach(() => {
      t = 1_000_000
      lines = []
      __setGlobLimiterClockForTest(() => t)
    })

    it('stays quiet while the cap has been full only briefly, warns once past a few deadlines, and is rate limited', async () => {
      const a = acquireGlobWalkSlot(2)
      const b = acquireGlobWalkSlot(2)
      const relA = await a.granted
      const relB = await b.granted
      try {
        t += DEADLINE
        assert.equal(warnIfGlobWalksStuck(DEADLINE, warn), false)
        assert.equal(lines.length, 0)

        t += 3 * DEADLINE
        assert.equal(warnIfGlobWalksStuck(DEADLINE, warn), true)
        assert.equal(lines.length, 1)
        assert.match(lines[0], /2 Glob walks/)

        // many calls in a burst: still one line
        for (let i = 0; i < 5; i++) warnIfGlobWalksStuck(DEADLINE, warn)
        t += DEADLINE
        assert.equal(warnIfGlobWalksStuck(DEADLINE, warn), false)
        assert.equal(lines.length, 1, 'rate limited: not one line per call')

        // still stuck a few deadlines later: one more reminder
        t += 3 * DEADLINE
        assert.equal(warnIfGlobWalksStuck(DEADLINE, warn), true)
        assert.equal(lines.length, 2)
      } finally {
        relA()
        relB()
      }
    })

    it('a release is progress: the stuck clock restarts and a not-full limiter never warns', async () => {
      const a = acquireGlobWalkSlot(2)
      const b = acquireGlobWalkSlot(2)
      const relA = await a.granted
      const relB = await b.granted
      try {
        t += 10 * DEADLINE
        relA() // a walk returned: not stuck
        assert.equal(warnIfGlobWalksStuck(DEADLINE, warn), false, 'below the cap')
        const c = acquireGlobWalkSlot(2)
        const relC = await c.granted
        try {
          t += DEADLINE
          assert.equal(warnIfGlobWalksStuck(DEADLINE, warn), false, 'cap refilled only a deadline ago')
        } finally {
          relC()
        }
      } finally {
        relB()
      }
      assert.equal(lines.length, 0)
    })

    it('a release that is immediately refilled (empty queue) restarts the stuck clock', async () => {
      const a = acquireGlobWalkSlot(1)
      const relA = await a.granted
      const b = acquireGlobWalkSlot(1) // queued behind a
      t += 10 * DEADLINE
      relA() // the pump hands the slot to b: cap refilled, queue now empty
      const relB = await b.granted
      try {
        assert.equal(warnIfGlobWalksStuck(DEADLINE, warn), false, 'the clock restarted at the refill')
        t += 3 * DEADLINE + 1
        assert.equal(warnIfGlobWalksStuck(DEADLINE, warn), true)
      } finally {
        relB()
      }
    })

    it('a queued Glob that times out reports a stuck limiter through the log', async () => {
      process.env.CHROXY_GLOB_MAX_CONCURRENT = '1'
      const held = acquireGlobWalkSlot(1)
      const releaseHeld = await held.granted
      process.env.CHROXY_GLOB_TIMEOUT_MS = '20'
      t += 10 * 20
      const logged = []
      const listener = (e) => { if (e.level === 'warn' && /Glob walks/.test(e.message)) logged.push(e.message) }
      addLogListener(listener)
      try {
        const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '*' }, ...ctx() })
        assert.match(r.content, /waited 20ms for a free walk slot/)
        assert.equal(logged.length, 1)
        assert.match(logged[0], /1 Glob walks/)
      } finally {
        removeLogListener(listener)
        releaseHeld()
      }
    })
  })
})
