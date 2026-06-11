/**
 * #5547 — server-side one-shot session summarizer.
 *
 * Produces a CONTINUATION BRIEF from a session's persisted message history so
 * the operator can right-click a session in the dashboard sidebar, summarize
 * it, and seed a fresh session with the result (cross-session `/compact`).
 *
 * Design:
 *   - History source is the session's `SessionMessageHistory` ring buffer
 *     (the universal, restart-surviving source — works even when the provider
 *     subprocess is gone). Entries are flattened with `extractSearchableText`
 *     from conversation-search.js — NOT re-derived here.
 *   - Long histories are WINDOWED before the model call: a small head sample
 *     plus the most-recent tail, capped at MAX_SUMMARIZE_CHARS. When truncated,
 *     the brief's header says so (and the result carries `truncated: true`).
 *   - Summarization is a ONE-SHOT model call (the SDK `query()` path), NOT a
 *     chat session — a short-lived invocation with no tools. Defaults to the
 *     target session's own model; `summarize.{provider,model}` config overrides.
 *
 * The model invocation is injectable (`runOneShot`) so the windowing/prompt
 * logic is unit-testable without a live provider.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { extractSearchableText } from './conversation-search.js'
import { createLogger } from './logger.js'

const log = createLogger('summarize')

// Cap the summarizer input. The tail (most-recent) gets the lion's share; a
// small head sample preserves the opening goals/context. Chosen to stay well
// inside a cheap model's context while covering the bulk of a long session.
export const MAX_SUMMARIZE_CHARS = 100_000
// Head sample size when the history overflows the cap — enough to capture the
// initial task framing without eating into the recent-tail budget.
export const HEAD_SAMPLE_CHARS = 8_000
// Marker inserted between the head sample and the recent tail when truncated.
const TRUNCATION_MARKER = '\n\n[... earlier conversation omitted (history windowed for summarization) ...]\n\n'

/**
 * Flatten a session's history entries to a single transcript string, reusing
 * `extractSearchableText` per entry. Each entry is prefixed with a coarse role
 * label derived from its chroxy history `type` so the model can tell user turns
 * from assistant/tool output. Entries that flatten to empty text are skipped.
 *
 * @param {Array<object>} history - SessionMessageHistory entries.
 * @returns {string} newline-joined transcript.
 */
export function flattenHistory(history) {
  if (!Array.isArray(history)) return ''
  const lines = []
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue
    // extractSearchableText reads entry.message.content; chroxy history entries
    // store their text on `content`. Normalize so the shared flattener sees a
    // message-shaped object regardless of which source produced the entry.
    const text = entryToText(entry)
    if (!text) continue
    lines.push(`${roleLabel(entry.type)}: ${text}`)
  }
  return lines.join('\n')
}

/**
 * Pull readable text out of one history entry. Tries the shared
 * `extractSearchableText` (JSONL message-shaped entries) first, then falls back
 * to chroxy's ring-buffer shape (`content` string, optional `tool` label).
 *
 * @param {object} entry
 * @returns {string}
 */
function entryToText(entry) {
  // JSONL / message-shaped entry: let the shared flattener handle it.
  const viaShared = extractSearchableText(entry).trim()
  if (viaShared) return viaShared

  // chroxy ring-buffer shape: { type, content, tool?, timestamp }
  const parts = []
  if (typeof entry.tool === 'string' && entry.tool) parts.push(`[${entry.tool}]`)
  if (typeof entry.content === 'string' && entry.content) {
    parts.push(entry.content)
  } else if (Array.isArray(entry.content)) {
    for (const block of entry.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join(' ').trim()
}

/**
 * Coarse role label for a chroxy history entry `type`.
 * @param {string} type
 * @returns {string}
 */
function roleLabel(type) {
  switch (type) {
    case 'user_input': return 'User'
    case 'response': return 'Assistant'
    case 'tool_use': return 'Tool'
    default: return type === undefined || type === null ? 'Entry' : String(type)
  }
}

/**
 * Window a flattened transcript to fit MAX_SUMMARIZE_CHARS. Under the cap the
 * transcript passes through untouched. Over the cap, keep a head sample +
 * the most-recent tail joined by a truncation marker.
 *
 * @param {string} transcript
 * @param {object} [opts]
 * @param {number} [opts.maxChars]
 * @param {number} [opts.headChars]
 * @returns {{ text: string, truncated: boolean }}
 */
export function windowTranscript(transcript, opts = {}) {
  const text = typeof transcript === 'string' ? transcript : ''
  const maxChars = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : MAX_SUMMARIZE_CHARS
  const headChars = Number.isFinite(opts.headChars) && opts.headChars >= 0 ? opts.headChars : HEAD_SAMPLE_CHARS

  if (text.length <= maxChars) {
    return { text, truncated: false }
  }

  // Reserve the head sample + marker; the rest is the most-recent tail.
  const effectiveHead = Math.min(headChars, Math.floor(maxChars / 2))
  const tailBudget = maxChars - effectiveHead - TRUNCATION_MARKER.length
  const head = effectiveHead > 0 ? text.slice(0, effectiveHead) : ''
  const tail = tailBudget > 0 ? text.slice(text.length - tailBudget) : text.slice(text.length - maxChars)
  return { text: `${head}${TRUNCATION_MARKER}${tail}`, truncated: true }
}

/**
 * Build the one-shot prompt asking the model for a continuation brief written
 * for the NEXT session to consume (not prose for a human).
 *
 * @param {object} args
 * @param {string} args.transcript - the (windowed) flattened transcript.
 * @param {boolean} args.truncated - whether the transcript was windowed.
 * @param {string} [args.sessionName] - human label for the source session.
 * @returns {string}
 */
export function buildSummaryPrompt({ transcript, truncated, sessionName }) {
  const truncationNote = truncated
    ? 'NOTE: the transcript below was WINDOWED (a head sample plus the most-recent tail) because the full history exceeded the size cap. State this caveat in your brief\'s header so the next session knows earlier detail may be missing.\n\n'
    : ''
  const label = typeof sessionName === 'string' && sessionName.trim()
    ? ` (source session: "${sessionName.trim()}")`
    : ''
  return [
    `You are writing a CONTINUATION BRIEF${label} so a fresh agent session can pick up this work with no other context.`,
    'Write for the NEXT session to consume — terse, structured, machine-actionable — NOT prose for a human reader.',
    '',
    'Cover, as headed sections, only what the transcript supports:',
    '- Goal / task: what the session set out to do.',
    '- Current state: what is done, in progress, or verified.',
    '- Key decisions: choices made and the reasoning, so they are not relitigated.',
    '- Open threads: unfinished work, known issues, next steps.',
    '- Key file paths: files touched or central to the work (absolute paths where given).',
    '',
    'Be faithful to the transcript; do not invent facts. If a section has nothing, omit it.',
    '',
    truncationNote,
    '--- TRANSCRIPT START ---',
    transcript,
    '--- TRANSCRIPT END ---',
  ].join('\n')
}

/**
 * Default one-shot model runner: the SDK `query()` path with NO tools, a single
 * user prompt, and the result text collected from assistant content blocks.
 * Used when the caller doesn't inject a `runOneShot` seam.
 *
 * @param {object} args
 * @param {string} args.prompt
 * @param {string} [args.model] - model id; omitted lets the SDK pick its default.
 * @param {string} [args.cwd]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<string>} the model's text reply.
 */
export async function defaultRunOneShot({ prompt, model, cwd, signal }) {
  const options = {
    // No tools — a pure text summarization turn. The session must not be able
    // to read/write files or run commands during summarization.
    tools: { type: 'preset', preset: 'empty' },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: false,
    maxTurns: 1,
  }
  if (typeof cwd === 'string' && cwd) options.cwd = cwd
  if (typeof model === 'string' && model) options.model = model
  if (signal) options.abortController = abortControllerFromSignal(signal)

  const parts = []
  const stream = query({ prompt, options })
  for await (const msg of stream) {
    if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
    } else if (msg?.type === 'result' && typeof msg.result === 'string' && parts.length === 0) {
      // Fallback: some SDK builds carry the final text on the result message
      // rather than (or in addition to) assistant blocks.
      parts.push(msg.result)
    }
  }
  return parts.join('').trim()
}

/**
 * Bridge a plain AbortSignal to the SDK's `abortController` option (the SDK
 * wants a controller, not a bare signal). When the upstream signal aborts, we
 * abort the derived controller.
 */
function abortControllerFromSignal(signal) {
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}

/**
 * Summarize a session's history into a continuation brief. Orchestrates
 * flatten → window → prompt → one-shot model call. The model call is injected
 * (`runOneShot`) so this is testable without a provider; production uses
 * `defaultRunOneShot`.
 *
 * @param {object} args
 * @param {Array<object>} args.history - SessionMessageHistory entries.
 * @param {string} [args.model] - model id to summarize with (default: session's).
 * @param {string} [args.cwd] - working dir for the one-shot.
 * @param {string} [args.sessionName] - human label for the brief header.
 * @param {Function} [args.runOneShot] - injected model runner.
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ summary: string, truncated: boolean }>}
 * @throws {Error} when there is no history to summarize or the model returns empty.
 */
export async function summarizeSession({ history, model, cwd, sessionName, runOneShot, signal } = {}) {
  const transcript = flattenHistory(history)
  if (!transcript.trim()) {
    const err = new Error('Session has no readable history to summarize')
    err.reason = 'empty-history'
    throw err
  }

  const { text, truncated } = windowTranscript(transcript)
  const prompt = buildSummaryPrompt({ transcript: text, truncated, sessionName })

  const runner = typeof runOneShot === 'function' ? runOneShot : defaultRunOneShot
  const summary = await runner({ prompt, model, cwd, signal })

  if (typeof summary !== 'string' || !summary.trim()) {
    const err = new Error('The summarizer returned no text')
    err.reason = 'empty-summary'
    throw err
  }

  log.info(`Summarized session${sessionName ? ` "${sessionName}"` : ''}: ${history.length} entries → ${summary.length} chars${truncated ? ' (windowed)' : ''}`)
  return { summary: summary.trim(), truncated }
}
