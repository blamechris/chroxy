// #8610 — readable Codex request errors.
//
// Hermetic: the helper cases are pure. The session cases build a CodexAppServerSession
// with no client, no child process, no start/destroy and no network, drive it only
// through `_onNotification` with literal payloads, and clear every timer in `finally`
// (the #6856 deadline goes through the injected timer seam). This file refuses to run
// outside `tests/_setup.mjs` (loaded with `--import`).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fsNamespace from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep, basename } from 'node:path'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { MODEL_UNSUPPORTED_CODE } from '../src/codex-model-rejections.js'
import {
  describeCodexError, formatCodexError, UNREADABLE_CODEX_ERROR,
  MAX_CODEX_ERROR_DEPTH, MAX_CODEX_ERROR_PARSE, MAX_CODEX_ERROR_TEXT,
} from '../src/codex-error-text.js'

// --- Mandatory isolation: tests/_setup.mjs must already be installed ---------
{
  const fail = (why) => {
    throw new Error(`codex-error-text.test.js: refusing to run without tests/_setup.mjs isolation: ${why}. ` +
      'Run with: node --import ./tests/_setup.mjs --experimental-test-module-mocks --test tests/codex-error-text.test.js')
  }
  const cfg = process.env.CHROXY_CONFIG_DIR
  if (!cfg) fail('CHROXY_CONFIG_DIR is not set')
  const realTmp = fsNamespace.realpathSync(tmpdir())
  const realCfg = fsNamespace.realpathSync(cfg)
  if (!realCfg.startsWith(realTmp + sep) || !basename(realCfg).startsWith('chroxy-test-cfg-')) {
    fail('CHROXY_CONFIG_DIR is not the per-process temp dir _setup.mjs creates')
  }
  const marker = Symbol.for('chroxy.testFsSandbox')
  for (const name of ['writeFileSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'renameSync']) {
    if (!fsNamespace[name]?.[marker]) fail(`fs.${name} is not guarded by the write sandbox`)
  }
}

// The shape from the #8610 report: the backend's error JSON-encoded inside `message`.
const ISSUE_ENVELOPE = () => ({
  message: JSON.stringify({
    type: 'error',
    status: 400,
    error: { type: 'invalid_request_error', message: 'The request was rejected by the backend.' },
  }),
})

describe('describeCodexError / formatCodexError (#8610)', () => {
  it('reads a plain string and a direct message', () => {
    assert.deepEqual(describeCodexError('connection reset'), { message: 'connection reset', status: null, type: null })
    assert.deepEqual(describeCodexError({ message: 'boom' }), { message: 'boom', status: null, type: null })
  })

  it('decodes the JSON-encoded envelope to the inner message, status and type', () => {
    const d = describeCodexError(ISSUE_ENVELOPE())
    assert.deepEqual(d, { message: 'The request was rejected by the backend.', status: 400, type: 'invalid_request_error' })
    assert.equal(formatCodexError(d), 'Codex error: The request was rejected by the backend. (status 400, invalid_request_error)')
  })

  it('prefers the nested error over a wrapper message', () => {
    assert.equal(describeCodexError({ message: 'Request failed', error: { message: 'real cause', type: 'rate_limit_error' } }).message, 'real cause')
    assert.equal(describeCodexError({ message: 'Request failed', error: '{"message":"inner"}' }).message, 'inner')
  })

  it('falls back to the wrapper message when the nested error has none', () => {
    assert.equal(describeCodexError({ message: 'outer', error: { code: 'x' } }).message, 'outer')
  })

  it('does not let a plain-text error code outrank a real message', () => {
    assert.equal(describeCodexError({ error: 'invalid_request_error', message: 'real message' }).message, 'real message')
    // With no message: prose is the last resort; a bare code-shaped token is not.
    assert.equal(describeCodexError({ error: 'rate limit exceeded' }).message, 'rate limit exceeded')
    assert.equal(describeCodexError({ error: 'rate limit exceeded', message: 'own message' }).message, 'own message')
    assert.equal(describeCodexError({ error: 'invalid_request_error' }), null)
    assert.equal(describeCodexError({ error: 'ERR_RATE_LIMIT' }), null)
    assert.equal(describeCodexError({ error: '["meta"]' }), null)
    assert.equal(describeCodexError({ error: '{"broken' }), null)
  })

  it('follows only the error and message keys', () => {
    assert.equal(describeCodexError({ detail: { message: 'hidden' } }), null)
    assert.equal(describeCodexError({ data: '{"message":"hidden"}' }), null)
  })

  it('returns null for absent, empty or non-object input', () => {
    for (const v of [null, undefined, '', '   ', {}, [], 42, true]) {
      assert.equal(describeCodexError(v), null, `input ${JSON.stringify(v)}`)
    }
  })

  it('treats malformed or oversized JSON-looking text as unreadable, never as the message', () => {
    assert.equal(describeCodexError({ message: '{"type":"error","error":{"message":"cut' }), null)
    assert.equal(describeCodexError('{not json}'), null)
    const big = `{"message":"${'x'.repeat(MAX_CODEX_ERROR_PARSE)}"}`
    assert.equal(big.length > MAX_CODEX_ERROR_PARSE, true)
    assert.equal(describeCodexError({ message: big }), null)
  })

  it('treats array-like text as unreadable, well-formed, malformed or oversized', () => {
    assert.equal(describeCodexError({ message: '["a","b"]' }), null)
    assert.equal(describeCodexError('["metadata"]'), null)
    assert.equal(describeCodexError('  ["metadata"]  '), null)
    assert.equal(describeCodexError('[not json'), null)
    assert.equal(describeCodexError(`[${'"x",'.repeat(MAX_CODEX_ERROR_PARSE)}"x"]`), null)
    assert.equal(describeCodexError({ message: '{"error":"[1,2,3]"}' }), null)
    assert.equal(describeCodexError({ message: '{"message":"[1,2,3]"}' }), null)
  })

  it('an array-like branch does not hide a readable one', () => {
    assert.equal(describeCodexError({ message: '["meta"]', error: { message: 'real cause' } }).message, 'real cause')
    assert.equal(describeCodexError({ error: '["meta"]', message: 'real cause' }).message, 'real cause')
    assert.equal(describeCodexError({ error: { message: '[1]' }, message: 'fallback' }).message, 'fallback')
  })

  it('stops at the depth bound', () => {
    // Nest through `error` objects; the readable string sits at depth (wraps + 1).
    const nest = (wraps) => {
      let x = { message: 'inner' }
      for (let i = 0; i < wraps; i++) x = { error: x }
      return x
    }
    assert.equal(describeCodexError(nest(MAX_CODEX_ERROR_DEPTH)), null)
    assert.equal(describeCodexError(nest(MAX_CODEX_ERROR_DEPTH - 3)).message, 'inner')
  })

  it('keeps status only as an integer 100-599 and type only as a short identifier', () => {
    const at = (status, type) => describeCodexError({ status, type, message: 'm' })
    assert.equal(at('400', 'invalid_request_error').status, null)
    assert.equal(at(999, 'x').status, null)
    assert.equal(at(400.5, 'x').status, null)
    assert.equal(at(503, 'x').status, 503)
    assert.equal(at(400, 'error').type, null)
    assert.equal(at(400, 'has spaces in it').type, null)
    assert.equal(at(400, `t${'x'.repeat(80)}`).type, null)
  })

  it('takes status and type from the deepest layer that has a valid one', () => {
    const d = describeCodexError({ status: 500, type: 'outer_type', error: { status: 400, type: 'inner_type', message: 'm' } })
    assert.equal(d.status, 400)
    assert.equal(d.type, 'inner_type')
    const f = describeCodexError({ status: 503, type: 'outer_type', error: { status: 'bad', type: 'has spaces', message: 'm' } })
    assert.equal(f.status, 503)
    assert.equal(f.type, 'outer_type')
  })

  it('bounds the whole formatted text, details included', () => {
    const text = formatCodexError({ message: 'y'.repeat(MAX_CODEX_ERROR_TEXT * 3), status: 400, type: 'invalid_request_error' })
    assert.equal(text.length <= MAX_CODEX_ERROR_TEXT, true)
    assert.equal(text.endsWith('… (status 400, invalid_request_error)'), true)
  })

  it('gives no sign-in advice for a 401 (the route is not known here)', () => {
    assert.equal(formatCodexError({ message: 'unauthorized', status: 401, type: null }), 'Codex error: unauthorized (status 401)')
  })
})

// --- Session path: the terminal error the client sees --------------------------
const THREAD = 'thr-8610'

function mkSession() {
  const sk = fsNamespace.mkdtempSync(join(tmpdir(), 'chroxy-cas-8610-'))
  const s = new CodexAppServerSession({
    cwd: '/tmp',
    skillsDir: sk,
    repoSkillsDir: null,
    setTimer: (fn, ms) => ({ fn, ms, unref() {} }),
    clearTimer: () => {},
  })
  s._threadId = THREAD
  const errors = []
  s.on('error', (p) => errors.push(p))
  const cleanup = () => {
    s._clearResultTimeout()
    s._clearReconnectWatchdog()
    s._clearReconnectDeadline()
    fsNamespace.rmSync(sk, { recursive: true, force: true })
  }
  return { s, errors, cleanup }
}
const openTurn = (s) => {
  s._isBusy = true
  s._activeTurn = { messageId: 'm1', turnId: 'turn-1', didStreamStart: false }
}
const errorNote = (turnId, error, extra = {}) => ({ method: 'error', params: { threadId: THREAD, turnId, error, ...extra } })

describe('Codex terminal error text (#8610)', () => {
  it('an ending error shows the decoded message and ends the turn', () => {
    const { s, errors, cleanup } = mkSession()
    try {
      openTurn(s)
      s._onNotification(errorNote('turn-1', ISSUE_ENVELOPE(), { willRetry: false }))
      assert.deepEqual(errors, [{ message: 'Codex error: The request was rejected by the backend. (status 400, invalid_request_error)' }])
      assert.equal(s._activeTurn, null)
      assert.equal(s._isBusy, false)
    } finally { cleanup() }
  })

  it('an unreadable error says so and shows no raw payload', () => {
    const { s, errors, cleanup } = mkSession()
    try {
      openTurn(s)
      s._onNotification(errorNote('turn-1', { message: '{"type":"error","secret_field":"abc' }, { willRetry: false }))
      assert.deepEqual(errors, [{ message: UNREADABLE_CODEX_ERROR }])
      assert.equal(s._activeTurn, null)
    } finally { cleanup() }
  })

  it('keeps the usage-limit message and code ahead of decoding', () => {
    const { s, errors, cleanup } = mkSession()
    try {
      openTurn(s)
      s._onNotification(errorNote('turn-1', { message: 'You hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' }, { willRetry: false }))
      assert.deepEqual(errors, [{ message: 'You hit your usage limit.', code: 'usage_limit' }])
    } finally { cleanup() }
  })

  it('keeps the model-rejection code ahead of decoding', () => {
    const { s, cleanup } = mkSession()
    try {
      const err = { message: "The 'gpt-zz-test' model is not supported when using Codex with a ChatGPT account." }
      assert.equal(s._terminalErrorPayload(err, { error: err }).code, MODEL_UNSUPPORTED_CODE)
    } finally { cleanup() }
  })

  it('a retry (willRetry: true) still keeps the turn open, whatever its text', () => {
    const { s, errors, cleanup } = mkSession()
    try {
      openTurn(s)
      s._onNotification(errorNote('turn-1', ISSUE_ENVELOPE(), { willRetry: true }))
      assert.deepEqual(errors, [])
      assert.ok(s._activeTurn)
    } finally { cleanup() }
  })

  it('a prose params.error string is shown as the message', () => {
    const { s, errors, cleanup } = mkSession()
    try {
      openTurn(s)
      s._onNotification(errorNote('turn-1', 'rate limit exceeded', { willRetry: false }))
      assert.deepEqual(errors, [{ message: 'Codex error: rate limit exceeded' }])
      assert.equal(s._activeTurn, null)
    } finally { cleanup() }
  })

  it('a code-shaped params.error string is not shown as a message', () => {
    const { s, errors, cleanup } = mkSession()
    try {
      openTurn(s)
      s._onNotification(errorNote('turn-1', 'invalid_request_error', { willRetry: false }))
      assert.deepEqual(errors, [{ message: UNREADABLE_CODEX_ERROR }])
      assert.equal(s._activeTurn, null)
    } finally { cleanup() }
  })

  it('an ending error with no turn open is surfaced with the decoded message', () => {
    const { s, errors, cleanup } = mkSession()
    try {
      s._onNotification(errorNote('turn-x', ISSUE_ENVELOPE(), { willRetry: false }))
      assert.deepEqual(errors, [{ message: 'Codex error: The request was rejected by the backend. (status 400, invalid_request_error)' }])
      assert.equal(s._activeTurn, null)
    } finally { cleanup() }
  })
})
