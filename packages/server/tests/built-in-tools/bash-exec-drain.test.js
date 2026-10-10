import { describe, it, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { recordTimerArms } from '../test-helpers.js'
import * as realChildProcess from 'node:child_process'

/**
 * #8120 — executeBash used to return as soon as the child's 'exit' event
 * fired. Node can fire 'exit' before the stdio pipes are drained, so a fast
 * command's output could still be in flight and was lost (a BYOK Bash/Grep
 * tool call returned empty stdout; main CI went red on it).
 *
 * A real `bash` cannot be made to reorder those events on demand, so this
 * file module-mocks `node:child_process` with a scripted child. It lives in
 * its own file because mock.module is process-wide.
 */

let makeChild = null
mock.module('node:child_process', {
  namedExports: { ...realChildProcess, spawn: () => makeChild() },
})
const { executeBash, STDIO_DRAIN_GRACE_MS } = await import('../../src/built-in-tools/bash-exec.js')

function scriptedChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.killed = false
  return child
}

const openStreams = []
after(() => {
  for (const s of openStreams) s.destroy()
})

describe('executeBash drains stdio after the child exits (#8120)', () => {
  it("keeps output that arrives after the 'exit' event", async () => {
    makeChild = () => {
      const child = scriptedChild()
      setImmediate(() => {
        child.exitCode = 0
        child.emit('exit', 0, null)
        setImmediate(() => {
          child.stdout.end('late output\n')
          child.stderr.end('late err\n')
        })
      })
      return child
    }
    const r = await executeBash({ command: 'ignored', timeoutMs: 5_000 })
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'late output\n')
    assert.equal(r.stderr, 'late err\n')
  })

  // The explicit timeout turns an unbounded-drain regression into a fast RED
  // instead of a hung run.
  it('does not hang when a stream never ends (a backgrounded grandchild holds the pipe)', { timeout: 15_000 }, async (t) => {
    let child
    makeChild = () => {
      child = scriptedChild()
      openStreams.push(child.stdout, child.stderr)
      setImmediate(() => {
        child.stdout.write('before exit\n')
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
      return child
    }
    // #7041: not a two-sided elapsed window. The drain returns because its grace
    // timer fired; the 30s command timeout was armed but never fired.
    const arms = recordTimerArms(t)
    const r = await executeBash({ command: 'ignored', timeoutMs: 30_000 })
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'before exit\n')
    const grace = arms.filter((a) => a.ms === STDIO_DRAIN_GRACE_MS)
    assert.equal(grace.length, 1, 'the drain arms exactly one grace timer')
    assert.equal(grace[0].fired, true, 'the call was released by the drain grace firing')
    const cmdTimeout = arms.filter((a) => a.ms === 30_000)
    assert.equal(cmdTimeout.length, 1)
    assert.equal(cmdTimeout[0].fired, false, `bounded by the drain grace, not the ${30_000}ms command timeout`)
  })
})
