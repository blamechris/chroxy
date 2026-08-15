// #7162 — audit retention floor + service-capture bounding
// (docs/security/discord-return-path.md §9.1: rotation must treat [AUDIT]
// lines as the retention floor; the launchd StandardOutPath capture must be
// bounded).

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createLogger, initFileLogging, closeFileLogging, setJsonMode,
  setConsoleQuiet, capStdioCaptureLogs, getAuditLogPath,
} from '../src/logger.js'

function silenceConsole() {
  const orig = { log: console.log, warn: console.warn, error: console.error }
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  return () => {
    console.log = orig.log
    console.warn = orig.warn
    console.error = orig.error
  }
}

describe('audit dual-write (#7162)', () => {
  let logDir
  let restoreConsole

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'chroxy-audit-'))
    restoreConsole = silenceConsole()
  })

  afterEach(() => {
    restoreConsole()
    closeFileLogging()
    rmSync(logDir, { recursive: true, force: true })
  })

  it('audit() lines land in both chroxy.log and chroxy-audit.log', () => {
    initFileLogging({ logDir })
    const log = createLogger('discord-audit')
    log.audit('interject attempt user=123')
    closeFileLogging()

    const main = readFileSync(join(logDir, 'chroxy.log'), 'utf8')
    const audit = readFileSync(join(logDir, 'chroxy-audit.log'), 'utf8')
    assert.ok(main.includes('[AUDIT] [discord-audit] interject attempt user=123'))
    assert.ok(audit.includes('[AUDIT] [discord-audit] interject attempt user=123'))
  })

  it('non-audit lines never reach chroxy-audit.log', () => {
    initFileLogging({ logDir, level: 'debug' })
    const log = createLogger('comp')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    closeFileLogging()

    assert.ok(!existsSync(join(logDir, 'chroxy-audit.log')),
      'audit log should not exist when only non-audit lines were written')
  })

  it('a level bypass via {always:true} does not reach the audit file — the gate keys on the audit level', () => {
    initFileLogging({ logDir })
    const log = createLogger('comp')
    log.info('level-bypassed but not audit', { always: true })
    closeFileLogging()
    assert.ok(!existsSync(join(logDir, 'chroxy-audit.log')),
      'only audit() may write the forensic file')
  })

  it('JSON-mode audit lines dual-write with level "audit" (the tag lives in the level field)', () => {
    initFileLogging({ logDir })
    setJsonMode(true)
    const log = createLogger('discord-audit')
    log.audit('json audit line')
    setJsonMode(false)
    closeFileLogging()
    const auditRaw = readFileSync(join(logDir, 'chroxy-audit.log'), 'utf8').trim()
    const entry = JSON.parse(auditRaw)
    assert.equal(entry.level, 'audit')
    assert.equal(entry.msg, 'json audit line')
  })

  it('getAuditLogPath reflects file-logging state (the §9.1 enable precondition)', () => {
    assert.equal(getAuditLogPath(), null)
    initFileLogging({ logDir })
    assert.equal(getAuditLogPath(), join(logDir, 'chroxy-audit.log'))
    closeFileLogging()
    assert.equal(getAuditLogPath(), null)
  })

  it('audit lines survive the main log rotating through its full cascade (retention floor)', () => {
    initFileLogging({ logDir, level: 'debug' })
    const log = createLogger('discord-audit')
    log.audit('RETENTION_FLOOR_MARKER')

    // Churn chroxy.log far past 5MB × 3 archives so the marker's original
    // main-log copy is gone from every chroxy*.log in the cascade.
    const noise = 'n'.repeat(1000)
    for (let i = 0; i < 25000; i++) log.info(noise)
    closeFileLogging()

    for (const name of ['chroxy.log', 'chroxy.1.log', 'chroxy.2.log', 'chroxy.3.log']) {
      const p = join(logDir, name)
      if (!existsSync(p)) continue
      assert.ok(!readFileSync(p, 'utf8').includes('RETENTION_FLOOR_MARKER'),
        `${name} should have churned past the marker (test premise)`)
    }
    const audit = readFileSync(join(logDir, 'chroxy-audit.log'), 'utf8')
    assert.ok(audit.includes('RETENTION_FLOOR_MARKER'),
      'audit copy must outlive the main-log cascade')
  })

  it('audit cascade keeps exactly 4 archives — .4 exists, .5 never created', () => {
    initFileLogging({ logDir })
    const auditPath = join(logDir, 'chroxy-audit.log')
    const log = createLogger('discord-audit')
    // Drive 6 rotations by pre-filling past the 10MB threshold each round;
    // each audit() append-then-check tips the cascade once.
    for (let round = 1; round <= 6; round++) {
      writeFileSync(auditPath, 'f'.repeat(10 * 1024 * 1024 + 1))
      log.audit(`round ${round}`)
    }
    assert.ok(existsSync(join(logDir, 'chroxy-audit.4.log')),
      'oldest retained archive .4 should exist after 6 rotations')
    assert.ok(!existsSync(join(logDir, 'chroxy-audit.5.log')),
      'cascade must be capped at 4 archives (bounded disk, §9.1)')
  })

  it('audit log rotates on its own 10MB budget with 4 archives', () => {
    initFileLogging({ logDir })
    const auditPath = join(logDir, 'chroxy-audit.log')
    // Pre-fill past the 10MB threshold, then one audit write triggers the
    // cascade (append-then-check, matching the main log's semantics).
    writeFileSync(auditPath, 'f'.repeat(10 * 1024 * 1024 + 1))
    const log = createLogger('discord-audit')
    log.audit('tips the rotation')
    assert.ok(existsSync(join(logDir, 'chroxy-audit.1.log')),
      'chroxy-audit.1.log should exist after rotation')

    log.audit('fresh file first line')
    closeFileLogging()
    const fresh = readFileSync(auditPath, 'utf8')
    assert.ok(fresh.includes('fresh file first line'))
    assert.ok(!fresh.includes('f'.repeat(64)), 'fresh audit log should not carry filler')
  })
})

describe('daemon-mode console quieting (#7162)', () => {
  let logDir
  let calls
  let restoreConsole

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'chroxy-quiet-'))
    calls = { log: 0, warn: 0, error: 0 }
    const orig = silenceConsole()
    console.log = () => { calls.log++ }
    console.warn = () => { calls.warn++ }
    console.error = () => { calls.error++ }
    restoreConsole = orig
  })

  afterEach(() => {
    restoreConsole()
    closeFileLogging()
    rmSync(logDir, { recursive: true, force: true })
  })

  it('suppresses info/debug/audit console mirrors, keeps warn/error', () => {
    initFileLogging({ logDir, level: 'debug' })
    setConsoleQuiet(true)
    const log = createLogger('comp')
    log.debug('d')
    log.info('i')
    log.audit('a')
    log.warn('w')
    log.error('e')

    assert.equal(calls.log, 0, 'info/debug/audit must not hit the console')
    assert.equal(calls.warn, 1)
    assert.equal(calls.error, 1)

    // The suppressed lines still reached the file log.
    closeFileLogging()
    const content = readFileSync(join(logDir, 'chroxy.log'), 'utf8')
    for (const marker of ['d', 'i', 'a', 'w', 'e']) {
      assert.ok(content.includes(`] ${marker}`), `file log should contain "${marker}"`)
    }
  })

  it('is a no-op when file logging is off (fail-safe: never lose both sinks)', () => {
    setConsoleQuiet(true)
    const log = createLogger('comp')
    log.info('still printed')
    assert.equal(calls.log, 1, 'with no file log, the console mirror must stay on')
    setConsoleQuiet(false)
  })

  it('falls back to the console when the file append FAILS, even with file logging configured', () => {
    initFileLogging({ logDir })
    // Make the append fail deterministically: a directory where the log file
    // should be gives appendFileSync EISDIR on every write.
    mkdirSync(join(logDir, 'chroxy.log'))
    setConsoleQuiet(true)
    const log = createLogger('comp')
    log.info('must not vanish')
    log.audit('audit must not vanish')
    assert.equal(calls.log, 2,
      'quieting keys on the actual write outcome, not on configuration — '
      + 'a failed append re-enables the console mirror (both lines printed)')
  })

  it('closeFileLogging resets the quiet flag', () => {
    initFileLogging({ logDir })
    setConsoleQuiet(true)
    closeFileLogging()
    // Re-init without re-quieting: console mirror is back on.
    initFileLogging({ logDir })
    const log = createLogger('comp')
    log.info('printed again')
    assert.equal(calls.log, 1)
  })
})

describe('capStdioCaptureLogs (#7162)', () => {
  let logDir

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'chroxy-cap-'))
  })

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true })
  })

  it('caps an oversized capture: tail preserved to .old.log, live file truncated in place', () => {
    const stdoutLog = join(logDir, 'chroxy-stdout.log')
    writeFileSync(stdoutLog, 'A'.repeat(900) + 'TAIL'.repeat(25)) // 1000 bytes, tail is Ts

    const capped = capStdioCaptureLogs({ logDir, maxSize: 500, tailKeep: 100 })

    assert.equal(capped.length, 1)
    assert.equal(capped[0].file, stdoutLog)
    assert.equal(capped[0].preservedBytes, 100)
    assert.equal(statSync(stdoutLog).size, 0, 'live capture truncated in place')
    const old = readFileSync(join(logDir, 'chroxy-stdout.old.log'), 'utf8')
    assert.equal(old.length, 100)
    assert.equal(old, 'TAIL'.repeat(25), 'archive holds exactly the tail')
  })

  it('capping preserves the inode — the service manager keeps writing to the same file', () => {
    if (process.platform === 'win32') return
    const stdoutLog = join(logDir, 'chroxy-stdout.log')
    writeFileSync(stdoutLog, 'X'.repeat(1000))
    const inoBefore = statSync(stdoutLog).ino
    capStdioCaptureLogs({ logDir, maxSize: 500, tailKeep: 100 })
    assert.equal(statSync(stdoutLog).ino, inoBefore,
      'truncate-in-place, never a rename — an fd held on this inode stays live')
  })

  it('archive starts on a whole line when the tail begins mid-line', () => {
    const stdoutLog = join(logDir, 'chroxy-stdout.log')
    writeFileSync(stdoutLog, 'A'.repeat(950) + '\nline-two\nline-three\n') // tail cut lands mid "A" run
    const capped = capStdioCaptureLogs({ logDir, maxSize: 500, tailKeep: 30 })
    const old = readFileSync(join(logDir, 'chroxy-stdout.old.log'), 'utf8')
    assert.equal(old, 'line-two\nline-three\n', 'partial leading line dropped')
    assert.equal(capped[0].preservedBytes, old.length)
  })

  it('caps stdout and stderr independently, leaves under-cap files untouched', () => {
    writeFileSync(join(logDir, 'chroxy-stdout.log'), 'small')
    writeFileSync(join(logDir, 'chroxy-stderr.log'), 'E'.repeat(1000))

    const capped = capStdioCaptureLogs({ logDir, maxSize: 500, tailKeep: 200 })

    assert.equal(capped.length, 1)
    assert.ok(capped[0].file.endsWith('chroxy-stderr.log'))
    assert.equal(readFileSync(join(logDir, 'chroxy-stdout.log'), 'utf8'), 'small',
      'under-cap capture untouched')
    assert.equal(statSync(join(logDir, 'chroxy-stderr.log')).size, 0)
  })

  it('overwrites a previous .old.log rather than accumulating archives', () => {
    const stderrLog = join(logDir, 'chroxy-stderr.log')
    writeFileSync(join(logDir, 'chroxy-stderr.old.log'), 'stale archive')
    writeFileSync(stderrLog, 'B'.repeat(1000))

    capStdioCaptureLogs({ logDir, maxSize: 500, tailKeep: 50 })

    const old = readFileSync(join(logDir, 'chroxy-stderr.old.log'), 'utf8')
    assert.equal(old, 'B'.repeat(50), 'archive replaced, not appended — total stays bounded')
  })

  it('returns empty and does not throw when captures are absent', () => {
    assert.deepEqual(capStdioCaptureLogs({ logDir }), [])
    assert.deepEqual(capStdioCaptureLogs({ logDir: join(logDir, 'no-such-dir') }), [])
  })

  it('a capture file exactly at the cap is not touched (boundary)', () => {
    const stdoutLog = join(logDir, 'chroxy-stdout.log')
    writeFileSync(stdoutLog, 'C'.repeat(500))
    assert.deepEqual(capStdioCaptureLogs({ logDir, maxSize: 500, tailKeep: 100 }), [])
    assert.equal(statSync(stdoutLog).size, 500)
  })
})
