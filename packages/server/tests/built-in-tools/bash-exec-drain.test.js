import { describe, it, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
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
  it('does not hang when a stream never ends (a backgrounded grandchild holds the pipe)', { timeout: 5_000 }, async () => {
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
    const started = Date.now()
    const r = await executeBash({ command: 'ignored', timeoutMs: 30_000 })
    const elapsed = Date.now() - started
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout, 'before exit\n')
    assert.ok(elapsed >= STDIO_DRAIN_GRACE_MS - 20, `waited the drain grace (${elapsed}ms)`)
    assert.ok(elapsed < STDIO_DRAIN_GRACE_MS + 1_000, `bounded by the drain grace, not the ${30_000}ms timeout (${elapsed}ms)`)
  })
})
