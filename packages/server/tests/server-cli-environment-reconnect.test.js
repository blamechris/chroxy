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
    // The warn must surface the count of unreachable (status === 'error') envs.
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
