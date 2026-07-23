/**
 * #6764 — semantic session titles (pure logic).
 *
 * The sidebar's auto-generated session title has historically been the raw
 * first user message truncated to ~40 chars at a word boundary. That is a
 * copy of the prompt, not a summary — long or code-heavy first messages produce
 * noisy, low-signal labels. This module produces a short, semantic title from a
 * cheap one-shot model call instead, and ALWAYS falls back to the truncation
 * behaviour when the feature is off, the call fails, or the model returns
 * nothing usable.
 *
 * Everything here is PURE and dependency-free (no provider, no SDK import): the
 * one-shot model runner is INJECTED (`runOneShot`) so the prompt/sanitise/gate
 * logic is unit-testable without a live provider. Production wires
 * `defaultRunOneShot` from summarize-session.js as the runner (reusing the same
 * SDK one-shot + credential plumbing as the #5547 summarizer).
 */

// Truncation-fallback cap — matches the historical `_autoLabelSession` length so
// the fallback label is byte-for-byte what the old behaviour produced.
export const TITLE_MAX_LEN = 40
// Cap for a model-generated title. A well-behaved Haiku reply is ~5-8 words; the
// cap only bites when the model ignores instructions and returns prose.
export const TITLE_MODEL_MAX_LEN = 60
// Default cheap model for the one-shot title call. The short alias resolves to
// the latest Haiku (see claude-model-catalog.js), so it survives model bumps.
export const DEFAULT_SEMANTIC_TITLE_MODEL = 'haiku'
// Default timeout (ms) for the one-shot title call. The call is fire-and-forget,
// so a stalled provider connection must never leave its promise pending forever:
// the closure retains the SessionManager, the first message, and the sessionId,
// so an un-timed-out call is an unbounded per-session leak for opted-in users, and
// the underlying one-shot subprocess is never torn down. The caller passes
// `AbortSignal.timeout(this)` as the `signal` so the call aborts (and the SDK
// tears the subprocess down) and `generateSessionTitle` fails open to the
// truncation label. Server-side only (Node's AbortSignal.timeout).
export const DEFAULT_SEMANTIC_TITLE_TIMEOUT_MS = 15_000

/**
 * Word-boundary truncation used as the ALWAYS-available fallback label. Byte-for
 * -byte compatible with the pre-#6764 `_autoLabelSession` truncation.
 *
 * @param {string} text
 * @param {number} [maxLen=TITLE_MAX_LEN]
 * @returns {string} the label, or '' when the input has no usable text.
 */
export function truncateTitle(text, maxLen = TITLE_MAX_LEN) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!trimmed) return ''
  if (trimmed.length <= maxLen) return trimmed
  const cut = trimmed.lastIndexOf(' ', maxLen)
  return (cut > 10 ? trimmed.slice(0, cut) : trimmed.slice(0, maxLen)) + '...'
}

/**
 * Clean a raw model reply into a usable one-line title. Models occasionally wrap
 * the title in quotes, add a trailing period, prepend prose, or emit multiple
 * lines — this strips all of that and returns '' when nothing usable remains
 * (which the caller treats as "fall back to truncation").
 *
 * @param {string} raw
 * @param {number} [maxLen=TITLE_MODEL_MAX_LEN]
 * @returns {string} a cleaned title, or '' when unusable.
 */
export function sanitizeModelTitle(raw, maxLen = TITLE_MODEL_MAX_LEN) {
  if (typeof raw !== 'string') return ''
  // First non-empty line — models sometimes prepend a preamble or add newlines.
  let line = ''
  for (const l of raw.split('\n')) {
    if (l.trim()) { line = l.trim(); break }
  }
  if (!line) return ''
  // Strip surrounding quotes/backticks (straight or curly) the model wrapped it in.
  line = line.replace(/^["'`“‘]+/, '').replace(/["'`”’]+$/, '').trim()
  // Collapse internal whitespace runs to single spaces.
  line = line.replace(/\s+/g, ' ')
  // Drop a single trailing sentence period, but preserve a real ellipsis ('...').
  line = line.replace(/(?<!\.)\.$/, '').trim()
  if (!line) return ''
  if (line.length <= maxLen) return line
  const cut = line.lastIndexOf(' ', maxLen)
  return (cut > 10 ? line.slice(0, cut) : line.slice(0, maxLen)) + '...'
}

/**
 * Build the one-shot prompt asking for a short semantic title. The first user
 * message is the primary signal; an optional first assistant response can be
 * supplied for extra context. Both are length-capped so the call stays cheap
 * even when the opening message is huge.
 *
 * @param {object} args
 * @param {string} args.firstUserMessage
 * @param {string} [args.firstAssistantResponse]
 * @returns {string}
 */
export function buildTitlePrompt({ firstUserMessage, firstAssistantResponse } = {}) {
  const parts = [
    'Generate a short, specific title (5 to 8 words maximum) that summarizes what this coding session is about, based on the first message below.',
    'Rules:',
    '- Output ONLY the title text: no surrounding quotes, no trailing punctuation, no preamble, no explanation.',
    '- Be concrete — name the actual task, file, feature, or bug. Avoid generic titles like "Help request" or "Coding question".',
    '- Never exceed 8 words.',
    '',
    'First user message:',
    String(firstUserMessage == null ? '' : firstUserMessage).slice(0, 4000),
  ]
  if (typeof firstAssistantResponse === 'string' && firstAssistantResponse.trim()) {
    parts.push('', 'First assistant response (extra context):', firstAssistantResponse.slice(0, 2000))
  }
  parts.push('', 'Title:')
  return parts.join('\n')
}

/**
 * Produce a session title, gated + fail-open.
 *
 * Resolution order:
 *   1. Feature off / no runner / no source text → truncation fallback.
 *   2. Model call succeeds with usable text     → the sanitised semantic title.
 *   3. Model call errors, times out, or returns
 *      nothing usable                            → truncation fallback.
 *
 * The returned `source` lets the caller decide whether to broadcast an update
 * (only a `'model'` title is worth replacing the already-applied truncation).
 *
 * @param {object} args
 * @param {string} args.firstUserMessage
 * @param {string} [args.firstAssistantResponse]
 * @param {boolean} [args.enabled] - feature gate; false → truncation.
 * @param {string} [args.model] - model id/alias for the one-shot.
 * @param {string} [args.cwd] - working dir for the one-shot.
 * @param {Function} [args.runOneShot] - injected model runner ({ prompt, model, cwd, signal }) => Promise<string>.
 * @param {AbortSignal} [args.signal]
 * @param {string} [args.fallback] - precomputed truncation label (else derived from firstUserMessage).
 * @returns {Promise<{ title: string, source: 'model'|'truncation' }>}
 */
export async function generateSessionTitle({
  firstUserMessage,
  firstAssistantResponse,
  enabled,
  model,
  cwd,
  runOneShot,
  signal,
  fallback,
} = {}) {
  const fallbackTitle = typeof fallback === 'string' && fallback
    ? fallback
    : truncateTitle(firstUserMessage)
  const truncated = { title: fallbackTitle, source: 'truncation' }

  if (enabled !== true) return truncated
  if (typeof runOneShot !== 'function') return truncated

  const source = typeof firstUserMessage === 'string' ? firstUserMessage.trim() : ''
  if (!source) return truncated

  try {
    const prompt = buildTitlePrompt({ firstUserMessage: source, firstAssistantResponse })
    const raw = await runOneShot({ prompt, model, cwd, signal })
    const clean = sanitizeModelTitle(raw)
    if (clean) return { title: clean, source: 'model' }
    return truncated
  } catch {
    // Fail open — a failed/timed-out title call must never leave a session
    // unnamed; the truncation label is always good enough.
    return truncated
  }
}
