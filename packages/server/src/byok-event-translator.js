/**
 * Translate `@anthropic-ai/sdk` streaming events to chroxy session events.
 *
 * The SDK exposes `client.messages.stream(...)` whose async iterator yields
 * a small set of event types per the Anthropic API SSE contract:
 *
 *   message_start         — turn opens; carries model + message id
 *   content_block_start   — a new block (text or tool_use) starts
 *   content_block_delta   — incremental text or tool input JSON
 *   content_block_stop    — a block finishes
 *   message_delta         — turn-level metadata (stop_reason, usage)
 *   message_stop          — turn ends
 *
 * We map these to the small set of events chroxy's WebSocket protocol
 * speaks. This module is a pure function so it's testable against recorded
 * fixture streams without an Anthropic API key.
 *
 * Returns `null` for events the caller doesn't need to forward (pings,
 * unrecognized future event types). The translator never throws on an
 * unknown shape — forward as `unknown` and let the caller decide.
 */

/**
 * @typedef {object} TranslatedEvent
 * @property {'stream_start'|'stream_delta'|'tool_start'|'tool_input_delta'|'thinking_delta'|'content_block_stop'|'message_delta'|'result'|'unknown'} kind
 * @property {string} [model]            Set on stream_start
 * @property {string} [messageId]        Set on stream_start
 * @property {string} [text]             Set on stream_delta / thinking_delta
 * @property {string} [toolUseId]        Set on tool_start
 * @property {string} [toolName]         Set on tool_start
 * @property {number} [index]            Block index (tool_start, content_block_stop)
 * @property {string} [partial]          Set on tool_input_delta — partial JSON
 * @property {string} [stopReason]       Set on message_delta / result
 * @property {object} [usage]            Token counts (input_tokens, output_tokens, cache_*)
 * @property {string} [sdkType]          Original SDK event type when kind === 'unknown'
 */

/**
 * @param {object} event - Event from @anthropic-ai/sdk async iterator
 * @returns {TranslatedEvent | null}
 */
export function translateSdkEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    return null
  }

  switch (event.type) {
    case 'message_start':
      return {
        kind: 'stream_start',
        model: event.message?.model,
        messageId: event.message?.id,
      }

    case 'content_block_start': {
      const cb = event.content_block
      if (cb?.type === 'tool_use') {
        return {
          kind: 'tool_start',
          toolUseId: cb.id,
          toolName: cb.name,
          index: event.index,
        }
      }
      // text / thinking blocks: nothing to emit at start — wait for the
      // first delta. Returning null avoids an "empty tool_start" smell.
      return null
    }

    case 'content_block_delta': {
      const delta = event.delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        return { kind: 'stream_delta', text: delta.text, index: event.index }
      }
      if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        return { kind: 'tool_input_delta', partial: delta.partial_json, index: event.index }
      }
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        return { kind: 'thinking_delta', text: delta.thinking, index: event.index }
      }
      // Future delta variants — return null so callers don't error out
      // on a new event type from a future SDK rev.
      return null
    }

    case 'content_block_stop':
      return { kind: 'content_block_stop', index: event.index }

    case 'message_delta':
      return {
        kind: 'message_delta',
        stopReason: event.delta?.stop_reason,
        usage: event.usage,
      }

    case 'message_stop':
      return { kind: 'result' }

    // ping is for heartbeats — no chroxy event needed.
    case 'ping':
      return null

    default:
      return { kind: 'unknown', sdkType: event.type }
  }
}
