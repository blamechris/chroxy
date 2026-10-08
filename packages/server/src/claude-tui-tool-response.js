import { formatWriteConfirmation } from './built-in-tools/tool-transforms.js'

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
 * Order of preference (see the #8082 PR review, Critical #1 — a plain
 * string `content` field is AMBIGUOUS and its priority relative to the
 * Write-shape check is load-bearing; a fixture that pins this ordering
 * lives in the test suite as the "rule order" regression case):
 *
 *   1a. A `content` field that is an ARRAY of `{ type: 'text', text }`
 *       blocks — this shape is unambiguous (Write/Edit/Bash/Read never
 *       produce it) and always wins: it's the exact shape emitToolResults()
 *       flattens, and it's what an MCP `{ content: [...], isError }` tool
 *       response carries verbatim.
 *   1b. A `content` field that is a STRING — used as-is, UNLESS the object
 *       is shaped like the built-in Write tool's result (see
 *       `isFileWriteResponseShape`), in which case this branch is skipped
 *       and rule 2 handles it instead. Grep's content-mode result
 *       (`{ mode: 'content', content: '<rg output>', numLines }`) and a
 *       string-content MCP response both qualify here; Write's result also
 *       carries a string `content` field, but there it is the ENTIRE
 *       written file, not a flattened summary — the whole reason this rule
 *       needs the Write-shape exclusion (#8082 review, Critical #1).
 *   2. The known built-in Write shape: `{ type: 'create'|'update', filePath,
 *      content, structuredPatch, originalFile, userModified }` — rendered as
 *      the SAME short confirmation text `byok-tool-executor.js`'s `runWrite`
 *      already produces for a successful write (`formatWriteConfirmation`,
 *      built-in-tools/tool-transforms.js), never the file body. Checked
 *      BEFORE the Bash/Read unwraps below too — not just before rule 1b —
 *      so a (pathological, never real) object that happened to satisfy both
 *      the Write shape and a Bash/Read shape still renders the Write
 *      confirmation, never the file body misread as stdout/file content.
 *   3. The known built-in Bash shape: `{ stdout, stderr, interrupted,
 *      isImage, noOutputExpected }`.
 *   4. The known built-in Read shape: `{ type: 'text', file: { content } }`.
 *   4b. (checked right after rule 1a) `{ type: 'file_unchanged', file: {
 *      filePath } }` — a repeated Read of an unchanged file — rendered as
 *      "File unchanged since it was last read (<path>)" (#8252).
 *   5. Anything else — unchanged from before this normalizer existed:
 *      `JSON.stringify(resp)`. This is a deliberate no-regression floor: an
 *      unrecognised structured shape must render exactly as it did before,
 *      never worse.
 *
 * KNOWN LIMITATION (not a regression — see the #8082 PR review, Suggestion
 * #3): an array `content` mixing a `{ type: 'image', ... }` block with text
 * blocks silently drops the image block with no placeholder (unlike Bash's
 * `isImage: true`, which renders `[Image output omitted]`). Before this
 * normalizer existed the whole envelope was JSON.stringify-d — including raw
 * base64 — so this is not worse than before, but it means MCP tool results
 * get parity with SdkSession/CliSession for TEXT content only; a real
 * `tool_result` event carries images via a separate `images` array
 * (tool-result.js's `emitToolResults`) that claude-tui's `tool_result` event
 * has no field for at all today.
 *
 * @param {string} toolName
 * @param {unknown} resp - `payload.tool_response` from a PostToolUse hook.
 * @returns {string}
 */
export function normalizeClaudeTuiToolResponse(toolName, resp) {
  if (typeof resp === 'string') return resp
  if (resp === null || resp === undefined) return ''
  if (typeof resp !== 'object') return ''

  // Rule 1a — array-of-text-blocks content ALWAYS qualifies. This shape is
  // unambiguous: Write/Edit/Bash/Read never produce it, so checking it
  // unconditionally (before the Write-shape check even runs) cannot regress
  // anything.
  const fromArrayContent = flattenArrayContent(resp.content)
  if (fromArrayContent !== null) return fromArrayContent

  // Rule 4b, checked right after rule 1a (#8252) — a repeated Read of a file that has not changed. Claude
  // Code answers with `{ type: 'file_unchanged', file: { filePath } }` instead of
  // the content, and the model is told to refer to the earlier read. Shape-
  // matched, not tool-matched: the type tag is unambiguous.
  if (resp.type === 'file_unchanged') return normalizeFileUnchangedResponse(resp)

  // The Write-shape check MUST be computed (and consulted by rule 1b)
  // BEFORE a string `content` field is allowed to win. Reversing this —
  // checking Bash/Read/Write shapes only after an unconditional string
  // rule 1 — is exactly the regression the #8082 PR review found: Write's
  // structured result carries a string `content` field (the entire file),
  // and an unscoped rule 1 renders it verbatim instead of a short
  // confirmation. See the "rule order" mutant in the test suite for the
  // fixture that pins this.
  const isWriteShape = isFileWriteResponseShape(resp)

  // Rule 1b — a plain string `content` field, when the object is NOT
  // shaped like a Write result (Grep content-mode, string-content MCP).
  if (typeof resp.content === 'string' && !isWriteShape) {
    return resp.content
  }

  // The Write-shape check ALSO has to win over the Bash/Read tool-specific
  // unwraps below, not just over rule 1b — a pathological object could in
  // principle satisfy both isFileWriteResponseShape AND
  // normalizeBashResponse's "has stdout or stderr" test (or Read's file.content
  // test); Write must still take priority so its `content` (the whole file)
  // is never mistaken for stdout/file-content text. A genuine Bash/Read
  // result never carries filePath/structuredPatch/type:create|update, so
  // this ordering has NO effect on any real tool response — see the
  // "rule-order regression" fixtures in the test suite that pin it.
  if (isWriteShape) {
    return normalizeWriteResponse(resp)
  }

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
 * Flatten a tool_result-block-shaped `content` field that is an ARRAY of
 * `{ type: 'text', text }` blocks, the same way tool-result.js's
 * `emitToolResults` flattens `block.content`: filtered to `type: 'text'`
 * blocks and joined with `\n`. Returns null when `content` is not an array,
 * or is an array with no text block at all (so the caller falls through to
 * the Write-shape check / a tool-specific unwrap), NOT when it flattens to
 * an empty string (a legitimately empty text result is a valid result).
 *
 * Deliberately does NOT handle a string `content` — that branch is
 * ambiguous (see `normalizeClaudeTuiToolResponse`'s rule 1b) and is decided
 * by the caller together with `isFileWriteResponseShape`, not here.
 *
 * @param {unknown} content
 * @returns {string|null}
 */
function flattenArrayContent(content) {
  if (!Array.isArray(content)) return null
  const hasTextBlock = content.some((b) => b && typeof b === 'object' && b.type === 'text')
  if (!hasTextBlock) return null
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/**
 * Does `resp` look like the built-in Write tool's structured result —
 * `{ type: 'create'|'update', filePath, content, structuredPatch,
 * originalFile, userModified }` — where `content` is the ENTIRE written
 * file, not a flattened model-facing summary?
 *
 * Checked by shape rather than tool name: `type: 'create'|'update'` AND a
 * string `content`. Both are required. `filePath` or `structuredPatch` alone
 * is NOT enough, because Edit's result carries both (`{ filePath, oldString,
 * newString, originalFile, structuredPatch, … }`) and has no `content`;
 * matching it here would render "Wrote 0 bytes to <path>", a false
 * statement, where Edit's unchanged fallback is at least accurate.
 *
 * @param {Record<string, unknown>} resp
 * @returns {boolean}
 */
function isFileWriteResponseShape(resp) {
  return (resp.type === 'create' || resp.type === 'update') && typeof resp.content === 'string'
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
 *   `flattenArrayContent` above and tool-result.js's own image
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

/**
 * Render the built-in Write tool's structured result — `{ type:
 * 'create'|'update', filePath, content, structuredPatch, originalFile,
 * userModified }` — as the SAME short confirmation text
 * `byok-tool-executor.js`'s `runWrite` already produces for a successful
 * write, via the shared `formatWriteConfirmation` helper
 * (built-in-tools/tool-transforms.js). NEVER the file body (#8082 PR
 * review, Critical #1) — `resp.content` here is the entire written file,
 * which is exactly why this function exists instead of letting rule 1b
 * render it.
 *
 * `bytesWritten` isn't carried on the hook's `tool_response` the way it is
 * on `byok-tool-executor.js`'s own write result, so it's derived from the
 * written content's UTF-8 byte length — the same measure `writeFileTool`
 * itself reports for an ordinary write.
 *
 * Only called when `isFileWriteResponseShape(resp)` is true — which can
 * match on `structuredPatch` or `type` alone, so `filePath` is NOT
 * guaranteed to be present here. A missing/non-string `filePath` or
 * `content` still renders a confirmation (empty path / `0` bytes
 * respectively) rather than throwing.
 *
 * @param {Record<string, unknown>} resp
 * @returns {string}
 */
function normalizeWriteResponse(resp) {
  const content = typeof resp.content === 'string' ? resp.content : ''
  return formatWriteConfirmation({
    bytesWritten: Buffer.byteLength(content, 'utf8'),
    filePath: typeof resp.filePath === 'string' ? resp.filePath : '',
    created: resp.type === 'create',
  })
}

/**
 * Render the built-in Read tool's repeated-read result — `{ type:
 * 'file_unchanged', file: { filePath } }` — as one plain sentence naming the
 * file, instead of the JSON envelope (#8252). A missing path drops the
 * parenthetical rather than printing an empty one.
 *
 * @param {Record<string, unknown>} resp
 * @returns {string}
 */
function normalizeFileUnchangedResponse(resp) {
  const filePath = resp.file && typeof resp.file === 'object' && typeof resp.file.filePath === 'string'
    ? resp.file.filePath
    : ''
  return filePath
    ? `File unchanged since it was last read (${filePath})`
    : 'File unchanged since it was last read'
}
