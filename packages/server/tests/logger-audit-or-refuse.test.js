// S11 (agent-principals.md section 10.1): `auditOrRefuse` reports success ONLY when the
// line was really appended to the audit log; `logger.audit()` swallows write errors and
// cannot fail closed.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, appendFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { auditOrRefuse, createLogger, initFileLogging, closeFileLogging, _setAppendFileSyncForTest } from '../src/logger.js'

const quiet = () => {
  const o = { log: console.log, warn: console.warn, error: console.error }
  console.log = console.warn = console.error = () => {}
  return () => { Object.assign(console, o) }
}

describe('auditOrRefuse', () => {
  let dir
  let restore
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chroxy-aor-')); restore = quiet() })
  afterEach(() => { _setAppendFileSyncForTest(null); closeFileLogging(); restore(); rmSync(dir, { recursive: true, force: true }) })

  it('positive control: with logging healthy it reports ok and the line is in the audit log', () => {
    initFileLogging({ logDir: dir })
    assert.deepEqual(auditOrRefuse('agent-audit', 'hello world'), { ok: true })
    const audit = readFileSync(join(dir, 'chroxy-audit.log'), 'utf8')
    assert.ok(audit.includes('[AUDIT] [agent-audit] hello world'))
    assert.ok(readFileSync(join(dir, 'chroxy.log'), 'utf8').includes('[AUDIT] [agent-audit] hello world'), 'also mirrored to the daemon log')
  })

  it('reports failure when file logging is off, and writes nothing', () => {
    assert.deepEqual(auditOrRefuse('agent-audit', 'x'), { ok: false, reason: 'audit_unavailable' })
  })

  for (const code of ['ENOSPC', 'EBADF', 'EACCES']) {
    it(`reports failure when the audit append throws ${code}`, () => {
      initFileLogging({ logDir: dir })
      _setAppendFileSyncForTest((path, data) => {
        if (String(path).endsWith('chroxy-audit.log')) throw Object.assign(new Error(code), { code })
        return appendFileSync(path, data)
      })
      assert.deepEqual(auditOrRefuse('agent-audit', 'x'), { ok: false, reason: 'audit_unavailable' })
    })
  }

  it('a failing daemon-log append alone does not make the audit write fail (the audit log is the record)', () => {
    initFileLogging({ logDir: dir })
    _setAppendFileSyncForTest((path, data) => {
      if (String(path).endsWith('chroxy.log')) throw Object.assign(new Error('x'), { code: 'EBADF' })
      return appendFileSync(path, data)
    })
    assert.deepEqual(auditOrRefuse('agent-audit', 'x'), { ok: true })
    assert.ok(readFileSync(join(dir, 'chroxy-audit.log'), 'utf8').includes('[agent-audit] x'))
  })

  it('redacts like audit(): a token-shaped value never lands in the line', () => {
    initFileLogging({ logDir: dir })
    auditOrRefuse('agent-audit', 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')
    assert.equal(readFileSync(join(dir, 'chroxy-audit.log'), 'utf8').includes('abcdefghijklmnopqrstuvwxyz0123456789'), false)
  })

  it('audit() itself still swallows the same failure (the behaviour this replaces for fail-closed callers)', () => {
    initFileLogging({ logDir: dir })
    _setAppendFileSyncForTest(() => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }) })
    assert.doesNotThrow(() => createLogger('x').audit('y'))
  })

  describe('record framing: every accepted line parses on its own', () => {
    const auditPath = () => join(dir, 'chroxy-audit.log')
    const records = () => readFileSync(auditPath(), 'utf8').split('\n').filter((l) => l.includes('[agent-audit]'))
    const payload = (line) => JSON.parse(/(\{.*\})$/.exec(line)[1])
    const rec = (n) => `attempt ${JSON.stringify({ n })}`
    /** An append that writes a PREFIX of the data and then throws, like ENOSPC mid-write. */
    const partialThenThrow = () => _setAppendFileSyncForTest((path, data) => {
      if (String(path).endsWith('chroxy-audit.log')) {
        appendFileSync(path, data.slice(0, 56))
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      }
      return appendFileSync(path, data)
    })

    it('a prefix-write then throw: the retried attempt record is on disk and parses on its own, before the effect would run', () => {
      initFileLogging({ logDir: dir })
      assert.deepEqual(auditOrRefuse('agent-audit', rec(1)), { ok: true })
      partialThenThrow()
      assert.deepEqual(auditOrRefuse('agent-audit', rec(2)), { ok: false, reason: 'audit_unavailable' })
      _setAppendFileSyncForTest(null)
      const retry = auditOrRefuse('agent-audit', rec(3))
      assert.deepEqual(retry, { ok: true })
      // the point at which a caller would run the effect: the accepted record must already parse
      const lines = records()
      assert.deepEqual(payload(lines.at(-1)), { n: 3 })
      assert.equal(lines.length, 3, 'the torn fragment is its own (unparseable) line')
      const parsed = lines.filter((l) => { try { payload(l); return true } catch { return false } })
      assert.deepEqual(parsed.map((l) => payload(l).n), [1, 3], 'both whole records parse; only the torn fragment does not')
    })

    it('an existing partial tail at startup is fenced off before the first write', () => {
      writeFileSync(auditPath(), '2026-01-01T00:00:00.000Z [AUDIT] [agent-audit] attempt {"n":')
      initFileLogging({ logDir: dir })
      assert.deepEqual(auditOrRefuse('agent-audit', rec(7)), { ok: true })
      assert.deepEqual(payload(records().at(-1)), { n: 7 })
      assert.equal(readFileSync(auditPath(), 'utf8').endsWith('\n'), true)
    })

    it('healthy positive control: no blank lines, one record per line, including a restart over a clean file', () => {
      initFileLogging({ logDir: dir })
      for (let i = 0; i < 5; i++) assert.deepEqual(auditOrRefuse('agent-audit', rec(i)), { ok: true })
      closeFileLogging()
      initFileLogging({ logDir: dir })
      assert.deepEqual(auditOrRefuse('agent-audit', rec(5)), { ok: true })
      const all = readFileSync(auditPath(), 'utf8').split('\n')
      assert.equal(all.at(-1), '', 'ends with a newline')
      assert.equal(all.slice(0, -1).filter((l) => l === '').length, 0, 'no blank lines')
      assert.deepEqual(records().map((l) => payload(l).n), [0, 1, 2, 3, 4, 5])
    })

    // A record framed the way the logger writes it, ending in a parseable JSON payload.
    const FRAMED = /^\S+ \[AUDIT\] \[agent-audit\] attempt \{"n":\d+\}$/

    it('the non-strict audit() respects the same boundary: the failed write leaves a REAL partial line, the retry gets its own line', () => {
      initFileLogging({ logDir: dir })
      partialThenThrow() // cuts data at 56 bytes
      const torn = 'torn ' + 'x'.repeat(80) // the record is far longer than the cut, so the cut lands inside the message
      createLogger('x').audit(torn)
      _setAppendFileSyncForTest(null)
      const afterFail = readFileSync(auditPath(), 'utf8')
      assert.ok(afterFail.length > 0 && !afterFail.endsWith('\n'), 'precondition: a partial line with no newline is on disk')
      assert.ok(!afterFail.includes('x'.repeat(80)), 'precondition: the record was cut, not written whole')
      createLogger('agent-audit').audit(rec(9))
      const physical = readFileSync(auditPath(), 'utf8').split('\n')
      assert.equal(physical.at(-1), '', 'ends with a newline')
      const own = physical.at(-2)
      assert.ok(FRAMED.test(own), 'the retry occupies its own fully framed physical line')
      assert.deepEqual(payload(own), { n: 9 })
      assert.ok(!physical.at(-3).includes('[agent-audit]'), 'the fragment is a separate line holding nothing of the retry')
      assert.ok(physical.at(-3).includes('torn'), 'and it is the torn record')
    })

    it('rotation: a partial tail rotated away leaves the next write on its own line at the top of the fresh file', () => {
      writeFileSync(auditPath(), Buffer.concat([
        Buffer.alloc(10 * 1024 * 1024, 'a'),
        Buffer.from('\n2026-01-01T00:00:00.000Z [AUDIT] [agent-audit] attempt {"n":'),
      ]))
      initFileLogging({ logDir: dir })
      assert.deepEqual(auditOrRefuse('agent-audit', rec(1)), { ok: true }) // fenced, then the file rotates
      assert.deepEqual(auditOrRefuse('agent-audit', rec(2)), { ok: true })
      const live = readFileSync(auditPath(), 'utf8')
      assert.ok(FRAMED.test(live.split('\n')[0]), 'the fresh file starts with the record, no blank line or glued fragment')
      assert.deepEqual(live.split('\n').slice(0, -1).map((l) => payload(l).n), [2])
      const archive = readFileSync(join(dir, 'chroxy-audit.1.log'), 'utf8').split('\n')
      assert.deepEqual(payload(archive.at(-2)), { n: 1 }, 'the fenced record parses on its own in the archive')
      assert.ok(archive.at(-3).endsWith('{"n":'), 'and the torn fragment stays a line of its own')
    })

    it('a boundary-inspection fault fails safe: the write still lands on its own line', () => {
      writeFileSync(auditPath(), '2026-01-01T00:00:00.000Z [AUDIT] [agent-audit] attempt {"n":')
      chmodSync(auditPath(), 0o200) // write-only: stat works, the open-for-read throws EACCES
      try {
        initFileLogging({ logDir: dir })
        assert.deepEqual(auditOrRefuse('agent-audit', rec(4)), { ok: true })
      } finally { chmodSync(auditPath(), 0o600) }
      const physical = readFileSync(auditPath(), 'utf8').split('\n')
      assert.ok(FRAMED.test(physical.at(-2)), 'own framed line: the uninspectable tail was treated as needing a boundary')
      assert.deepEqual(payload(physical.at(-2)), { n: 4 })
      assert.ok(physical.at(-3).endsWith('{"n":'), 'the fragment is fenced off')
    })
  })
})
