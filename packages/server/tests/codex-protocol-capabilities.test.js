import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseCodexUserAgent,
  parseSemver,
  compareSemver,
  meetsMinimum,
  capabilitiesForVersion,
  probeMethod,
  CAPABILITY_MIN_VERSIONS,
  CAPABILITY_NAMES,
  CODEX_PROTOCOL_FLOOR,
  UNKNOWN,
} from '../src/codex-protocol-capabilities.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { CodexAppServerClient } from '../src/codex-app-server-client.js'

// #7724 (CDX-1) — the codex app-server version gate. Three invariants, each with
// its own failure-direction proof:
//   1. gate FEATURES, never the connection
//   2. an unparseable userAgent is UNKNOWN (→ probe), never false (→ disabled)
//   3. the probe switches on the error SHAPE, never on a code or on message text

// Real strings. The first is the verbatim `initialize.userAgent` observed from a
// live codex 0.154.0 binary — the only app-server handshake this repo has on record.
const LIVE_0_154 = 'chroxy-probe/0.154.0 (Mac OS 26.6.2; arm64) unknown (chroxy-probe; 0)'

const USER_AGENT_TABLE = [
  { name: 'live 0.154.0 handshake', ua: LIVE_0_154, version: '0.154.0', originator: 'chroxy-probe' },
  { name: 'floor release', ua: 'codex/0.128.0 (Linux 6.8.0; x86_64) unknown (codex_cli_rs; 0)', version: '0.128.0', originator: 'codex' },
  { name: 'below the floor', ua: 'codex/0.100.3 (Mac OS 15.0; arm64) unknown', version: '0.100.3', originator: 'codex' },
  { name: 'alpha prerelease', ua: 'codex/0.155.0-alpha.3 (Mac OS 26.6.2; arm64) unknown (codex_cli_rs; 0)', version: '0.155.0-alpha.3', originator: 'codex' },
  { name: 'build metadata', ua: 'codex/0.160.0+sha.deadbee (Linux 6.8.0; aarch64)', version: '0.160.0+sha.deadbee', originator: 'codex' },
  { name: 'a fork that renamed the originator', ua: 'my-codex-fork/0.154.0 (Windows 11; x86_64)', version: '0.154.0', originator: 'my-codex-fork' },
  // UNPARSEABLE — the leading token carries no version. The platform parens DO
  // carry a dotted-numeric run, so an unanchored scan would report "26.6.2" here.
  { name: 'no version in the leading token', ua: 'unknown (Mac OS 26.6.2; arm64) unknown', version: null, originator: null },
  // UNPARSEABLE, and the trap: the free-form tail carries a SECOND
  // `<name>/<semver>` token. Only the LEADING one describes the binary serving
  // this session, so an unanchored scan reports a version that is not ours.
  { name: 'a name/version token in the free-form tail', ua: 'unknown (Mac OS 26.6.2; arm64) codex_cli_rs/0.128.0', version: null, originator: null },
  { name: 'empty string', ua: '', version: null, originator: null },
  { name: 'not a semver after the slash', ua: 'codex/nightly (Mac OS 26.6.2; arm64)', version: null, originator: null },
  { name: 'two-part version', ua: 'codex/0.154 (Mac OS 26.6.2; arm64)', version: null, originator: null },
]

describe('parseCodexUserAgent (#7724)', () => {
  for (const row of USER_AGENT_TABLE) {
    it(`parses: ${row.name}`, () => {
      const got = parseCodexUserAgent(row.ua)
      assert.equal(got.version, row.version, `version for ${JSON.stringify(row.ua)}`)
      assert.equal(got.originator, row.originator, `originator for ${JSON.stringify(row.ua)}`)
      assert.equal(got.raw, row.ua, 'raw is the input, verbatim')
    })
  }

  it('a non-string userAgent (absent handshake field) is null, not a throw', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      const got = parseCodexUserAgent(bad)
      assert.equal(got.version, null)
      assert.equal(got.raw, null)
    }
  })

  it('never reads a version out of the platform parens', () => {
    // "Mac OS 26.6.2" must not become the version.
    const got = parseCodexUserAgent('unknown (Mac OS 26.6.2; arm64) unknown (chroxy-probe; 0)')
    assert.equal(got.version, null, 'the OS version is not the codex version')
  })

  it('reads ONLY the leading token — a version later in the string is not ours', () => {
    // The anchor's own proof: drop it and each of these reports a version for a
    // handshake that carried none, which is a cannot-check read as a yes.
    for (const ua of [
      'unknown (Mac OS 26.6.2; arm64) codex_cli_rs/0.128.0',
      'unknown (Mac OS 26.6.2; arm64) unknown (chroxy-probe/0.154.0; 0)',
      'nightly (Linux 6.8.0 x86_64) vendored-codex/9.9.9',
    ]) {
      assert.equal(parseCodexUserAgent(ua).version, null, `only the leading token counts: ${ua}`)
    }
  })
})

describe('semver comparison (#7724)', () => {
  it('parses and orders releases', () => {
    assert.equal(compareSemver(parseSemver('0.128.0'), parseSemver('0.128.0')), 0)
    assert.equal(compareSemver(parseSemver('0.127.9'), parseSemver('0.128.0')), -1)
    assert.equal(compareSemver(parseSemver('0.129.0'), parseSemver('0.128.0')), 1)
    assert.equal(compareSemver(parseSemver('1.0.0'), parseSemver('0.999.999')), 1)
  })

  it('a prerelease ranks BELOW its own release and above the previous one', () => {
    assert.equal(compareSemver(parseSemver('0.154.0-alpha.3'), parseSemver('0.154.0')), -1)
    assert.equal(compareSemver(parseSemver('0.155.0-alpha.3'), parseSemver('0.154.0')), 1)
    assert.equal(compareSemver(parseSemver('0.154.0-alpha.3'), parseSemver('0.154.0-alpha.10')), -1, 'numeric identifiers compare numerically, not as strings')
    assert.equal(compareSemver(parseSemver('0.154.0-alpha'), parseSemver('0.154.0-alpha.1')), -1, 'a shorter identifier set ranks lower')
    assert.equal(compareSemver(parseSemver('0.154.0-1'), parseSemver('0.154.0-alpha')), -1, 'numeric ranks below alphanumeric')
  })

  it('build metadata is ignored', () => {
    assert.equal(compareSemver(parseSemver('0.154.0+sha.a'), parseSemver('0.154.0+sha.b')), 0)
  })

  it('meetsMinimum yields UNKNOWN — not false — for anything unparseable', () => {
    for (const bad of [null, undefined, '', 'nightly', '0.154', 42]) {
      assert.equal(meetsMinimum(bad, CODEX_PROTOCOL_FLOOR), UNKNOWN, `${JSON.stringify(bad)} is a cannot-check`)
    }
    assert.notEqual(UNKNOWN, false, 'the sentinel is distinguishable from a no')
  })
})

describe('capabilitiesForVersion (#7724)', () => {
  it('the capability table is non-empty and every minimum is a real semver', () => {
    // Guards the iterating tests below against passing vacuously over 0 rows.
    assert.ok(CAPABILITY_NAMES.length >= 3, `expected several gates, got ${CAPABILITY_NAMES.length}`)
    for (const name of CAPABILITY_NAMES) {
      assert.ok(parseSemver(CAPABILITY_MIN_VERSIONS[name]), `${name} minimum is a semver`)
    }
  })

  it('an UNPARSEABLE version leaves EVERY gate unknown, never false', () => {
    for (const bad of [null, undefined, '', 'nightly', '0.154']) {
      const caps = capabilitiesForVersion(bad)
      assert.deepEqual(Object.keys(caps).sort(), [...CAPABILITY_NAMES].sort(), 'every named gate is present')
      for (const name of CAPABILITY_NAMES) {
        assert.equal(caps[name], UNKNOWN, `${name} for ${JSON.stringify(bad)} must be a cannot-check, not a no`)
      }
    }
  })

  it('a version at the floor has every floor capability', () => {
    const caps = capabilitiesForVersion(CODEX_PROTOCOL_FLOOR)
    for (const name of CAPABILITY_NAMES) {
      if (CAPABILITY_MIN_VERSIONS[name] === CODEX_PROTOCOL_FLOOR) {
        assert.equal(caps[name], true, `${name} exists at the floor`)
      }
    }
  })

  it('a version BELOW the floor is a hard false for every floor capability', () => {
    const caps = capabilitiesForVersion('0.100.3')
    for (const name of CAPABILITY_NAMES) {
      assert.equal(caps[name], false, `${name} is known-absent below the floor`)
    }
  })

  it('supportsMidTurnSettings turns on at 0.154.0, not before', () => {
    assert.equal(CAPABILITY_MIN_VERSIONS.supportsMidTurnSettings, '0.154.0')
    assert.equal(capabilitiesForVersion('0.153.9').supportsMidTurnSettings, false)
    assert.equal(capabilitiesForVersion('0.154.0-alpha.3').supportsMidTurnSettings, false, 'a prerelease of the gating version is below it')
    assert.equal(capabilitiesForVersion('0.154.0').supportsMidTurnSettings, true)
    assert.equal(capabilitiesForVersion(parseCodexUserAgent(LIVE_0_154).version).supportsMidTurnSettings, true, 'the live binary has it')
    assert.equal(capabilitiesForVersion('0.155.0-alpha.3').supportsMidTurnSettings, true, 'an alpha PAST the gate has it')
  })

  it('every other gate is still on at 0.154.0 (a newer binary loses nothing)', () => {
    const caps = capabilitiesForVersion('0.154.0')
    for (const name of CAPABILITY_NAMES) assert.equal(caps[name], true, name)
  })
})

// The caller contract the UNKNOWN sentinel exists for: ONLY an explicit `false`
// skips the runtime probe. This is the shape #7726 will use for model/list.
async function catalogVia(capability, client) {
  if (capability === false) return { probed: false, models: [] }
  const r = await probeMethod(client, 'model/list', {})
  return { probed: true, models: r.supported ? (r.result?.data ?? []) : [] }
}

describe('probeMethod (#7724)', () => {
  const okClient = { request: async () => ({ data: [{ id: 'gpt-6-astra' }], nextCursor: null }) }
  function rejectingClient(error) {
    return { request: async () => { throw error } }
  }
  function jsonRpcErr(code, message) {
    const e = new Error(message)
    e.code = code
    return e
  }

  it('a result is supported:true and carries the result through', async () => {
    const r = await probeMethod(okClient, 'model/list', {})
    assert.equal(r.supported, true)
    assert.equal(r.result.data[0].id, 'gpt-6-astra')
  })

  it('-32600 "unknown variant" and -32601 degrade IDENTICALLY', async () => {
    // The live 0.154.0 binary answers an unknown method with -32600, not -32601.
    const a = await probeMethod(rejectingClient(jsonRpcErr(-32600, 'Invalid request: unknown variant `model/list`, expected one of `initialize`, `thread/start`')), 'model/list', {})
    const b = await probeMethod(rejectingClient(jsonRpcErr(-32601, 'Method not found')), 'model/list', {})
    assert.equal(a.supported, false, '-32600 unknown-variant is a degrade')
    assert.equal(b.supported, false, '-32601 is a degrade')
    assert.equal(a.supported, b.supported, 'the two codes are indistinguishable to the caller')
  })

  it('a differently-WORDED -32601 is still recognised (code and shape, never text)', async () => {
    for (const message of [
      'Method not found',
      'méthode inconnue',
      'the server has no such handler',
      '',
      'model/list is fully supported', // adversarial: the wording says the opposite
    ]) {
      const r = await probeMethod(rejectingClient(jsonRpcErr(-32601, message)), 'model/list', {})
      assert.equal(r.supported, false, `wording must not change the verdict: ${JSON.stringify(message)}`)
    }
  })

  it('ANY error is a degrade — including codes and errors with no code at all', async () => {
    for (const err of [
      jsonRpcErr(-32602, 'Invalid params'),
      jsonRpcErr(-32000, 'server error'),
      jsonRpcErr(0, 'zero'),
      new Error('codex app-server exited (code=1)'), // transport failure, no code
    ]) {
      const r = await probeMethod(rejectingClient(err), 'model/list', {})
      assert.equal(r.supported, false, `degrade on ${err.message}`)
      assert.equal(r.error, err, 'the original error is passed through for logging')
    }
  })

  it('the numeric code is passed through for logging, and is null when absent', async () => {
    assert.equal((await probeMethod(rejectingClient(jsonRpcErr(-32600, 'x')), 'm')).code, -32600)
    assert.equal((await probeMethod(rejectingClient(new Error('boom')), 'm')).code, null)
    assert.equal((await probeMethod(rejectingClient(Object.assign(new Error('boom'), { code: 'ENOENT' })), 'm')).code, null, 'a non-numeric code is not a JSON-RPC code')
  })

  it('a handshake with NO version string still gets a catalog via the probe', async () => {
    // The failure-direction test. If an unparseable userAgent ever resolves to
    // `false` instead of UNKNOWN, this reaches no probe and returns no models.
    const caps = capabilitiesForVersion(parseCodexUserAgent('unknown (Mac OS 26.6.2; arm64) unknown').version)
    const got = await catalogVia(caps.supportsModelList, okClient)
    assert.equal(got.probed, true, 'a cannot-check must fall through to the probe')
    assert.equal(got.models.length, 1, 'and the probe answers with the real catalog')
  })

  it('a KNOWN-absent capability skips the probe entirely', async () => {
    let calls = 0
    const counting = { request: async () => { calls++; return { data: [] } } }
    const caps = capabilitiesForVersion('0.100.3')
    const got = await catalogVia(caps.supportsModelList, counting)
    assert.equal(got.probed, false)
    assert.equal(calls, 0, 'a hard false is not re-litigated at runtime')
  })
})

describe('CodexAppServerClient — JSON-RPC error codes (#7724)', () => {
  it('a rejected request carries the numeric error code', async () => {
    const c = new CodexAppServerClient({})
    c._child = { stdin: { write: () => {} } }
    const p = c.request('model/list', {})
    c._dispatch({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid request: unknown variant `model/list`', data: { hint: 'x' } } })
    const err = await p.then(() => null, (e) => e)
    assert.ok(err instanceof Error)
    assert.equal(err.message, 'Invalid request: unknown variant `model/list`')
    assert.equal(err.code, -32600)
    assert.equal(err.jsonRpcCode, -32600)
    assert.deepEqual(err.data, { hint: 'x' })
  })

  it('an error response with no code still rejects (message preserved)', async () => {
    const c = new CodexAppServerClient({})
    c._child = { stdin: { write: () => {} } }
    const p = c.request('x', {})
    c._dispatch({ jsonrpc: '2.0', id: 1, error: { message: 'boom' } })
    const err = await p.then(() => null, (e) => e)
    assert.equal(err.message, 'boom')
    assert.equal(err.code, undefined)
  })
})

// ---------------------------------------------------------------------------
// Session wiring: the handshake capture, and the rule that NOTHING here can
// refuse a session.
// ---------------------------------------------------------------------------

function mkSession(extraOpts = {}) {
  const sk = mkdtempSync(join(tmpdir(), 'chroxy-cdx1-'))
  const s = new CodexAppServerSession({ cwd: '/tmp', skillsDir: sk, repoSkillsDir: null, ...extraOpts })
  return { s, cleanup: () => rmSync(sk, { recursive: true, force: true }) }
}

/**
 * Stub the transport so start() never spawns a real `codex app-server`: mock
 * initialize (which is where the spawn lives) and request on the prototype, so
 * the session's own `new CodexAppServerClient(...)` picks them up.
 */
function stubTransport({ userAgent, requests }) {
  mock.method(CodexAppServerClient.prototype, 'initialize', async function stubInit() {
    return userAgent === undefined ? {} : { userAgent, codexHome: '/tmp/.codex', platformOs: 'macos' }
  })
  mock.method(CodexAppServerClient.prototype, 'request', async function stubRequest(method, params) {
    requests.push([method, params])
    if (method === 'thread/start') return { thread: { id: 'thr-1', model: 'gpt-5.5', reasoningEffort: 'xhigh' }, model: 'gpt-5.5', reasoningEffort: 'xhigh' }
    if (method === 'turn/start') return { turn: { id: 'turn-1' } }
    return {}
  })
}

describe('CodexAppServerSession — handshake capture (#7724)', () => {
  it('a fresh session is all-UNKNOWN before the handshake', () => {
    const { s, cleanup } = mkSession()
    assert.equal(s.codexVersion, null)
    assert.equal(s.codexUserAgent, null)
    for (const name of CAPABILITY_NAMES) {
      assert.equal(s.codexCapabilities[name], UNKNOWN, `${name} is unknown before initialize()`)
    }
    cleanup()
  })

  it('start() captures the version and derives the capabilities', async (t) => {
    t.after(() => mock.restoreAll())
    const requests = []
    stubTransport({ userAgent: LIVE_0_154, requests })
    const { s, cleanup } = mkSession()
    await s.start()
    assert.equal(s.codexVersion, '0.154.0')
    assert.equal(s.codexUserAgent, LIVE_0_154)
    assert.equal(s.codexCapabilities.supportsMidTurnSettings, true)
    assert.equal(s.codexCapabilities.supportsModelList, true)
    assert.equal(s._threadId, 'thr-1', 'the thread still started')
    cleanup()
  })

  it('a version BELOW the floor still starts a session AND still sends turn/start', async (t) => {
    t.after(() => mock.restoreAll())
    const requests = []
    stubTransport({ userAgent: 'codex/0.100.3 (Mac OS 15.0; arm64) unknown', requests })
    const { s, cleanup } = mkSession()
    await s.start()
    assert.equal(s._threadId, 'thr-1', 'a low version NEVER refuses the connection')
    assert.equal(s._processReady, true)
    assert.equal(s.codexVersion, '0.100.3')
    assert.equal(s.codexCapabilities.supportsModelList, false, 'the FEATURE is gated off...')
    await s.sendMessage('hello')
    const methods = requests.map(([m]) => m)
    assert.ok(methods.includes('thread/start'), '...the thread still started')
    assert.ok(methods.includes('turn/start'), '...and the turn still went out')
    cleanup()
  })

  it('an UNPARSEABLE userAgent still starts a session, and leaves the gates unknown', async (t) => {
    t.after(() => mock.restoreAll())
    const requests = []
    stubTransport({ userAgent: 'unknown (Mac OS 26.6.2; arm64) unknown', requests })
    const { s, cleanup } = mkSession()
    await s.start()
    assert.equal(s._threadId, 'thr-1')
    assert.equal(s.codexVersion, null)
    for (const name of CAPABILITY_NAMES) {
      assert.equal(s.codexCapabilities[name], UNKNOWN, `${name} falls through to a probe`)
    }
    cleanup()
  })

  it('a handshake result with NO userAgent field at all still starts a session', async (t) => {
    t.after(() => mock.restoreAll())
    const requests = []
    stubTransport({ userAgent: undefined, requests })
    const { s, cleanup } = mkSession()
    await s.start()
    assert.equal(s._threadId, 'thr-1')
    assert.equal(s.codexVersion, null)
    assert.equal(s.codexUserAgent, null)
    assert.equal(s.codexCapabilities.supportsModelList, UNKNOWN)
    cleanup()
  })
})

describe('CodexAppServerSession — deprecationNotice (#7724)', () => {
  function mkLogged() {
    const { s, cleanup } = mkSession()
    const lines = []
    s._log = { info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]), debug: () => {} }
    return { s, cleanup, lines }
  }

  it('is logged when it arrives BETWEEN turns (the handshake window)', () => {
    const { s, cleanup, lines } = mkLogged()
    assert.equal(s._activeTurn, null, 'no active turn — the switch below is unreachable here')
    s._onNotification({ method: 'deprecationNotice', params: { message: 'app-server v1 is deprecated; migrate to v2' } })
    const warned = lines.filter(([lvl, m]) => lvl === 'warn' && /deprecation/i.test(m))
    assert.equal(warned.length, 1, 'exactly one deprecation warning')
    assert.ok(warned[0][1].includes('app-server v1 is deprecated'), 'the notice text is carried into the log')
    cleanup()
  })

  it('is logged DURING a turn too, and is not mistaken for turn content', () => {
    const { s, cleanup, lines } = mkLogged()
    const events = []
    for (const e of ['stream_delta', 'error', 'tool_start']) s.on(e, (p) => events.push([e, p]))
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    s._onNotification({ method: 'deprecationNotice', params: { message: 'thread/start.config is going away' } })
    assert.equal(lines.filter(([lvl, m]) => lvl === 'warn' && /deprecation/i.test(m)).length, 1)
    assert.deepEqual(events, [], 'it emits no session events')
    cleanup()
  })

  it('a notice with no message field logs the payload rather than swallowing it', () => {
    const { s, cleanup, lines } = mkLogged()
    s._onNotification({ method: 'deprecationNotice', params: { deprecated: 'turn/start.summary' } })
    const warned = lines.filter(([lvl, m]) => lvl === 'warn' && /deprecation/i.test(m))
    assert.equal(warned.length, 1)
    assert.ok(warned[0][1].includes('turn/start.summary'), 'the raw payload is preserved')
    cleanup()
  })

  it('an unrelated between-turns notification is still ignored', () => {
    const { s, cleanup, lines } = mkLogged()
    s._onNotification({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'i1' } } })
    assert.equal(lines.filter(([lvl, m]) => lvl === 'warn' && /deprecation/i.test(m)).length, 0)
    cleanup()
  })
})
