/**
 * The ONE builder of the wire `message` envelope (#6630).
 *
 * A chat message reaches a client two ways: LIVE, as the frame the event
 * normalizer builds the moment a session emits `message` / `error`, and REPLAYED,
 * as the history entry the ring buffer recorded for it. The replay used to be a
 * hand-picked subset of the live frame (content, tool, options, timestamp), so
 * every field added to the live envelope since -- the error `code`,
 * `attemptedResumeId`, `timeoutMs`, the `compact_boundary` / MCP-prompt-expansion
 * markers -- was silently absent from the replay and the client fell back to its
 * generic bubble. Worse, an `error` event was not recorded at all, so an error
 * card vanished on the first session switch.
 *
 * Both paths now build the envelope here: `EventNormalizer` for the live frame,
 * `SessionMessageHistory` for the entry it stores. A field added to a builder
 * reaches both, and the replay-parity fixtures in store-core
 * (`contract-fixtures/replay-parity-data.ts`) prove it.
 */
import { MAX_SANE_DURATION_MS } from '@chroxy/protocol'
import { redactValue } from './redaction.js'

/**
 * #6941 review (Copilot) — coerce+bound a footer-stat numeric field
 * (`thinkingDurationMs` / `thinkingTokens`) before forwarding it onto the
 * wire. Mirrors the protocol schema's
 * `z.number().int().nonnegative().finite()[.max(ceiling)]`: floors a stray
 * fractional value (matches store-core's `parseFiniteNonNegIntField`, which
 * re-guards the same field client-side) and OMITS — never clamps — when the
 * value is negative, non-finite, or exceeds an optional ceiling. A clock
 * jump / suspend producing a bogus multi-day duration should vanish from the
 * footer, not render as an incorrect exact-ceiling number.
 *
 * @param {*} value - candidate value straight off the session event.
 * @param {{ max?: number }} [opts] - optional upper bound (inclusive).
 * @returns {number|undefined}
 */
export function boundedNonNegInt(value, { max } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  const floored = Math.floor(value)
  if (typeof max === 'number' && floored > max) return undefined
  return floored
}

/**
 * #6973 (agent-review on #6970) — coerce+bound `compactMetadata`'s
 * `preTokens`/`postTokens`/`durationMs` sub-fields before forwarding onto
 * the wire, same defense-in-depth as `boundedNonNegInt` above (the #6941
 * thinkingDurationMs pattern) applied field-by-field. Unlike
 * thinkingDurationMs/thinkingTokens (fully optional on the wire), these
 * three sub-fields are `.nullable()` — not `.optional()` — on
 * `ServerCompactMetadataSchema`, so the shape always carries all three keys;
 * an out-of-range/malformed value is coerced to `null` here rather than
 * dropped, matching `parseCompactBoundaryMeta`'s own "null for
 * missing/malformed" convention (claude-stream-parser.js) so a client always
 * gets the stable shape to pattern-match against. `durationMs` is
 * additionally bounded by `MAX_SANE_DURATION_MS` (the same clock-jump guard
 * as `thinkingDurationMs`); `preTokens`/`postTokens` have no documented
 * ceiling — legitimate context windows run into the millions of tokens — so
 * only non-negative-integer coercion applies.
 *
 * @param {{trigger?: *, preTokens?: *, postTokens?: *, durationMs?: *}} meta
 * @returns {{trigger: 'manual'|'auto', preTokens: number|null, postTokens: number|null, durationMs: number|null}}
 */
function boundedCompactMetadata(meta) {
  const boundedOrNull = (value, opts) => {
    const bounded = boundedNonNegInt(value, opts)
    return bounded === undefined ? null : bounded
  }
  return {
    trigger: meta.trigger === 'manual' ? 'manual' : 'auto',
    preTokens: boundedOrNull(meta.preTokens),
    postTokens: boundedOrNull(meta.postTokens),
    durationMs: boundedOrNull(meta.durationMs, { max: MAX_SANE_DURATION_MS }),
  }
}

// #6845: wire-boundary caps for the MCP-prompt expansion marker. server/prompt
// mirror ServerMcpPromptExpansionSchema's 256-char names; `text` mirrors its
// 8192 ceiling. byok-session already caps the display copy (4000 + a
// truncation marker); this is the defense-in-depth re-bound at the serialization
// choke point (same posture as boundedCompactMetadata) so a wire-bypassing or
// malformed producer can't push an unbounded payload onto clients.
const MCP_PROMPT_EXPANSION_NAME_CAP = 256
const MCP_PROMPT_EXPANSION_TEXT_CAP = 8192

// Thread-2/honesty-nit fix (post-#6845 review): the suffix now says the FULL
// text still reached the model, matching byok-session.js's display-cap suffix
// and store-core's client-side re-bound suffix — a reader who only sees the
// truncated marker (mobile, System tab) must not conclude the model saw less
// than it did. Sliced-length arithmetic below subtracts THIS string's actual
// length rather than a hardcoded magic number, so the total (slice + suffix)
// never exceeds the cap even if the wording changes again later.
const MCP_PROMPT_EXPANSION_TRUNCATION_SUFFIX = '\n…(truncated for display; full text sent to the model)'

/**
 * #6845 — coerce+bound the `mcpPromptExpansion` marker fields before forwarding
 * onto the wire. Requires a string `text` (the marker is meaningless without
 * the injected content) — returns `null` when `text` is not a string so the
 * caller skips attaching `subtype`/`mcpPromptExpansion` entirely rather than
 * forwarding a marker with blank/coerced content. This mirrors store-core's
 * `parseMcpPromptExpansion` reject-on-non-string-text contract (post-#6845
 * review thread 1 — the two layers previously disagreed: this function used to
 * silently stringify a non-string `text`, while the client rejected the whole
 * marker; they now agree on reject).
 *
 * `server`/`prompt` are cosmetic provenance labels (not content), so they stay
 * on the more forgiving "coerce" side: a non-string value becomes `''` rather
 * than failing the whole marker, then caps at 256. `text` caps at 8192,
 * appending {@link MCP_PROMPT_EXPANSION_TRUNCATION_SUFFIX} when it overflows so
 * the client never silently drops content; `truncated` stays true if EITHER
 * the producer flagged it or this re-bound truncated.
 *
 * @param {{server?: *, prompt?: *, text?: *, truncated?: *}} meta
 * @returns {{server: string, prompt: string, text: string, truncated: boolean} | null}
 */
function boundedMcpPromptExpansion(meta) {
  if (typeof meta?.text !== 'string') return null
  const asString = (v) => (typeof v === 'string' ? v : '')
  const cap = (s, n) => (s.length > n ? s.slice(0, n) : s)
  const rawText = meta.text
  const overflow = rawText.length > MCP_PROMPT_EXPANSION_TEXT_CAP
  const sliceLen = Math.max(0, MCP_PROMPT_EXPANSION_TEXT_CAP - MCP_PROMPT_EXPANSION_TRUNCATION_SUFFIX.length)
  const text = overflow
    ? `${cap(rawText, sliceLen)}${MCP_PROMPT_EXPANSION_TRUNCATION_SUFFIX}`
    : rawText
  return {
    server: cap(asString(meta?.server), MCP_PROMPT_EXPANSION_NAME_CAP),
    prompt: cap(asString(meta?.prompt), MCP_PROMPT_EXPANSION_NAME_CAP),
    text,
    truncated: meta?.truncated === true || overflow,
  }
}

/**
 * Build the wire envelope for a session `message` event.
 *
 * @param {{ type: string, content: string, tool?: string, options?: *, timestamp?: number,
 *   subtype?: string, compactMetadata?: *, mcpPromptExpansion?: * }} data
 * @returns {object}
 */
export function buildMessageWire(data) {
  const msg = {
    type: 'message',
    messageType: data.type,
    content: data.content,
    tool: data.tool,
    options: data.options,
    timestamp: data.timestamp,
  }
  // #6768: forward the structured compaction-boundary marker fields.
  // Gated strictly on `messageType === 'system'` + the compact_boundary
  // subtype (mirrors the `code`/`attemptedResumeId` gating pattern in the
  // `error:` normalizer below) so a buggy producer can't sneak
  // `compactMetadata` onto an unrelated message type. #6973: the numeric
  // sub-fields are bounded (see `boundedCompactMetadata`) rather than
  // forwarded raw, so a malformed/out-of-range value from the SDK/CLI
  // can't reach the wire unbounded.
  if (data.type === 'system' && data.subtype === 'compact_boundary' && data.compactMetadata) {
    msg.subtype = data.subtype
    msg.compactMetadata = boundedCompactMetadata(data.compactMetadata)
  }
  // #6845: forward the MCP-prompt expansion marker (the honesty surface for a
  // server-controlled `/mcp__server__prompt` expansion injected as the user
  // turn). Gated identically to compact_boundary — `messageType: 'system'` +
  // the `mcp_prompt_expansion` subtype + a present payload — and re-bounded
  // here so a malformed producer can't reach the wire unbounded. Unlike
  // compact_boundary, `boundedMcpPromptExpansion` can return `null` (a
  // non-string `text` — see its doc comment), in which case neither
  // `subtype` nor `mcpPromptExpansion` is attached: the envelope falls back
  // to a plain system message rather than claiming a structured marker it
  // can't honestly populate.
  if (data.type === 'system' && data.subtype === 'mcp_prompt_expansion' && data.mcpPromptExpansion) {
    const bounded = boundedMcpPromptExpansion(data.mcpPromptExpansion)
    if (bounded) {
      msg.subtype = data.subtype
      msg.mcpPromptExpansion = bounded
    }
  }
  return msg
}

/**
 * Ceiling on the text of one error, in characters. The same 50 KiB the persisted
 * copy is clipped to (`SessionMessageHistory.truncateEntry`), applied here at
 * ADMISSION so the live frame, the ring buffer and every replay hold the same
 * bounded text -- the persistence clip alone left the in-memory entry (and each
 * retransmission of it) unbounded.
 */
export const ERROR_TEXT_MAX = 50 * 1024

/**
 * Hard ceiling on the text the redactor is ever handed (characters). An error body
 * can in principle be megabytes (a proxy's HTML page); the patterns are linear, but
 * there is no reason to scan more than this to keep a 50 KiB result.
 */
export const ERROR_REDACT_SCAN_MAX = 1024 * 1024

/**
 * Text appended to an error message that was cut. Counted INSIDE the 50 KiB budget:
 * the saved copy (`SessionMessageHistory.truncateEntry`) clips anything over 50 KiB
 * and appends its own marker, so a message that overshot by this much came out as
 * `...\n[t[truncated]`. Within the budget the persisted copy is the live one.
 */
const ERROR_TRUNCATION_MARKER = '\n[truncated]'

/**
 * Redact secret-shaped substrings from error text, THEN bound it to `max`
 * characters. An error is whatever the provider or a setup command said, and it can
 * carry an API key or a token (a BYOK request failure, a post-create script's
 * output). It is part of the durable transcript, written to `session-state.json`,
 * so it passes through the same redactor the logger and the permission descriptions
 * use (`redactValue`), here in the shared builder so the live frame and the
 * recorded entry are identical.
 *
 * ORDER matters: redact the COMPLETE text, then cut. Cutting first can leave the
 * front of a key the patterns no longer recognise (a 40-character floor on `sk-ant-`
 * keys; an `AIza` key cut 29 characters in) when the bound falls inside it. After
 * redaction the keys are already gone, so the cut can be a plain slice (the
 * post-create caps have always sliced rather than dropped, and a test pins it). The
 * one exception is input past the redaction scan ceiling, which cannot be scanned
 * whole: it is cut at the last whitespace inside the ceiling (`redactBounded`'s
 * rule: a run with no whitespace to stop at is dropped, never half-kept) before it
 * is redacted.
 *
 * @param {string} text
 * @param {number} max  character budget for the result, marker included
 * @param {string} [marker]  appended when the text had to be cut
 * @returns {string}
 */
export function redactAndClip(text, max, marker = '') {
  let clipped = false
  if (text.length > ERROR_REDACT_SCAN_MAX) {
    const head = text.slice(0, ERROR_REDACT_SCAN_MAX)
    const cut = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'), head.lastIndexOf('\t'), head.lastIndexOf('\r'))
    text = cut > 0 ? head.slice(0, cut) : ''
    clipped = true
  }
  const redacted = redactValue(text)
  if (redacted.length <= max && !clipped) return redacted
  if (redacted.length <= max - marker.length) return redacted + marker
  return redacted.slice(0, Math.max(0, max - marker.length)) + marker
}

/** The error message: redacted, then bounded to 50 KiB with a marker that fits inside it. */
function errorMessageText(message) {
  return redactAndClip(String(message), ERROR_TEXT_MAX, ERROR_TRUNCATION_MARKER)
}

/**
 * Longest `code` a client will chip on. A code is an identifier (`stream_stall`,
 * `HTTP_429`, `ECONNRESET`, `invalid_api_key`); anything else a provider put there
 * (an object from an SSE error body, a message-length string) is not one.
 */
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/

/**
 * Build the wire envelope for a session `error` event -- a `message` frame with
 * `messageType: 'error'`, so the clients render it as an error bubble (or one of
 * the code-specific chips).
 *
 * @param {{ message: string, code?: string, attemptedResumeId?: string, timeoutMs?: number,
 *   stdout?: string, stderr?: string }} data
 * @returns {object}
 */
export function buildErrorWire(data) {
  const msg = {
    type: 'message',
    messageType: 'error',
    content: errorMessageText(data.message),
    // The session manager stamps one time on the event so the live frame and the
    // recorded entry agree (#6630); a direct caller without one gets "now".
    timestamp: Number.isFinite(data.timestamp) ? data.timestamp : Date.now(),
  }
  // Only a bounded identifier travels as the code. An OpenAI-compatible SSE error can
  // put an object (holding a key) in `code` and BYOK forwards what the SDK saw; a
  // value that is not an identifier is dropped, and the bubble renders as a plain error.
  const code = typeof data.code === 'string' && ERROR_CODE_PATTERN.test(data.code) ? data.code : undefined
  if (code) msg.code = code
  // #4947: forward `attemptedResumeId` when CliSession's resume-failure
  // path tagged the error envelope (see cli-session.js
  // `_handleChildClose` — emits `error{code:'resume_unknown',
  // attemptedResumeId, message}` from server PR #4944). The dashboard
  // ResumeUnknownChip surfaces this id as subtext so operators can
  // correlate against `~/.chroxy/session-state.json.resumeConversationId`
  // without grepping logs.
  //
  // #4948: also forward on `resume_unknown_exhausted` — the terminal
  // escalation code emitted when the post-fallback retry ALSO matches the
  // unknown-resume pattern. Same operator-correlation rationale; the
  // dashboard renders a distinct "auto-recovery exhausted" affordance but
  // still wants to surface the attempted id as subtext.
  //
  // Hardening (from PR #4967 Copilot review):
  //   1. Gate strictly on the two resume-failure codes so a buggy producer
  //      can't sneak the field onto unrelated error envelopes.
  //   2. Trim whitespace and treat whitespace-only as missing — same UX
  //      guard the chip's render-time check already applies, but enforced
  //      at the wire boundary so downstream consumers (mobile app, future
  //      log/console viewers) see a consistent "present or absent, never
  //      present-but-empty" shape.
  //   3. Enforce the same 256-char cap the wire schema declares
  //      (`ServerMessageSchema.attemptedResumeId`). The server doesn't
  //      validate outgoing messages against ServerMessageSchema before
  //      send, so without this guard a misbehaving producer could ship a
  //      megabyte payload that the dashboard accepts (lax client parse)
  //      but trips Zod-validating consumers. Silently truncate rather
  //      than drop — the truncated id still helps operator triage.
  if (
    (code === 'resume_unknown' || code === 'resume_unknown_exhausted') &&
    typeof data.attemptedResumeId === 'string'
  ) {
    const trimmed = data.attemptedResumeId.trim()
    if (trimmed.length > 0) {
      msg.attemptedResumeId = trimmed.length > 256 ? trimmed.slice(0, 256) : trimmed
    }
  }
  // #8223: forward the watchdog window that actually fired on a
  // `stream_stall`, so the clients can say "No response for 90 seconds" for
  // the first-output watchdog instead of the mid-turn window `auth_ok`
  // advertises. Gated on the code like the two blocks around it, and held to
  // the positive-finite-integer shape the wire schema declares; anything else
  // is dropped so the clients fall back to their `auth_ok` value.
  if (code === 'stream_stall' && Number.isInteger(data.timeoutMs) && data.timeoutMs > 0) {
    msg.timeoutMs = data.timeoutMs
  }
  // #5067: forward captured `stdout` / `stderr` on docker-byok
  // postCreateCommand failures so the operator can diagnose without
  // re-running the broken setup. The session layer
  // (docker-byok-session.js) already tail-caps each stream to
  // POST_CREATE_OUTPUT_CAP_BYTES (4 KiB) before emitting; we re-cap at
  // the wire boundary at 8 KiB per stream as a belt-and-suspenders
  // bound (matches ServerMessageSchema.{stdout,stderr}.max(8192)) so a
  // misbehaving producer can't ship a megabyte payload that the
  // dashboard accepts but trips Zod-validating consumers. Gated
  // strictly on the post-create-failure code so a buggy producer can't
  // sneak the fields onto unrelated error envelopes — same hardening
  // pattern as the resume_unknown gate above. Empty-string and
  // non-string both treated as "absent" so receivers see a consistent
  // "present or absent, never present-but-empty" shape.
  if (code === 'post_create_command_failed') {
    for (const stream of ['stdout', 'stderr']) {
      if (typeof data[stream] !== 'string' || data[stream].length === 0) continue
      // Redacted like the message: setup output is where a token most often turns up.
      const text = redactAndClip(data[stream], 8192)
      if (text.length > 0) msg[stream] = text
    }
  }
  return msg
}
