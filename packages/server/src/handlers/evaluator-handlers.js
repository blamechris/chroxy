/**
 * Prompt evaluator WS handler (#3068, Step 1 of the ladder).
 *
 * Handles: evaluate_draft
 *
 * The handler is intentionally thin — all evaluation logic lives in
 * prompt-evaluator.js. Here we only:
 *   - validate the inbound message shape
 *   - resolve the active session (for cwd context — optional, evaluation
 *     works without it)
 *   - call evaluateDraft and shape the response
 *   - propagate the requestId so the dashboard can correlate
 */
import { createLogger } from '../logger.js'
import { resolveSession } from '../handler-utils.js'
import { evaluateDraft as defaultEvaluateDraft } from '../prompt-evaluator.js'

const log = createLogger('ws')

// Cap the draft we'll forward to the evaluator. A 50KB draft is already
// pathological for a "what should I send" check; protect both the model bill
// and our own message-size budget.
const MAX_DRAFT_BYTES = 50 * 1024

async function handleEvaluateDraft(ws, client, msg, ctx) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null
  const draft = typeof msg?.draft === 'string' ? msg.draft : ''

  if (!draft.trim()) {
    ctx.send(ws, {
      type: 'evaluate_draft_result',
      requestId,
      error: { code: 'INVALID_DRAFT', message: 'evaluate_draft requires a non-empty draft string' },
    })
    return
  }

  if (Buffer.byteLength(draft, 'utf8') > MAX_DRAFT_BYTES) {
    ctx.send(ws, {
      type: 'evaluate_draft_result',
      requestId,
      error: {
        code: 'DRAFT_TOO_LARGE',
        message: `Draft exceeds ${Math.round(MAX_DRAFT_BYTES / 1024)}KB limit for evaluation`,
      },
    })
    return
  }

  // Optional: include the active session's cwd so the evaluator can ground
  // ambiguity in the project context. Evaluation works without it; if there's
  // no session bound, we just skip the cwd field.
  const entry = resolveSession(ctx, msg, client)
  const cwd = entry?.session?.cwd || null

  // Tests can inject `ctx.evaluateDraft` to stub the network call without
  // patching modules; production code never sets it and falls through to the
  // real evaluator.
  const evaluator = typeof ctx?.evaluateDraft === 'function' ? ctx.evaluateDraft : defaultEvaluateDraft

  let result
  try {
    result = await evaluator({ draft, cwd })
  } catch (err) {
    log.warn(`evaluate_draft failed (${err.code || 'UNKNOWN'}): ${err.message}`)
    ctx.send(ws, {
      type: 'evaluate_draft_result',
      requestId,
      error: { code: err.code || 'EVALUATOR_ERROR', message: err.message },
    })
    return
  }

  ctx.send(ws, {
    type: 'evaluate_draft_result',
    requestId,
    verdict: result.verdict,
    rewritten: result.rewritten,
    clarification: result.clarification,
    reasoning: result.reasoning,
  })
}

export const evaluatorHandlers = {
  evaluate_draft: handleEvaluateDraft,
}
