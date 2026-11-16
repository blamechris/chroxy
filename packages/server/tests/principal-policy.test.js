import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registeredMessageTypes, registerMessageHandler, handleSessionMessage } from '../src/ws-message-handlers.js'
import { ClientMessageSchema } from '../src/ws-schemas.js'
import { SCHEMA_BACKED_OUTBOUND_TYPES } from '../src/ws-outbound-schemas.js'
import {
  BOUND_OUTGOING_SCHEMALESS_ALLOWED,
  BOUND_OUTGOING_SCHEMALESS_DENIED,
} from '../src/outgoing-policy.js'
import { refuseBoundMessage } from '../src/bound-client-policy.js'
import {
  PRINCIPAL_TRANSPORT_EXEMPT,
  PRINCIPAL_ALLOWED_MESSAGE_TYPES,
  PRINCIPAL_DENIED_MESSAGE_TYPES,
  PRINCIPAL_ENVELOPES,
  PRINCIPAL_OUTGOING_ALLOWED,
  PRINCIPAL_OUTGOING_DENIED,
  PRINCIPAL_TRANSPORT_FRAMES,
  PRINCIPAL_TRANSPORT_SERVER_ERROR_MESSAGES,
  PRINCIPAL_BROADCAST_ALLOWED,
  principalTransportFrame,
  frameForPrincipalBroadcast,
  PRINCIPAL_TIER_ORDER,
  isPrincipalClient,
  dispatchPolicyFor,
  refusePrincipalMessage,
  principalMaySee,
  frameForPrincipal,
} from '../src/principal-policy.js'
import { addLogListener, removeLogListener } from '../src/logger.js'
import { emittedFrameTypes, scanEmittedFrames, perClientLoopFrames, relSrc } from './helpers/emitted-frame-types.js'
import { REAL_HANDLERS, SENTINEL, principalClient, plainCtx } from './principal-test-helpers.js'

const allowed = Object.keys(PRINCIPAL_ALLOWED_MESSAGE_TYPES)
const denied = Object.keys(PRINCIPAL_DENIED_MESSAGE_TYPES)

// Independent oracles. Spelled out here, not derived from the module under test,
// so changing the v1 surface is a visible change to this file too.
const EXPECTED_EXEMPT = ['auth', 'key_exchange', 'ping']
const EXPECTED_ALLOWED_TIERS = {
  principal_subscribe: 'observe',
  principal_unsubscribe: 'observe',
  principal_events_read: 'observe',
  principal_pending_permissions: 'observe',
  principal_sessions_snapshot: 'observe',
  input: 'steer',
  interrupt: 'drive',
  create_session: 'drive',
  destroy_session: 'drive',
  permission_response: 'answer',
}
const EXPECTED_OUTGOING = [
  'auth_ok', 'credential_invalidated', 'input_ack', 'pong', 'principal_event', 'principal_events_page', 'principal_gap',
  'principal_live_fence', 'principal_pending_permissions_result', 'principal_sessions_snapshot_result', 'principal_subscribed', 'rate_limited', 'server_error', 'session_error',
]

const clientSchemaTypes = new Set(ClientMessageSchema.options.map((o) => o.shape.type.value))
const registered = new Set(registeredMessageTypes)
const union = new Set([...clientSchemaTypes, ...registered])

function captureLogs(fn) {
  const lines = []
  const listener = (entry) => lines.push(entry.message)
  addLogListener(listener)
  try {
    return { result: fn(), lines }
  } finally {
    removeLogListener(listener)
  }
}

describe('principal inbound roster', () => {
  it('the transport exempt set is exactly auth, key_exchange and ping', () => {
    assert.deepEqual([...PRINCIPAL_TRANSPORT_EXEMPT], EXPECTED_EXEMPT)
  })

  it('the exempt types are outside both registries and both lists', () => {
    for (const t of EXPECTED_EXEMPT) {
      assert.equal(union.has(t), false, `${t} must be handled outside the registry`)
      assert.equal(Object.hasOwn(PRINCIPAL_ALLOWED_MESSAGE_TYPES, t), false, t)
      assert.equal(Object.hasOwn(PRINCIPAL_DENIED_MESSAGE_TYPES, t), false, t)
    }
  })

  it('the roster is non-empty and the client-schema registry and registeredMessageTypes agree', () => {
    assert.ok(clientSchemaTypes.size > 0, 'client schema registry must not be empty')
    assert.ok(registered.size > 0, 'registeredMessageTypes must not be empty')
    const onlySchema = [...clientSchemaTypes].filter((t) => !registered.has(t))
    const onlyRegistry = [...registered].filter((t) => !clientSchemaTypes.has(t))
    assert.deepEqual(onlySchema, [], 'in the schema registry but not registered')
    assert.deepEqual(onlyRegistry, [], 'registered but not in the schema registry')
  })

  it('the real-handler table used by these tests covers exactly the registered types', () => {
    assert.deepEqual(Object.keys(REAL_HANDLERS).sort(), [...registeredMessageTypes])
  })

  it('every type in the union is allowed XOR denied', () => {
    let cases = 0
    for (const t of union) {
      cases++
      const a = Object.hasOwn(PRINCIPAL_ALLOWED_MESSAGE_TYPES, t)
      const d = Object.hasOwn(PRINCIPAL_DENIED_MESSAGE_TYPES, t)
      assert.ok(a || d, `${t} is in neither list: classify it in src/principal-policy.js`)
      assert.ok(!(a && d), `${t} is in both lists`)
    }
    assert.ok(cases > 0, 'zero cases')
    assert.equal(cases, union.size)
  })

  it('every listed name is a real type (no stale entries, no invented names)', () => {
    const stale = [...allowed, ...denied].filter((t) => !union.has(t))
    assert.deepEqual(stale, [])
  })

  it('every entry carries a written reason', () => {
    for (const [t, spec] of Object.entries(PRINCIPAL_ALLOWED_MESSAGE_TYPES)) {
      assert.ok(typeof spec.reason === 'string' && spec.reason.length > 10, `${t} needs a reason`)
    }
    for (const [t, why] of Object.entries(PRINCIPAL_DENIED_MESSAGE_TYPES)) {
      assert.ok(typeof why === 'string' && why.length > 10, `${t} needs a reason`)
    }
  })

  it('the v1 allowlist is exactly the five existing types plus the three S3 journal types and the S4 pending-permission snapshot, at the contract tiers', () => {
    const actual = Object.fromEntries(Object.entries(PRINCIPAL_ALLOWED_MESSAGE_TYPES).map(([t, s]) => [t, s.tier]))
    assert.deepEqual(actual, EXPECTED_ALLOWED_TIERS)
    for (const tier of Object.values(actual)) assert.ok(PRINCIPAL_TIER_ORDER.includes(tier))
  })

  it('the allowed and denied counts add up to the union (an oracle independent of the lists)', () => {
    assert.equal(allowed.length + denied.length, union.size)
    assert.equal(allowed.length, Object.keys(EXPECTED_ALLOWED_TIERS).length)
  })

  it('only the S1 management surface (denied) and the S3 journal read path (allowed) carry a principal_ name', () => {
    // principal_admin_* is the strict-primary management surface (S1): denied to a
    // principal and to a bound client, never allowed. The S3 read path is the only
    // principal_ name that is allowed; any other needs its handler first.
    const MANAGEMENT = ['principal_admin_grant', 'principal_admin_list', 'principal_admin_revoke']
    const JOURNAL = ['principal_events_read', 'principal_pending_permissions', 'principal_sessions_snapshot', 'principal_subscribe', 'principal_unsubscribe']
    assert.deepEqual(allowed.filter((t) => t.startsWith('principal_')).sort(), JOURNAL)
    assert.deepEqual(denied.filter((t) => t.startsWith('principal_')).sort(), MANAGEMENT)
    assert.deepEqual(Object.keys(PRINCIPAL_OUTGOING_ALLOWED).filter((t) => t.startsWith('principal_')).sort(),
      ['principal_event', 'principal_events_page', 'principal_gap', 'principal_live_fence', 'principal_pending_permissions_result', 'principal_sessions_snapshot_result', 'principal_subscribed'])
    // none of them is registered as a broadcast type: the broadcast allowlist stays empty
    assert.deepEqual(Object.keys(PRINCIPAL_BROADCAST_ALLOWED), [])
  })

  it('every allowed type has a closed envelope with its own type field', () => {
    for (const t of allowed) {
      const env = PRINCIPAL_ENVELOPES[t]
      assert.ok(env && env.fields.length > 0, `${t} needs an envelope`)
      assert.ok(env.fields.includes('type'), t)
    }
    assert.deepEqual(Object.keys(PRINCIPAL_ENVELOPES).sort(), [...allowed].sort())
  })
})

describe('principal behavioural check: no grant is refused at the handler, not merely by the list', () => {
  const FIXTURES = {
    input: { need: 'steer', msg: { type: 'input', sessionId: 'sess-1', clientMessageId: 'm1', data: 'hello' } },
    interrupt: { need: 'drive', msg: { type: 'interrupt', sessionId: 'sess-1', requestId: 'r1' } },
    create_session: { need: null, msg: { type: 'create_session', requestId: 'r1', cwd: '/tmp/x' } },
    destroy_session: { need: 'drive', msg: { type: 'destroy_session', sessionId: 'sess-1', requestId: 'r1' } },
    permission_response: { need: 'answer', msg: { type: 'permission_response', sessionId: 'sess-1', requestId: 'r1', decision: 'deny' } },
  }
  const SESSIONS = { 'sess-1': { cwd: '/tmp/a' }, other: { cwd: '/tmp/b' } }

  function callHandler(type, client, ctxOpts) {
    const { ctx, sent, calls } = plainCtx({ sessions: SESSIONS, ...ctxOpts })
    const { lines } = captureLogs(() => REAL_HANDLERS[type]({}, client, FIXTURES[type].msg, ctx))
    return { sent, calls, reasonLines: lines.filter((l) => l.includes('refused message type')) }
  }

  it('has a fixture for every allowed type (so none can be skipped); the observe journal types are covered below', () => {
    const observeTypes = allowed.filter((t) => PRINCIPAL_ALLOWED_MESSAGE_TYPES[t].tier === 'observe')
    assert.deepEqual(observeTypes.sort(), ['principal_events_read', 'principal_pending_permissions', 'principal_sessions_snapshot', 'principal_subscribe', 'principal_unsubscribe'])
    assert.deepEqual(Object.keys(FIXTURES).sort(), allowed.filter((t) => !observeTypes.includes(t)).sort())
  })

  for (const type of Object.keys(FIXTURES)) {
    const { need } = FIXTURES[type]

    if (need !== null) {
      it(`${type}: a principal with no grant for the session is refused by the handler (principalMaySee: scope)`, async () => {
        const client = principalClient({ principal: { constraints: { sessionIds: ['other'] } } })
        const { sent, calls, reasonLines } = callHandler(type, client)
        await Promise.resolve()
        assert.equal(sent.length, 1)
        assert.equal(sent[0].type, 'session_error')
        assert.equal(sent[0].code, 'scope_denied')
        assert.deepEqual(calls, [], 'no host-side effect')
        assert.equal(reasonLines.length, 1)
        assert.ok(reasonLines[0].includes('(scope)'), reasonLines[0])
      })

      it(`${type}: a granted principal with no lease is refused by the handler (principalMaySee: lease_required)`, () => {
        const { sent, calls, reasonLines } = callHandler(type, principalClient())
        assert.equal(sent.length, 1)
        assert.equal(sent[0].code, 'scope_denied')
        assert.deepEqual(calls, [])
        assert.ok(reasonLines[0].includes('(lease_required)'), reasonLines[0])
      })

      it(`${type}: even a granted, leased principal never reaches the host path in S2`, () => {
        const { sent, calls, reasonLines } = callHandler(type, principalClient(), { leaseFor: () => ({ kind: 'drive' }) })
        assert.equal(sent.length, 1)
        assert.equal(sent[0].code, 'scope_denied')
        assert.deepEqual(calls, [])
        assert.ok(reasonLines[0].includes('(not_available)'), reasonLines[0])
      })

      it(`${type}: the target is the explicit sessionId, never the active session`, () => {
        // Granted ONLY through the active session's id: an explicit sessionId that is
        // not granted must still be refused 'scope', not resolved through the fallback.
        const client = principalClient({ activeSessionId: 'sess-1', principal: { constraints: { sessionIds: ['sess-1'] } } })
        const msg = { ...FIXTURES[type].msg }
        delete msg.sessionId
        const { ctx, sent, calls } = plainCtx({ sessions: SESSIONS, leaseFor: () => ({ kind: 'drive' }) })
        const { lines } = captureLogs(() => REAL_HANDLERS[type]({}, client, msg, ctx))
        assert.equal(sent.length, 1)
        assert.deepEqual(calls, [])
        assert.ok(lines.some((l) => l.includes('(scope)')), 'a missing sessionId is not granted')
      })
    } else {
      it(`${type}: refused by the handler for a principal, before the bound refusal, with no host effect`, () => {
        const { sent, calls, reasonLines } = callHandler(type, principalClient())
        assert.equal(sent.length, 1)
        assert.equal(sent[0].code, 'scope_denied')
        assert.equal('boundSessionId' in sent[0], false, 'must not be the bound refusal')
        assert.deepEqual(calls, [])
        assert.ok(reasonLines[0].includes('(not_available)'), reasonLines[0])
      })
    }
  }
})

describe('refusePrincipalMessage / dispatchPolicyFor', () => {
  function run(client, msg) {
    const { ctx, sent } = plainCtx({ sessions: { 'sess-1': { cwd: '/tmp/a' } } })
    const refused = refusePrincipalMessage({}, client, msg, ctx)
    return { refused, sent }
  }
  const fullFields = {
    input: { type: 'input', sessionId: 'sess-1', clientMessageId: 'm1', data: 'hi', leaseId: 'L1', gen: 1 },
    interrupt: { type: 'interrupt', sessionId: 'sess-1', requestId: 'r1', leaseId: 'L1', gen: 1 },
    permission_response: { type: 'permission_response', sessionId: 'sess-1', requestId: 'r1', decision: 'deny', leaseId: 'L1', gen: 1 },
    destroy_session: { type: 'destroy_session', sessionId: 'sess-1', requestId: 'r1', leaseId: 'L1', gen: 1 },
    create_session: { type: 'create_session', requestId: 'r1', cwd: '/tmp/a', name: 'n', provider: 'claude-sdk', model: 'm', permissionMode: 'approve', worktree: false },
    principal_subscribe: { type: 'principal_subscribe', requestId: 'r1', sessionIds: ['sess-1'], cursors: [{ sessionId: 'sess-1', journalId: 'j', seq: 0 }] },
    principal_unsubscribe: { type: 'principal_unsubscribe', requestId: 'r1', sessionIds: ['sess-1'] },
    principal_events_read: { type: 'principal_events_read', requestId: 'r1', sessionId: 'sess-1', cursor: { sessionId: 'sess-1', journalId: 'j', seq: 0 }, limit: 10 },
    principal_pending_permissions: { type: 'principal_pending_permissions', requestId: 'r1', sessionIds: ['sess-1'] },
    principal_sessions_snapshot: { type: 'principal_sessions_snapshot', requestId: 'r1', sessionIds: ['sess-1'] },
  }

  it('the selector gives a principal the principal policy and everyone else the bound policy', () => {
    assert.equal(dispatchPolicyFor(principalClient()), refusePrincipalMessage)
    assert.equal(dispatchPolicyFor({ id: 'b', boundSessionId: 'sess-1' }), refuseBoundMessage)
    assert.equal(dispatchPolicyFor({ id: 'u', boundSessionId: null }), refuseBoundMessage)
    assert.equal(dispatchPolicyFor({ id: 'u' }), refuseBoundMessage)
    assert.equal(dispatchPolicyFor(null), refuseBoundMessage)
    assert.equal(dispatchPolicyFor(undefined), refuseBoundMessage)
  })

  it('a malformed stamp is still a principal (fail safe, like the == null bound rule)', () => {
    for (const principal of [{}, false, 0, '', []]) {
      const c = { id: 'x', principal }
      assert.equal(isPrincipalClient(c), true, JSON.stringify(principal))
      assert.equal(dispatchPolicyFor(c), refusePrincipalMessage)
    }
    assert.equal(isPrincipalClient({ id: 'x', principal: null }), false)
    assert.equal(isPrincipalClient({ id: 'x' }), false)
    assert.equal(isPrincipalClient(null), false)
  })

  it('returns false and sends nothing for a client that is not a principal', () => {
    for (const client of [{ id: 'u' }, { id: 'b', boundSessionId: 'sess-1' }, { id: 'e', boundSessionId: '' }, null]) {
      const { refused, sent } = run(client, { type: 'revoke_token' })
      assert.equal(refused, false)
      assert.deepEqual(sent, [])
    }
  })

  it('refuses every denied type scope_denied, echoing only requestType and requestId', () => {
    assert.ok(denied.length > 0)
    for (const type of denied) {
      const { refused, sent } = run(principalClient(), { type, requestId: 'r1', sessionId: 'sess-1' })
      assert.equal(refused, true, type)
      assert.equal(sent.length, 1, type)
      assert.deepEqual(sent[0], {
        type: 'session_error', code: 'scope_denied', message: 'Not permitted for this credential', requestType: type, requestId: 'r1',
      }, type)
    }
  })

  it('refuses an unlisted, malformed or prototype-named type', () => {
    for (const msg of [{ type: 'zz_unknown' }, {}, { requestId: 'r' }, { type: 5 }, { type: null }, { type: { a: 1 } }, { type: '__proto__' }, { type: 'constructor' }, { type: 'toString' }, { type: 'principal_snapshot_not_a_type' }]) {
      const { refused, sent } = run(principalClient(), msg)
      assert.equal(refused, true, JSON.stringify(msg))
      assert.equal(sent[0].code, 'scope_denied')
      assert.equal('requestType' in sent[0] && typeof msg.type !== 'string', false, 'a non-string type is never echoed')
    }
    // A message that is not even an object.
    const { refused } = run(principalClient(), null)
    assert.equal(refused, true)
  })

  it('does not dispatch the transport exempt types through the registry (they pass this gate untouched)', () => {
    for (const type of EXPECTED_EXEMPT) {
      const { refused, sent } = run(principalClient(), { type })
      assert.equal(refused, false, type)
      assert.deepEqual(sent, [])
    }
  })

  it('does not echo a requestId or type that is not a short string', () => {
    for (const requestId of [{ a: 1 }, 7, ['x'], null, true]) {
      const { sent } = run(principalClient(), { type: 'revoke_token', requestId })
      assert.equal('requestId' in sent[0], false, JSON.stringify(requestId))
    }
    const long = 'x'.repeat(129)
    const over = run(principalClient(), { type: long, requestId: long })
    assert.equal('requestType' in over.sent[0], false)
    assert.equal('requestId' in over.sent[0], false)
    const edge = 'y'.repeat(128)
    const at = run(principalClient(), { type: edge, requestId: edge })
    assert.equal(at.sent[0].requestType, edge)
    assert.equal(at.sent[0].requestId, edge)
  })

  it('never serializes the sentinel binding or any session id in a refusal', () => {
    for (const msg of [
      { type: 'terminal_input', sessionId: 'sess-1', data: 'x' },
      { type: 'input', sessionId: 'sess-1', data: 'x', extra: 1 },
      { type: 'zz', sessionId: SENTINEL },
    ]) {
      const { sent } = run(principalClient({ activeSessionId: 'sess-1' }), msg)
      const text = JSON.stringify(sent)
      assert.equal(text.includes(SENTINEL), false)
      assert.equal(text.includes('sess-1'), false)
      assert.equal('boundSessionId' in sent[0], false)
      assert.equal('sessionId' in sent[0], false)
    }
  })

  it('logs no payload: only a loggable type and a fixed reason word', () => {
    const secret = 'SECRET-PAYLOAD-d41d8c'
    const { lines } = captureLogs(() => {
      run(principalClient(), { type: 'terminal_input', sessionId: 'sess-1', data: secret, requestId: secret })
      run(principalClient(), { type: 'input', sessionId: 'sess-1', data: secret, smuggled: secret })
    })
    const mine = lines.filter((l) => l.includes('refused message type'))
    assert.equal(mine.length, 2)
    assert.equal(lines.some((l) => l.includes(secret)), false, 'the payload must never reach a log line')
  })

  it('keeps a type containing a newline on one log line', () => {
    const { lines } = captureLogs(() => run(principalClient(), { type: 'revoke_token\n[INFO] [ws] forged line' }))
    const mine = lines.filter((l) => l.includes('forged line'))
    assert.equal(mine.length, 1)
    assert.equal(mine[0].includes('\n'), false)
  })

  describe('tier', () => {
    const JOURNAL_TYPES = ['principal_subscribe', 'principal_unsubscribe', 'principal_events_read', 'principal_pending_permissions', 'principal_sessions_snapshot']
    const TIER_CAN_SEND = {
      observe: JOURNAL_TYPES,
      steer: [...JOURNAL_TYPES, 'input'],
      drive: [...JOURNAL_TYPES, 'input', 'interrupt', 'create_session', 'destroy_session'],
      answer: [...JOURNAL_TYPES, 'input', 'interrupt', 'create_session', 'destroy_session', 'permission_response'],
    }
    for (const [tier, can] of Object.entries(TIER_CAN_SEND)) {
      for (const type of allowed) {
        it(`a ${tier} principal ${can.includes(type) ? 'may' : 'may not'} send ${type}`, () => {
          const { refused } = run(principalClient({ principal: { tier } }), fullFields[type])
          assert.equal(refused, !can.includes(type))
        })
      }
    }

    it('an unknown or missing tier sends nothing', () => {
      for (const principal of [{ tier: 'root' }, { tier: undefined }, { tier: 'ANSWER' }, { tier: null }]) {
        for (const type of allowed) {
          assert.equal(run(principalClient({ principal }), fullFields[type]).refused, true, `${JSON.stringify(principal)} ${type}`)
        }
      }
    })
  })

  describe('envelopes', () => {
    it('a message with exactly the allowed fields passes dispatch, for every allowed type', () => {
      let cases = 0
      for (const type of allowed) {
        cases++
        const { refused, sent } = run(principalClient(), fullFields[type])
        assert.equal(refused, false, type)
        assert.deepEqual(sent, [])
        // The fixture really is the whole envelope (no field is missing from it).
        const missing = PRINCIPAL_ENVELOPES[type].fields.filter((f) => !Object.hasOwn(fullFields[type], f))
        assert.deepEqual(missing, [], `${type} fixture must exercise every envelope field`)
      }
      assert.ok(cases > 0)
    })

    it('a message with any single envelope field alone passes dispatch (fields are limits, not requirements)', () => {
      for (const type of allowed) {
        for (const field of PRINCIPAL_ENVELOPES[type].fields) {
          const msg = field === 'type' ? { type } : { type, [field]: fullFields[type][field] }
          assert.equal(run(principalClient(), msg).refused, false, `${type}.${field}`)
        }
      }
    })

    const EXTRAS = [
      ['attachments', [{ name: 'a' }]], ['context', { version: 1 }], ['isVoice', true],
      ['sandbox', { autoAllowBashIfSandboxed: true }], ['codexSandbox', 'danger-full-access'],
      ['skipPermissions', true], ['connectionId', 'c'], ['environmentId', 'e'], ['isolation', 'container'],
      ['agentCommId', 'a'], ['force', true], ['scope', 'always'], ['editedInput', { x: 1 }], ['reason', 'because'],
      ['smuggled', 'x'],
    ]
    for (const type of allowed) {
      for (const [field, value] of EXTRAS) {
        if (PRINCIPAL_ENVELOPES[type].fields.includes(field)) continue
        it(`${type}: the extra field ${field} is refused scope_denied`, () => {
          const { refused, sent } = run(principalClient(), { ...fullFields[type], [field]: value })
          assert.equal(refused, true)
          assert.equal(sent[0].code, 'scope_denied')
        })
      }
      it(`${type}: an own __proto__ key (JSON.parse) is refused`, () => {
        const msg = JSON.parse(`{"__proto__": {"x": 1}, "type": "${type}"}`)
        assert.equal(run(principalClient(), msg).refused, true)
      })
    }

    it('a permission_response may only deny, and the decision value is checked at dispatch', () => {
      for (const decision of ['allow', 'allowAlways', 'deny ', 'DENY', undefined, null, true]) {
        const msg = { ...fullFields.permission_response, decision }
        assert.equal(run(principalClient(), msg).refused, true, String(decision))
      }
      assert.equal(run(principalClient(), { ...fullFields.permission_response, decision: 'deny' }).refused, false)
    })

    it('an array or non-object message has no envelope', () => {
      assert.equal(run(principalClient(), ['input']).refused, true)
      assert.equal(run(principalClient(), 'input').refused, true)
    })
  })
})

describe('principalMaySee', () => {
  const root = mkdtempSync(join(tmpdir(), 'principal-maysee-'))
  const inside = join(root, 'granted', 'proj')
  const outside = join(root, 'elsewhere', 'proj')
  const lookalike = join(root, 'granted-evil')
  const escape = join(root, 'granted', 'escape-link')
  mkdirSync(inside, { recursive: true })
  mkdirSync(outside, { recursive: true })
  mkdirSync(lookalike, { recursive: true })
  symlinkSync(outside, escape)
  const grantedRoot = join(root, 'granted')
  const cwds = { 'in-1': inside, 'out-1': outside, 'evil-1': lookalike, 'esc-1': escape, 'gone-1': join(root, 'granted', 'missing') }
  const sessionCwd = (id) => cwds[id] ?? null
  const driveLease = () => ({ kind: 'drive' })

  after(() => rmSync(root, { recursive: true, force: true }))

  function client(constraints, tier = 'answer') {
    return principalClient({ principal: { tier, constraints } })
  }

  it('is never ok for a client that is not a principal', () => {
    for (const c of [{ id: 'u' }, { id: 'b', boundSessionId: 'sess-1' }, null, undefined]) {
      assert.deepEqual(principalMaySee(c, 'sess-1', 'observe', {}), { ok: false, reason: 'not_principal' })
    }
  })

  describe('grant constraints', () => {
    it('a session id in the grant is covered; one outside it is not', () => {
      const c = client({ sessionIds: ['sess-1'] })
      assert.deepEqual(principalMaySee(c, 'sess-1', 'observe', {}), { ok: true })
      assert.deepEqual(principalMaySee(c, 'sess-2', 'observe', {}), { ok: false, reason: 'scope' })
    })

    it('a cwd root covers a session under it, not a sibling, not a lookalike prefix, not a symlink escape', () => {
      const c = client({ cwdRoots: [grantedRoot] })
      const opts = { sessionCwd }
      assert.deepEqual(principalMaySee(c, 'in-1', 'observe', opts), { ok: true })
      assert.deepEqual(principalMaySee(c, 'out-1', 'observe', opts), { ok: false, reason: 'scope' })
      assert.deepEqual(principalMaySee(c, 'evil-1', 'observe', opts), { ok: false, reason: 'scope' })
      assert.deepEqual(principalMaySee(c, 'esc-1', 'observe', opts), { ok: false, reason: 'scope' })
    })

    it('a cwd root with no cwd resolver, an unresolvable cwd or a missing directory grants nothing', () => {
      const c = client({ cwdRoots: [grantedRoot] })
      assert.equal(principalMaySee(c, 'in-1', 'observe', {}).ok, false)
      assert.equal(principalMaySee(c, 'unknown', 'observe', { sessionCwd }).ok, false)
      assert.equal(principalMaySee(c, 'gone-1', 'observe', { sessionCwd }).ok, false)
      assert.equal(principalMaySee(client({ cwdRoots: [join(root, 'no-such-root')] }), 'in-1', 'observe', { sessionCwd }).ok, false)
    })

    it('session ids and cwd roots together grant the union', () => {
      const c = client({ sessionIds: ['out-1'], cwdRoots: [grantedRoot] })
      assert.equal(principalMaySee(c, 'out-1', 'observe', { sessionCwd }).ok, true)
      assert.equal(principalMaySee(c, 'in-1', 'observe', { sessionCwd }).ok, true)
      assert.equal(principalMaySee(c, 'evil-1', 'observe', { sessionCwd }).ok, false)
    })

    it('no, empty or malformed constraints grant nothing', () => {
      for (const constraints of [undefined, null, {}, { sessionIds: [] }, { cwdRoots: [] }, { sessionIds: 'sess-1' }, { cwdRoots: grantedRoot }, 'sess-1', 7]) {
        assert.equal(principalMaySee(client(constraints), 'sess-1', 'observe', { sessionCwd }).ok, false, JSON.stringify(constraints))
      }
    })

    it('a missing, empty or non-string session id is not granted', () => {
      const c = client({ sessionIds: ['', 'sess-1'] })
      for (const id of [undefined, null, '', 5, {}, ['sess-1']]) {
        assert.deepEqual(principalMaySee(c, id, 'observe', {}), { ok: false, reason: 'scope' })
      }
    })

    it('a non-granted session and a nonexistent session are indistinguishable', () => {
      const c = client({ sessionIds: ['sess-1'] })
      const exists = (id) => id === 'sess-1' || id === 'real-other'
      const nonGranted = principalMaySee(c, 'real-other', 'observe', { sessionExists: exists })
      const nonexistent = principalMaySee(c, 'no-such-session', 'observe', { sessionExists: exists })
      assert.deepEqual(nonGranted, nonexistent)
      assert.deepEqual(nonGranted, { ok: false, reason: 'scope' })
      // A granted id whose session no longer exists is refused the same way.
      const gone = principalMaySee(client({ sessionIds: ['gone'] }), 'gone', 'observe', { sessionExists: exists })
      assert.deepEqual(gone, { ok: false, reason: 'scope' })
      // The same holds for a mutation need: the lease question is never reached.
      assert.deepEqual(principalMaySee(c, 'no-such-session', 'drive', { sessionExists: exists, leaseFor: driveLease }), nonGranted)
      assert.deepEqual(principalMaySee(c, 'real-other', 'drive', { sessionExists: exists, leaseFor: driveLease }), nonGranted)
    })

    it('does not read the sentinel binding', () => {
      const base = principalMaySee(client({ sessionIds: ['sess-1'] }), 'sess-1', 'observe', {})
      for (const boundSessionId of [undefined, null, '', 'sess-1', 'anything']) {
        const c = client({ sessionIds: ['sess-1'] })
        c.boundSessionId = boundSessionId
        assert.deepEqual(principalMaySee(c, 'sess-1', 'observe', {}), base)
      }
    })
  })

  describe('tier ordering', () => {
    const NEEDS = ['observe', 'steer', 'drive', 'answer']
    // Independent oracle: the highest need each tier covers.
    const COVERS = { observe: ['observe'], steer: ['observe', 'steer'], drive: ['observe', 'steer', 'drive'], answer: NEEDS }
    for (const [tier, covers] of Object.entries(COVERS)) {
      for (const need of NEEDS) {
        it(`a ${tier} principal with a drive lease ${covers.includes(need) ? 'may' : 'may not'} ${need}`, () => {
          const verdict = principalMaySee(client({ sessionIds: ['sess-1'] }, tier), 'sess-1', need, { leaseFor: driveLease })
          assert.equal(verdict.ok, covers.includes(need))
          if (!verdict.ok) assert.equal(verdict.reason, 'tier')
        })
      }
    }

    it('an unknown tier or need is refused', () => {
      assert.equal(principalMaySee(client({ sessionIds: ['sess-1'] }, 'root'), 'sess-1', 'observe', {}).ok, false)
      assert.equal(principalMaySee(principalClient({ principal: { tier: undefined, constraints: { sessionIds: ['sess-1'] } } }), 'sess-1', 'observe', {}).ok, false)
      for (const need of ['write', undefined, 'ANSWER', '__proto__']) {
        assert.deepEqual(principalMaySee(client({ sessionIds: ['sess-1'] }), 'sess-1', need, { leaseFor: driveLease }), { ok: false, reason: 'tier' })
      }
    })
  })

  describe('lease', () => {
    const c = () => client({ sessionIds: ['sess-1'] })

    it('observe needs no lease', () => {
      assert.deepEqual(principalMaySee(c(), 'sess-1', 'observe', {}), { ok: true })
    })

    it('every mutation need is lease_required when no lease source exists (the default)', () => {
      for (const need of ['steer', 'drive', 'answer']) {
        assert.deepEqual(principalMaySee(c(), 'sess-1', need, {}), { ok: false, reason: 'lease_required' }, need)
        assert.deepEqual(principalMaySee(c(), 'sess-1', need, { leaseFor: () => null }), { ok: false, reason: 'lease_required' }, need)
        assert.deepEqual(principalMaySee(c(), 'sess-1', need, { leaseFor: () => undefined }), { ok: false, reason: 'lease_required' }, need)
        assert.deepEqual(principalMaySee(c(), 'sess-1', need, { leaseFor: () => ({}) }), { ok: false, reason: 'lease_required' }, need)
      }
    })

    it('a steer lease covers steer only; a drive lease covers steer, drive and answer', () => {
      const steer = { leaseFor: () => ({ kind: 'steer' }) }
      assert.deepEqual(principalMaySee(c(), 'sess-1', 'steer', steer), { ok: true })
      assert.equal(principalMaySee(c(), 'sess-1', 'drive', steer).reason, 'lease_required')
      assert.equal(principalMaySee(c(), 'sess-1', 'answer', steer).reason, 'lease_required')
      const drive = { leaseFor: driveLease }
      for (const need of ['steer', 'drive', 'answer']) assert.deepEqual(principalMaySee(c(), 'sess-1', need, drive), { ok: true }, need)
    })

    it('asks for the lease of THIS session only', () => {
      const asked = []
      principalMaySee(c(), 'sess-1', 'drive', { leaseFor: (cl, id) => { asked.push(id); return { kind: 'drive' } } })
      assert.deepEqual(asked, ['sess-1'])
      const leasedElsewhere = principalMaySee(client({ sessionIds: ['sess-1', 'sess-2'] }), 'sess-2', 'drive', { leaseFor: (cl, id) => (id === 'sess-1' ? { kind: 'drive' } : null) })
      assert.equal(leasedElsewhere.reason, 'lease_required')
    })

    it('the lease is not consulted for a session that is not granted', () => {
      let asked = 0
      principalMaySee(c(), 'sess-9', 'drive', { leaseFor: () => { asked++; return { kind: 'drive' } } })
      assert.equal(asked, 0)
    })
  })
})

describe('frameForPrincipal and the outgoing roster', () => {
  const granted = principalClient({ principal: { constraints: { sessionIds: ['sess-1'] } } })
  const opts = { sessionExists: (id) => id === 'sess-1' || id === 'sess-2' }
  const schemaTypes = [...new Set(SCHEMA_BACKED_OUTBOUND_TYPES)]
  const schemaless = [...BOUND_OUTGOING_SCHEMALESS_ALLOWED, ...BOUND_OUTGOING_SCHEMALESS_DENIED]

  it('the roster is non-empty', () => {
    assert.ok(schemaTypes.length > 0)
    assert.ok(schemaless.length > 0)
  })

  it('the delivered set is exactly the literal v1 list (checked against every schema-backed frame type)', () => {
    const deliveredNoSession = schemaTypes.filter((t) => frameForPrincipal(granted, { type: t }, opts) !== null).sort()
    const deliveredGranted = schemaTypes.filter((t) => frameForPrincipal(granted, { type: t, sessionId: 'sess-1' }, opts) !== null).sort()
    assert.deepEqual(deliveredNoSession, EXPECTED_OUTGOING)
    assert.deepEqual(deliveredGranted, EXPECTED_OUTGOING)
  })

  it('no schema-less frame the source emits by name is delivered', () => {
    for (const t of schemaless) {
      assert.equal(frameForPrincipal(granted, { type: t }, opts), null, t)
      assert.equal(frameForPrincipal(granted, { type: t, sessionId: 'sess-1' }, opts), null, t)
    }
  })

  it('every allowed outgoing name is a real frame type (no stale entries)', () => {
    const real = new Set(schemaTypes)
    assert.deepEqual(Object.keys(PRINCIPAL_OUTGOING_ALLOWED).filter((t) => !real.has(t)), [])
    assert.deepEqual(Object.keys(PRINCIPAL_OUTGOING_ALLOWED).sort(), EXPECTED_OUTGOING)
  })

  it('a frame tagged with a session outside the grant is never delivered, and nonexistent looks the same', () => {
    for (const t of Object.keys(PRINCIPAL_OUTGOING_ALLOWED)) {
      assert.equal(frameForPrincipal(granted, { type: t, sessionId: 'sess-2' }, opts), null, `non-granted ${t}`)
      assert.equal(frameForPrincipal(granted, { type: t, sessionId: 'no-such' }, opts), null, `nonexistent ${t}`)
    }
  })

  it('a frame with a granted session is delivered, and the session id is kept', () => {
    const f = frameForPrincipal(granted, { type: 'input_ack', sessionId: 'sess-1', clientMessageId: 'm1', status: 'accepted', delivery: 'queued', retrySafe: true, dedupScope: 'process', internal: 'x' }, opts)
    assert.deepEqual(f, { type: 'input_ack', sessionId: 'sess-1', clientMessageId: 'm1', status: 'accepted', delivery: 'queued', retrySafe: true, dedupScope: 'process' })
  })

  it('ordinary session broadcasts are never delivered, even inside the grant', () => {
    for (const type of ['stream_start', 'stream_delta', 'stream_end', 'message', 'tool_start', 'tool_result', 'permission_request', 'permission_resolved', 'user_input', 'session_status', 'result', 'terminal_output', 'history_replay_start', 'agent_event', 'session_list', 'client_joined']) {
      assert.equal(frameForPrincipal(granted, { type, sessionId: 'sess-1' }, opts), null, type)
    }
  })

  it('host-wide and credential frames are never delivered', () => {
    for (const type of ['token_rotated', 'pairing_refreshed', 'auth_bootstrap', 'auth_fail', 'key_exchange_ok', 'cost_update', 'mcp_servers', 'tunnel_url_changed', 'environment_list', 'notification_prefs', 'credentials_status', 'server_shutdown', 'server_status']) {
      assert.equal(frameForPrincipal(granted, { type, token: 'secret' }, opts), null, type)
    }
  })

  it('is deny by default for an untyped or prototype-named frame, and for a client that is not a principal', () => {
    for (const m of [null, undefined, {}, { data: 1 }, { type: 5 }, { type: '__proto__' }, { type: 'constructor' }, { type: 'toString' }]) {
      assert.equal(frameForPrincipal(granted, m, opts), null)
    }
    for (const c of [{ id: 'u' }, { id: 'b', boundSessionId: 'sess-1' }, null]) {
      assert.equal(frameForPrincipal(c, { type: 'pong' }, opts), null)
    }
  })

  it('auth_ok is reduced to the handshake negotiation: no session list, no host fields', () => {
    const full = {
      type: 'auth_ok', clientId: 'c1', serverMode: 'cli', serverVersion: '0.11.7', latestVersion: '0.11.8', serverCommit: 'abc', cwd: '/Users/x/secret',
      connectedClients: [{ clientId: 'o', deviceName: 'Other' }], encryption: 'disabled', protocolVersion: 3, minProtocolVersion: 1, maxProtocolVersion: 3,
      capabilities: { a: true }, billingCanary: { x: 1 }, webFeatures: { y: 1 }, exposure: { lanBind: true }, sessions: [{ sessionId: 'sess-1' }, { sessionId: 'sess-2' }],
      activeSessionId: 'sess-2', boundSessionId: SENTINEL, boundSessionName: 'n',
    }
    const f = frameForPrincipal(granted, full, opts)
    assert.deepEqual(f, { type: 'auth_ok', clientId: 'c1', encryption: 'disabled', protocolVersion: 3, minProtocolVersion: 1, maxProtocolVersion: 3 })
    const text = JSON.stringify(f)
    for (const leak of ['secret', 'Other', 'sess-2', '0.11.7', SENTINEL, 'lanBind']) assert.equal(text.includes(leak), false, leak)
  })

  it('session_error keeps its refusal fields and drops every binding field', () => {
    const f = frameForPrincipal(granted, {
      type: 'session_error', message: 'm', code: 'scope_denied', requestType: 'input', requestId: 'r1', recoverable: false,
      boundSessionId: SENTINEL, boundSessionName: 'Secret Name', primaryClientId: 'other-client', category: 'x',
    }, opts)
    assert.deepEqual(f, { type: 'session_error', message: 'm', code: 'scope_denied', recoverable: false, requestId: 'r1', requestType: 'input' })
  })

  it('server_error drops its free-text message (host detail) and keeps category and recoverable', () => {
    const f = frameForPrincipal(granted, { type: 'server_error', category: 'tunnel', message: 'cloudflared at /Users/x exited', recoverable: true }, opts)
    assert.deepEqual(f, { type: 'server_error', category: 'tunnel', recoverable: true })
  })

  it('credential_invalidated and rate_limited and pong are delivered reduced to their fields', () => {
    assert.deepEqual(frameForPrincipal(granted, { type: 'credential_invalidated', reason: 'revoked', x: 1 }, opts), { type: 'credential_invalidated', reason: 'revoked' })
    assert.deepEqual(frameForPrincipal(granted, { type: 'rate_limited', retryAfterMs: 5, message: 'slow', x: 1 }, opts), { type: 'rate_limited', retryAfterMs: 5, message: 'slow' })
    assert.deepEqual(frameForPrincipal(granted, { type: 'pong', serverTs: 7, x: 1 }, opts), { type: 'pong', serverTs: 7 })
  })

  it('a frame that would carry the client\'s binding value is dropped, whichever field holds it', () => {
    assert.equal(frameForPrincipal(granted, { type: 'session_error', message: `bound to ${SENTINEL}`, code: 'x' }, opts), null)
    assert.equal(frameForPrincipal(granted, { type: 'rate_limited', retryAfterMs: 1, message: SENTINEL }, opts), null)
  })

  it('never serializes the sentinel in anything delivered across every dispatch fixture', async () => {
    const sessions = { 'sess-1': { cwd: '/tmp/a' }, other: { cwd: '/tmp/b' } }
    const raw = []
    for (const type of [...allowed, ...denied, ...EXPECTED_EXEMPT, 'zz_unknown']) {
      for (const client of [principalClient(), principalClient({ principal: { tier: 'observe' } }), principalClient({ activeSessionId: 'sess-1' })]) {
        const { ctx, sent } = plainCtx({ sessions, leaseFor: () => ({ kind: 'drive' }) })
        const msg = type === 'permission_response' ? { type, sessionId: 'sess-1', requestId: 'r', decision: 'deny' } : { type, sessionId: 'sess-1', requestId: 'r' }
        try { await handleSessionMessage({}, client, msg, ctx) } catch { /* a handler without services may throw: only the frames matter */ }
        raw.push(...sent)
      }
    }
    assert.ok(raw.length > 0)
    for (const frame of raw) {
      const delivered = frameForPrincipal(principalClient(), frame, opts)
      if (delivered !== null) assert.equal(JSON.stringify(delivered).includes(SENTINEL), false)
    }
    // And the refusal path itself never produced the sentinel in the first place.
    assert.equal(raw.some((f) => JSON.stringify(f).includes(SENTINEL)), false)
  })
})

// Names the source passes to a send-like call that are NOT frames to a client: client-to-server
// messages the agent-control and supervisor code sends, and provider plumbing. Listed here by
// hand, independently of outgoing-policy.js, and checked against the emitted set both ways.
const NOT_CLIENT_FRAMES_LOCAL = [
  'auth', 'drain', 'drain_complete', 'input', 'interrupt', 'key_exchange', 'list_sessions',
  'permission_response', 'ping', 'ready', 'shutdown', 'stdin', 'stdin_end', 'subscribe_sessions',
  // agent-control's client-to-server sessions and the provider-process plumbing:
  'create_session', 'resume', 'spawn',
]

describe('outgoing roster is exhaustive: every real server frame is classified exactly once', () => {
  const emitted = emittedFrameTypes()
  const schemaTypes = new Set(SCHEMA_BACKED_OUTBOUND_TYPES)
  const real = new Set([...schemaTypes, ...[...emitted].filter((t) => !NOT_CLIENT_FRAMES_LOCAL.includes(t))])
  const allowedOut = Object.keys(PRINCIPAL_OUTGOING_ALLOWED)
  const deniedOut = [...PRINCIPAL_OUTGOING_DENIED]
  const transportOut = Object.keys(PRINCIPAL_TRANSPORT_FRAMES)

  it('enumerates a non-empty schema roster and a non-empty set of emitted frames (acorn)', () => {
    assert.ok(schemaTypes.size > 100)
    assert.ok(emitted.size > 100)
    assert.ok(real.size > 0)
  })

  it('the independent not-a-frame list is real: each name is emitted and none is a schema frame', () => {
    for (const t of NOT_CLIENT_FRAMES_LOCAL) {
      assert.ok(emitted.has(t), `${t} is no longer emitted: drop it from the list`)
      assert.equal(schemaTypes.has(t), false, `${t} is a schema-backed frame`)
    }
  })

  it('every real frame (schema-backed and schema-less) is in exactly one of allowed, denied, transport', () => {
    const where = (t) => [
      allowedOut.includes(t) && 'allowed', deniedOut.includes(t) && 'denied', transportOut.includes(t) && 'transport',
    ].filter(Boolean)
    const unclassified = [...real].filter((t) => where(t).length === 0).sort()
    const multiple = [...real].filter((t) => where(t).length > 1).sort()
    assert.deepEqual(unclassified, [], 'classify each new server frame in src/principal-policy.js')
    assert.deepEqual(multiple, [])
  })

  it('every classified name is a real frame (no stale entries)', () => {
    assert.deepEqual([...allowedOut, ...deniedOut, ...transportOut].filter((t) => !real.has(t)), [])
  })

  it('the three lists are pairwise disjoint and the denied list has no duplicates', () => {
    const all = [...allowedOut, ...deniedOut, ...transportOut]
    assert.equal(new Set(all).size, all.length)
    assert.equal(all.length, real.size, 'allowed + denied + transport must equal the real roster')
  })

  it('a denied frame is never delivered on the direct-reply path', () => {
    const client = principalClient({ principal: { constraints: { sessionIds: ['sess-1'] } } })
    for (const t of [...deniedOut, ...transportOut]) {
      assert.equal(frameForPrincipal(client, { type: t }, {}), null, t)
      assert.equal(frameForPrincipal(client, { type: t, sessionId: 'sess-1' }, {}), null, t)
    }
  })

  it('regression: file_list, built in a local variable by ws-file-ops/browser.js and sent by identifier, is enumerated and classified', () => {
    assert.ok(emitted.has('file_list'), 'the scanner must resolve `const response = { type: "file_list" }; sendFn(ws, response)`')
    assert.ok(deniedOut.includes('file_list'))
  })

  // Send arguments the scanner cannot resolve to a frame type (a helper call, a relay of a frame
  // built elsewhere, a serialized payload). Each file lists how many it has and why that is
  // acceptable; a NEW unresolved send, or one that disappears, fails here so it is decided.
  const UNRESOLVED_ALLOWANCES = {
    'agent-control/client.js': [4, 'client-to-server messages of the agent-control MCP client (including the CLI admin request()), not frames to a client'],
    'test-client.js': [2, 'client-to-server messages of the test client'],
    'control-room/handler-factory.js': [6, 'control-room replies built by the action factories; every type is a schema-backed, denied frame'],
    'dev-preview.js': [1, 'permission_request built by buildPermissionRequestMessage (denied)'],
    'event-ingest.js': [3, 'notification titles and bodies handed to the sink, not client frames'],
    'handlers/conversation-handlers.js': [2, 'conversation frames built by the handler (all denied; the CONVERSATION_FRAME marker is for bound clients)'],
    'handlers/feature-handlers.js': [1, 'dev-preview status relayed from the manager (dev_preview_status, denied)'],
    'handlers/github-webhook-handlers.js': [1, 'github_webhook_config built by buildWebhookConfig (denied)'],
    'handlers/input-handlers.js': [4, 'session_error input_conflict built by buildInputConflictError (direct reply type, session tagged)'],
    'handlers/scheduler-handlers.js': [1, 'scheduled_tasks snapshot built by buildSnapshot (denied)'],
    'handlers/session-pr-status-handlers.js': [5, 'session_pr_status built by degraded() (denied)'],
    'handlers/session-pr-threads-handlers.js': [5, 'session_pr_threads built by degraded() (denied)'],
    'handlers/settings-handlers.js': [5, 'permission_input and thinking_level_changed relays (denied)'],
    'notifications/sink-registry.js': [1, 'notification context handed to a sink, not a client frame'],
    'per-session-settings.js': [1, 'per-setting broadcast whose type comes from the setting definition (denied settings frames)'],
    'roster-broadcast.js': [3, 'relay of a roster frame built and classified by its producer (available_models, denied)'],
    'server-cli/tunnel-lifecycle-handler.js': [3, 'server_status frames built by the tunnel lifecycle helpers (denied)'],
    'server-cli.js': [3, 'relays of frames built at their producers, and notification titles'],
    'session-ci-watcher.js': [1, 'notification title handed to the sink, not a client frame'],
    'supervisor.js': [1, 'notification title handed to the sink, not a client frame'],
    'principal-policy.js': [1, 'the raw transport sink, which writes only the output of principalTransportFrame'],
    'ws-broadcaster.js': [3, 'the broadcaster relays frames its callers built'],
    'ws-client-sender.js': [2, 'serialization of the frame being delivered, after the outgoing policy ran'],
    'ws-file-ops/browser.js': [1, 'a frame built by its caller with an optional requestId merged in (file_content family, denied)'],
    'ws-file-ops/git.js': [10, 'git_create_pr_result built by prResult() (denied)'],
    'ws-file-ops/memory.js': [2, 'memory frames with an optional requestId merged in (denied)'],
    'ws-file-ops/reader.js': [2, 'file frames with an optional requestId merged in (denied)'],
    'ws-forwarding.js': [10, 'relays of provider events normalized elsewhere and tagged with a session (all denied session broadcasts)'],
    'ws-history.js': [5, 'replayed history entries and snapshots (denied for a principal, which is sent no replay)'],
    'ws-message-handlers.js': [1, 'the adapter relays a frame its handler built'],
    'ws-permissions.js': [4, 'permission_request frames built by buildPermissionRequestMessage (denied)'],
    'ws-server.js': [16, 'relays of frames built by their producers, which are classified where they are built'],
  }

  it('scanner file keys use forward slashes on every platform (Windows walks yield backslashes)', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
    assert.equal(relSrc(src + '\\agent-control\\client.js'), 'agent-control/client.js')
    assert.equal(relSrc(src + '/ws-file-ops/browser.js'), 'ws-file-ops/browser.js')
    assert.equal(relSrc(src + '\\ws-file-ops/browser.js'), 'ws-file-ops/browser.js')
  })

  it('every send argument the scanner cannot resolve is accounted for, in both directions', () => {
    const { unresolved } = scanEmittedFrames()
    const counts = {}
    for (const u of unresolved) counts[u.file] = (counts[u.file] ?? 0) + 1
    for (const [file, [n, reason]] of Object.entries(UNRESOLVED_ALLOWANCES)) {
      assert.ok(reason.length > 10, `${file} needs a reason`)
      assert.equal(counts[file] ?? 0, n, `${file}: unresolved send count changed (decide the new send, then update the allowance)`)
    }
    assert.deepEqual(Object.keys(counts).filter((f) => !Object.hasOwn(UNRESOLVED_ALLOWANCES, f)).sort(), [], 'a file has an unresolved send with no allowance')
  })

  it('no loop over the connected clients fans out a direct-reply type (a principal would receive it)', () => {
    const sends = perClientLoopFrames()
    assert.ok(sends.length > 0, 'the scan found no per-client loop sends: the scanner is broken')
    const bad = sends.filter((x) => !x.single && Object.hasOwn(PRINCIPAL_OUTGOING_ALLOWED, x.type))
    assert.deepEqual(bad.map((x) => `${x.file}:${x.line} ${x.type}`), [])
  })
})

describe('principal transport frames (raw sinks)', () => {
  const principal = principalClient()
  it('a client that is not a principal gets the frame back untouched (same object)', () => {
    for (const client of [{ id: 'u' }, { id: 'b', boundSessionId: 'sess-1' }, null]) {
      const frame = { type: 'error', code: 'INVALID_MESSAGE', message: 'm', details: 'd' }
      assert.equal(principalTransportFrame(client, frame), frame)
    }
  })

  it('key_exchange_ok is reduced to the public handshake fields', () => {
    const out = principalTransportFrame(principal, { type: 'key_exchange_ok', publicKey: 'pk', serverKeySig: 's', newIdentityKey: 'n', rotationCert: 'r', extra: 1, boundSessionId: SENTINEL })
    assert.deepEqual(out, { type: 'key_exchange_ok', publicKey: 'pk', serverKeySig: 's', newIdentityKey: 'n', rotationCert: 'r' })
  })

  it('an error is sent only for the key-exchange codes and without its details', () => {
    for (const code of PRINCIPAL_TRANSPORT_FRAMES.error.codes) {
      assert.deepEqual(principalTransportFrame(principal, { type: 'error', code, message: 'm', details: 'secret zod text' }), { type: 'error', code, message: 'm' })
    }
    assert.equal(principalTransportFrame(principal, { type: 'error', code: 'SOMETHING_ELSE', message: 'm' }), null)
  })

  it('a server_error is sent only with one of the two fixed encryption messages', () => {
    for (const message of PRINCIPAL_TRANSPORT_SERVER_ERROR_MESSAGES) {
      assert.deepEqual(principalTransportFrame(principal, { type: 'server_error', message, recoverable: false, category: 'x' }), { type: 'server_error', message, recoverable: false })
    }
    assert.equal(principalTransportFrame(principal, { type: 'server_error', message: 'cloudflared at /Users/x died', recoverable: true }), null)
  })

  it('any other frame type is not sent raw to a principal', () => {
    for (const type of ['auth_ok', 'session_list', 'token_rotated', 'message', undefined]) {
      assert.equal(principalTransportFrame(principal, { type }), null)
    }
  })

  it('auth_ok keeps the public key-exchange material and still drops the host fields', () => {
    const f = frameForPrincipal(principal, {
      type: 'auth_ok', clientId: 'c', encryption: 'required', protocolVersion: 3, minProtocolVersion: 1, maxProtocolVersion: 3,
      serverPublicKey: 'spk', serverKeySig: 'sig', newIdentityKey: 'nik', rotationCert: 'rc', cwd: '/x', serverVersion: '1', capabilities: {},
    }, {})
    assert.deepEqual(f, {
      type: 'auth_ok', clientId: 'c', encryption: 'required', protocolVersion: 3, minProtocolVersion: 1, maxProtocolVersion: 3,
      serverPublicKey: 'spk', serverKeySig: 'sig', newIdentityKey: 'nik', rotationCert: 'rc',
    })
  })
})

describe('principal broadcast path is separate from direct replies', () => {
  const client = principalClient({ principal: { constraints: { sessionIds: ['sess-1'] } } })
  const probe = { probe_event: ['type', 'sessionId', 'n'] }

  it('the broadcast allowlist is empty in S2, so no frame of any kind is delivered', () => {
    assert.deepEqual(Object.keys(PRINCIPAL_BROADCAST_ALLOWED), [])
    for (const type of [...Object.keys(PRINCIPAL_OUTGOING_ALLOWED), ...PRINCIPAL_OUTGOING_DENIED]) {
      assert.equal(frameForPrincipalBroadcast(client, { type, sessionId: 'sess-1' }, {}), null, type)
      assert.equal(frameForPrincipalBroadcast(client, { type }, {}), null, type)
    }
  })

  it('a direct-reply type is not a broadcast type even when the extension point is filled', () => {
    for (const type of Object.keys(PRINCIPAL_OUTGOING_ALLOWED)) {
      assert.equal(frameForPrincipalBroadcast(client, { type, sessionId: 'sess-1' }, { broadcastAllowed: probe }), null, type)
    }
  })

  it('with the extension point filled: granted session delivered and reduced, others and untagged frames not', () => {
    const opts = { broadcastAllowed: probe, sessionExists: () => true }
    assert.deepEqual(frameForPrincipalBroadcast(client, { type: 'probe_event', sessionId: 'sess-1', n: 1, secret: 'x' }, opts), { type: 'probe_event', sessionId: 'sess-1', n: 1 })
    assert.equal(frameForPrincipalBroadcast(client, { type: 'probe_event', sessionId: 'sess-2', n: 1 }, opts), null)
    assert.equal(frameForPrincipalBroadcast(client, { type: 'probe_event', n: 1 }, opts), null)
    assert.equal(frameForPrincipalBroadcast({ id: 'u' }, { type: 'probe_event', sessionId: 'sess-1' }, opts), null)
  })

  describe('a vetted frame is bound to its recipient and payload', () => {
    const opts = { broadcastAllowed: probe, sessionExists: () => true }
    const vet = (c) => frameForPrincipalBroadcast(c, { type: 'probe_event', sessionId: 'sess-1', n: 1 }, opts)

    it('only a frame the broadcast path vetted passes the direct path under an unlisted type', () => {
      const vetted = vet(client)
      assert.equal(frameForPrincipal(client, vetted, opts), vetted)
      assert.equal(frameForPrincipal(client, { ...vetted }, opts), null, 'a copy of the same shape is not vetted')
    })

    it('a frame vetted for principal A is refused for principal B, even with the same grant', () => {
      const a = principalClient({ id: 'A', principal: { constraints: { sessionIds: ['sess-1'] } } })
      const b = principalClient({ id: 'B', principal: { constraints: { sessionIds: ['sess-1'] } } })
      const vetted = vet(a)
      assert.equal(frameForPrincipal(a, vetted, opts), vetted)
      assert.equal(frameForPrincipal(b, vetted, opts), null)
    })

    it('the approved frame is frozen, so it cannot be changed after vetting', () => {
      const vetted = vet(client)
      assert.ok(Object.isFrozen(vetted))
      assert.throws(() => { vetted.sessionId = 'sess-2' }, TypeError)
      assert.throws(() => { vetted.extra = 'x' }, TypeError)
      assert.equal(vetted.sessionId, 'sess-1')
    })

    it('the vetted frame is DEEP-frozen and shares no nested value with its source (S2 review note)', () => {
      const nested = { type: 'probe_nested', sessionId: 'sess-1', body: { list: [1, { deep: true }] } }
      const o = { broadcastAllowed: { probe_nested: ['type', 'sessionId', 'body'] }, sessionExists: () => true }
      const vetted = frameForPrincipalBroadcast(client, nested, o)
      assert.ok(Object.isFrozen(vetted.body) && Object.isFrozen(vetted.body.list) && Object.isFrozen(vetted.body.list[1]))
      assert.throws(() => { vetted.body.list.push(2) }, TypeError)
      assert.throws(() => { vetted.body.list[1].deep = false }, TypeError)
      assert.notEqual(vetted.body, nested.body)
      nested.body.list.push('late') // the source can change; the vetted frame cannot follow it
      assert.deepEqual(vetted.body.list, [1, { deep: true }])
    })

    it('a delivered direct-reply frame holds a COPY of any nested value', () => {
      const data = { a: [1, 2] }
      const f = frameForPrincipal(client, { type: 'principal_event', sessionId: 'sess-1', journalId: 'j', journalSeq: 1, ts: 1, eventType: 'm', data }, { sessionExists: () => true })
      assert.notEqual(f.data, data)
      assert.notEqual(f.data.a, data.a)
      f.data.a.push(3)
      assert.deepEqual(data.a, [1, 2])
    })

    it('principal_subscribed lists sessions: every listed session must be granted or the frame is withheld', () => {
      const o = { sessionExists: () => true }
      const sess = (ids) => ({ type: 'principal_subscribed', requestId: 'r', sessions: ids.map((sessionId) => ({ sessionId, journalId: 'j', headSeq: 0 })) })
      assert.ok(frameForPrincipal(client, sess(['sess-1']), o))
      assert.equal(frameForPrincipal(client, sess(['sess-1', 'sess-2']), o), null)
      assert.equal(frameForPrincipal(client, { type: 'principal_subscribed', requestId: 'r', sessions: 'x' }, o), null)
    })

    it('a grant revoked between vetting and sending is honoured', () => {
      const c = principalClient({ principal: { constraints: { sessionIds: ['sess-1'] } } })
      const vetted = vet(c)
      assert.equal(frameForPrincipal(c, vetted, opts), vetted)
      c.principal = { ...c.principal, constraints: { sessionIds: [] } }
      assert.equal(frameForPrincipal(c, vetted, opts), null)
    })
  })
})

describe('principal dispatch through handleSessionMessage', () => {
  const sessions = { 'sess-1': { cwd: '/tmp/a' } }

  it('an allowed type with an exact envelope reaches its handler for a principal (positive control)', async () => {
    const original = REAL_HANDLERS.input
    let reached = 0
    registerMessageHandler('input', () => { reached++ })
    try {
      const { ctx, sent } = plainCtx({ sessions })
      await handleSessionMessage({}, principalClient(), { type: 'input', sessionId: 'sess-1', clientMessageId: 'm1', data: 'hi' }, ctx)
      assert.equal(reached, 1)
      assert.deepEqual(sent, [])
    } finally {
      registerMessageHandler('input', original)
    }
  })

  it('a denied type never reaches its handler for a principal', async () => {
    const original = REAL_HANDLERS.terminal_input
    let reached = 0
    registerMessageHandler('terminal_input', () => { reached++ })
    try {
      const { ctx, sent } = plainCtx({ sessions })
      await handleSessionMessage({}, principalClient(), { type: 'terminal_input', sessionId: 'sess-1', data: 'x' }, ctx)
      assert.equal(reached, 0)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].code, 'scope_denied')
      assert.equal('boundSessionId' in sent[0], false, 'not the bound refusal')
    } finally {
      registerMessageHandler('terminal_input', original)
    }
  })

  it('a handler registered at runtime and never classified is unavailable to a principal', async () => {
    let ran = false
    registerMessageHandler('zz_unclassified_principal_probe', () => { ran = true })
    const { ctx, sent } = plainCtx({ sessions })
    await handleSessionMessage({}, principalClient(), { type: 'zz_unclassified_principal_probe' }, ctx)
    assert.equal(ran, false)
    assert.equal(sent[0].code, 'scope_denied')
    // A client with no stamp (unbound host) still reaches it.
    await handleSessionMessage({}, { id: 'u', boundSessionId: null }, { type: 'zz_unclassified_principal_probe' }, ctx)
    assert.equal(ran, true)
  })

  it('non-principal invariance: a bound client keeps the bound policy and an unbound client is untouched', async () => {
    const { ctx, sent } = plainCtx({ sessions })
    // bound: a denied type is refused with the bound refusal, an allowed type dispatches
    await handleSessionMessage({}, { id: 'b', boundSessionId: 'sess-1' }, { type: 'revoke_token', requestId: 'r' }, ctx)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].code, 'SESSION_TOKEN_MISMATCH')
    let seen = 0
    registerMessageHandler('client_visible', () => { seen++ })
    await handleSessionMessage({}, { id: 'b', boundSessionId: 'sess-1' }, { type: 'client_visible' }, ctx)
    await handleSessionMessage({}, { id: 'u' }, { type: 'client_visible' }, ctx)
    assert.equal(seen, 2)
    assert.equal(sent.length, 1)
  })
})
