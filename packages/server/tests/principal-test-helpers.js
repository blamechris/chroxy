/**
 * Fixtures for the agent-principal policy tests (principal-policy.js).
 *
 * No client can carry a principal stamp until S1 lands, so these tests stamp the
 * client record directly, with the shape of contract §3.1 item 1:
 * `{ principalId, label, tier, scope, constraints }`, `isPrimaryToken = false`
 * and a fixed non-empty sentinel in `boundSessionId`.
 */

import { inputHandlers } from '../src/handlers/input-handlers.js'
import { sessionHandlers } from '../src/handlers/session-handlers.js'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { fileHandlers } from '../src/handlers/file-handlers.js'
import { ideHandlers } from '../src/handlers/ide-handlers.js'
import { conversationHandlers } from '../src/handlers/conversation-handlers.js'
import { checkpointHandlers } from '../src/handlers/checkpoint-handlers.js'
import { repoHandlers } from '../src/handlers/repo-handlers.js'
import { featureHandlers } from '../src/handlers/feature-handlers.js'
import { evaluatorHandlers } from '../src/handlers/evaluator-handlers.js'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { githubWebhookHandlers } from '../src/handlers/github-webhook-handlers.js'
import { summarizeHandlers } from '../src/handlers/summarize-handlers.js'
import { pairingHandlers } from '../src/handlers/pairing-handlers.js'
import { tokenHandlers } from '../src/handlers/token-handlers.js'
import { orchestrationHandlers } from '../src/handlers/orchestration-handlers.js'
import { schedulerHandlers } from '../src/handlers/scheduler-handlers.js'
import { sessionPrStatusHandlers } from '../src/handlers/session-pr-status-handlers.js'
import { sessionPrThreadsHandlers } from '../src/handlers/session-pr-threads-handlers.js'
import { daemonUpdateHandlers } from '../src/handlers/daemon-update-handlers.js'

/**
 * type -> real handler function, assembled from the same handler modules
 * ws-message-handlers.js registers. A test calls one DIRECTLY, with dispatch
 * bypassed, to prove the handler refuses a principal on its own. The roster test
 * asserts this table's keys equal `registeredMessageTypes`, so it cannot drift.
 */
export const REAL_HANDLERS = Object.freeze(Object.assign({},
  inputHandlers, sessionHandlers, settingsHandlers, fileHandlers, ideHandlers,
  conversationHandlers, checkpointHandlers, repoHandlers, featureHandlers, evaluatorHandlers,
  controlRoomHandlers, githubWebhookHandlers, summarizeHandlers, pairingHandlers, tokenHandlers,
  orchestrationHandlers, schedulerHandlers, sessionPrStatusHandlers, sessionPrThreadsHandlers,
  daemonUpdateHandlers))

/** A stand-in for the S1 sentinel: fixed, non-empty, opaque, equal to no session id. */
export const SENTINEL = 'principal-sentinel-7f3a9c'

/** A principal-stamped client record. `over` replaces top-level fields. */
export function principalClient(over = {}) {
  const { principal: principalOver, ...rest } = over
  return {
    id: 'principal-client-1',
    authenticated: true,
    isPrimaryToken: false,
    boundSessionId: SENTINEL,
    activeSessionId: null,
    subscribedSessionIds: new Set(),
    principal: {
      principalId: 'pr-1',
      label: 'supervisor',
      tier: 'answer',
      scope: 'answer',
      constraints: { sessionIds: ['sess-1'] },
      ...principalOver,
    },
    ...rest,
  }
}

/** A host (unbound, primary-token) client record. */
export function hostClient(over = {}) {
  return {
    id: 'host-client-1',
    authenticated: true,
    isPrimaryToken: true,
    authToken: 'primary-token-value',
    boundSessionId: null,
    activeSessionId: 'sess-1',
    subscribedSessionIds: new Set(['sess-1']),
    ...over,
  }
}

/**
 * A handler context whose namespaces RECORD every property read. A handler that
 * refuses a client before it touches the session manager, the services, the
 * permission manager or the runtime leaves `touched` empty; one that proceeds
 * into its host path reads one of them. `transport.send` is the only thing a
 * refusal may use, and is captured in `sent`.
 *
 * Some handlers read one property before their gate (a feature flag, the session
 * manager's presence). `stubs` supplies a value for such a dotted path, and
 * `tolerate` lists the exact paths whose read is not counted, so the probe still
 * gets as far as the gate and what is recorded is the host path BEYOND it.
 *
 * @param {{ stubs?: Record<string, unknown>, tolerate?: string[] }} [opts]
 * @returns {{ ctx: object, sent: object[], touched: string[] }}
 */
export function recordingCtx({ stubs = {}, tolerate = [] } = {}) {
  const sent = []
  const touched = []
  const note = (path) => { if (!tolerate.includes(path)) touched.push(path) }
  const wrap = (path, value) => {
    if (value === null || typeof value !== 'object') return value
    return new Proxy(value, {
      get: (t, prop, recv) => {
        if (typeof prop === 'symbol') return Reflect.get(t, prop, recv)
        note(`${path}.${prop}`)
        const v = Reflect.get(t, prop, recv)
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
  }
  const spy = (ns) => new Proxy({}, {
    get: (_t, prop) => {
      if (typeof prop === 'symbol') return undefined
      const path = `${ns}.${prop}`
      note(path)
      return Object.hasOwn(stubs, path) ? wrap(path, stubs[path]) : undefined
    },
  })
  const transport = new Proxy({ send: (_ws, m) => { sent.push(m) } }, {
    get: (t, prop) => {
      if (prop === 'send') return t.send
      if (typeof prop === 'symbol') return undefined
      note(`transport.${prop}`)
      return undefined
    },
  })
  const ctx = {
    transport,
    sessions: spy('sessions'),
    services: spy('services'),
    permissions: spy('permissions'),
    runtime: spy('runtime'),
    correlationId: 'corr-1',
  }
  return { ctx, sent, touched }
}

/**
 * A plain handler context with a session manager over `sessions`
 * (`{ id: { cwd } }`) and an optional lease store, a `sent` capture and a `calls`
 * record of every host-side effect a handler could reach.
 */
export function plainCtx({ sessions = {}, leaseFor } = {}) {
  const sent = []
  // Every host-side effect a handler could reach is recorded, so a refusal can
  // assert that NONE happened.
  const calls = []
  const effect = (name) => (...args) => { calls.push({ name, args }) }
  const sessionManager = {
    getSession: (id) => (Object.hasOwn(sessions, id)
      ? {
        name: id,
        cwd: sessions[id].cwd,
        session: {
          cwd: sessions[id].cwd,
          interrupt: effect('session.interrupt'),
          sendMessage: effect('session.sendMessage'),
          setModel: effect('session.setModel'),
          setPermissionMode: effect('session.setPermissionMode'),
          writeTerminalInput: effect('session.writeTerminalInput'),
        },
      }
      : null),
    createSession: effect('sessionManager.createSession'),
    destroySession: effect('sessionManager.destroySession'),
  }
  const ctx = {
    transport: { send: (_ws, m) => { sent.push(m) } },
    sessions: { sessionManager },
    services: leaseFor ? { principalLeases: { leaseFor } } : {},
    runtime: {},
    permissions: {},
    correlationId: 'corr-1',
  }
  return { ctx, sent, calls }
}
