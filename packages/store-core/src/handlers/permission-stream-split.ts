/**
 * Shared stateless resolver for the #554 "split streaming response at a
 * permission boundary" decision (driven by a `permission_request` message).
 *
 * Extracted from ./misc.ts (issue #6034 — splitting the P2-3 leftover
 * catch-all into cohesively-named slices). Pure move, no logic change.
 * Re-exported from ./index so the public surface is unchanged. The pure part —
 * deciding whether a split applies and reverse-mapping the stream id — lives
 * here; all side effects stay at the call site. See ./index.ts for the
 * stateless-handler contract.
 */

// ---------------------------------------------------------------------------
// permission_request — #554 stream-split resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the #554 "split streaming response at permission boundary" decision
 * for a `permission_request` message.
 *
 * Both clients carried a near line-for-line copy of this block: when a
 * permission prompt arrives mid-stream, the in-flight assistant message must
 * be split so the prompt doesn't get visually fused onto it. The pure part —
 * deciding whether a split applies and reverse-mapping the client-side stream
 * id back to the server-origin id through the delta-remap table — lives here.
 *
 * Returns null when there is nothing to split: no current stream, or the
 * `'pending'` placeholder id (stream_start not yet processed).
 *
 * Side effects stay at the call site, in this order (matching both prior
 * inline copies): clear the pending delta-flush timer, flush pending deltas,
 * add `serverStreamId` to the post-permission-splits set, and clear the
 * target session's `streamingMessageId`.
 */
export function resolvePermissionStreamSplit(
  currentStreamId: string | null,
  deltaIdRemaps: ReadonlyMap<string, string>,
): { serverStreamId: string } | null {
  if (!currentStreamId || currentStreamId === 'pending') return null
  let serverStreamId = currentStreamId
  for (const [origId, remappedId] of deltaIdRemaps) {
    if (remappedId === currentStreamId) {
      serverStreamId = origId
      break
    }
  }
  return { serverStreamId }
}
