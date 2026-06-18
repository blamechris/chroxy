/**
 * Shared stateless handlers for cost-budget messages (budget_warning /
 * budget_exceeded / budget_resumed / budget_resume_ack).
 *
 * Extracted from the handlers barrel (audit P2-3) — pure move, no logic
 * change. Re-exported from ./index so the public surface is unchanged. Each
 * handler builds a `system` ChatMessage note for the budget lifecycle. See
 * ./index.ts for the stateless-handler contract.
 */

import type { ChatMessage } from '../types'
import { nextMessageId } from '../utils'

// ---------------------------------------------------------------------------
// budget_warning
// ---------------------------------------------------------------------------

/** Extract warning text and build a system message for `budget_warning`. */
export function handleBudgetWarning(msg: Record<string, unknown>): {
  warningMessage: string
  systemMessage: ChatMessage
} {
  const warningMessage =
    typeof msg.message === 'string' ? msg.message : 'Approaching cost budget limit'
  return {
    warningMessage,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: warningMessage,
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// budget_exceeded
// ---------------------------------------------------------------------------

/** Extract exceeded text and build a system message for `budget_exceeded`. */
export function handleBudgetExceeded(msg: Record<string, unknown>): {
  exceededMessage: string
  systemMessage: ChatMessage
} {
  const exceededMessage =
    typeof msg.message === 'string' ? msg.message : 'Cost budget exceeded'
  return {
    exceededMessage,
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: `${exceededMessage} — session paused`,
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// budget_resumed
// ---------------------------------------------------------------------------

/** Build a system message for `budget_resumed`. */
export function handleBudgetResumed(): { systemMessage: ChatMessage } {
  return {
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: 'Cost budget override — session resumed',
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// budget_resume_ack (#5752)
// ---------------------------------------------------------------------------

/**
 * Acknowledge an actioned `resume_budget` request.
 *
 * When the session was actually paused (`wasPaused === true`) the server also
 * broadcast a `budget_resumed`, which already injected the "session resumed"
 * note — so the ack adds nothing and returns `{ systemMessage: null }`. When the
 * session was NOT paused the ack is the only feedback the clicking client gets,
 * so it appends a quiet note rather than leaving the control silently dead
 * (e.g. a second client in a shared session tapping Resume after the first
 * already resumed).
 */
export function handleBudgetResumeAck(
  msg: Record<string, unknown>,
): { systemMessage: ChatMessage | null } {
  if (msg.wasPaused === true) return { systemMessage: null }
  return {
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: 'Budget was not paused — nothing to resume',
      timestamp: Date.now(),
    },
  }
}
