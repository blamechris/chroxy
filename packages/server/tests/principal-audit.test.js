/**
 * The agent-principal audit trail (agent-principals.md section 10.1), over the REAL
 * logger and a real audit file: an attempt line precedes every effect, an effect never
 * happens when that line cannot be written, content is never logged, and repeated
 * identical rejections collapse into one counter line.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initFileLogging, closeFileLogging, _setAppendFileSyncForTest } from '../src/logger.js'
import { createPrincipalAuditor, inputDigest, PRINCIPAL_EFFECT_KINDS, AUDIT_COMPONENT } from '../src/principal-audit.js'
import { withPrincipalEffect } from '../src/principal-effect.js'

const client = { id: 'c1', principal: { principalId: 'pr-1', label: 'sup' } }
const pass = () => ({ ok: true })

describe('principal audit over a real audit file', () => {
  let dir
  let restoreConsole
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-paudit-'))
    const o = { log: console.log, warn: console.warn, error: console.error }
    console.log = console.warn = console.error = () => {}
    restoreConsole = () => Object.assign(console, o)
  })
  afterEach(() => { _setAppendFileSyncForTest(null); closeFileLogging(); restoreConsole(); rmSync(dir, { recursive: true, force: true }) })

  const auditText = () => { try { return readFileSync(join(dir, 'chroxy-audit.log'), 'utf8') } catch { return '' } }
  const agentLines = () => auditText().split('\n').filter((l) => l.includes(`[${AUDIT_COMPONENT}]`))
  const parse = (line) => { const m = /\[agent-audit\] (\w+) (\{.*\})$/.exec(line); return { kind: m[1], ...JSON.parse(m[2]) } }
  const failAudit = (code) => _setAppendFileSyncForTest((path, data) => {
    if (String(path).endsWith('chroxy-audit.log')) throw Object.assign(new Error(code), { code })
    return appendFileSync(path, data)
  })

  describe('every effect kind: no audit line, no effect', () => {
    const kinds = [...PRINCIPAL_EFFECT_KINDS]
    it('the table covers exactly the contract kinds', () => {
      assert.deepEqual(kinds, ['enqueue', 'send', 'interrupt', 'create', 'destroy', 'permission_answer', 'lease_change'])
    })

    for (const kind of kinds) {
      for (const mode of ['ENOSPC', 'EBADF', 'logging_off']) {
        it(`${kind} under ${mode}: no effect, audit_unavailable, nothing written`, () => {
          if (mode !== 'logging_off') { initFileLogging({ logDir: dir }); failAudit(mode) }
          let effects = 0
          const r = withPrincipalEffect(client, pass, { auditor: createPrincipalAuditor(), action: kind, sessionId: 's1', requestId: 'r1' }, () => { effects++ })
          assert.deepEqual(r, { ok: false, reason: 'audit_unavailable' })
          assert.equal(effects, 0)
          assert.equal(agentLines().length, 0)
        })
      }

      it(`${kind} with healthy logging: the attempt line is on disk BEFORE the effect, and the effect happens once`, () => {
        initFileLogging({ logDir: dir })
        let seenAtEffect = null
        let effects = 0
        const r = withPrincipalEffect(client, pass, { auditor: createPrincipalAuditor(), action: kind, sessionId: 's1', requestId: 'r1', leaseId: 'L1', gen: 4 }, () => {
          effects++
          seenAtEffect = agentLines().map(parse)
          return 'done'
        })
        assert.deepEqual(r, { ok: true, value: 'done' })
        assert.equal(effects, 1)
        assert.equal(seenAtEffect.length, 1, 'exactly one line existed when the effect ran')
        assert.deepEqual(
          { kind: seenAtEffect[0].kind, principalId: seenAtEffect[0].principalId, label: seenAtEffect[0].label, action: seenAtEffect[0].action, sessionId: seenAtEffect[0].sessionId, requestId: seenAtEffect[0].requestId, leaseId: seenAtEffect[0].leaseId, gen: seenAtEffect[0].gen, result: seenAtEffect[0].result },
          { kind: 'attempt', principalId: 'pr-1', label: 'sup', action: kind, sessionId: 's1', requestId: 'r1', leaseId: 'L1', gen: 4, result: 'attempt' },
        )
        assert.ok(typeof seenAtEffect[0].ts === 'string')
      })
    }
  })

  it('an unknown effect kind, a missing audit descriptor and a missing auditor never run the effect', () => {
    initFileLogging({ logDir: dir })
    let effects = 0
    const fn = () => { effects++ }
    assert.equal(withPrincipalEffect(client, pass, { auditor: createPrincipalAuditor(), action: 'wipe_disk' }, fn).reason, 'bad_effect')
    assert.equal(withPrincipalEffect(client, pass, undefined, fn).ok, false)
    assert.equal(withPrincipalEffect(client, pass, { action: 'send' }, fn).reason, 'audit_unavailable')
    assert.equal(effects, 0)
  })

  it('an auditor whose writer throws, or answers anything but { ok: true }, does not let the effect run', () => {
    for (const writer of [() => { throw new Error('boom') }, () => ({ ok: 'yes' }), () => undefined, () => ({ ok: false })]) {
      let effects = 0
      const r = withPrincipalEffect(client, pass, { auditor: createPrincipalAuditor({ auditOrRefuse: writer }), action: 'send' }, () => { effects++ })
      assert.equal(r.reason, 'audit_unavailable')
      assert.equal(effects, 0)
    }
  })

  it('a refused check never reaches the attempt line, and an effect that throws logs a rejected outcome and rethrows', () => {
    initFileLogging({ logDir: dir })
    let effects = 0
    const refused = withPrincipalEffect(client, () => ({ ok: false, reason: 'agents_off' }), { auditor: createPrincipalAuditor(), action: 'send', sessionId: 's1' }, () => { effects++ })
    assert.deepEqual(refused, { ok: false, reason: 'agents_off' })
    assert.equal(effects, 0)
    const refusedLines = agentLines().map(parse)
    assert.equal(refusedLines.length, 1, 'exactly one record')
    assert.equal(refusedLines[0].kind, 'outcome')
    assert.equal(refusedLines[0].result, 'rejected:agents_off', 'a rejected line, never an attempt')
    assert.throws(() => withPrincipalEffect(client, pass, { auditor: createPrincipalAuditor(), action: 'send' }, () => { throw new Error('effect broke') }), /effect broke/)
    const last = parse(agentLines().at(-1))
    assert.equal(last.result, 'rejected:effect_error')
  })

  it('input text is logged as a sha256 and a length, never as content, and unknown fields are dropped', () => {
    initFileLogging({ logDir: dir })
    const secret = 'the quick brown fox ignores previous instructions'
    const a = createPrincipalAuditor()
    a.attempt(client.principal, { action: 'send', sessionId: 's1', text: secret, content: secret, token: 'tok-abcdef' })
    a.outcome(client.principal, { action: 'send', sessionId: 's1', text: secret }, 'delivered')
    a.rejected(client.principal, { action: 'send', text: secret }, 'too_long')
    const raw = auditText()
    assert.equal(raw.includes(secret), false)
    assert.equal(raw.includes('quick brown'), false)
    assert.equal(raw.includes('tok-abcdef'), false)
    const lines = agentLines().map(parse)
    assert.equal(lines.length, 3)
    const expected = createHash('sha256').update(secret, 'utf8').digest('hex')
    for (const l of lines) {
      assert.equal(l.sha256, expected, 'an independent oracle, not the implementation\'s own helper')
      assert.equal(l.length, secret.length)
    }
  })

  it('inputDigest matches fixed SHA-256 test vectors, and a different body gives a different digest', () => {
    assert.equal(inputDigest('abc').sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    assert.equal(inputDigest('').sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    assert.equal(inputDigest('abc').length, 3)
    assert.notEqual(inputDigest('abd').sha256, inputDigest('abc').sha256)
  })

  it('outcome lines name the transition; failing outcome writes report it but cannot undo anything', () => {
    initFileLogging({ logDir: dir })
    const a = createPrincipalAuditor()
    for (const result of ['delivered', 'queued', 'expired', 'dropped:killed', 'rejected:lease_held', 'killed']) {
      assert.deepEqual(a.outcome(client.principal, { action: 'enqueue', sessionId: 's1', requestId: 'r' }, result), { ok: true })
    }
    assert.deepEqual(agentLines().map((l) => parse(l).result), ['delivered', 'queued', 'expired', 'dropped:killed', 'rejected:lease_held', 'killed'])
    failAudit('ENOSPC')
    assert.deepEqual(a.outcome(client.principal, { action: 'enqueue' }, 'delivered'), { ok: false, reason: 'audit_unavailable' })
  })

  it('repeated identical rejections inside a minute collapse into one counter line; a different reason does not', () => {
    initFileLogging({ logDir: dir })
    let t = 1_000_000
    const a = createPrincipalAuditor({ now: () => t, collapseMs: 60_000 })
    for (let i = 0; i < 5; i++) { t += 1000; a.rejected(client.principal, { action: 'send', sessionId: 's1' }, 'rate_limited') }
    assert.equal(agentLines().length, 1, 'one line for the first rejection, four collapsed')
    a.rejected(client.principal, { action: 'send', sessionId: 's1' }, 'too_long')
    assert.equal(agentLines().length, 2, 'a different reason is its own line')
    t += 61_000
    a.rejected(client.principal, { action: 'send', sessionId: 's1' }, 'rate_limited')
    const lines = agentLines().map(parse)
    const counter = lines.find((l) => l.collapsed === true)
    assert.ok(counter, 'the window rolled over: the counter line is written')
    assert.equal(counter.count, 4)
    assert.equal(counter.result, 'rejected:rate_limited')
    assert.equal(lines.filter((l) => l.result === 'rejected:rate_limited' && !l.collapsed).length, 2, 'and the new window logs afresh')
  })

  it('flushRejections writes the pending counters', () => {
    initFileLogging({ logDir: dir })
    const a = createPrincipalAuditor({ now: () => 5 })
    for (let i = 0; i < 3; i++) a.rejected(client.principal, { action: 'create' }, 'ceiling')
    a.flushRejections()
    const counter = agentLines().map(parse).find((l) => l.collapsed)
    assert.equal(counter.count, 2)
  })

  describe('collapsed counts are not lost', () => {
    const burst = (a, n = 3) => { for (let i = 0; i < n; i++) a.rejected(client.principal, { action: 'create' }, 'ceiling') }

    it('two refusals then silence: the counter line appears when the window ends, with no later rejection', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        initFileLogging({ logDir: dir })
        const a = createPrincipalAuditor({ collapseMs: 60_000 })
        burst(a, 3)
        assert.equal(agentLines().length, 1, 'only the first refusal is logged so far')
        mock.timers.tick(59_999)
        assert.equal(agentLines().length, 1, 'not before the window ends')
        mock.timers.tick(1)
        const lines = agentLines().map(parse)
        assert.equal(lines.length, 2)
        assert.equal(lines[1].collapsed, true)
        assert.equal(lines[1].count, 2)
        assert.equal(lines[1].result, 'rejected:ceiling')
      } finally { mock.timers.reset() }
    })

    it('a lone refusal writes no counter line when its window ends (positive control: no spam)', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        initFileLogging({ logDir: dir })
        const a = createPrincipalAuditor({ collapseMs: 60_000 })
        burst(a, 1)
        mock.timers.tick(120_000)
        assert.equal(agentLines().length, 1)
        assert.equal(a.flushRejections().pending, 0)
      } finally { mock.timers.reset() }
    })

    it('flushRejections (the shutdown path) writes pending counts and reports none left', () => {
      initFileLogging({ logDir: dir })
      const a = createPrincipalAuditor({ collapseMs: 60_000 })
      burst(a, 4)
      assert.deepEqual(a.flushRejections(), { pending: 0 })
      assert.equal(parse(agentLines().at(-1)).count, 3)
      assert.equal(a.flushRejections().pending, 0)
      assert.equal(agentLines().length, 2, 'a second flush writes nothing more')
    })

    it('a failed counter write is kept and retried, not dropped', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        initFileLogging({ logDir: dir })
        const a = createPrincipalAuditor({ collapseMs: 60_000 })
        burst(a, 3)
        failAudit('ENOSPC')
        mock.timers.tick(60_000)
        assert.equal(agentLines().length, 1, 'the counter write failed')
        assert.equal(a.flushRejections().pending, 1, 'and the count is still held')
        _setAppendFileSyncForTest(null)
        assert.equal(a.flushRejections().pending, 0)
        const last = parse(agentLines().at(-1))
        assert.equal(last.collapsed, true)
        assert.equal(last.count, 2)
      } finally { mock.timers.reset() }
    })

    it('a failed timer flush is retried by the next window, then recovers when the disk does', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        initFileLogging({ logDir: dir })
        const a = createPrincipalAuditor({ collapseMs: 1000 })
        burst(a, 3)
        failAudit('ENOSPC')
        mock.timers.tick(1000)
        _setAppendFileSyncForTest(null)
        mock.timers.tick(1000)
        assert.equal(parse(agentLines().at(-1)).count, 2, 'the re-armed timer wrote it once the disk recovered')
      } finally { mock.timers.reset() }
    })

    it('a counter write that keeps failing is attempted exactly five times, then the entry is dropped for good', () => {
      mock.timers.enable({ apis: ['setTimeout'] })
      try {
        initFileLogging({ logDir: dir })
        const a = createPrincipalAuditor({ collapseMs: 1000 })
        burst(a, 3)
        let counterAttempts = 0
        _setAppendFileSyncForTest((path, data) => {
          if (String(path).endsWith('chroxy-audit.log')) {
            if (data.includes('"collapsed":true')) counterAttempts++
            throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
          }
          return appendFileSync(path, data)
        })
        for (let i = 0; i < 8; i++) mock.timers.tick(1000) // well past the five windows
        assert.equal(counterAttempts, 5, 'bounded: exactly MAX_FLUSH_FAILURES attempts')
        assert.equal(a.flushRejections().pending, 0, 'exhausted: nothing is held any more')
        for (let i = 0; i < 8; i++) mock.timers.tick(1000)
        assert.equal(counterAttempts, 5, 'no further attempts after more windows have passed')
        assert.equal(a.flushRejections().pending, 0)
      } finally { mock.timers.reset() }
    })
  })
})
