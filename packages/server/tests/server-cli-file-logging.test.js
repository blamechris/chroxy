import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { initFileLoggingFromConfig } from '../src/server-cli.js'
import { createLogger, closeFileLogging } from '../src/logger.js'

/**
 * Issue #3731 — server logs were not persisted to disk.
 *
 * `initFileLogging()` existed in `logger.js` with rotation logic, but was
 * never invoked anywhere in the codebase. As a result, every timeout, crash,
 * or stuck session left zero forensic trail — the only sink was stdout/stderr,
 * captured into a 100-line ring buffer in the Tauri parent that rolled over
 * within minutes.
 *
 * The fix: a small `initFileLoggingFromConfig()` helper called from
 * `startCliServer`, with sensible defaults and an env-var opt-out for the
 * supervisor case.
 */
describe('initFileLoggingFromConfig (#3731)', () => {
  let logDir
  const savedEnv = {}

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'chroxy-file-log-test-'))
    // Snapshot env vars we may toggle so the test is hermetic — without this
    // a developer with CHROXY_LOG_LEVEL=debug in their shell sees different
    // assertions than CI.
    savedEnv.CHROXY_NO_FILE_LOGGING = process.env.CHROXY_NO_FILE_LOGGING
    savedEnv.CHROXY_LOG_LEVEL = process.env.CHROXY_LOG_LEVEL
    savedEnv.CHROXY_LOG_DIR = process.env.CHROXY_LOG_DIR
    delete process.env.CHROXY_NO_FILE_LOGGING
    delete process.env.CHROXY_LOG_LEVEL
    delete process.env.CHROXY_LOG_DIR
  })

  afterEach(() => {
    closeFileLogging()
    rmSync(logDir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('initializes file logging when called with a config logDir', () => {
    const result = initFileLoggingFromConfig({ logDir })
    assert.equal(result.enabled, true)
    assert.equal(result.logDir, logDir)
    assert.equal(result.level, 'info')

    const log = createLogger('boot-test')
    log.info('boot-line-from-config')
    closeFileLogging()

    const logPath = join(logDir, 'chroxy.log')
    assert.ok(existsSync(logPath), 'chroxy.log should be created at the configured logDir')
    assert.match(readFileSync(logPath, 'utf8'), /boot-line-from-config/)
  })

  it('honors CHROXY_LOG_DIR env var when no config logDir given', () => {
    process.env.CHROXY_LOG_DIR = logDir
    const result = initFileLoggingFromConfig({})
    assert.equal(result.enabled, true)
    assert.equal(result.logDir, logDir)
  })

  it('honors CHROXY_LOG_LEVEL env var when no config logLevel given', () => {
    const result = initFileLoggingFromConfig({ logDir })
    assert.equal(result.level, 'info', 'default is info')

    closeFileLogging()
    process.env.CHROXY_LOG_LEVEL = 'debug'
    const debugResult = initFileLoggingFromConfig({ logDir })
    assert.equal(debugResult.level, 'debug')
  })

  it('config logLevel/logDir take precedence over env vars', () => {
    process.env.CHROXY_LOG_LEVEL = 'warn'
    const otherDir = mkdtempSync(join(tmpdir(), 'chroxy-file-log-other-'))
    try {
      process.env.CHROXY_LOG_DIR = otherDir
      const result = initFileLoggingFromConfig({ logLevel: 'debug', logDir })
      assert.equal(result.level, 'debug', 'config wins over CHROXY_LOG_LEVEL')
      assert.equal(result.logDir, logDir, 'config wins over CHROXY_LOG_DIR')
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('returns disabled without invoking initFileLogging when CHROXY_NO_FILE_LOGGING=1', () => {
    // Used by parent processes (supervisor, Tauri) that capture stdout themselves
    // and don't want a duplicate sink in their child.
    process.env.CHROXY_NO_FILE_LOGGING = '1'
    const result = initFileLoggingFromConfig({ logDir })
    assert.equal(result.enabled, false)
    assert.equal(result.logDir, null, 'logDir not propagated when disabled')

    // Confirm no log file was created — the env-var truly skipped the init,
    // it didn't just lie about the return value.
    const log = createLogger('boot-test')
    log.info('this-should-not-land')
    closeFileLogging()
    assert.ok(!existsSync(join(logDir, 'chroxy.log')), 'no chroxy.log when disabled')
  })

  it('does not throw on initFileLogging failure (boot must not abort over logging)', () => {
    // Pass a logDir under a non-existent root path. mkdirSync({recursive:true})
    // can usually recover, so we point at a path under a *file* — that fails
    // ENOTDIR which mkdirSync cannot recover from.
    const stubFile = join(logDir, 'not-a-dir')
    writeFileSync(stubFile, 'placeholder')
    const result = initFileLoggingFromConfig({ logDir: join(stubFile, 'sub') })
    assert.equal(result.enabled, false)
    assert.ok(result.error, 'should report the error')
  })
})
