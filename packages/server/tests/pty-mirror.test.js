import { describe, it, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * PtyMirror tests — exercises the class API deterministically.
 * Uses _setPtyForTest() to simulate both node-pty available and unavailable paths.
 */

describe('PtyMirror', () => {
  let PtyMirror
  let originalAvailable

  before(async () => {
    const mod = await import('../src/pty-mirror.js')
    PtyMirror = mod.PtyMirror
    originalAvailable = PtyMirror.available
  })

  afterEach(() => {
    // Restore original pty state
    if (originalAvailable) {
      // Restore real node-pty — we need a truthy value; the real module was loaded at import
      // Re-import is not possible, so we use a sentinel to mark "restore"
      // The simplest approach: if it was originally available, set a mock that makes .available true
      PtyMirror._setPtyForTest({ spawn: () => { throw new Error('mock') } })
    } else {
      PtyMirror._setPtyForTest(null)
    }
  })

  it('exports PtyMirror class', () => {
    assert.ok(PtyMirror)
    assert.equal(typeof PtyMirror, 'function')
  })

  it('has static available property', () => {
    assert.equal(typeof PtyMirror.available, 'boolean')
  })

  it('creates instance with default options', () => {
    const mirror = new PtyMirror({})
    assert.equal(mirror.alive, false)
    assert.equal(mirror.pid, null)
    assert.deepEqual(mirror.dimensions, { cols: 120, rows: 40 })
  })

  it('creates instance with custom options', () => {
    const mirror = new PtyMirror({ cols: 80, rows: 24, cwd: '/tmp' })
    assert.deepEqual(mirror.dimensions, { cols: 80, rows: 24 })
  })

  it('refuses to spawn after destroy', () => {
    const mirror = new PtyMirror({})
    mirror.destroy()
    const errors = []
    mirror.on('error', (e) => errors.push(e))
    const result = mirror.spawn()
    assert.equal(result, false)
    assert.ok(errors.some(e => e.message.includes('destroyed')))
  })

  it('destroy is idempotent', () => {
    const mirror = new PtyMirror({})
    mirror.destroy()
    mirror.destroy() // Should not throw
    assert.equal(mirror.alive, false)
  })

  it('write is a no-op when not spawned', () => {
    const mirror = new PtyMirror({})
    mirror.write('test')
    assert.equal(mirror.alive, false)
  })

  it('resize is a no-op when not spawned', () => {
    const mirror = new PtyMirror({})
    mirror.resize(80, 24)
    assert.equal(mirror.alive, false)
  })
})

describe('PtyMirror — unavailable path (deterministic)', () => {
  let PtyMirror

  before(async () => {
    const mod = await import('../src/pty-mirror.js')
    PtyMirror = mod.PtyMirror
  })

  afterEach(() => {
    // Restore to a truthy mock so other tests aren't affected
    PtyMirror._setPtyForTest({ spawn: () => { throw new Error('mock') } })
  })

  it('reports unavailable when pty is null', () => {
    PtyMirror._setPtyForTest(null)
    assert.equal(PtyMirror.available, false)
  })

  it('emits error on spawn when pty is null', () => {
    PtyMirror._setPtyForTest(null)
    const mirror = new PtyMirror({})
    const errors = []
    mirror.on('error', (e) => errors.push(e))
    const result = mirror.spawn()
    assert.equal(result, false)
    assert.equal(errors.length, 1)
    assert.ok(errors[0].message.includes('node-pty'))
  })
})

describe('PtyMirror — available path with mock (deterministic)', () => {
  let PtyMirror

  before(async () => {
    const mod = await import('../src/pty-mirror.js')
    PtyMirror = mod.PtyMirror
  })

  afterEach(() => {
    PtyMirror._setPtyForTest({ spawn: () => { throw new Error('mock') } })
  })

  it('reports available when pty is set', () => {
    PtyMirror._setPtyForTest({ spawn: () => {} })
    assert.equal(PtyMirror.available, true)
  })

  /** Create a mock node-pty process (uses onData/onExit callbacks, not EventEmitter) */
  function createMockPtyProcess(pid) {
    let dataCallback = null
    let exitCallback = null
    return {
      pid,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: (cb) => { dataCallback = cb },
      onExit: (cb) => { exitCallback = cb },
      // Test helpers to simulate events
      _emitData: (data) => dataCallback && dataCallback(data),
      _emitExit: (info) => exitCallback && exitCallback(info),
    }
  }

  it('emits spawned event with mock PTY process', () => {
    const mockProcess = createMockPtyProcess(42)

    PtyMirror._setPtyForTest({
      spawn: () => mockProcess,
    })

    const mirror = new PtyMirror({ cwd: '/tmp' })
    const events = []
    mirror.on('spawned', (e) => events.push(e))
    mirror.on('error', (e) => events.push({ error: e }))

    const result = mirror.spawn()
    assert.equal(result, true)
    assert.equal(mirror.alive, true)
    assert.equal(mirror.pid, 42)
    assert.equal(events.length, 1)
    assert.equal(events[0].pid, 42)

    mirror.destroy()
  })

  it('emits data events from mock PTY', () => {
    const mockProcess = createMockPtyProcess(43)

    PtyMirror._setPtyForTest({ spawn: () => mockProcess })

    const mirror = new PtyMirror({ cwd: '/tmp' })
    const dataChunks = []
    mirror.on('data', (d) => dataChunks.push(d))

    mirror.spawn()

    // Simulate PTY output
    mockProcess._emitData('hello world')

    // Data is batched — flush by destroying
    mirror.destroy()

    assert.ok(dataChunks.length >= 1)
    assert.ok(dataChunks.join('').includes('hello'))
  })

  it('emits exit event from mock PTY', () => {
    const mockProcess = createMockPtyProcess(44)

    PtyMirror._setPtyForTest({ spawn: () => mockProcess })

    const mirror = new PtyMirror({ cwd: '/tmp' })
    const exits = []
    mirror.on('exit', (e) => exits.push(e))

    mirror.spawn()
    mockProcess._emitExit({ exitCode: 0, signal: undefined })

    assert.equal(exits.length, 1)
    assert.equal(exits[0].exitCode, 0)
    assert.equal(mirror.alive, false)
  })

  it('refuses to spawn twice', () => {
    const mockProcess = createMockPtyProcess(45)

    PtyMirror._setPtyForTest({ spawn: () => mockProcess })

    const mirror = new PtyMirror({ cwd: '/tmp' })
    const errors = []
    mirror.on('error', (e) => errors.push(e))

    mirror.spawn()
    const result2 = mirror.spawn()
    assert.equal(result2, false)
    assert.ok(errors.some(e => e.message.includes('already spawned')))

    mirror.destroy()
  })
})
