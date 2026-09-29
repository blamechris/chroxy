/**
 * Normalise a claude-tui PostToolUse hook's `tool_response` into the same
 * kind of flat display text SdkSession/CliSession forward for a tool_result
 * (see tool-result.js's `emitToolResults`).
 *
 * #8082: the PostToolUse hook payload's `tool_response` field is Claude
 * Code's raw structured tool result (the same object the on-disk transcript
 * stores as `toolUseResult`, alongside a `tool_result` content block whose
 * `content` is the flattened text the model actually saw). The claude-tui
 * provider only observes the hook payload, not the transcript's sibling
 * content block, so — unlike SdkSession/CliSession, which read `content`
 * directly off the tool_result block via `emitToolResults` — there is no
 * flattened-text field available here for the built-in tools. This function
 * unwraps the known structured shapes into the same kind of plain text
 * instead of forwarding (and previously, JSON.stringify-ing) the envelope.
 *
 * Order of preference:
 *   1. A `content` field shaped like a tool_result block's own content
 *      (string, or an array of `{ type: 'text', text }` blocks) — this is
 *      the exact shape emitToolResults() flattens, and it is what MCP tool
 *      responses carry verbatim (`{ content, isError }`), so MCP tool
 *      results get full parity with SdkSession/CliSession for free.
 *   2. The known built-in Bash shape: `{ stdout, stderr, interrupted,
 *      isImage, noOutputExpected }`.
 *   3. The known built-in Read shape: `{ type: 'text', file: { content } }`.
 *   4. Anything else — unchanged from today: `JSON.stringify(resp)`. This
 *      is a deliberate no-regression floor: an unrecognised structured
 *      shape must render exactly as it did before this fix, never worse.
 *
 * @param {string} toolName
 * @param {unknown} resp - `payload.tool_response` from a PostToolUse hook.
 * @returns {string}
 */
export function normalizeClaudeTuiToolResponse(toolName, resp) {
  if (typeof resp === 'string') return resp
  if (resp === null || resp === undefined) return ''
  if (typeof resp !== 'object') return String(resp)

  const fromContent = flattenToolResultContent(resp.content)
  if (fromContent !== null) return fromContent

  if (toolName === 'Bash') {
    const bash = normalizeBashResponse(resp)
    if (bash !== null) return bash
  }

  if (toolName === 'Read') {
    const read = normalizeReadResponse(resp)
    if (read !== null) return read
  }

  // Unknown/unmapped shape — unchanged from today's behavior.
  try {
    return JSON.stringify(resp)
  } catch {
    return String(resp)
  }
}

/**
 * Flatten a tool_result-block-shaped `content` field the same way
 * tool-result.js's `emitToolResults` flattens `block.content`: a string is
 * used as-is, an array is filtered to `type: 'text'` blocks and joined with
 * `\n`. Returns null when `content` is absent or not in this shape (so the
 * caller can fall through to a tool-specific unwrap), NOT when it flattens
 * to an empty string (a legitimately empty text result is a valid result).
 *
 * @param {unknown} content
 * @returns {string|null}
 */
function flattenToolResultContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const hasTextBlock = content.some((b) => b && typeof b === 'object' && b.type === 'text')
    if (!hasTextBlock) return null
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  return null
}

/**
 * Unwrap the built-in Bash tool's structured result:
 * `{ stdout, stderr, interrupted, isImage, noOutputExpected }`.
 *
 * - stdout alone → stdout, unchanged (matches the SdkSession/CliSession
 *   shape: a Bash result with no stderr is just the command's output text).
 * - stdout + non-empty stderr → stdout, then stderr on its own line. stderr
 *   must never be silently dropped — that's the whole "Bash cards show
 *   stdout, and stderr when it isn't empty" acceptance criterion.
 * - stderr alone (stdout empty) → stderr by itself, so a failing command
 *   with no stdout still shows *something* rather than a blank card.
 * - both empty + interrupted → a short placeholder rather than a blank
 *   card with no explanation.
 * - both empty, not interrupted → '' (matches ToolBubble's existing
 *   "empty string result renders nothing" contract — nothing ran wrong,
 *   there's just nothing to show).
 * - `isImage: true` → the hook payload carries no actual image bytes for
 *   Bash (unlike Read/MCP image content blocks, which flow through
 *   `flattenToolResultContent` above and tool-result.js's own image
 *   extraction), so `stdout` here is not decodable image data by this
 *   provider today. A placeholder avoids dumping raw/base64 noise into a
 *   plain-text tool card; see the PR for the "Needs live check" note.
 *
 * Returns null when `resp` doesn't carry either of `stdout`/`stderr` as a
 * string at all (not really a Bash-shaped response), so the caller falls
 * through to the generic JSON.stringify floor.
 *
 * @param {Record<string, unknown>} resp
 * @returns {string|null}
 */
function normalizeBashResponse(resp) {
  if (typeof resp.stdout !== 'string' && typeof resp.stderr !== 'string') return null

  const stdout = typeof resp.stdout === 'string' ? resp.stdout : ''
  const stderr = typeof resp.stderr === 'string' ? resp.stderr : ''

  if (resp.isImage === true) {
    return stderr ? `[Image output omitted]\n${stderr}` : '[Image output omitted]'
  }

  if (!stdout && !stderr) {
    return resp.interrupted === true ? '[Interrupted — no output]' : ''
  }

  if (stderr) {
    return stdout ? `${stdout}\n${stderr}` : stderr
  }
  return stdout
}

/**
 * Unwrap the built-in Read tool's structured result:
 * `{ type: 'text', file: { filePath, content, numLines, startLine,
 * totalLines } }`. Returns the file content verbatim, or null when `resp`
 * doesn't carry a `file.content` string (falls through to the generic
 * JSON.stringify floor).
 *
 * @param {Record<string, unknown>} resp
 * @returns {string|null}
 */
function normalizeReadResponse(resp) {
  const file = resp.file
  if (!file || typeof file !== 'object' || typeof file.content !== 'string') return null
  return file.content
}
