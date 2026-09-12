/**
 * Shared stateless handlers for session/agent runtime-config + readiness
 * messages (model_changed, claude_ready, agent_idle / agent_busy,
 * thinking_level_changed).
 *
 * Extracted from ./misc.ts (issue #6034 — splitting the P2-3 leftover
 * catch-all into cohesively-named slices). Pure move, no logic change.
 * Re-exported from ./index so the public surface is unchanged. See ./index.ts
 * for the stateless-handler contract.
 */

import { isWellFormedThinkingLevel, LEGACY_DEFAULT_THINKING_LEVEL } from '@chroxy/protocol'
import type { ActiveTool, TranscriptBackgroundTask } from '../types'
import { parseStringField, resolveSessionId, type SessionPatch } from './_shared'

// ---------------------------------------------------------------------------
// model_changed
// ---------------------------------------------------------------------------

/** Extract the model value from a `model_changed` message. */
export function handleModelChanged(msg: Record<string, unknown>): { model: string | null } {
  return { model: parseStringField(msg, 'model') }
}

/**
 * #5618 — `model_changed` as a session patch for the shared dispatch table.
 * Targets the resolved session (msg.sessionId, else the active session) and sets
 * its `activeModel`. The `sessionPatchDispatcher` only applies the patch when
 * that session exists, so a stray `model_changed` for an unknown session is a
 * no-op — replacing the two clients' divergent edge fallbacks (the app updated
 * the active session; the dashboard wrote flat `activeModel`). For every normal
 * case (a known target — including the active session, whose flat mirror the
 * dashboard adapter keeps in sync) both clients behave exactly as before.
 */
export function handleModelChangedPatch(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionPatch {
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch: { activeModel: handleModelChanged(msg).model },
  }
}

// ---------------------------------------------------------------------------
// claude_ready
// ---------------------------------------------------------------------------

/**
 * State patch for `claude_ready`.
 *
 * `stoppedAt`/`stoppedCode` are reset to null here so the quiet "Session
 * stopped." status strip introduced for #4879 clears the moment the
 * server reports the child is ready again (typically because the user
 * sent another message after tapping Stop). This is purely additive for
 * sessions that were never stopped — both fields stay null end-to-end.
 */
export function handleClaudeReady(msg?: Record<string, unknown>): {
  claudeReady: true
  stoppedAt: null
  stoppedCode: null
  transcriptBackgroundTasks?: TranscriptBackgroundTask[]
  scheduledWakeup?: { at: number; reason: string } | null
} {
  const patch: ReturnType<typeof handleClaudeReady> = {
    claudeReady: true,
    stoppedAt: null,
    stoppedCode: null,
  }
  // #5431: enriched ready — `backgroundTasks` present (even as []) means the
  // server computed a fresh transcript snapshot, so it is authoritative for
  // BOTH fields: a snapshot with tasks but no wakeup means any previously
  // stored wakeup has fired/been superseded. Absent means a pre-#5431 server
  // or no transcript access — leave the stored fields untouched.
  if (Array.isArray(msg?.backgroundTasks)) {
    patch.transcriptBackgroundTasks = msg.backgroundTasks.filter(
      (t): t is TranscriptBackgroundTask =>
        !!t && typeof t === 'object' &&
        typeof (t as TranscriptBackgroundTask).toolUseId === 'string' &&
        ['bash', 'agent', 'monitor'].includes((t as TranscriptBackgroundTask).kind) &&
        typeof (t as TranscriptBackgroundTask).description === 'string' &&
        Number.isFinite((t as TranscriptBackgroundTask).startedAt),
    )
    const wakeup = msg.scheduledWakeup as { at?: unknown; reason?: unknown } | undefined
    patch.scheduledWakeup =
      wakeup && typeof wakeup.at === 'number' && typeof wakeup.reason === 'string'
        ? { at: wakeup.at, reason: wakeup.reason }
        : null
  }
  return patch
}

// ---------------------------------------------------------------------------
// agent_idle / agent_busy
// ---------------------------------------------------------------------------

/** State patch for `agent_idle`.
 *
 * Also clears `streamingMessageId` so the stop button hides if the agent
 * reaches idle without a closing `stream_end`/`result` (abnormal Agent SDK
 * shutdown). Pre-#3170 the 5s safety timer in `sendInput` recovered this
 * case; post-#3170 the timer is bypassed once `tool_start` bumps the value,
 * so `agent_idle` is the remaining recovery hook. See #3171.
 *
 * #4308 — also clears `activeTools` as a safety net: a missed `tool_result`
 * (server crash mid-turn, dropped broadcast, etc.) would otherwise leave a
 * phantom "Running X" indicator visible for the rest of the session. Idle
 * is a guaranteed turn-boundary, so it's the right place to drop any
 * still-tracked in-flight tools.
 */
export function handleAgentIdle(): {
  isIdle: true
  streamingMessageId: null
  activeTools: ActiveTool[]
} {
  return { isIdle: true, streamingMessageId: null, activeTools: [] }
}

/** State patch for `agent_busy`. */
export function handleAgentBusy(): { isIdle: false } {
  return { isIdle: false }
}

// ---------------------------------------------------------------------------
// session_activity (#4639 / #7518)
// ---------------------------------------------------------------------------

/**
 * Parse a `session_activity` ping into the `isIdle` the server's authoritative
 * `isBusy` implies — the LIVE half of the #4639 resync.
 *
 * `ws-forwarding.js` broadcasts this to every authenticated client on
 * `stream_start` (`isBusy: true`) and `result` (`isBusy: false`), for EVERY
 * session, so it is the only per-session busy channel that moves on a turn
 * boundary (`sessions[].isBusy` from `session_list` is a create/destroy/switch
 * snapshot; flat `isIdle` mirrors the active session alone).
 *
 * Returns `null` — the caller writes nothing — when either field is missing or
 * the wrong type. There is deliberately NO active-session fallback: unlike
 * `agent_idle`, this ping always carries an explicit `sessionId`
 * (`ServerSessionActivitySchema` requires it), and resolving a malformed one
 * onto the active session would apply another session's busy state to the tab
 * the user is looking at.
 *
 * The patch is `isIdle` ALONE. `agent_idle` additionally clears
 * `streamingMessageId` + `activeTools` because it marks a turn BOUNDARY; this is
 * a state reconciliation against a snapshot, and clearing turn-scoped state on
 * it would fight the #7500 replay synthesis and #7508's pending-question resend
 * for fields they own.
 */
export function handleSessionActivity(
  msg: Record<string, unknown>,
): { sessionId: string; isIdle: boolean } | null {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null
  if (!sessionId) return null
  if (typeof msg.isBusy !== 'boolean') return null
  return { sessionId, isIdle: !msg.isBusy }
}

// ---------------------------------------------------------------------------
// thinking_level_changed
// ---------------------------------------------------------------------------

/**
 * #7730 — an OPEN string, not a union of three.
 *
 * This used to be a union of the three Claude levels, with a `Set` that
 * silently COERCED anything else to the first of them. That coercion is the
 * defect: the server has just CONFIRMED a level the session actually entered
 * (codex reports `xhigh` from the operator's own `~/.codex/config.toml`), and
 * the store threw it away and rendered "Auto" — a control reporting a state
 * the session is not in, with no error anywhere. The roster is per-model and lives on the model's
 * catalog row; the store keeps whatever the server confirmed.
 */
export type ThinkingLevel = string

/**
 * Extract the thinking level from a `thinking_level_changed` message.
 *
 * The only check left is the SYNTACTIC one shared with the wire schema and the
 * server gate (`isWellFormedThinkingLevel`: 1-32 chars of `[A-Za-z0-9_-]`) —
 * it bounds what a compromised or buggy server can push into a React `value`
 * prop and a persisted store, without pretending to know which levels exist.
 * A missing, malformed or oversized value falls back to the legacy default
 * rather than being carried: that is "the server said nothing usable", which is
 * a different thing from "the server named a level this client has not heard
 * of" — the latter is now kept verbatim.
 */
export function handleThinkingLevelChanged(msg: Record<string, unknown>): { level: ThinkingLevel } {
  const raw = parseStringField(msg, 'level')
  return { level: isWellFormedThinkingLevel(raw) ? raw : LEGACY_DEFAULT_THINKING_LEVEL }
}
