// S11 (agent-principals.md section 10.1): `auditOrRefuse` reports success ONLY when the
// line was really appended to the audit log; `logger.audit()` swallows write errors and
// cannot fail closed.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs'
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
})
