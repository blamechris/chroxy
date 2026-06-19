/**
 * Pure translation between the Anthropic Messages API shapes and the OpenAI
 * Chat Completions API shapes (#5420, option 1 — the AnthropicShimClient core).
 *
 * `ClaudeByokSession` drives `@anthropic-ai/sdk`'s `client.messages.stream(...)`:
 * it sends an Anthropic request and consumes an async iterable of raw SDK events
 * (message_start / content_block_start / content_block_delta / content_block_stop
 * / message_delta / message_stop), then reads `stream.finalMessage()`. To reach
 * OpenAI-compatible servers (LM Studio, vLLM, llama.cpp, OpenRouter, …) without
 * forking that loop, a shim reproduces the SDK surface but speaks chat-completions
 * underneath. THIS module is the pure, side-effect-free heart of that shim:
 *
 *   - `anthropicRequestToOpenAi(params)` — request shape translation.
 *   - `createStreamTranslator()`        — fold OpenAI streaming chunks into the
 *                                         Anthropic SDK event sequence + a final
 *                                         Message (`{stop_reason, content, usage}`).
 *
 * Keeping it pure means the whole translation is fixture-testable against recorded
 * OpenAI chunk sequences with no `openai` dependency and no live endpoint — the
 * network glue (importing `openai`, awaiting the SSE iterator) is a thin separate
 * layer. Live-endpoint fidelity (the #5420 spike: tool streaming, parallel tool
 * calls, usage accounting against real servers) is verified separately.
 *
 * The emitted event objects match the RAW Anthropic SDK shapes that
 * `byok-event-translator.js` switches on — that file is the contract this
 * module's output must satisfy.
 */

// ---------------------------------------------------------------------------
// Request: Anthropic Messages params → OpenAI Chat Completions params
// ---------------------------------------------------------------------------

/**
 * Map Anthropic content (string | block[]) to an OpenAI message `content` /
 * `tool_calls`. Anthropic packs tool results and tool calls INTO the message
 * content array; OpenAI splits them across roles, so a single Anthropic message
 * can fan out into several OpenAI messages. This returns the pieces for one
 * Anthropic message so the caller can flatten.
 */
function anthropicMessageToOpenAi(msg) {
  const { role, content } = msg
  // Plain string content → a single same-role message.
  if (typeof content === 'string') {
    return [{ role, content }]
  }
  if (!Array.isArray(content)) {
    return [{ role, content: '' }]
  }

  const textParts = content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)

  // Tool RESULT blocks (carried on a 'user' message in Anthropic) become
  // standalone OpenAI 'tool' messages keyed by tool_call_id. A user turn may
  // ALSO carry sibling text blocks alongside the results — byok-session's
  // MAX_TOOL_ROUNDS path builds exactly such a `[tool_result…, text]` turn (the
  // "summarise, do not call tools" instruction). OpenAI has no text channel on a
  // `tool` message, so append the text as a following `user` message rather than
  // dropping it (#6128).
  const toolResults = content.filter((b) => b?.type === 'tool_result')
  if (toolResults.length > 0) {
    const msgs = toolResults.map((b) => ({
      role: 'tool',
      tool_call_id: b.tool_use_id,
      content: toolResultContentToString(b.content),
    }))
    if (textParts.length > 0) msgs.push({ role: 'user', content: textParts.join('') })
    return msgs
  }

  // Assistant tool_use blocks → OpenAI assistant message with tool_calls.
  const toolUses = content.filter((b) => b?.type === 'tool_use')
  if (toolUses.length > 0) {
    return [
      {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('') : null,
        tool_calls: toolUses.map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        })),
      },
    ]
  }

  // Otherwise: concatenate text blocks into a single same-role message.
  return [{ role, content: textParts.join('') }]
}

/** Anthropic tool_result `content` is string | block[]; OpenAI wants a string. */
function toolResultContentToString(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
      .join('')
  }
  return ''
}

/**
 * Translate an Anthropic `messages.create/stream` params object to an OpenAI
 * `chat.completions.create` params object. `stream`/`stream_options` are set by
 * the caller (the shim always streams); everything else is shape translation.
 */
export function anthropicRequestToOpenAi(params = {}) {
  const out = {
    model: params.model,
    // OpenAI uses max_tokens (deprecated) / max_completion_tokens; max_tokens is
    // the broadly-compatible field across LM Studio / vLLM / llama.cpp / OpenRouter.
    max_tokens: params.max_tokens,
    messages: [],
  }

  // Anthropic carries the system prompt as a top-level string; OpenAI wants a
  // leading system-role message.
  if (typeof params.system === 'string' && params.system.length > 0) {
    out.messages.push({ role: 'system', content: params.system })
  }

  for (const msg of params.messages || []) {
    for (const m of anthropicMessageToOpenAi(msg)) out.messages.push(m)
  }

  if (Array.isArray(params.tools) && params.tools.length > 0) {
    out.tools = params.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        // Anthropic calls it input_schema; OpenAI calls it parameters.
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }))
  }

  if (params.tool_choice) out.tool_choice = mapToolChoice(params.tool_choice)
  if (typeof params.temperature === 'number') out.temperature = params.temperature
  return out
}

/** Anthropic tool_choice → OpenAI tool_choice. */
function mapToolChoice(tc) {
  if (!tc || typeof tc !== 'object') return undefined
  if (tc.type === 'auto') return 'auto'
  if (tc.type === 'any') return 'required'
  if (tc.type === 'tool' && typeof tc.name === 'string') {
    return { type: 'function', function: { name: tc.name } }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Response: OpenAI streaming chunks → Anthropic SDK event sequence
// ---------------------------------------------------------------------------

/** OpenAI finish_reason → Anthropic stop_reason. */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'stop_sequence'
    default:
      return reason ? 'end_turn' : null
  }
}

/** OpenAI usage → Anthropic usage (no cache tokens in OpenAI; default 0). */
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  }
  return {
    input_tokens: Number(usage.prompt_tokens) || 0,
    output_tokens: Number(usage.completion_tokens) || 0,
    cache_read_input_tokens: Number(usage.prompt_tokens_details?.cached_tokens) || 0,
    cache_creation_input_tokens: 0,
  }
}

/**
 * Stateful (but I/O-free) fold of an OpenAI chat-completions STREAM into the
 * Anthropic SDK event sequence the byok loop consumes, plus the final Message.
 *
 * OpenAI streams one `choices[0].delta` per chunk: `delta.content` (text) and/or
 * `delta.tool_calls[]` (each with a stable `index`, an `id`+`function.name` on
 * first appearance, and `function.arguments` fragments thereafter). Anthropic
 * instead opens a content BLOCK (content_block_start) per text run / tool_use,
 * streams deltas into it, and closes it (content_block_stop) — so this translator
 * assigns Anthropic block indices and tracks which OpenAI tool_call index maps to
 * which block.
 *
 * Usage:
 *   const tr = createStreamTranslator()
 *   for (const chunk of openaiChunks) emit(...tr.push(chunk))   // Anthropic events
 *   const { events, finalMessage } = tr.finish()                // trailing events + final
 *
 * `push` returns the events to emit for that chunk (possibly empty); `finish`
 * returns any trailing close events plus the assembled final Message.
 */
export function createStreamTranslator() {
  let started = false
  let nextBlockIndex = 0
  // Text block: opened lazily on the first text delta, closed when a tool call
  // starts or the stream ends.
  let textBlock = null // { index, text }
  // OpenAI tool_call index -> { blockIndex, id, name, args }
  const toolCalls = new Map()
  // Anthropic content-block order, for finalMessage.content assembly.
  const order = [] // { type: 'text'|'tool_use', ref }
  let stopReason = null
  let usage = null
  let model = null
  let messageId = null

  function ensureStarted(chunk) {
    if (started) return []
    started = true
    model = chunk?.model ?? null
    messageId = chunk?.id ?? null
    return [{ type: 'message_start', message: { id: messageId, model, role: 'assistant', content: [], usage: mapUsage(null) } }]
  }

  function closeTextBlock() {
    if (!textBlock) return []
    const ev = [{ type: 'content_block_stop', index: textBlock.index }]
    textBlock = null
    return ev
  }

  function push(chunk) {
    const events = []
    if (!chunk || typeof chunk !== 'object') return events
    events.push(...ensureStarted(chunk))

    // Usage can ride on any chunk (final chunk when stream_options.include_usage),
    // and some servers send a usage-only trailing chunk with empty choices.
    if (chunk.usage) usage = chunk.usage

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
    if (!choice) return events
    const delta = choice.delta || {}

    // Text delta → open a text block if needed, then stream into it.
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (!textBlock) {
        textBlock = { index: nextBlockIndex++, text: '' }
        order.push({ type: 'text', ref: textBlock })
        events.push({ type: 'content_block_start', index: textBlock.index, content_block: { type: 'text', text: '' } })
      }
      textBlock.text += delta.content
      events.push({ type: 'content_block_delta', index: textBlock.index, delta: { type: 'text_delta', text: delta.content } })
    }

    // Tool-call deltas.
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const oaIndex = typeof tc.index === 'number' ? tc.index : 0
        let entry = toolCalls.get(oaIndex)
        if (!entry) {
          // A tool block begins — close any open text block first (Anthropic
          // blocks don't overlap).
          events.push(...closeTextBlock())
          entry = { blockIndex: nextBlockIndex++, id: tc.id || '', name: tc.function?.name || '', args: '' }
          toolCalls.set(oaIndex, entry)
          order.push({ type: 'tool_use', ref: entry })
          events.push({
            type: 'content_block_start',
            index: entry.blockIndex,
            content_block: { type: 'tool_use', id: entry.id, name: entry.name, input: {} },
          })
        } else {
          // Late id/name (some servers send them split across chunks).
          if (!entry.id && tc.id) entry.id = tc.id
          if (!entry.name && tc.function?.name) entry.name = tc.function.name
        }
        const argFragment = tc.function?.arguments
        if (typeof argFragment === 'string' && argFragment.length > 0) {
          entry.args += argFragment
          events.push({
            type: 'content_block_delta',
            index: entry.blockIndex,
            delta: { type: 'input_json_delta', partial_json: argFragment },
          })
        }
      }
    }

    if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason)
    return events
  }

  function finish() {
    const events = []
    // Close any still-open blocks (text, then each tool block in order).
    events.push(...closeTextBlock())
    for (const entry of toolCalls.values()) {
      events.push({ type: 'content_block_stop', index: entry.blockIndex })
    }
    const finalUsage = mapUsage(usage)
    // message_delta carries the final stop_reason + usage; message_stop ends it.
    events.push({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: finalUsage })
    events.push({ type: 'message_stop' })

    const content = order.map((o) =>
      o.type === 'text'
        ? { type: 'text', text: o.ref.text }
        : { type: 'tool_use', id: o.ref.id, name: o.ref.name, input: safeParseJson(o.ref.args) },
    )
    const finalMessage = {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content,
      // If the model emitted tool calls but the server omitted a finish_reason,
      // infer tool_use so the byok loop runs the tools.
      stop_reason: stopReason ?? (toolCalls.size > 0 ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: finalUsage,
    }
    return { events, finalMessage }
  }

  return { push, finish }
}

/** Parse accumulated tool-arguments JSON; empty/invalid → {} (never throw). */
function safeParseJson(s) {
  if (typeof s !== 'string' || s.trim() === '') return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}
