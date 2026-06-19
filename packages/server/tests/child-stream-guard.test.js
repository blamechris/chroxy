import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { guardChildStreams } from '../src/child-stream-guard.js'

/**
 * Unit coverage for the shared child stdout/stderr EPIPE guard (#5324/#5361).
 * A stream 'error' with no listener crashes the whole daemon; this guard must
 * attach a swallowing handler to both streams, respect the `destroying` getter,
 * and never throw inside its own error path.
 */

function makeChild() {
  const child = {}
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

function makeLog() {
  const warnings = []
  return { warnings, warn: (m) => warnings.push(m) }
}

describe('guardChildStreams', () => {
  it('swallows + logs a stream error on both stdout and stderr (no throw)', () => {
    const child = makeChild()
    const log = makeLog()
    guardChildStreams(child, { destroying: () => false, log, label: 'sess-1' })
    assert.doesNotThrow(() => child.stdout.emit('error', new Error('EPIPE')))
    assert.doesNotThrow(() => child.stderr.emit('error', new Error('read fault')))
    assert.equal(log.warnings.length, 2)
    assert.match(log.warnings[0], /\[sess-1\] stdout stream error \(ignored\): EPIPE/)
    assert.match(log.warnings[1], /\[sess-1\] stderr stream error \(ignored\): read fault/)
  })

  it('stays silent while the session is destroying (expected teardown)', () => {
    const child = makeChild()
    const log = makeLog()
    let destroying = false
    guardChildStreams(child, { destroying: () => destroying, log })
    destroying = true
    child.stdout.emit('error', new Error('EPIPE'))
    assert.equal(log.warnings.length, 0)
  })

  it('reads the destroying getter lazily on each error (not captured at attach time)', () => {
    const child = makeChild()
    const log = makeLog()
    let destroying = false
    guardChildStreams(child, { destroying: () => destroying, log })
    child.stdout.emit('error', new Error('first'))   // logged
    destroying = true
    child.stdout.emit('error', new Error('second'))  // suppressed
    assert.equal(log.warnings.length, 1)
    assert.match(log.warnings[0], /first/)
  })

  it('tolerates a child with a missing stream', () => {
    const child = { stdout: new EventEmitter(), stderr: null }
    const log = makeLog()
    assert.doesNotThrow(() => guardChildStreams(child, { destroying: () => false, log }))
    assert.doesNotThrow(() => child.stdout.emit('error', new Error('EPIPE')))
    assert.equal(log.warnings.length, 1)
  })

  it('falls back to a default logger when none is passed (never TypeErrors in its own handler)', () => {
    const child = makeChild()
    assert.doesNotThrow(() => guardChildStreams(child, { destroying: () => false }))
    assert.doesNotThrow(() => child.stdout.emit('error', new Error('EPIPE')))
  })

  it('omitting opts entirely does not throw (defensive default arg)', () => {
    const child = makeChild()
    assert.doesNotThrow(() => guardChildStreams(child))
  })
})
