import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLogger, initFileLogging, closeFileLogging } from '../src/logger.js'

describe('createLogger backward compatibility', () => {
  it('returns object with info, warn, error methods', () => {
    const log = createLogger('test-component')
    assert.equal(typeof log.info, 'function')
    assert.equal(typeof log.warn, 'function')
    assert.equal(typeof log.error, 'function')
  })

  it('returns object with debug and log methods', () => {
    const log = createLogger('test-component')
    assert.equal(typeof log.debug, 'function')
    assert.equal(typeof log.log, 'function')
  })

  it('can call all methods without error', () => {
    const log = createLogger('test-component')
    assert.doesNotThrow(() => log.info('info message'))
    assert.doesNotThrow(() => log.warn('warn message'))
    assert.doesNotThrow(() => log.error('error message'))
    assert.doesNotThrow(() => log.debug('debug message'))
    assert.doesNotThrow(() => log.log('log message'))
  })
})

describe('initFileLogging', () => {
  let logDir

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'chroxy-log-'))
  })

  afterEach(() => {
    closeFileLogging()
    rmSync(logDir, { recursive: true, force: true })
  })

  it('writes log messages to chroxy.log in logDir', () => {
    initFileLogging({ logDir })
    const log = createLogger('mycomp')
    log.info('hello file')
    closeFileLogging()

    const logPath = join(logDir, 'chroxy.log')
    assert.ok(existsSync(logPath), 'chroxy.log should exist')
    const content = readFileSync(logPath, 'utf8')
    assert.ok(content.includes('hello file'), 'log file should contain the message')
  })

  it('log file contains timestamp, level, component, and message', () => {
    initFileLogging({ logDir })
    const log = createLogger('widget')
    log.warn('something bad')
    closeFileLogging()

    const content = readFileSync(join(logDir, 'chroxy.log'), 'utf8')
    // Format: 2026-02-22T12:34:56.789Z [WARN] [widget] something bad
    assert.match(content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
    assert.ok(content.includes('[WARN]'), 'should contain level')
    assert.ok(content.includes('[widget]'), 'should contain component')
    assert.ok(content.includes('something bad'), 'should contain message')
  })

  it('closeFileLogging stops file writing', () => {
    initFileLogging({ logDir })
    const log = createLogger('comp')
    log.info('before close')
    closeFileLogging()
    log.info('after close')

    const content = readFileSync(join(logDir, 'chroxy.log'), 'utf8')
    assert.ok(content.includes('before close'))
    assert.ok(!content.includes('after close'), 'should not contain messages after close')
  })
})

describe('log levels', () => {
  let logDir

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'chroxy-log-'))
  })

  afterEach(() => {
    closeFileLogging()
    rmSync(logDir, { recursive: true, force: true })
  })

  it('at level info, debug messages are NOT written to file', () => {
    initFileLogging({ logDir, level: 'info' })
    const log = createLogger('comp')
    log.debug('debug-msg')
    log.info('info-msg')
    closeFileLogging()

    const content = readFileSync(join(logDir, 'chroxy.log'), 'utf8')
    assert.ok(!content.includes('debug-msg'), 'debug should be filtered at info level')
    assert.ok(content.includes('info-msg'), 'info should pass at info level')
  })

  it('at level info, info/warn/error ARE written', () => {
    initFileLogging({ logDir, level: 'info' })
    const log = createLogger('comp')
    log.info('info-msg')
    log.warn('warn-msg')
    log.error('error-msg')
    closeFileLogging()

    const content = readFileSync(join(logDir, 'chroxy.log'), 'utf8')
    assert.ok(content.includes('info-msg'))
    assert.ok(content.includes('warn-msg'))
    assert.ok(content.includes('error-msg'))
  })

  it('at level error, only error messages are written', () => {
    initFileLogging({ logDir, level: 'error' })
    const log = createLogger('comp')
    log.debug('debug-msg')
    log.info('info-msg')
    log.warn('warn-msg')
    log.error('error-msg')
    closeFileLogging()

    const content = readFileSync(join(logDir, 'chroxy.log'), 'utf8')
    assert.ok(!content.includes('debug-msg'))
    assert.ok(!content.includes('info-msg'))
    assert.ok(!content.includes('warn-msg'))
    assert.ok(content.includes('error-msg'))
  })

  it('at level debug, all messages are written', () => {
    initFileLogging({ logDir, level: 'debug' })
    const log = createLogger('comp')
    log.debug('debug-msg')
    log.info('info-msg')
    log.warn('warn-msg')
    log.error('error-msg')
    closeFileLogging()

    const content = readFileSync(join(logDir, 'chroxy.log'), 'utf8')
    assert.ok(content.includes('debug-msg'))
    assert.ok(content.includes('info-msg'))
    assert.ok(content.includes('warn-msg'))
    assert.ok(content.includes('error-msg'))
  })
})

describe('log rotation', () => {
  let logDir
  let origLog
  let origWarn
  let origError

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'chroxy-log-'))
    // Suppress console output during rotation tests (very noisy)
    origLog = console.log
    origWarn = console.warn
    origError = console.error
    console.log = () => {}
    console.warn = () => {}
    console.error = () => {}
  })

  afterEach(() => {
    console.log = origLog
    console.warn = origWarn
    console.error = origError
    closeFileLogging()
    rmSync(logDir, { recursive: true, force: true })
  })

  it('rotates when file exceeds 5MB', () => {
    initFileLogging({ logDir, level: 'debug' })
    const log = createLogger('test')

    // Write ~6MB of data (each line ~1060 bytes with overhead)
    const bigMessage = 'x'.repeat(1000)
    for (let i = 0; i < 6000; i++) {
      log.info(bigMessage)
    }

    closeFileLogging()

    assert.ok(existsSync(join(logDir, 'chroxy.log')), 'chroxy.log should exist')
    assert.ok(existsSync(join(logDir, 'chroxy.1.log')), 'chroxy.1.log should exist after rotation')
  })

  it('keeps only 3 rotated files', () => {
    initFileLogging({ logDir, level: 'debug' })
    const log = createLogger('test')

    // Write ~25MB to trigger multiple rotations
    const bigMessage = 'x'.repeat(1000)
    for (let i = 0; i < 25000; i++) {
      log.info(bigMessage)
    }

    closeFileLogging()

    assert.ok(existsSync(join(logDir, 'chroxy.log')), 'chroxy.log should exist')
    assert.ok(existsSync(join(logDir, 'chroxy.1.log')), 'chroxy.1.log should exist')
    assert.ok(existsSync(join(logDir, 'chroxy.2.log')), 'chroxy.2.log should exist')
    assert.ok(existsSync(join(logDir, 'chroxy.3.log')), 'chroxy.3.log should exist')
    assert.ok(!existsSync(join(logDir, 'chroxy.4.log')), 'chroxy.4.log should NOT exist')
  })

  it('after rotation, new chroxy.log is created and writable', () => {
    initFileLogging({ logDir, level: 'debug' })
    const log = createLogger('test')

    // Write ~6MB to trigger rotation
    const bigMessage = 'x'.repeat(1000)
    for (let i = 0; i < 6000; i++) {
      log.info(bigMessage)
    }

    // Write a marker after rotation
    log.info('AFTER_ROTATION_MARKER')
    closeFileLogging()

    const content = readFileSync(join(logDir, 'chroxy.log'), 'utf8')
    assert.ok(content.includes('AFTER_ROTATION_MARKER'), 'new log file should contain post-rotation message')
  })
})

describe('console output', () => {
  let logDir

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'chroxy-log-'))
  })

  afterEach(() => {
    closeFileLogging()
    rmSync(logDir, { recursive: true, force: true })
  })

  it('in foreground mode (no initFileLogging), console methods are still called', () => {
    const calls = []
    const origLog = console.log
    const origWarn = console.warn
    const origError = console.error
    console.log = (...args) => calls.push(['log', ...args])
    console.warn = (...args) => calls.push(['warn', ...args])
    console.error = (...args) => calls.push(['error', ...args])

    try {
      const log = createLogger('fg')
      log.info('info-msg')
      log.warn('warn-msg')
      log.error('error-msg')

      assert.ok(calls.some(c => c[0] === 'log' && c[1].includes('info-msg')))
      assert.ok(calls.some(c => c[0] === 'warn' && c[1].includes('warn-msg')))
      assert.ok(calls.some(c => c[0] === 'error' && c[1].includes('error-msg')))
    } finally {
      console.log = origLog
      console.warn = origWarn
      console.error = origError
    }
  })

  it('after initFileLogging, console methods are also called (dual output)', () => {
    const calls = []
    const origLog = console.log
    const origWarn = console.warn
    console.log = (...args) => calls.push(['log', ...args])
    console.warn = (...args) => calls.push(['warn', ...args])

    try {
      initFileLogging({ logDir })
      const log = createLogger('dual')
      log.info('dual-info')
      log.warn('dual-warn')

      // Console was called
      assert.ok(calls.some(c => c[0] === 'log' && c[1].includes('dual-info')))
      assert.ok(calls.some(c => c[0] === 'warn' && c[1].includes('dual-warn')))

      closeFileLogging()

      // File was also written
      const content = readFileSync(join(logDir, 'chroxy.log'), 'utf8')
      assert.ok(content.includes('dual-info'))
      assert.ok(content.includes('dual-warn'))
    } finally {
      console.log = origLog
      console.warn = origWarn
    }
  })
})

describe('setLogLevel (#747)', () => {
  let logDir

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'chroxy-log-'))
  })

  afterEach(() => {
    closeFileLogging()
    rmSync(logDir, { recursive: true, force: true })
  })

  it('is exported as a function', async () => {
    const { setLogLevel } = await import('../src/logger.js')
    assert.equal(typeof setLogLevel, 'function')
  })

  it('changes the minimum log level at runtime', async () => {
    const { setLogLevel } = await import('../src/logger.js')
    initFileLogging({ logDir, level: 'info' })
    const log = createLogger('test')

    // At info level, debug messages should not appear
    log.debug('debug-before')

    // Change to debug level
    setLogLevel('debug')
    log.debug('debug-after')

    closeFileLogging()
    const content = readFileSync(join(logDir, 'chroxy.log'), 'utf8')
    assert.ok(!content.includes('debug-before'), 'debug should be filtered before setLogLevel')
    assert.ok(content.includes('debug-after'), 'debug should pass after setLogLevel to debug')
  })

  it('can raise the level to suppress lower-priority messages', async () => {
    const { setLogLevel } = await import('../src/logger.js')
    initFileLogging({ logDir, level: 'debug' })
    const log = createLogger('test')

    log.info('info-before')

    // Raise to error-only
    setLogLevel('error')
    log.info('info-after')
    log.error('error-after')

    closeFileLogging()
    const content = readFileSync(join(logDir, 'chroxy.log'), 'utf8')
    assert.ok(content.includes('info-before'))
    assert.ok(!content.includes('info-after'), 'info should be filtered at error level')
    assert.ok(content.includes('error-after'))
  })

  it('also affects console output filtering', async () => {
    const { setLogLevel } = await import('../src/logger.js')
    // Don't init file logging — test console-only mode
    closeFileLogging() // reset state

    const calls = []
    const origLog = console.log
    console.log = (...args) => calls.push(args.join(' '))

    try {
      // Default level is info (after closeFileLogging resets)
      const log = createLogger('fg')
      log.debug('should-not-appear')
      assert.ok(!calls.some(c => c.includes('should-not-appear')))

      setLogLevel('debug')
      log.debug('should-appear')
      assert.ok(calls.some(c => c.includes('should-appear')))
    } finally {
      console.log = origLog
      closeFileLogging() // reset
    }
  })
})

describe('logger file write error handling (#746)', () => {
  let logDir

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'chroxy-log-'))
  })

  afterEach(() => {
    closeFileLogging()
    rmSync(logDir, { recursive: true, force: true })
  })

  it('does not throw when file write fails', () => {
    initFileLogging({ logDir })
    const log = createLogger('test')

    // Remove the log directory to cause write failure
    rmSync(logDir, { recursive: true, force: true })

    // This should NOT throw, even though the file cannot be written
    assert.doesNotThrow(() => {
      log.info('this write should fail silently')
    })
  })

  it('still writes to console when file write fails', () => {
    initFileLogging({ logDir })
    const log = createLogger('test')

    // Remove the log directory to cause write failure
    rmSync(logDir, { recursive: true, force: true })

    const calls = []
    const origLog = console.log
    console.log = (...args) => calls.push(args.join(' '))

    try {
      log.info('console-still-works')
      assert.ok(calls.some(c => c.includes('console-still-works')),
        'console output should still work when file write fails')
    } finally {
      console.log = origLog
    }
  })
})
