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

  it('SIGKILL DOES escalate when the child ignores SIGTERM past the grace window (#4067)', { timeout: 10_000 }, async () => {
    // Walk through the pre-fix behavior to see why this is the right
    // test: at t=200ms timeoutHandle fires → killChild('SIGTERM') sets
    // `child.killed = true` (node sets this on any signal send). At
    // t=2200ms hardKillTimer fires. Pre-fix guard:
    //   if (!child.killed && child.exitCode === null) child.kill('SIGKILL')
    // `!child.killed` is now `false` (we just signalled), so SIGKILL is
    // NEVER sent. With a SIGTERM-ignoring child, the await on exit
    // would hang forever. Post-fix guard:
    //   if (child.exitCode === null && child.signalCode === null) ...
    // correctly tests liveness; SIGKILL fires and the child dies.
    //
    // `trap "" TERM` silently ignores SIGTERM. The test sets a 10s test
    // timeout to fail loudly (rather than hang) if the regression
    // re-appears.
    const t0 = Date.now()
    const r = await executeBash({
      command: `bash -c 'trap "" TERM; while true; do sleep 0.5; done'`,
      timeoutMs: 200,
    })
    const elapsed = Date.now() - t0
    assert.equal(r.timedOut, true, 'timeout MUST fire (precondition for this test)')
    // SIGKILL was the killing signal — proves the guard fired.
    assert.equal(r.signal, 'SIGKILL',
      `expected signal=SIGKILL after 2s grace, got signal=${r.signal} exitCode=${r.exitCode} — guard regressed?`)
    // And it took at least HARD_KILL_GRACE_MS (2s) to escalate.
    assert.ok(elapsed >= 2000,
      `SIGKILL must wait HARD_KILL_GRACE_MS=2000ms, escalated after only ${elapsed}ms`)
  })
})
