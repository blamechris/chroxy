import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { logEnvironmentManagerReconnectResult } from '../src/server-cli.js'

/**
 * Issue #3464 — aggregate warn when EnvironmentManager.reconnect() returns false.
 *
 * Background: PR #3462 made `EnvironmentManager.reconnect()` return
 * `Promise<boolean>` so callers can detect the unreachable-environment case.
 * The single existing caller in `server-cli.js` discarded that flag, so the
 * only signal was a buried per-env `warn` log. This helper centralises the
 * boot-path log so that:
 *   - the all-healthy path emits exactly the existing `info` summary
 *   - the partially-unhealthy path additionally emits an aggregate `warn`
 *     summarising the count of unreachable environments
 */
describe('logEnvironmentManagerReconnectResult (#3464)', () => {
  function makeManager({ allHealthy, environments }) {
    return {
      reconnect: async () => allHealthy,
      list: () => environments,
    }
  }

  function captureLogger() {
    const calls = []
    return {
      info: (msg) => calls.push({ level: 'info', msg }),
      warn: (msg) => calls.push({ level: 'warn', msg }),
      error: (msg) => calls.push({ level: 'error', msg }),
      debug: (msg) => calls.push({ level: 'debug', msg }),
      calls,
    }
  }

  it('logs only the info summary when reconnect resolves true (all healthy)', async () => {
    const logger = captureLogger()
    const manager = makeManager({
      allHealthy: true,
      environments: [
        { id: 'a', name: 'a', status: 'running' },
        { id: 'b', name: 'b', status: 'running' },
      ],
    })

    await logEnvironmentManagerReconnectResult(manager, logger)

    assert.equal(logger.calls.length, 1)
    assert.equal(logger.calls[0].level, 'info')
    assert.match(logger.calls[0].msg, /EnvironmentManager ready \(2 environment\(s\)\)/)
  })

  it('logs the info summary even when zero environments are restored', async () => {
    const logger = captureLogger()
    const manager = makeManager({ allHealthy: true, environments: [] })

    await logEnvironmentManagerReconnectResult(manager, logger)

    assert.equal(logger.calls.length, 1)
    assert.equal(logger.calls[0].level, 'info')
    assert.match(logger.calls[0].msg, /EnvironmentManager ready \(0 environment\(s\)\)/)
  })

  it('emits an aggregate warn with the unreachable count when reconnect returns false', async () => {
    const logger = captureLogger()
    const manager = makeManager({
      allHealthy: false,
      environments: [
        { id: 'a', name: 'a', status: 'running' },
        { id: 'b', name: 'b', status: 'error' },
        { id: 'c', name: 'c', status: 'error' },
        { id: 'd', name: 'd', status: 'stopped' },
      ],
    })

    await logEnvironmentManagerReconnectResult(manager, logger)

    // Both the existing info summary and the new aggregate warn fire.
    const infoCalls = logger.calls.filter(c => c.level === 'info')
    const warnCalls = logger.calls.filter(c => c.level === 'warn')

    assert.equal(infoCalls.length, 1)
    assert.match(infoCalls[0].msg, /EnvironmentManager ready \(4 environment\(s\)\)/)

    assert.equal(warnCalls.length, 1)
    // The warn surfaces the count of unreachable envs (status in
    // UNREACHABLE_STATUSES — i.e. 'error' or 'stopped'). Per the #3492
    // invariant, every reconnect() branch that flips allHealthy=false also
    // sets env.status to one of those values, so this count is authoritative.
    assert.match(warnCalls[0].msg, /3 environment\(s\) unreachable/)
  })

  it('counts both error and stopped statuses as unreachable (#3492)', async () => {
    // After PR #3491 the `getEnvironmentStatus` returning false branch sets
    // `env.status = 'stopped'` (not 'error') while flipping allHealthy=false.
    // The aggregate warn must include 'stopped' in its count, otherwise a
    // stopped-only failure surfaces as "0 environment(s) unreachable".
    const logger = captureLogger()
    const manager = makeManager({
      allHealthy: false,
      environments: [
        { id: 'a', name: 'a', status: 'stopped' },
        { id: 'b', name: 'b', status: 'stopped' },
      ],
    })

    await logEnvironmentManagerReconnectResult(manager, logger)

    const warnCalls = logger.calls.filter(c => c.level === 'warn')
    assert.equal(warnCalls.length, 1)
    assert.match(warnCalls[0].msg, /2 environment\(s\) unreachable/)
  })

  it('does not double-log a warn when reconnect resolves true', async () => {
    const logger = captureLogger()
    const manager = makeManager({
      allHealthy: true,
      // Even if a stale 'error' status sneaks in, allHealthy=true is the
      // authoritative signal — we trust the manager's contract rather than
      // re-deriving health from the list.
      environments: [{ id: 'a', name: 'a', status: 'error' }],
    })

    await logEnvironmentManagerReconnectResult(manager, logger)

    assert.equal(logger.calls.filter(c => c.level === 'warn').length, 0)
  })
})
