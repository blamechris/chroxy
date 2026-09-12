import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCodexVersion,
  parseBareVersion,
  deriveCapabilities,
  isUnknownMethodError,
  probeMethodSupported,
  atLeast,
  CODEX_VERSION_FLOOR,
  RPC_INVALID_REQUEST,
  CAPABILITY_FLOORS,
} from '../src/codex-protocol-capabilities.js'
import { toRpcError } from '../src/codex-app-server-client.js'

/**
 * #7724 (CDX-1) — the codex feature gate.
 *
 * The one string in here that is not synthetic is the LIVE userAgent, recorded
 * from `codex app-server` 0.154.0 on 2026-09-11 with chroxy's real clientInfo.
 * It matters because it falsifies the shape the issue was written against: the
 * leading token is chroxy's OWN name echoed back, not a codex originator, so a
 * pattern anchored on `codex/` matches nothing this binary emits.
 */

const LIVE_USER_AGENT = 'chroxy/0.154.0 (Mac OS 26.6.2; arm64) unknown (chroxy; 1)'

describe('#7724 parseCodexVersion', () => {
  const CASES = [
    // [label, input, expected]
    ['the LIVE 0.154.0 string (chroxy clientInfo)', LIVE_USER_AGENT, '0.154.0'],
    ['the live shape at the floor', 'chroxy/0.128.0 (Mac OS 26.6.2; arm64) unknown (chroxy; 1)', '0.128.0'],
    ['a different client name', 'chroxy-probe/0.154.0 (Mac OS 26.6.2; arm64) unknown (chroxy-probe; 1)', '0.154.0'],
    ['an alpha/pre-release build', 'chroxy/0.155.0-alpha.3 (Linux 6.1; x86_64) unknown (chroxy; 1)', '0.155.0-alpha.3'],
    ['a build-metadata suffix', 'chroxy/0.154.0+deadbeef (Linux 6.1; x86_64)', '0.154.0+deadbeef'],
    ['bare originator/version with no parenthetical', 'chroxy/1.2.3', '1.2.3'],
    ['UNPARSEABLE — no slash at all', 'codex app-server, version unknown', null],
    ['UNPARSEABLE — a fork with no version', 'my-fork/unknown (Linux 6.1)', null],
    ['UNPARSEABLE — empty string', '', null],
    ['UNPARSEABLE — not a string', undefined, null],
    ['UNPARSEABLE — null', null, null],
    ['a two-component version is not a semver core', 'chroxy/0.154 (Linux 6.1)', null],
    // A FOUR-component vendor build must REFUSE to parse, not truncate. A
    // truncated '0.128.0' would compare equal to the floor instead of above it —
    // a confident wrong answer, where null is the fail-safe one.
    ['a four-component build refuses rather than truncating', 'chroxy/0.128.0.99 (Linux 6.1)', null],
    ['and the same with no parenthetical', 'chroxy/1.2.3.4', null],
  ]
  for (const [label, input, expected] of CASES) {
    it(label, () => { assert.equal(parseCodexVersion(input), expected) })
  }

  it('does NOT pick up the OS version later in the string — the trap the live shape sets', () => {
    // `Mac OS 26.6.2` is also `\d+\.\d+\.\d+`. An unanchored search finds it,
    // and on a host whose OS version is higher than the codex version the gate
    // would silently read as "new enough". The anchor is load-bearing.
    assert.equal(parseCodexVersion('chroxy/0.128.0 (Mac OS 26.6.2; arm64)'), '0.128.0')
    // And with NO version in position 2, the OS version must not be adopted.
    assert.equal(parseCodexVersion('chroxy/unknown (Mac OS 26.6.2; arm64)'), null)
  })
})

describe('#7724 deriveCapabilities', () => {
  it('a floor binary supports the floor features but not the post-floor one', () => {
    const caps = deriveCapabilities({ userAgent: 'chroxy/0.128.0 (Mac OS 26.6.2; arm64)' })
    assert.equal(caps.version, '0.128.0')
    assert.equal(caps.belowFloor, false)
    assert.equal(caps.supportsModelList, true)
    assert.equal(caps.supportsThreadResume, true)
    assert.equal(caps.supportsMidTurnSettings, false, 'thread/settings/update arrived after the floor')
  })

  it('the LIVE 0.154.0 binary supports everything', () => {
    const caps = deriveCapabilities({ userAgent: LIVE_USER_AGENT })
    assert.equal(caps.version, '0.154.0')
    assert.equal(caps.belowFloor, false)
    for (const cap of Object.keys(CAPABILITY_FLOORS)) {
      assert.equal(caps[cap], true, `${cap} on 0.154.0`)
    }
  })

  it('a BELOW-FLOOR binary is flagged but still gets its post-floor gates answered honestly', () => {
    const caps = deriveCapabilities({ userAgent: 'chroxy/0.100.0 (Linux 6.1; x86_64)' })
    assert.equal(caps.belowFloor, true)
    assert.equal(caps.supportsModelList, false)
    assert.equal(caps.supportsMidTurnSettings, false)
  })

  it('an UNPARSEABLE userAgent yields SUPPORTED for every gate, never disabled', () => {
    // The fail-safe direction, and the AC's explicit rule: a cannot-check must
    // not read as a no. RED under: defaulting an unknown version to false.
    const caps = deriveCapabilities({ userAgent: 'codex app-server, version unknown' })
    assert.equal(caps.version, null)
    assert.equal(caps.belowFloor, false, 'unknown is not "below the floor" — that would be a verdict we cannot support')
    for (const cap of Object.keys(CAPABILITY_FLOORS)) {
      assert.equal(caps[cap], true, `${cap} must default to supported when the version is unknown`)
    }
  })

  it('no signals at all behaves the same as an unparseable one', () => {
    const caps = deriveCapabilities()
    assert.equal(caps.version, null)
    for (const cap of Object.keys(CAPABILITY_FLOORS)) assert.equal(caps[cap], true)
  })

  it('cliVersion (a bare semver) wins over the userAgent parse', () => {
    // thread/start echoes `thread.cliVersion` as a bare semver, needing no
    // string surgery. Give the two signals DIFFERENT versions so the winner is
    // observable — an assertion where both agree could not tell which was read.
    const caps = deriveCapabilities({ cliVersion: '0.128.0', userAgent: 'chroxy/0.154.0 (Mac OS 26.6.2; arm64)' })
    assert.equal(caps.version, '0.128.0')
    assert.equal(caps.supportsMidTurnSettings, false, 'the cliVersion answer is the one that took effect')
  })

  it('accepts a v-prefixed or space-padded cliVersion instead of silently demoting it', () => {
    // The old synthetic-`x/`-prefix parse rejected these, so the userAgent
    // quietly became the answer — a surprising reason for a fallback to fire.
    assert.equal(parseBareVersion('v0.154.0'), '0.154.0')
    assert.equal(parseBareVersion('  0.154.0  '), '0.154.0')
    assert.equal(parseBareVersion('0.128.0.99'), null, 'and a 4-component build still refuses')
    assert.equal(deriveCapabilities({ cliVersion: 'v0.154.0', userAgent: 'chroxy/0.100.0 (Linux 6.1)' }).version, '0.154.0')
  })

  it('falls back to the userAgent when cliVersion is absent or junk', () => {
    assert.equal(deriveCapabilities({ cliVersion: null, userAgent: LIVE_USER_AGENT }).version, '0.154.0')
    assert.equal(deriveCapabilities({ cliVersion: 'nightly', userAgent: LIVE_USER_AGENT }).version, '0.154.0')
  })

  it('a pre-release at a floor counts as meeting it', () => {
    assert.equal(atLeast('0.154.0-alpha.1', '0.154.0'), true)
    assert.equal(deriveCapabilities({ cliVersion: '0.154.0-alpha.1' }).supportsMidTurnSettings, true)
  })

  it('compares numerically, not lexically', () => {
    // '0.9.0' > '0.128.0' as strings. A lexical compare would read a 0.9 build
    // as newer than the floor and enable everything on a binary that has none
    // of it.
    assert.equal(atLeast('0.9.0', CODEX_VERSION_FLOOR), false)
    assert.equal(atLeast('0.128.0', CODEX_VERSION_FLOOR), true)
    assert.equal(atLeast('1.0.0', CODEX_VERSION_FLOOR), true)
  })
})

describe('#7724 isUnknownMethodError', () => {
  /** Built the way the client builds it, so the code survives the round trip. */
  const rpc = (code, message) => toRpcError({ code, message })

  it('recognises the LIVE unknown-method error by CODE plus the method we sent', () => {
    const err = rpc(RPC_INVALID_REQUEST,
      'Invalid request: unknown variant `no/such/method`, expected one of `initialize`, `thread/start`')
    assert.equal(isUnknownMethodError(err, 'no/such/method'), true)
  })

  it('is indifferent to the WORDING — only the code and our own method name matter', () => {
    // The #7503/#7540 guard: a check pinned to upstream prose stops matching
    // when upstream rewords and reads as "nothing wrong". These two messages
    // share no phrasing at all.
    assert.equal(isUnknownMethodError(rpc(RPC_INVALID_REQUEST, 'unknown variant `model/list`'), 'model/list'), true)
    assert.equal(isUnknownMethodError(rpc(RPC_INVALID_REQUEST, 'no idea what model/list is, sorry'), 'model/list'), true)
    assert.equal(isUnknownMethodError(rpc(RPC_INVALID_REQUEST, 'MODEL/LIST: rejected — model/list unsupported in this build'), 'model/list'), true)
  })

  it('does NOT fire on -32600 for an unrelated request — the code alone is insufficient', () => {
    // -32600 is the general validation code, not a method-not-found code. A gate
    // that treated any -32600 as "unsupported" would disable a feature on a
    // malformed-params error.
    const err = rpc(RPC_INVALID_REQUEST, 'Invalid request: missing field `cwd`')
    assert.equal(isUnknownMethodError(err, 'thread/start'), false)
  })

  it('does not fire on -32601, which this server never emits, nor on any other code', () => {
    for (const code of [-32601, -32602, -32603, -32700, 0, null]) {
      assert.equal(isUnknownMethodError(rpc(code, 'unknown variant `model/list`'), 'model/list'), false, `code ${code}`)
    }
  })

  it('does not fire on a non-RPC error, or with no method to match', () => {
    assert.equal(isUnknownMethodError(new Error('socket hang up'), 'model/list'), false)
    assert.equal(isUnknownMethodError(null, 'model/list'), false)
    assert.equal(isUnknownMethodError(rpc(RPC_INVALID_REQUEST, 'unknown variant `model/list`'), ''), false)
    assert.equal(isUnknownMethodError(rpc(RPC_INVALID_REQUEST, 'unknown variant `model/list`'), undefined), false)
  })
})

describe('#7724 probeMethodSupported', () => {
  it('a successful call means supported', async () => {
    assert.equal(await probeMethodSupported(async () => ({ data: [] }), 'model/list'), true)
  })

  it('a positive unknown-method verdict means UNsupported', async () => {
    const request = async () => { throw toRpcError({ code: RPC_INVALID_REQUEST, message: 'unknown variant `model/list`' }) }
    assert.equal(await probeMethodSupported(request, 'model/list'), false)
  })

  it('ANY other failure means supported — absence of evidence is not evidence of absence', async () => {
    // Each of these is a reason the probe could not answer. Reading them as
    // "unsupported" would disable the picker on a working binary because a
    // socket blipped.
    const failures = [
      new Error('socket hang up'),
      toRpcError({ code: -32602, message: 'Invalid params' }),
      toRpcError({ code: RPC_INVALID_REQUEST, message: 'Invalid request: missing field `cwd`' }),
      Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    ]
    for (const f of failures) {
      const request = async () => { throw f }
      assert.equal(await probeMethodSupported(request, 'model/list'), true, `${f.message} must not disable the feature`)
    }
  })

  it('passes the method and params through to the request function', async () => {
    const calls = []
    await probeMethodSupported(async (m, p) => { calls.push([m, p]); return {} }, 'model/list', { cursor: 'x' })
    assert.deepEqual(calls, [['model/list', { cursor: 'x' }]])
  })
})

describe('#7724 toRpcError preserves the code', () => {
  it('carries an integer code and data through to the caller', () => {
    const err = toRpcError({ code: RPC_INVALID_REQUEST, message: 'nope', data: { hint: 'x' } })
    assert.ok(err instanceof Error)
    assert.equal(err.code, RPC_INVALID_REQUEST)
    assert.equal(err.message, 'nope')
    assert.deepEqual(err.data, { hint: 'x' })
  })

  it('a missing or non-integer code becomes null, so `=== -32600` is a clean false', () => {
    assert.equal(toRpcError({ message: 'no code' }).code, null)
    assert.equal(toRpcError({ code: '-32600', message: 'stringly typed' }).code, null)
    assert.equal(toRpcError({ code: 1.5, message: 'not an integer' }).code, null)
    assert.equal(toRpcError(null).code, null)
  })

  it('falls back to a JSON dump when there is no message, so the error is never empty', () => {
    assert.match(toRpcError({ code: -1 }).message, /-1/)
  })
})

describe('#7724 the gate can never break a connection', () => {
  it('deriveCapabilities NEVER throws, for any input the handshake could hand it', () => {
    // This is the assertion that backs "gate FEATURES, never the connection".
    // deriveCapabilities is called inside the start() try-block, so a throw here
    // would be relabelled as a handshake failure and REFUSE THE SESSION — the
    // one outcome the AC forbids. Cheaper and more direct than asserting the
    // absence of an abort branch, which a source grep cannot prove.
    const inputs = [
      undefined, null, {}, { userAgent: undefined }, { userAgent: null }, { userAgent: '' },
      { userAgent: 123 }, { userAgent: {} }, { userAgent: [] },
      { userAgent: 'chroxy/0.154.0 (Mac OS 26.6.2; arm64) unknown (chroxy; 1)' },
      { userAgent: 'a'.repeat(10000) },
      { userAgent: 'chroxy/999999999999999999999.0.0' },
      { userAgent: 'chroxy/0.0.0' },
      { userAgent: '/0.154.0' },
      { userAgent: '\u0000\u0001/1.2.3' },
      { cliVersion: '' }, { cliVersion: 0 }, { cliVersion: {} }, { cliVersion: 'nightly' },
      { cliVersion: '0.154.0', userAgent: null },
    ]
    for (const input of inputs) {
      let caps
      assert.doesNotThrow(() => { caps = deriveCapabilities(input) }, `input ${JSON.stringify(input)?.slice(0, 60)}`)
      // And whatever it returns must be usable: every declared capability is a
      // boolean, so a consumer's `if (caps.x)` cannot read undefined as false.
      for (const cap of Object.keys(CAPABILITY_FLOORS)) {
        assert.equal(typeof caps[cap], 'boolean', `${cap} is a boolean for ${JSON.stringify(input)?.slice(0, 40)}`)
      }
    }
  })

  it('parseCodexVersion never throws either', () => {
    for (const input of [undefined, null, 0, {}, [], '', 'x'.repeat(10000), '\u0000/1.2.3']) {
      assert.doesNotThrow(() => parseCodexVersion(input))
    }
  })

  it('probeMethodSupported never rejects, whatever the request function does', async () => {
    // Same reasoning one layer out: a probe that throws would propagate into the
    // caller's start path.
    const throwers = [
      async () => { throw new Error('x') },
      async () => { throw null },
      async () => { throw 'a string' },
      () => { throw new Error('sync throw before the promise') },
    ]
    for (const request of throwers) {
      const result = await probeMethodSupported(request, 'model/list').catch((e) => ({ rejected: e }))
      assert.equal(typeof result, 'boolean', 'resolved to a boolean rather than rejecting')
    }
  })
})
