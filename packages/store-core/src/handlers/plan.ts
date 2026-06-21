/**
 * Shared stateless handlers for plan-mode messages (plan_started / plan_ready
 * / inactivity_warning).
 *
 * Extracted from the handlers barrel (audit P2-3) — pure move, no logic
 * change. Re-exported from ./index so the public surface is unchanged. These
 * resolve a target session and produce SessionPatch updates for the plan
 * lifecycle. See ./index.ts for the stateless-handler contract.
 */

import { parseUnknownArrayField, resolveSessionId } from './_shared'
import type { SessionPatch } from './_shared'

// ---------------------------------------------------------------------------
// plan_started
// ---------------------------------------------------------------------------

/**
 * Resolve target session and produce a patch resetting plan state to idle.
 *
 * Both clients clear `isPlanPending` and `planAllowedPrompts` when the server
 * announces a new plan run is starting. The caller should only apply the
 * patch when `sessionId` is non-null AND maps to an existing session in its
 * own state (matches the prior inline `if (... && sessionStates[id])` guard).
 */
export function handlePlanStarted(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionPatch {
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch: {
      isPlanPending: false,
      planAllowedPrompts: [],
    },
  }
}

// ---------------------------------------------------------------------------
// plan_ready
// ---------------------------------------------------------------------------

/**
 * Single allowed prompt the server attaches to a `plan_ready` message.
 *
 * Note: this is the *expected* server-side shape. The handler below validates
 * only array-ness, NOT per-element shape — matches prior inline behaviour in
 * both clients. Tightening element validation would be a behaviour change and
 * is out of scope for the #2661 mechanical migration.
 */
export interface PlanAllowedPrompt {
  tool: string
  prompt: string
}

/**
 * Resolve target session and produce a patch flipping plan state to "ready".
 *
 * Validates `msg.allowedPrompts` is an array; non-array values fall back to
 * an empty array (matches the prior inline `Array.isArray(...) ? ... : []`).
 * Per-element shape is NOT validated — the cast to `PlanAllowedPrompt[]` is
 * unsafe and matches what both clients did before this migration. If a server
 * regression emits malformed entries, downstream consumers see them verbatim.
 *
 * This handler intentionally produces ONLY the universal state patch. The
 * mobile app additionally pushes a session notification on plan-ready via
 * its own `pushSessionNotification` helper — that's a platform-specific UX
 * concern (the dashboard has no equivalent surface) and stays at the call
 * site. The shared handler exposes `sessionId` so the app can route the
 * notification to the right session without re-resolving.
 */
export function handlePlanReady(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionPatch {
  // Behaviour-preserving unsafe cast (see docstring above). `as unknown as`
  // makes it clear at the call site that the element shape isn't checked.
  const prompts = parseUnknownArrayField(
    msg,
    'allowedPrompts',
  ) as PlanAllowedPrompt[]
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch: {
      isPlanPending: true,
      planAllowedPrompts: prompts,
    },
  }
}

// ---------------------------------------------------------------------------
// inactivity_warning (#3899)
//
// Soft warning fired after `resultTimeoutMs` of silence. The server keeps
// the session alive — pending permissions remain pending, busy state is
// preserved — and asks the client to surface a one-click "Status update?"
// affordance. The handler validates the wire payload (idleMs > 0, prefab
// is a non-empty string) and produces a patch that stores the warning on
// the targeted session. Bad payloads return a null patch so the call site
// can ignore them without crashing.
// ---------------------------------------------------------------------------

/**
 * Upper bound for `idleMs` in the inactivity_warning handler.
 *
 * Mirrors the `MAX_SANE_DURATION_MS = 24h` ceiling that
 * `ServerInactivityWarningSchema` enforces on the wire (see
 * packages/protocol/src/schemas/server.ts). Duplicated as a literal
 * here so store-core stays free of the @chroxy/protocol dependency for
 * mobile build size — protocol is the source of truth, this is the
 * defence-in-depth backstop the handler applies when dashboard /
 * mobile dispatch a message without re-running Zod parse.
 */
const MAX_INACTIVITY_IDLE_MS = 24 * 60 * 60 * 1000

export function handleInactivityWarning(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): SessionPatch | null {
  const idleMsRaw = msg.idleMs
  const prefabRaw = msg.prefab
  if (typeof idleMsRaw !== 'number' || !Number.isFinite(idleMsRaw)) {
    return null
  }
  // Floor BEFORE the threshold check so sub-1ms values (e.g. 0.5) don't
  // sneak past `> 0` and store a stale `idleMs: 0`. The wire schema
  // already requires `.int().positive()`, so this is a defence-in-depth
  // backstop against a malformed payload, not the primary gate.
  const idleMs = Math.floor(idleMsRaw)
  if (idleMs <= 0 || idleMs > MAX_INACTIVITY_IDLE_MS) {
    return null
  }
  if (typeof prefabRaw !== 'string' || !prefabRaw.trim()) {
    return null
  }
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    patch: {
      inactivityWarning: {
        idleMs,
        prefab: prefabRaw,
        receivedAt: Date.now(),
      },
    },
  }
}
