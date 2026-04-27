/**
 * Prompt evaluator (#3068, Step 1 of the ladder).
 *
 * Single-shot Claude call that evaluates a user's draft message and returns
 * one of three verdicts:
 *
 *   - 'forward'  — the draft is clear, send as-is
 *   - 'rewrite'  — the draft is vague; here's a sharpened version
 *   - 'clarify'  — the draft is ambiguous in a way only the user can resolve
 *
 * This is the on-demand variant invoked from the dashboard "Evaluate" button.
 * The auto-intercept-every-message variant proposed in the original issue is
 * deliberately deferred until we measure whether the manual variant actually
 * gets used (Step 2 of the ladder).
 *
 * Auth: reads ANTHROPIC_API_KEY from the environment. We don't try to share
 * Claude Code's OAuth credentials here — a Step 1.5 follow-up can add that
 * if missing-key turns out to be the dominant friction point.
 */
import Anthropic from '@anthropic-ai/sdk'
import { createLogger } from './logger.js'

const log = createLogger('prompt-evaluator')

// Stable default; user can override via CHROXY_EVALUATOR_MODEL. We default to
// opus because the evaluator's job is to catch things a cheaper session model
// would miss — using a less capable evaluator defeats the point of the feature.
const DEFAULT_MODEL = 'claude-opus-4-5'

// Cap the response so a runaway evaluator can't burn the whole context window
// on its 'reasoning' field.
const MAX_OUTPUT_TOKENS = 1024

const SYSTEM_PROMPT = `You are a prompt evaluator. A user is about to send the draft below to a coding assistant. Your job is to decide ONE of three outcomes:

1. "forward"  — The draft is clear and well-specified. The assistant has enough to act.
2. "rewrite"  — The draft is vague, under-specified, or would clearly produce a better result if sharpened. Provide a tightened rewrite.
3. "clarify"  — The draft is ambiguous in a way only the user can resolve (e.g. multiple valid interpretations, missing critical context). Provide a focused clarifying question.

Be conservative. Prefer "forward" unless there is a real improvement to be made — most everyday prompts ("yes do it", "fix that bug", "go ahead") are fine as-is. Reserve "rewrite" for cases where you can materially improve the chance of a good answer. Reserve "clarify" for genuine ambiguity, not for asking the user to write more.

You MUST reply with a single JSON object and nothing else. No prose before or after. Schema:

{
  "verdict": "forward" | "rewrite" | "clarify",
  "rewritten": string | null,
  "clarification": string | null,
  "reasoning": string
}

Rules:
- "rewritten" MUST be a non-empty string when verdict is "rewrite", and null otherwise.
- "clarification" MUST be a non-empty, single-question string when verdict is "clarify", and null otherwise.
- "reasoning" is always a 1-2 sentence explanation of your decision, addressed to the user.`

const VALID_VERDICTS = new Set(['forward', 'rewrite', 'clarify'])

/**
 * Evaluate a draft user message.
 *
 * @param {object} args
 * @param {string} args.draft - The user's draft message (required, non-empty)
 * @param {string} [args.cwd] - Session cwd, included in the user prompt for context
 * @param {string} [args.model] - Anthropic model id (default: claude-opus-4-5
 *   or value of CHROXY_EVALUATOR_MODEL)
 * @param {string} [args.apiKey] - Anthropic API key (default: ANTHROPIC_API_KEY env)
 * @param {object} [args.client] - Test seam: pre-built Anthropic client (skips
 *   construction). Used by tests to inject a stub.
 * @returns {Promise<{
 *   verdict: 'forward' | 'rewrite' | 'clarify',
 *   rewritten: string | null,
 *   clarification: string | null,
 *   reasoning: string,
 * }>}
 */
export async function evaluateDraft({ draft, cwd, model, apiKey, client } = {}) {
  if (typeof draft !== 'string' || !draft.trim()) {
    throw new Error('evaluateDraft: draft must be a non-empty string')
  }

  const resolvedKey = apiKey || process.env.ANTHROPIC_API_KEY
  if (!client && !resolvedKey) {
    const err = new Error(
      'ANTHROPIC_API_KEY is not set. The prompt evaluator needs an Anthropic API key — set ANTHROPIC_API_KEY in the chroxy server environment to use this feature.',
    )
    err.code = 'EVALUATOR_NO_API_KEY'
    throw err
  }

  const anthropic = client || new Anthropic({ apiKey: resolvedKey })
  const resolvedModel = model || process.env.CHROXY_EVALUATOR_MODEL || DEFAULT_MODEL

  const userMessage = cwd
    ? `Session cwd: ${cwd}\n\nDraft message:\n${draft}`
    : `Draft message:\n${draft}`

  let response
  try {
    response = await anthropic.messages.create({
      model: resolvedModel,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })
  } catch (err) {
    log.warn(`Anthropic API call failed: ${err.message}`)
    const wrapped = new Error(`Evaluator API call failed: ${err.message}`)
    wrapped.code = 'EVALUATOR_API_ERROR'
    wrapped.cause = err
    throw wrapped
  }

  const text = _extractText(response)
  return _parseEvaluatorResponse(text)
}

/**
 * Extract the assistant text from a messages.create response.
 * The SDK returns content as an array of typed blocks; we want the first text block.
 */
function _extractText(response) {
  const blocks = Array.isArray(response?.content) ? response.content : []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text
  }
  return ''
}

/**
 * Parse and validate the model's JSON response.
 * Throws EVALUATOR_BAD_RESPONSE if the response isn't usable so the handler
 * can surface a specific error to the client instead of silently 'forward'-ing.
 */
function _parseEvaluatorResponse(text) {
  const trimmed = (text || '').trim()
  if (!trimmed) {
    const err = new Error('Evaluator returned an empty response')
    err.code = 'EVALUATOR_BAD_RESPONSE'
    throw err
  }

  // Models occasionally wrap the JSON in ```json fences despite instructions.
  // Strip the most common wrapper before parsing.
  const unwrapped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')

  let parsed
  try {
    parsed = JSON.parse(unwrapped)
  } catch (err) {
    const wrapped = new Error(`Evaluator returned invalid JSON: ${err.message}`)
    wrapped.code = 'EVALUATOR_BAD_RESPONSE'
    throw wrapped
  }

  if (!parsed || typeof parsed !== 'object') {
    const err = new Error('Evaluator response was not a JSON object')
    err.code = 'EVALUATOR_BAD_RESPONSE'
    throw err
  }

  const verdict = parsed.verdict
  if (!VALID_VERDICTS.has(verdict)) {
    const err = new Error(`Evaluator returned an unknown verdict: ${JSON.stringify(verdict)}`)
    err.code = 'EVALUATOR_BAD_RESPONSE'
    throw err
  }

  const rewritten = typeof parsed.rewritten === 'string' && parsed.rewritten.trim()
    ? parsed.rewritten.trim()
    : null
  const clarification = typeof parsed.clarification === 'string' && parsed.clarification.trim()
    ? parsed.clarification.trim()
    : null
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : ''

  if (verdict === 'rewrite' && !rewritten) {
    const err = new Error('Evaluator verdict was "rewrite" but no rewritten text was provided')
    err.code = 'EVALUATOR_BAD_RESPONSE'
    throw err
  }
  if (verdict === 'clarify' && !clarification) {
    const err = new Error('Evaluator verdict was "clarify" but no clarification question was provided')
    err.code = 'EVALUATOR_BAD_RESPONSE'
    throw err
  }

  return { verdict, rewritten, clarification, reasoning }
}
