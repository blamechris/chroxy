import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { waitForTunnel } from '../src/tunnel-check.js'

/**
 * Logging-specific tests for waitForTunnel (#2206)
 *
 * Verifies that each verification attempt is logged with attempt number,
 * success is logged, and final "giving up" includes total attempts.
 */

afterEach(() => {
  mock.restoreAll()
})

describe('waitForTunnel logging', () => {
  it('logs each failed attempt with attempt number and failure reason', async () => {
    const logs = []
    mock.method(console, 'log', (msg) => logs.push(msg))
    mock.method(globalThis, 'fetch', async () => { throw new Error('ECONNREFUSED') })

    await waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 3, interval: 0 })

    const attemptLogs = logs.filter((l) => l.includes('Attempt'))
    assert.equal(attemptLogs.length, 3)
    assert.ok(attemptLogs[0].includes('Attempt 1/3'))
    assert.ok(attemptLogs[0].includes('ECONNREFUSED'))
    assert.ok(attemptLogs[1].includes('Attempt 2/3'))
    assert.ok(attemptLogs[2].includes('Attempt 3/3'))
  })

  it('logs HTTP status code for non-ok responses', async () => {
    const logs = []
    mock.method(console, 'log', (msg) => logs.push(msg))
    mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 502 }))

    await waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 2, interval: 0 })

    const attemptLogs = logs.filter((l) => l.includes('Attempt'))
    assert.equal(attemptLogs.length, 2)
    assert.ok(attemptLogs[0].includes('HTTP 502'))
  })

  it('logs success with attempt number on verification pass', async () => {
    const logs = []
    mock.method(console, 'log', (msg) => logs.push(msg))
    let calls = 0
    mock.method(globalThis, 'fetch', async () => {
      calls++
      if (calls <= 1) throw new Error('ECONNREFUSED')
      return { ok: true }
    })

    await waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 5, interval: 0 })

    const successLog = logs.find((l) => l.includes('Tunnel verified'))
    assert.ok(successLog, 'should log verification success')
    assert.ok(successLog.includes('attempt 2/5'))
  })

  it('logs total attempts in final "giving up" message', async () => {
    const logs = []
    mock.method(console, 'log', (msg) => logs.push(msg))
    mock.method(globalThis, 'fetch', async () => { throw new Error('Network error') })

    await waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 4, interval: 0 })

    const finalLog = logs[logs.length - 1]
    assert.ok(finalLog.includes('4 attempts'), `expected "4 attempts" in: ${finalLog}`)
    assert.ok(finalLog.includes('proceeding anyway'))
  })

  it('logs success on first attempt without prior failure logs', async () => {
    const logs = []
    mock.method(console, 'log', (msg) => logs.push(msg))
    mock.method(globalThis, 'fetch', async () => ({ ok: true }))

    await waitForTunnel('https://example.trycloudflare.com', { maxAttempts: 3, interval: 0 })

    const failureLogs = logs.filter((l) => l.includes('failed'))
    assert.equal(failureLogs.length, 0, 'no failure logs expected')
    const successLog = logs.find((l) => l.includes('Tunnel verified'))
    assert.ok(successLog)
    assert.ok(successLog.includes('attempt 1/3'))
  })
})
