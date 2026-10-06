/**
 * #8301 — the `daemonTurnInput` capability, checked against the REAL provider
 * classes rather than fakes.
 *
 * Every other test of the wake route uses a stand-in session. A stand-in proves
 * the route works for a class that behaves as the stand-in does; it cannot prove
 * that the classes which DECLARE the capability behave that way, and the flag is
 * a claim about each of them ("my sendMessage queues when busy and reports
 * admission"). This file therefore:
 *
 *   1. DERIVES the flagged set from the code (every BaseSession subclass the
 *      session modules export, the provider registry, and the config-driven ACP
 *      class factory) and compares it, in BOTH directions, with the documented
 *      set in docs/providers.md — so a class gaining the flag undocumented, or
 *      the docs listing a class that lost it, goes red;
 *   2. drives each flagged class through the real `sendMessage` while busy and
 *      asserts the wake QUEUES, with nothing spawned;
 *   3. pins each provider's `daemonTurnRefusal()` against the state fields its
 *      real `sendMessage` branches on.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { BaseSession } from '../src/base-session.js'
import { getRegisteredProviderNames, getProvider } from '../src/providers.js'
import { createAcpSessionClass } from '../src/acp-session.js'
import { wakeSession, supportsDaemonTurnInput } from '../src/session-wake.js'
import { SessionManager } from '../src/session-manager.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'providers.md')

let scratch
before(() => { scratch = mkdtempSync(join(tmpdir(), 'daemon-turn-roster-')) })
after(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })

const flagged = (Klass) => {
  try { return Klass.capabilities?.daemonTurnInput === true } catch { return false }
}

/** Every distinct BaseSession subclass the session modules export, plus the registry's, plus an ACP class. */
async function deriveSessionClasses() {
  const classes = new Set()
  for (const file of readdirSync(SRC).filter((f) => f.endsWith('-session.js'))) {
    const mod = await import(join(SRC, file))
    for (const value of Object.values(mod)) {
      if (typeof value === 'function' && value.prototype instanceof BaseSession) classes.add(value)
    }
  }
  for (const name of getRegisteredProviderNames()) classes.add(getProvider(name))
  classes.add(createAcpSessionClass({ id: 'roster-acp', command: process.execPath, args: [], env: {} }))
  return [...classes].filter((K) => typeof K === 'function' && K.prototype instanceof BaseSession)
}

/** Minimal construction. `skillsDir`/`repoSkillsDir` keep skill loading off the developer's real ~/.claude. */
const make = (Klass, extra = {}) => new Klass({ cwd: '/tmp', skillsDir: join(scratch, 'skills'), repoSkillsDir: null, stateFilePath: join(scratch, 'state.json'), ...extra })

/** The "started/ready" state each class's sendMessage requires before it will accept or queue input. */
const markStarted = (s) => {
  s._processReady = true
  s._client = s._client || {}
  s._connection = s._connection || {}
  s._stdinForwardingDisabled = false
  return s
}

describe('daemonTurnInput roster (#8301)', () => {
  let classes
  before(async () => { classes = await deriveSessionClasses() })

  it('derives a non-trivial roster (a derivation that finds nothing must not pass)', () => {
    assert.ok(classes.length >= 8, `found only ${classes.length} session classes`)
    assert.ok(classes.some(flagged), 'no flagged class found at all')
    assert.ok(classes.some((K) => !flagged(K)), 'no unflagged class found: the derivation is not discriminating')
  })

  it('the flagged classes equal the documented set, in BOTH directions', () => {
    const derived = new Set(classes.filter(flagged).map((K) => K.name))
    const doc = readFileSync(DOCS, 'utf8')
    const line = doc.split('\n').find((l) => l.startsWith('Classes declaring `daemonTurnInput`'))
    assert.ok(line, 'docs/providers.md must carry the "Classes declaring `daemonTurnInput`" line')
    const documented = new Set([...line.matchAll(/`([A-Za-z]+Session)`/g)].map((m) => m[1]))
    assert.ok(documented.size > 0)
    assert.deepEqual([...derived].filter((n) => !documented.has(n)), [], 'flagged in code but not documented')
    assert.deepEqual([...documented].filter((n) => !derived.has(n)), [], 'documented but not flagged in code')
  })

  it('the capability-matrix row agrees with the registry, per provider column, in both directions', () => {
    const doc = readFileSync(DOCS, 'utf8')
    const lines = doc.split('\n')
    const header = lines.find((l) => l.startsWith('| Capability |'))
    const row = lines.find((l) => l.includes('Daemon turn input (`daemonTurnInput`'))
    assert.ok(header && row, 'the matrix header and the daemonTurnInput row must exist')
    const cells = (l) => l.split('|').slice(1, -1).map((c) => c.trim())
    const names = cells(header).slice(1).map((n) => n.replace(/`/g, ''))
    const values = cells(row).slice(1)
    assert.equal(names.length, values.length)
    for (let i = 0; i < names.length; i++) {
      const documentedYes = /^Yes/.test(values[i])
      assert.equal(flagged(getProvider(names[i])), documentedYes, `${names[i]}: documented "${values[i]}" vs code`)
    }
  })

  describe('each flagged class, through its real sendMessage', () => {
    let restore
    let spawned
    before(() => {
      // Nothing may be spawned by a wake that queues. Patch the builtin and
      // re-sync the ESM named exports so modules that import `{ spawn }` see it.
      spawned = []
      const originals = {}
      for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        originals[fn] = childProcess[fn]
        childProcess[fn] = () => { spawned.push(fn); throw new Error(`unexpected child_process.${fn}`) }
      }
      syncBuiltinESMExports()
      restore = () => { Object.assign(childProcess, originals); syncBuiltinESMExports() }
    })
    after(() => restore && restore())

    it('queues a wake behind a running turn and spawns nothing', async () => {
      const names = classes.filter(flagged).map((K) => K.name)
      assert.ok(names.includes('SdkSession') && names.includes('CliSession') && names.includes('CodexAppServerSession') && names.includes('AcpSession'))
      assert.ok(names.includes('DockerSdkSession') && names.includes('DockerSession'), 'the Docker subclasses inherit the flag')
      for (const Klass of classes.filter(flagged)) {
        const s = markStarted(make(Klass))
        s._isBusy = true
        const admitted = []
        const out = wakeSession(s, 'CI finished on PR #1', { turnInput: true, clientMessageId: 'chroxy-ci-wake-t-1', onAdmission: (a) => admitted.push(a.outcome) })
        assert.equal(out, 'queued', `${Klass.name}: wake while busy`)
        assert.deepEqual(admitted, ['queued'], Klass.name)
        assert.equal(s.outgoingQueueLength, 1, `${Klass.name}: it is really in the provider's own queue`)
        assert.equal(supportsDaemonTurnInput(s), true, Klass.name)
        s._backgroundShellTracker?.destroy?.()
      }
      assert.deepEqual(spawned, [], 'nothing was spawned')
    })

    it('an unflagged class is not routed, whatever its state', () => {
      const exercised = []
      for (const Klass of classes.filter((K) => !flagged(K))) {
        let s
        try { s = markStarted(make(Klass)) } catch { continue } // some classes need opts we do not have; they are unflagged either way
        exercised.push(Klass.name)
        s._isBusy = true
        assert.equal(wakeSession(s, 'x', { turnInput: true }), Klass.isClaudeTui === true ? 'busy' : 'not-tui', Klass.name)
        assert.equal(s.outgoingQueueLength, 0, `${Klass.name} was not queued into`)
      }
      // A loop that skipped every class would pass; require real coverage.
      assert.ok(exercised.length >= 4, `only exercised ${JSON.stringify(exercised)}`)
      assert.ok(exercised.includes('ClaudeByokSession') || exercised.includes('GeminiSession'), JSON.stringify(exercised))
    })
  })

  describe('daemonTurnRefusal() matches the state each real sendMessage branches on', () => {
    const byName = (n) => classes.find((K) => K.name === n)

    it('the base default is null (a provider with no unwilling state is always willing)', () => {
      assert.equal(make(BaseSession).daemonTurnRefusal(), null)
    })

    it('CliSession: stopped by the user, or a latched spawn refusal, while not ready', () => {
      const s = make(byName('CliSession'))
      s._processReady = false
      assert.equal(s.daemonTurnRefusal(), null, 'not ready but not stopped (still starting): not refused')
      s._stoppedByUser = true
      assert.equal(s.daemonTurnRefusal(), 'stopped')
      s._stoppedByUser = false
      s._spawnRefusal = { code: 'x' }
      assert.equal(s.daemonTurnRefusal(), 'stopped')
      s._processReady = true
      assert.equal(s.daemonTurnRefusal(), null, 'a live process is willing')
    })

    it('a wake never respawns a stopped CliSession (sendMessage would call _restartAfterStop)', () => {
      const s = make(byName('CliSession'))
      s._processReady = false
      s._stoppedByUser = true
      let restarts = 0
      s._restartAfterStop = () => { restarts++ }
      const mgr = new SessionManager({ skipPreflight: true, maxSessions: 2, stateFilePath: join(scratch, 'mgr.json') })
      mgr._sessions.set('s1', { session: s, name: 'S', cwd: '/tmp' })
      assert.equal(mgr.daemonTurnRefusal('s1'), 'stopped')
      assert.equal(restarts, 0)
    })

    it('SdkSession (and its Docker subclass): stdin forwarding disabled', () => {
      for (const n of ['SdkSession', 'DockerSdkSession']) {
        const s = make(byName(n))
        assert.equal(s.daemonTurnRefusal(), null, n)
        s._stdinForwardingDisabled = true
        assert.equal(s.daemonTurnRefusal(), 'stdin-disabled', n)
      }
    })

    it('SdkSession with stdin disabled: a refused wake leaves the user\'s own queued follow-ups alone', () => {
      const s = make(byName('SdkSession'))
      s._stdinForwardingDisabled = true
      s._isBusy = true
      s.enqueueOutgoingMessage({ prompt: 'the user typed this', sendOptions: { clientMessageId: 'u1' } })
      const mgr = new SessionManager({ skipPreflight: true, maxSessions: 2, stateFilePath: join(scratch, 'mgr2.json') })
      mgr._sessions.set('s1', { session: s, name: 'S', cwd: '/tmp' })
      assert.equal(mgr.daemonTurnRefusal('s1'), 'stdin-disabled')
      assert.equal(s.outgoingQueueLength, 1, 'asking did not discard anything')
    })

    it('CodexAppServerSession and AcpSession: not started', () => {
      for (const n of ['CodexAppServerSession', 'AcpSession']) {
        const s = make(byName(n))
        assert.equal(s.daemonTurnRefusal(), 'not-started', n)
        markStarted(s)
        assert.equal(s.daemonTurnRefusal(), null, n)
        s._client = null
        s._connection = null
        assert.equal(s.daemonTurnRefusal(), 'not-started', `${n}: ready flag but no transport`)
      }
    })
  })
})
