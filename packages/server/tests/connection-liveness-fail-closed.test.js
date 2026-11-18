/**
 * #9074: a discovery record whose pid liveness could NOT be verified (EPERM under a
 * sandbox) must not be treated as a healthy daemon. Its primary bearer is never sent,
 * and the record is never deleted. The real `readConnectionInfo` reads a temp
 * CHROXY_CONFIG_DIR, and the pid probe is MOCKED (an injected `kill` that throws
 * EPERM). No real process is probed, no live config is read, and every `fetch` is a
 * recording fake.
 */
import { describe, it, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const originalConfigDir = process.env.CHROXY_CONFIG_DIR
const testDir = mkdtempSync(join(tmpdir(), 'chroxy-liveness-fail-closed-'))
process.env.CHROXY_CONFIG_DIR = testDir

const { writeConnectionInfo, readConnectionInfo, getConnectionInfoPath } = await import('../src/connection-info.js')
const { probePidLiveness } = await import('../src/utils/pid-liveness.js')
const { collectStatus } = await import('../src/cli/status-cmd.js')
const { fetchPairingCode } = await import('../src/cli/pair-code-cmd.js')
const { postPairDiscord } = await import('../src/cli/pair-discord-cmd.js')
const { runPagesListCmd } = await import('../src/cli/pages-cmd.js')
const { runShellListCmd } = await import('../src/cli/shell-cmd.js')

after(() => {
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* gone */ }
  if (originalConfigDir !== undefined) process.env.CHROXY_CONFIG_DIR = originalConfigDir
  else delete process.env.CHROXY_CONFIG_DIR
})

const TOKEN = 'primary-bearer-that-must-not-be-sent'
const errno = (code) => Object.assign(new Error(code), { code })
/** The real reader, with the pid probe's `kill` mocked to fail with `code`. */
const readerWith = (code) => () => readConnectionInfo({
  probePidLiveness: (pid) => probePidLiveness(pid, { kill: () => { if (code) throw errno(code) } }),
})
const unverifiedReader = readerWith('EPERM')
const aliveReader = readerWith(null)

/** A recording fetch: answers 200 JSON to everything and remembers url + headers. */
function recordingFetch() {
  const calls = []
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), headers: { ...(init.headers || {}) } })
    return { ok: true, status: 200, json: async () => ({ status: 'ok', version: '0.0.0-test', mode: 'cli', sessions: { active: 1 }, code: 'ABC', posted: true, pages: [], shells: [] }) }
  }
  return { fetchFn, calls }
}
const sentBearer = (calls) => calls.some((c) => Object.keys(c.headers).some((h) => h.toLowerCase() === 'authorization'))

beforeEach(() => {
  writeConnectionInfo({ pid: 4242, port: 47123, httpUrl: 'http://127.0.0.1:47123/', wsUrl: 'ws://127.0.0.1:47123', apiToken: TOKEN })
})

describe('an unverified record fails closed (#9074)', () => {
  it('status: a healthy /health with an unverified pid sends no Authorization and never calls /metrics', async () => {
    // Mutation: classify EPERM as alive -> status reads the record and calls the
    // authenticated /metrics with the bearer, and this goes red.
    const { fetchFn, calls } = recordingFetch()
    const status = await collectStatus({ readConnectionInfo: unverifiedReader, fetchFn, defaultPort: 47999 })
    assert.equal(status.running, true, 'the unauthenticated health ping still decides running')
    assert.equal(sentBearer(calls), false, 'no request carried the primary bearer')
    assert.equal(calls.some((c) => c.url.includes('/metrics')), false, '/metrics (authenticated) was not called')
    assert.equal(calls.every((c) => c.url.startsWith('http://127.0.0.1:')), true)
    assert.equal(status.pid, null, 'an unverified pid is not reported as the daemon pid')
    assert.ok(existsSync(getConnectionInfoPath()), 'the record is kept')
  })

  it('status positive control: a verified-alive pid does use the bearer for /metrics', async () => {
    const { fetchFn, calls } = recordingFetch()
    await collectStatus({ readConnectionInfo: aliveReader, fetchFn, defaultPort: 47999 })
    assert.equal(calls.some((c) => c.url.includes('/metrics')), true)
    assert.equal(sentBearer(calls), true, 'the test can see a bearer when one is sent')
  })

  for (const [name, run] of [
    ['pair-code', (deps) => fetchPairingCode(deps)],
    ['pair-discord', (deps) => postPairDiscord(deps)],
    ['pages list', (deps) => runPagesListCmd({}, { ...deps, write: () => {}, writeErr: () => {} })],
    ['shell list', (deps) => runShellListCmd({}, { ...deps, readShellApprovalInfo: () => ({ port: 47124 }), out: () => {}, err: () => {} })],
  ]) {
    it(`${name}: an unverified record never reaches fetch, so the bearer is never sent`, async () => {
      // Mutation: classify EPERM as alive -> fetch is called with the bearer.
      const { fetchFn, calls } = recordingFetch()
      await run({ readConnectionInfo: unverifiedReader, fetchFn })
      assert.equal(calls.length, 0, `${name} made no request`)
      assert.ok(existsSync(getConnectionInfoPath()), 'the record is kept')
    })

    it(`${name} positive control: a verified-alive record does reach fetch with the bearer`, async () => {
      const { fetchFn, calls } = recordingFetch()
      await run({ readConnectionInfo: aliveReader, fetchFn })
      assert.ok(calls.length > 0, `${name} made a request`)
      assert.equal(sentBearer(calls), true)
    })
  }
})
