// PushNotificationHandler (#5368 slice a) — extracted from server-cli.js's
// startCliServer god function.
//
// Owns the entire `session_event` → push-notification path, including the
// per-session idle-push dedupe (#3866) and the four separately-fixed races it
// relocates verbatim:
//   - #3866 — per-session dedupe Set so a duplicate `result` can't double-fire
//     the idle push.
//   - #3870 — latch the dedupe SYNCHRONOUSLY before `send()` returns its
//     promise, so a second `result` in the same tick can't pass the gate twice.
//   - #3871 — the `session_event` listener is registered BEFORE wsServer
//     exists, so a `result` from a restoreState-resurrected session can fire
//     while wsServer is still undefined; read it through `getWsServer()` and
//     guard the undefined case rather than capturing it at construction.
//   - #3872 — reset the dedupe on `tool_start` too (not just `stream_start`),
//     because Codex tool-only turns emit `tool_start` without a `stream_start`.
//
// Constructor-injection seams (sessionManager / pushManager / getWsServer /
// logger) make this unit-testable with fakes — the biggest coverage win of the
// split, since the inline version was impossible to exercise in isolation.

import {
  composeReadyNotificationBody,
  readBackgroundTaskSnapshot,
} from '../notifications/ready-body.js'

export class PushNotificationHandler {
  /**
   * @param {{
   *   sessionManager: import('events').EventEmitter & { getSession: Function },
   *   pushManager: { hasConfiguredSinks: () => boolean, send: Function },
   *   getWsServer: () => ({ authenticatedClientCount: number, hasActiveViewersForSession: Function } | undefined),
   *   logger: { info: Function, warn: Function, error: Function, debug: Function },
   * }} deps
   *   `getWsServer` is a getter (not the instance) because the handler is wired
   *   before wsServer is constructed (#3871).
   */
  constructor({ sessionManager, pushManager, getWsServer, logger }) {
    this._sessionManager = sessionManager
    this._pushManager = pushManager
    this._getWsServer = typeof getWsServer === 'function' ? getWsServer : () => undefined
    this._log = logger

    // #3866 — explicit per-session dedupe for the idle push. Each entry pins
    // "we already sent an idle push for the current active→idle cycle of this
    // session" so a duplicate `result` event (or a race where the gate flips
    // mid-turn) can't produce two OS-level notifications. Cleared when the
    // session next emits `stream_start`/`tool_start` (next busy cycle) or is
    // destroyed.
    this._idleNotifiedSessions = new Set()
  }

  /**
   * Attach the listeners. Call once, after pushManager exists and before
   * wsServer is constructed (so an early restoreState event still routes here —
   * the wsServer-undefined branch handles it, #3871).
   */
  start() {
    this._sessionManager.on('session_event', (e) => this._onSessionEvent(e))
    // The dedupe must clear when a session goes away so a future session that
    // reuses the id can't be wrongly suppressed (the rest of session_destroyed
    // logging stays in server-cli.js).
    this._sessionManager.on('session_destroyed', ({ sessionId }) => {
      this._idleNotifiedSessions.delete(sessionId)
    })
  }

  _onSessionEvent({ sessionId, event, data }) {
    const log = this._log
    const pushManager = this._pushManager
    const sessionManager = this._sessionManager
    const wsServer = this._getWsServer()

    // #5413 Phase 2: gate on "any sink configured" rather than the
    // Expo-only `hasTokens` — a Discord-only setup must not have its
    // notifications suppressed here, upstream of the pipeline. The
    // `hasTokens` fallback keeps legacy fakes/PushManager doubles working.
    const hasSinks = typeof pushManager.hasConfiguredSinks === 'function'
      ? pushManager.hasConfiguredSinks()
      : pushManager.hasTokens

    if (event === 'ready') {
      log.info(`Session ${sessionId} ready: ${data.sessionId} (model: ${data.model})`)
    } else if (event === 'error') {
      log.error(`Session ${sessionId} error: ${data.message}`)
      // Error is already broadcast as { type: 'message', messageType: 'error' } through
      // the forwarding path (ws-forwarding.js → EventNormalizer). Don't also broadcastError()
      // here — that produces a duplicate server_error message on every client.
      // Activity update: error (immediate)
      if (hasSinks) {
        const sessionName = sessionManager.getSession(sessionId)?.name
        pushManager.send('activity_error', 'Session error', data.message, {
          sessionId,
          sessionName,
          state: 'error',
          detail: data.message,
        })
      }
    } else if (event === 'result' && data.cost != null) {
      log.info(`Session ${sessionId} query: $${data.cost.toFixed(4)} in ${data.duration}ms`)
      // Note: this arm used to ALSO fire an 'idle' push here ("Claude is waiting")
      // for the same unattended-completion case that the activity_update push below
      // already covers. Because the two pushes used different rate-limit buckets
      // (idle=60s, activity_update=10s) they never deduped each other, so every
      // unattended completion produced two OS-level notifications on the phone.
      // Removed in favor of the single activity_update fire below.
    } else if (event === 'result') {
      // result without cost (e.g. Gemini providers) — log duration if available
      if (data.duration != null) {
        log.info(`Session ${sessionId} query completed in ${data.duration}ms`)
      }
    } else if (event === 'budget_warning') {
      log.warn(`Budget warning: ${data.message}`)
    } else if (event === 'budget_exceeded') {
      log.warn(`Budget exceeded: ${data.message}`)
    }

    // Reset the idle-push dedupe at the start of each busy cycle (#3866).
    // Different providers emit different "session became busy" signals:
    //   - SDK / Claude CLI turns typically fire stream_start first
    //   - Codex tool-only turns can fire tool_start without any stream_start
    //     (see codex-session.js _processJsonlLine — `item.type === 'tool_call'`
    //     emits tool_start unconditionally)
    // Without clearing on tool_start, a Codex turn that runs a tool and
    // returns no streamed text would leave the dedupe latched, and the
    // *next* turn's result would be wrongly suppressed as "already
    // notified" (#3872, Copilot review).
    if (event === 'stream_start' || event === 'tool_start') {
      this._idleNotifiedSessions.delete(sessionId)
    }

    // Push notifications for actionable events only (#2612)
    // Intermediate events (stream_start, tool_start) no longer trigger pushes.
    if (!hasSinks && (event === 'result' || event === 'permission_request' || event === 'user_question')) {
      // #3866 diagnostic — silently dropping a push because no delivery
      // channel is configured (no push token ever registered, no Discord
      // webhook) is the most common "I'm getting nothing" failure mode.
      // Surface it at debug so operators can confirm registration happened
      // on their last connect.
      log.debug(`Push suppressed for ${event} on ${sessionId}: no configured notification sinks`)
    }
    if (hasSinks) {
      if (event === 'result') {
        // Session idle push (#3866). Gate on noActiveViewers so the user
        // isn't pinged while actively chatting with this session. The
        // per-session dedupe Set prevents a duplicate `result` from
        // firing twice for the same active→idle transition.
        if (wsServer) {
          const noClients = wsServer.authenticatedClientCount === 0
          const noActiveViewers = !noClients && !wsServer.hasActiveViewersForSession(sessionId)
          const allowed = noClients || noActiveViewers
          const alreadyNotified = this._idleNotifiedSessions.has(sessionId)
          if (allowed && !alreadyNotified) {
            const session = sessionManager.getSession(sessionId)
            const sessionName = session?.name
            // #5438 — enrich the idle body with the #5436 background-task
            // snapshot ("still watching: <task>" / "resumes at HH:MM").
            // Absent snapshot (session type doesn't expose one, or the
            // transcript scan degraded) = no information → body unchanged.
            // The body rides the pipeline to every sink, so the Expo push
            // and the Discord status embed both pick this up.
            const body = composeReadyNotificationBody(readBackgroundTaskSnapshot(session))
            // #3870: latch SYNCHRONOUSLY before send() returns its promise
            // so a second `result` arriving in the same tick can't double-
            // fire (passes the !alreadyNotified gate twice). `send()` now
            // returns a Promise<boolean> — `false` means Expo hard-failed
            // (non-2xx or network throw, both caught inside _sendToTokenSet
            // and surfaced via this return value, NOT via rejection since
            // _sendToTokenSet swallows the throw). On hard failure, log at
            // warn and RELEASE the latch so the next active→idle cycle gets
            // a fresh chance — without this the user was silently dropped
            // *and* permanently latched until the session went busy again.
            this._idleNotifiedSessions.add(sessionId)
            Promise.resolve(
              pushManager.send('activity_update', 'Session idle', body, {
                sessionId,
                sessionName,
                state: 'idle',
                ...(data.duration != null && { elapsed: data.duration }),
              })
            ).then(ok => {
              if (ok === false) {
                log.warn(`Idle push send failed for ${sessionId} (Expo hard failure)`)
                this._idleNotifiedSessions.delete(sessionId)
              }
            }).catch(err => {
              // Defensive — _sendToTokenSet should never throw, but if a
              // future refactor lets one escape, treat it as hard failure.
              log.warn(`Idle push send failed for ${sessionId}: ${err?.message || err}`)
              this._idleNotifiedSessions.delete(sessionId)
            })
          } else if (!allowed) {
            // Diagnostic for #3866: surface why a push was suppressed so we
            // can tell registration failures apart from "user is viewing".
            log.debug(`Idle push suppressed for ${sessionId}: active viewers present`)
          } else if (alreadyNotified) {
            log.debug(`Idle push suppressed for ${sessionId}: already notified this turn`)
          }
        } else {
          // #3871: session_event listener is registered BEFORE wsServer is
          // constructed, so a result event from a restoreState-resurrected
          // session can fire while wsServer is still undefined. Surface that
          // here at debug so it's not silently dropped — same diagnostic
          // discipline as the no-tokens / active-viewers / already-notified
          // branches above (#3866).
          log.debug(`Idle push suppressed for ${sessionId}: wsServer not yet initialized`)
        }
      } else if (event === 'permission_request') {
        const sessionName = sessionManager.getSession(sessionId)?.name
        pushManager.send('activity_waiting', 'Waiting for approval', `Permission needed: ${data.tool}`, {
          sessionId,
          sessionName,
          state: 'waiting',
          detail: data.tool,
        })
      } else if (event === 'user_question') {
        const sessionName = sessionManager.getSession(sessionId)?.name
        pushManager.send('activity_waiting', 'Input needed', 'Claude has a question', {
          sessionId,
          sessionName,
          state: 'waiting',
        })
      } else if (event === 'inactivity_warning') {
        // #3899: soft inactivity warning replaces the pre-#3899 kill-on-
        // timeout behaviour. Push regardless of active-viewer state — a
        // viewer with the dashboard open but AFK still benefits from the
        // device-level nudge. (The transient UI chip in the dashboard
        // covers the actively-watching case.)
        const sessionName = sessionManager.getSession(sessionId)?.name
        pushManager.send('inactivity_warning', 'Agent quiet for a while', 'Tap to check in', {
          sessionId,
          sessionName,
          state: 'idle_warning',
          prefab: data.prefab,
          idleMs: data.idleMs,
        })
      }
    }
  }
}
