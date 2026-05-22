import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { executeBash } from '../../src/built-in-tools/bash-exec.js'

/**
 * Tests for built-in-tools/bash-exec.js — basic exec, timeout, abort,
 * output cap, exit code reporting. Pulled into its own file because
 * other built-in tools (Glob, Grep) shell out via this helper.
 */

describe('executeBash', () => {
  it('captures stdout from a simple command', async () => {
    const r = await executeBash({ command: 'echo hello world' })
    assert.equal(r.exitCode, 0)
    assert.equal(r.stdout.trim(), 'hello world')
    assert.equal(r.stderr, '')
    assert.equal(r.timedOut, false)
    assert.equal(r.aborted, false)
  })

  it('captures stderr separately from stdout', async () => {
    const r = await executeBash({ command: 'echo out; echo err >&2' })
    assert.match(r.stdout, /out/)
    assert.match(r.stderr, /err/)
  })

  it('reports non-zero exit code', async () => {
    const r = await executeBash({ command: 'exit 42' })
    assert.equal(r.exitCode, 42)
    assert.equal(r.timedOut, false)
  })

  it('honors cwd', async () => {
    const r = await executeBash({ command: 'pwd', cwd: '/tmp' })
    // macOS realpaths /tmp → /private/tmp; both are acceptable. Just
    // assert the result is one of them.
    assert.ok(['/tmp', '/private/tmp'].includes(r.stdout.trim()),
      `expected /tmp or /private/tmp, got: ${r.stdout.trim()}`)
  })

  it('times out and kills a long-running process', async () => {
    const r = await executeBash({ command: 'sleep 5', timeoutMs: 200 })
    assert.equal(r.timedOut, true)
    // The process should be killed before completing. exitCode may be
    // null (signal kill) or non-zero. Just assert duration is well
    // below the sleep target.
    assert.ok(r.durationMs < 4000, `expected fast kill, got ${r.durationMs}ms`)
  })

  it('aborts via AbortSignal', async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    const r = await executeBash({ command: 'sleep 5', signal: ctrl.signal, timeoutMs: 30_000 })
    assert.equal(r.aborted, true)
    assert.ok(r.durationMs < 3000, `expected fast abort kill, got ${r.durationMs}ms`)
  })

  it('caps output bytes and marks truncated', async () => {
    // Generate ~2KB of output; cap at 100B. Should truncate.
    const r = await executeBash({
      command: 'yes A | head -c 2048',
      maxOutputBytes: 100,
      timeoutMs: 5000,
    })
    assert.equal(r.truncated, true)
    assert.ok(r.stdout.length <= 100, `expected output <=100B, got ${r.stdout.length}`)
  })

  it('rejects empty command', async () => {
    await assert.rejects(() => executeBash({ command: '' }), /non-empty string/)
    await assert.rejects(() => executeBash({ command: null }), /non-empty string/)
  })

  it('rejects non-positive timeout', async () => {
    await assert.rejects(() => executeBash({ command: 'echo x', timeoutMs: 0 }), /positive number/)
    await assert.rejects(() => executeBash({ command: 'echo x', timeoutMs: -5 }), /positive number/)
  })

  it('does NOT send SIGKILL when child exits cleanly during the SIGTERM grace window (#4067)', async () => {
    // Set a fast 200ms timeout so SIGTERM fires soon after start. The
    // child script installs a SIGTERM handler that exits 0 cleanly. The
    // pre-fix guard (`!child.killed`) is always false after we called
    // child.kill('SIGTERM'), so SIGKILL would always fire after the 2s
    // grace. With the fixed guard checking actual liveness via
    // exitCode/signalCode, SIGKILL must NOT escalate.
    //
    // Note: the trap must propagate through `bash -c`. Use double quotes
    // for the trap argument so the outer single quotes don't collide.
    const r = await executeBash({
      command: `bash -c 'trap "exit 0" TERM; while true; do sleep 0.1; done'`,
      timeoutMs: 200,
    })
    assert.equal(r.timedOut, true, 'timeout MUST fire (precondition for this test)')
    // Clean exit under SIGTERM: node reports exitCode === 0 because the
    // trap explicitly `exit 0`'d. If the SIGKILL had escalated, the
    // signal would be 'SIGKILL' and exitCode null. The fix guarantees
    // we observe the clean exit instead.
    assert.equal(r.exitCode, 0,
      `expected exitCode=0 (clean exit under SIGTERM trap), got exitCode=${r.exitCode} signal=${r.signal} — guard regressed to !child.killed?`)
    assert.notEqual(r.signal, 'SIGKILL', 'SIGKILL must not escalate when child exits cleanly under SIGTERM')
  })
})
