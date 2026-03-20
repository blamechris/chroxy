/**
 * Stream ID collision resolution utility.
 *
 * The server reuses the same messageId for `tool_start` and the subsequent
 * post-tool `stream_start`. When the incoming stream_start ID matches an
 * existing non-response message (e.g. tool_use), we suffix the ID so both
 * messages can coexist, and return a remap entry so future stream_delta
 * messages route to the correct response bubble.
 */

export interface StreamIdResult {
  /** The ID to use for the new response message */
  resolvedId: string
  /** If present, register this remap so deltas for `from` route to `to` */
  remap?: { from: string; to: string }
}

/**
 * Resolve a stream_start ID collision.
 *
 * @param existingMessage - The message already stored with this ID (if any).
 *   Only the `type` field is inspected.
 * @param incomingId - The messageId from the stream_start event.
 * @returns The resolved ID and an optional remap directive.
 */
export function resolveStreamId(
  existingMessage: { type?: string } | undefined,
  incomingId: string,
): StreamIdResult {
  // No collision — ID is free
  if (!existingMessage) {
    return { resolvedId: incomingId }
  }

  // Existing message is already a response (reconnect replay dedup) — reuse it
  if (existingMessage.type === 'response') {
    return { resolvedId: incomingId }
  }

  // Collision with a non-response message (e.g. tool_use) — suffix and remap
  const suffixed = `${incomingId}-response`
  return {
    resolvedId: suffixed,
    remap: { from: incomingId, to: suffixed },
  }
}
