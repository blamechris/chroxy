/**
 * Tests for the per-session settings registry (#4664).
 *
 * The registry collapses the per-session-setting boilerplate that the
 * promptEvaluator (#3185) → chroxyContextHint (#3805) → sessionPreamble
 * (#4660) iterations each hand-wrote across SessionManager (createSession
 * forwarding + serializeState + restoreState) and settings-handlers.js
 * (WS handler + broadcast + immediate persist).
 *
 * These tests describe the abstraction's contract — a single declaration
 * per knob, with derived helpers that drive the WS handler factory, the
 * createSession providerOpts forwarder, and the serialize / restore
 * pair. The existing per-knob behaviour (BaseSession field declarations,
 * setter validation, jsonl-subprocess middle layer forwarding) is
 * unchanged and continues to be covered by base-session.test.js +
 * jsonl-subprocess-session.test.js.
 */
import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import {
  definePerSessionSetting,
  PER_SESSION_SETTINGS,
  forwardPerSessionSettingsToProviderOpts,
  serializePerSessionSettings,
  restorePerSessionSettings,
  buildPerSessionSettingHandler,
} from '../src/per-session-settings.js'
import { nsCtx } from './test-helpers.js'

// ---- definePerSessionSetting ------------------------------------------------

describe('definePerSessionSetting', () => {
  it('returns a frozen definition with the supplied fields', () => {
    const def = definePerSessionSetting({
      id: 'foo',
      defaultValue: false,
      // Boolean coerce + accept predicate are the simplest pair — mirrors
      // the promptEvaluator shape.
      coerce: (v) => !!v,
      acceptFromWire: (v) => typeof v === 'boolean',
      acceptFromConstructor: (v) => typeof v === 'boolean',
      requestType: 'set_foo',
      broadcastType: 'foo_changed',
      handlerInvalidValueMessage: 'set_foo requires a boolean `value`',
      handlerUnsupportedMessage: 'This provider does not support foo',
      setterName: 'setFoo',
    })
    assert.equal(def.id, 'foo')
    assert.equal(def.defaultValue, false)
    assert.equal(typeof def.coerce, 'function')
    assert.equal(def.requestType, 'set_foo')
    assert.equal(def.broadcastType, 'foo_changed')
    // Defensive freeze — handlers iterate the registry; a stray mutation
    // would silently change behaviour at every call site.
    assert.throws(() => { def.id = 'bar' }, /read.only|Cannot assign/)
  })

  it('throws when a required field is missing', () => {
    assert.throws(
      () => definePerSessionSetting({ id: 'foo' }),
      /defaultValue|coerce|requestType|broadcastType|setterName/,
    )
  })
})

// ---- PER_SESSION_SETTINGS registry -----------------------------------------

describe('PER_SESSION_SETTINGS registry', () => {
  it('includes the three current per-session settings', () => {
    const ids = PER_SESSION_SETTINGS.map((s) => s.id).sort()
    assert.deepEqual(ids, ['chroxyContextHint', 'promptEvaluator', 'sessionPreamble'])
  })

  it('every entry has the wire request + broadcast pair', () => {
    for (const def of PER_SESSION_SETTINGS) {
      assert.equal(typeof def.requestType, 'string', `${def.id} missing requestType`)
      assert.equal(typeof def.broadcastType, 'string', `${def.id} missing broadcastType`)
      assert.equal(typeof def.setterName, 'string', `${def.id} missing setterName`)
      assert.equal(typeof def.coerce, 'function', `${def.id} missing coerce`)
    }
  })

  // Locks in the exact wire types so a future rename in the registry can't
  // silently break dashboard clients that hard-code the strings.
  it('wire types match the existing protocol', () => {
    const byId = new Map(PER_SESSION_SETTINGS.map((s) => [s.id, s]))
    assert.equal(byId.get('promptEvaluator').requestType, 'set_prompt_evaluator')
    assert.equal(byId.get('promptEvaluator').broadcastType, 'prompt_evaluator_changed')
    assert.equal(byId.get('chroxyContextHint').requestType, 'set_chroxy_context_hint')
    assert.equal(byId.get('chroxyContextHint').broadcastType, 'chroxy_context_hint_changed')
    assert.equal(byId.get('sessionPreamble').requestType, 'set_session_preamble')
    assert.equal(byId.get('sessionPreamble').broadcastType, 'session_preamble_changed')
  })
})

// ---- forwardPerSessionSettingsToProviderOpts -------------------------------

describe('forwardPerSessionSettingsToProviderOpts', () => {
  it('copies declared keys when the wire-accept predicate returns true', () => {
    const out = {}
    forwardPerSessionSettingsToProviderOpts(out, {
      promptEvaluator: true,
      chroxyContextHint: false,
      sessionPreamble: '  hello  ',
    })
    assert.equal(out.promptEvaluator, true)
    assert.equal(out.chroxyContextHint, false)
    assert.equal(out.sessionPreamble, '  hello  ')
  })

  it('skips a key when the accept predicate rejects (preserves BaseSession defaults)', () => {
    const out = {}
    forwardPerSessionSettingsToProviderOpts(out, {
      promptEvaluator: 'not-a-bool',
      chroxyContextHint: 1,
      sessionPreamble: 42,
    })
    // None of the three forwarded — BaseSession's constructor coerce will
    // apply its own default for each.
    assert.equal('promptEvaluator' in out, false)
    assert.equal('chroxyContextHint' in out, false)
    assert.equal('sessionPreamble' in out, false)
  })

  it('does not include keys absent from source', () => {
    const out = {}
    forwardPerSessionSettingsToProviderOpts(out, {})
    assert.equal('promptEvaluator' in out, false)
    assert.equal('chroxyContextHint' in out, false)
    assert.equal('sessionPreamble' in out, false)
  })
})

// ---- serializePerSessionSettings -------------------------------------------

describe('serializePerSessionSettings', () => {
  it('falls back to defaultValue when the session field is undefined (Copilot review on #4751)', () => {
    const session = {
      // Simulate a custom provider that skips BaseSession's field
      // initialiser — defaultValue feeds the coerce so the wire shape
      // is right (`false` / `false` / `''`), not `undefined` everywhere.
      promptEvaluator: undefined,
      chroxyContextHint: undefined,
      sessionPreamble: undefined,
    }
    const out = serializePerSessionSettings(session)
    assert.equal(out.promptEvaluator, false)
    assert.equal(out.chroxyContextHint, false)
    assert.equal(out.sessionPreamble, '')
  })

  it('coerces a present but wrong-shape session field to the wire-safe form', () => {
    // A hand-edited state file or a custom provider that initialised the
    // field to a non-typeof-correct value: the coerce still runs and
    // produces the safe wire shape (boolean via `!!v`, '' via
    // `typeof v === 'string' ? v : ''`). defaultValue is NOT used here
    // because the raw value is defined — only `undefined` triggers the
    // defaultValue fallback.
    const session = {
      promptEvaluator: 'truthy-string',
      chroxyContextHint: 0,
      sessionPreamble: 42,
    }
    const out = serializePerSessionSettings(session)
    assert.equal(out.promptEvaluator, true) // !! on truthy string
    assert.equal(out.chroxyContextHint, false) // !! on 0
    assert.equal(out.sessionPreamble, '') // non-string → ''
  })

  it('round-trips set values', () => {
    const session = {
      promptEvaluator: true,
      chroxyContextHint: true,
      sessionPreamble: 'hello world',
    }
    const out = serializePerSessionSettings(session)
    assert.equal(out.promptEvaluator, true)
    assert.equal(out.chroxyContextHint, true)
    assert.equal(out.sessionPreamble, 'hello world')
  })
})

// ---- restorePerSessionSettings ---------------------------------------------

describe('restorePerSessionSettings', () => {
  it('returns undefined for fields absent from the state file', () => {
    const out = restorePerSessionSettings({})
    // undefined → createSession leaves BaseSession's constructor default
    // in place. Cleanest backward-compat — pre-existing state files
    // round-trip unchanged.
    assert.equal(out.promptEvaluator, undefined)
    assert.equal(out.chroxyContextHint, undefined)
    assert.equal(out.sessionPreamble, undefined)
  })

  it('forwards explicit values', () => {
    const out = restorePerSessionSettings({
      promptEvaluator: true,
      chroxyContextHint: false,
      sessionPreamble: 'hi',
    })
    assert.equal(out.promptEvaluator, true)
    assert.equal(out.chroxyContextHint, false)
    assert.equal(out.sessionPreamble, 'hi')
  })

  it('drops bad shapes (non-string sessionPreamble, non-boolean toggles) so createSession ignores them', () => {
    const out = restorePerSessionSettings({
      promptEvaluator: 'truthy-not-boolean',
      chroxyContextHint: 0,
      sessionPreamble: 42,
    })
    // All three drop → createSession applies BaseSession defaults rather
    // than feeding the malformed value through. Matches the pre-refactor
    // per-knob behaviour in session-manager.js.
    assert.equal(out.promptEvaluator, undefined)
    assert.equal(out.chroxyContextHint, undefined)
    assert.equal(out.sessionPreamble, undefined)
  })
})

// ---- buildPerSessionSettingHandler -----------------------------------------

describe('buildPerSessionSettingHandler', () => {
  // Reusable boolean test definition. Mirrors the promptEvaluator wiring.
  const booleanDef = definePerSessionSetting({
    id: 'fooFlag',
    defaultValue: false,
    coerce: (v) => !!v,
    acceptFromWire: (v) => typeof v === 'boolean',
    acceptFromConstructor: (v) => typeof v === 'boolean',
    requestType: 'set_foo_flag',
    broadcastType: 'foo_flag_changed',
    setterName: 'setFooFlag',
    handlerInvalidValueMessage: 'set_foo_flag requires a boolean `value`',
    handlerUnsupportedMessage: 'This provider does not support fooFlag',
  })

  function makeCtx(session, overrides = {}) {
    const sessionMap = new Map()
    if (session) sessionMap.set('sess-1', { session, name: 'test' })
    return nsCtx({
      sessionManager: {
        getSession: (id) => sessionMap.get(id) ?? null,
        serializeState: mock.fn(() => null),
      },
      send: mock.fn(),
      broadcast: mock.fn(),
      broadcastToSession: mock.fn(),
      _sessions: sessionMap,
      ...overrides,
    })
  }

  const client = { id: 'c1', activeSessionId: 'sess-1' }

  it('rejects payload with the wrong-shape value (sends session_error and no broadcast)', () => {
    const session = { fooFlag: false, setFooFlag: mock.fn(() => true) }
    const ctx = makeCtx(session)
    const handler = buildPerSessionSettingHandler(booleanDef)
    handler({}, client, { type: 'set_foo_flag', value: 'not-a-bool' }, ctx)

    assert.equal(ctx.transport.broadcastToSession.mock.callCount(), 0)
    assert.equal(session.setFooFlag.mock.callCount(), 0)
    assert.equal(ctx.transport.send.mock.callCount(), 1)
    const reply = ctx.transport.send.mock.calls[0].arguments[1]
    assert.equal(reply.type, 'session_error')
    assert.match(reply.message, /boolean.*value/i)
  })

  it('sends session_error when no session is bound', () => {
    const ctx = makeCtx(null)
    const handler = buildPerSessionSettingHandler(booleanDef)
    handler({}, { id: 'c1', activeSessionId: 'sess-missing' }, { type: 'set_foo_flag', value: true }, ctx)

    assert.equal(ctx.transport.broadcastToSession.mock.callCount(), 0)
    assert.equal(ctx.transport.send.mock.callCount(), 1)
    assert.equal(ctx.transport.send.mock.calls[0].arguments[1].type, 'session_error')
  })

  it('sends session_error when session lacks the setter (defensive)', () => {
    // No setFooFlag method — a custom provider that bypasses BaseSession.
    const session = { fooFlag: false }
    const ctx = makeCtx(session)
    const handler = buildPerSessionSettingHandler(booleanDef)
    handler({}, client, { type: 'set_foo_flag', value: true }, ctx)

    assert.equal(ctx.transport.broadcastToSession.mock.callCount(), 0)
    assert.equal(ctx.transport.send.mock.callCount(), 1)
    assert.match(ctx.transport.send.mock.calls[0].arguments[1].message, /does not support/i)
  })

  it('broadcasts when the setter returns true (state actually changed)', () => {
    const session = { fooFlag: true, setFooFlag: mock.fn(() => true) }
    const ctx = makeCtx(session)
    const handler = buildPerSessionSettingHandler(booleanDef)
    handler({}, client, { type: 'set_foo_flag', value: true }, ctx)

    assert.equal(session.setFooFlag.mock.callCount(), 1)
    assert.equal(session.setFooFlag.mock.calls[0].arguments[0], true)
    assert.equal(ctx.transport.broadcastToSession.mock.callCount(), 1)
    const [sessionId, broadcast] = ctx.transport.broadcastToSession.mock.calls[0].arguments
    assert.equal(sessionId, 'sess-1')
    assert.equal(broadcast.type, 'foo_flag_changed')
    assert.equal(broadcast.value, true)
    // Immediate persist — toggles are rare operator actions; matches the
    // existing per-knob behaviour.
    assert.equal(ctx.sessions.sessionManager.serializeState.mock.callCount(), 1)
  })

  it('skips broadcast + persist when the setter reports a no-op (false)', () => {
    const session = { fooFlag: false, setFooFlag: mock.fn(() => false) }
    const ctx = makeCtx(session)
    const handler = buildPerSessionSettingHandler(booleanDef)
    handler({}, client, { type: 'set_foo_flag', value: false }, ctx)

    assert.equal(session.setFooFlag.mock.callCount(), 1)
    assert.equal(ctx.transport.broadcastToSession.mock.callCount(), 0)
    assert.equal(ctx.sessions.sessionManager.serializeState.mock.callCount(), 0)
    assert.equal(ctx.transport.send.mock.callCount(), 0)
  })

  it('does not throw when persist itself fails (best-effort)', () => {
    const session = { fooFlag: true, setFooFlag: mock.fn(() => true) }
    const ctx = makeCtx(session, {
      sessionManager: {
        getSession: (id) => ({ session, name: 'test' }),
        serializeState: mock.fn(() => { throw new Error('disk full') }),
      },
    })
    const handler = buildPerSessionSettingHandler(booleanDef)
    // Must not throw — the in-memory state is correct; the persist is
    // best-effort with a log line only.
    assert.doesNotThrow(() => {
      handler({}, client, { type: 'set_foo_flag', value: true }, ctx)
    })
    assert.equal(ctx.transport.broadcastToSession.mock.callCount(), 1)
  })
})
