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

const { writeConnectionInfo, readConnectionInfo, readConnectionState, getConnectionInfoPath } = await import('../src/connection-info.js')
const { probePidLiveness } = await import('../src/utils/pid-liveness.js')
const { collectStatus } = await import('../src/cli/status-cmd.js')
const { fetchPairingCode } = await import('../src/cli/pair-code-cmd.js')
const { postPairDiscord } = await import('../src/cli/pair-discord-cmd.js')
const { runPagesListCmd } = await import('../src/cli/pages-cmd.js')
const { runShellListCmd } = await import('../src/cli/shell-cmd.js')
const { runAgentList, runAgentRevoke } = await import('../src/cli/agent-cmd.js')

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
/** The real state reader (`{ info, reason }`), with the probe's `kill` mocked. */
const stateWith = (code) => () => readConnectionState({
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

// `chroxy agent` (cli/agent-cmd.js) resolves the daemon through agent-control's
// resolveLocalConnection. A liveness_unverified refusal must reach the user as that
// reason, and no client may ever be constructed for it (no socket, no auth frame,
// no token). Pure: the resolver and the client class are injected, so no server is
// started and nothing is dialed.
describe('chroxy agent: an unverified record is refused before any client exists (#9074)', () => {
  /** Run `fn` with process.stderr captured (reportConnectFailure writes there directly). */
  async function withStderr(fn) {
    const lines = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s) => { lines.push(String(s)); return true }
    try { return { result: await fn(), lines } } finally { process.stderr.write = original }
  }
  const neverConstructedClient = (counter) => class {
    constructor () { counter.n++; throw new Error('an AgentControlClient must not be constructed') }
  }

  it('list and revoke fail with liveness_unverified, say so, and never construct a client', async () => {
    // Mutation: map every resolver failure to not_running in connectToLocalDaemon ->
    // the reason (and the message) is not_running, and this goes red.
    const counter = { n: 0 }
    const deps = {
      resolveLocalConnection: () => ({ ok: false, reason: 'liveness_unverified' }),
      AgentControlClient: neverConstructedClient(counter),
      out: () => {},
      err: () => {},
    }
    const { result: results, lines } = await withStderr(async () => [
      await runAgentList({}, deps),
      await runAgentRevoke('some-label', {}, deps),
    ])
    for (const r of results) {
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'liveness_unverified')
    }
    assert.equal(counter.n, 0, 'no client was constructed, so no socket was opened and no token was used')
    assert.equal(lines.filter((l) => /Could not verify that the Chroxy daemon in connection\.json is running/.test(l)).length, 2)
    assert.equal(lines.some((l) => /not running\. Start it/.test(l)), false, 'not reported as "not running"')
  })

  it('positive control: not_running is still reported as not running, also without a client', async () => {
    const counter = { n: 0 }
    const deps = {
      resolveLocalConnection: () => ({ ok: false, reason: 'not_running' }),
      AgentControlClient: neverConstructedClient(counter),
      out: () => {},
      err: () => {},
    }
    const { result, lines } = await withStderr(() => runAgentList({}, deps))
    assert.equal(result.reason, 'not_running')
    assert.equal(counter.n, 0)
    assert.ok(lines.some((l) => /not running\. Start it/.test(l)))
  })
})

// #9229: the CLIs word "could not verify" differently from "not running", through the
// real reader's `{ info, reason }`, and still fail closed. Same mocked probe, same
// temp CONFIG_DIR, recording fetch. The unverified wording is pinned verbatim.
describe('an unverified record is worded as unverified, and still fails closed (#9229)', () => {
  const UNVERIFIED = /Could not verify that the Chroxy daemon in connection\.json is running/
  const NOT_RUNNING = /Chroxy server is not running\. Start it/
  const unverifiedState = stateWith('EPERM')
  const deadState = stateWith('ESRCH')

  const clis = [
    ['pair-code', async (deps, lines) => {
      const r = await fetchPairingCode(deps)
      const { runPairCodeCmd } = await import('../src/cli/pair-code-cmd.js')
      await runPairCodeCmd({}, { ...deps, write: () => {}, writeErr: (l) => lines.push(l) })
      return r
    }],
    ['pair-discord', async (deps, lines) => {
      const r = await postPairDiscord(deps)
      const { runPairDiscordCmd } = await import('../src/cli/pair-discord-cmd.js')
      await runPairDiscordCmd({}, { ...deps, write: () => {}, writeErr: (l) => lines.push(l) })
      return r
    }],
    ['pages list', async (deps, lines) => runPagesListCmd({}, { ...deps, write: () => {}, writeErr: (l) => lines.push(l) })],
    ['shell list', async (deps, lines) => runShellListCmd({}, { ...deps, readShellApprovalInfo: () => ({ port: 47124 }), out: () => {}, err: (l) => lines.push(l) })],
  ]

  for (const [name, run] of clis) {
    it(`${name}: unverified says so, makes no request, keeps the record`, async () => {
      // Mutation: map unverified back to not_running (withheldReason) -> NOT_RUNNING is
      // printed and the UNVERIFIED assertion goes red. Mutation: hand out the record when
      // unverified -> calls.length > 0 goes red.
      const { fetchFn, calls } = recordingFetch()
      const lines = []
      const result = await run({ readConnectionState: unverifiedState, fetchFn }, lines)
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'liveness_unverified')
      assert.equal(calls.length, 0, 'no request, so the bearer was never sent')
      assert.ok(lines.some((l) => UNVERIFIED.test(l)), `unverified wording printed: ${lines.join(' | ')}`)
      assert.equal(lines.some((l) => NOT_RUNNING.test(l)), false)
      assert.ok(existsSync(getConnectionInfoPath()), 'the record file is untouched')
    })
  }

  it('control: a dead pid is still "not running" (and its record is still removed)', async () => {
    const { fetchFn, calls } = recordingFetch()
    const lines = []
    const result = await runPagesListCmd({}, { readConnectionState: deadState, fetchFn, write: () => {}, writeErr: (l) => lines.push(l) })
    assert.equal(result.reason, 'not_running')
    assert.equal(calls.length, 0)
    assert.ok(lines.some((l) => NOT_RUNNING.test(l)))
    assert.equal(existsSync(getConnectionInfoPath()), false, 'ESRCH cleanup unchanged')
  })

  it('control: no record at all is "not running"', async () => {
    rmSync(getConnectionInfoPath(), { force: true })
    const { fetchFn, calls } = recordingFetch()
    const result = await fetchPairingCode({ readConnectionState: unverifiedState, fetchFn })
    assert.equal(result.reason, 'not_running')
    assert.equal(calls.length, 0)
  })

  it('a state that claims a record but not "alive" is withheld (fail closed)', async () => {
    const { fetchFn, calls } = recordingFetch()
    const result = await fetchPairingCode({
      readConnectionState: () => ({ info: { pid: 1, apiToken: TOKEN, port: 47123 }, reason: 'liveness_unverified' }),
      fetchFn,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'liveness_unverified')
    assert.equal(calls.length, 0)
  })

  it('positive control: a verified-alive state reaches fetch with the bearer', async () => {
    const { fetchFn, calls } = recordingFetch()
    await fetchPairingCode({ readConnectionState: stateWith(null), fetchFn })
    assert.equal(sentBearer(calls), true)
  })

  it('status: not running + unverified is reported as could-not-verify, JSON and human, with no request at all', async () => {
    // Mutation: drop the unverified branch in printHuman -> "Not running" is printed.
    const { runStatusCmd } = await import('../src/cli/status-cmd.js')
    const calls = []
    const downFetch = async (url, init = {}) => { calls.push({ url: String(url), headers: { ...(init.headers || {}) } }); throw new Error('unreachable') }
    const humanOut = []
    const status = await runStatusCmd({}, { readConnectionState: unverifiedState, fetchFn: downFetch, write: (s) => humanOut.push(s), defaultPort: 47999 })
    assert.equal(status.running, false)
    assert.equal(status.livenessUnverified, true)
    assert.equal(status.connectionReason, 'liveness_unverified')
    assert.ok(UNVERIFIED.test(humanOut.join('\n')))
    assert.ok(/Could not verify/.test(humanOut.join('\n')))
    assert.equal(/Status:\s+Not running/.test(humanOut.join('\n')), false)
    const jsonOut = []
    await runStatusCmd({ json: true }, { readConnectionState: unverifiedState, fetchFn: downFetch, write: (s) => jsonOut.push(s), defaultPort: 47999 })
    assert.equal(JSON.parse(jsonOut[0]).livenessUnverified, true)
    assert.equal(sentBearer(calls), false, 'no request carried a bearer')
    assert.equal(calls.some((c) => c.url.includes('/metrics')), false)
    assert.ok(existsSync(getConnectionInfoPath()))
  })

  it('status: a healthy ping + an unverified record says Running AND that the record is unverified, with no bearer', async () => {
    // Mutation: drop the note printed under "Running" -> the note assertion goes red.
    const { runStatusCmd } = await import('../src/cli/status-cmd.js')
    const { fetchFn, calls } = recordingFetch()
    const humanOut = []
    const status = await runStatusCmd({}, { readConnectionState: unverifiedState, fetchFn, write: (s) => humanOut.push(s), defaultPort: 47999 })
    const text = humanOut.join('\n')
    assert.equal(status.running, true)
    assert.equal(status.livenessUnverified, true)
    assert.ok(/Status:\s+Running/.test(text))
    assert.ok(/connection record could not be verified; its token was not used, so metrics are unavailable/.test(text), text)
    assert.equal(sentBearer(calls), false, 'no request carried a bearer')
    assert.equal(calls.some((c) => c.url.includes('/metrics')), false)
    assert.equal(status.sessions, null)
    const jsonOut = []
    await runStatusCmd({ json: true }, { readConnectionState: unverifiedState, fetchFn, write: (s) => jsonOut.push(s), defaultPort: 47999 })
    const parsed = JSON.parse(jsonOut[0])
    assert.equal(parsed.livenessUnverified, true)
    assert.equal(parsed.connectionReason, 'liveness_unverified')
    assert.ok(existsSync(getConnectionInfoPath()))
  })

  for (const [label, state] of [['missing', { info: null }], ['unknown', { info: null, reason: 'some_future_reason' }]]) {
    it(`a ${label} reason is worded as "could not verify", never "not running", and carries the raw reason`, async () => {
      // Mutation: withheldReason collapses everything but liveness_unverified to not_running.
      const { fetchFn, calls } = recordingFetch()
      const result = await fetchPairingCode({ readConnectionState: () => state, fetchFn })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'liveness_unverified')
      assert.equal(result.connectionReason, state.reason ?? null)
      assert.equal(calls.length, 0)
    })
  }

  it('control: no_record and dead carry their raw reason and read as not running', async () => {
    const { fetchFn } = recordingFetch()
    for (const reason of ['no_record', 'dead']) {
      const result = await fetchPairingCode({ readConnectionState: () => ({ info: null, reason }), fetchFn })
      assert.equal(result.reason, 'not_running')
      assert.equal(result.connectionReason, reason)
    }
  })

  it('status control: a dead pid reads "Not running", not unverified', async () => {
    writeConnectionInfo({ pid: 4242, port: 47123, apiToken: TOKEN })
    const { runStatusCmd } = await import('../src/cli/status-cmd.js')
    const out = []
    const status = await runStatusCmd({}, { readConnectionState: deadState, fetchFn: async () => { throw new Error('x') }, write: (s) => out.push(s), defaultPort: 47999 })
    assert.equal(status.livenessUnverified, false)
    assert.ok(/Status:\s+Not running/.test(out.join('\n')))
  })
})

describe('chroxy agent reports each resolver reason accurately (#9229)', () => {
  async function withStderr(fn) {
    const lines = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = (s) => { lines.push(String(s)); return true }
    try { return { result: await fn(), lines } } finally { process.stderr.write = original }
  }
  const cases = [
    ['not_running', /Chroxy server is not running\. Start it/],
    ['liveness_unverified', /Could not verify that the Chroxy daemon in connection\.json is running/],
    // any reason the resolver may grow is reported as itself, never as "not running"
    ['some_future_reason', /Could not reach the daemon: some_future_reason/],
  ]
  for (const [reason, pattern] of cases) {
    it(`${reason}: reported as itself, no client constructed`, async () => {
      let constructed = 0
      const deps = {
        resolveLocalConnection: () => ({ ok: false, reason }),
        AgentControlClient: class { constructor () { constructed++ } },
        out: () => {},
        err: () => {},
      }
      const { result, lines } = await withStderr(() => runAgentList({}, deps))
      assert.equal(result.ok, false)
      assert.equal(result.reason, reason)
      assert.equal(constructed, 0)
      assert.ok(lines.some((l) => pattern.test(l)), lines.join(' | '))
      if (reason !== 'not_running') assert.equal(lines.some((l) => /is not running\. Start it/.test(l)), false)
    })
  }

  it('end to end through the real resolver: an EPERM record gives liveness_unverified, not not_running', async () => {
    const { resolveLocalConnection, readConnectionInfoNonMutating } = await import('../src/agent-control/local-connection.js')
    writeConnectionInfo({ pid: 4242, port: 47123, apiToken: TOKEN })
    let constructed = 0
    const deps = {
      resolveLocalConnection: () => resolveLocalConnection({
        readConnectionInfo: () => readConnectionInfoNonMutating({ probePidLiveness: (pid) => probePidLiveness(pid, { kill: () => { throw errno('EPERM') } }) }),
      }),
      AgentControlClient: class { constructor () { constructed++ } },
      out: () => {},
      err: () => {},
    }
    const { result } = await withStderr(() => runAgentList({}, deps))
    assert.equal(result.reason, 'liveness_unverified')
    assert.equal(constructed, 0)
    assert.ok(existsSync(getConnectionInfoPath()))
  })
})
