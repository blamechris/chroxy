/**
 * #5433: shared oversize-body rejection for capped HTTP body readers.
 *
 * The previous pattern (`req.destroy()` inside the 'data' handler) tore the
 * socket down before any response was written — after a mid-stream destroy,
 * 'end' never fires (verified on Node 22), so the 413 branch in the 'end'
 * handler was dead code and clients saw ECONNRESET instead of the documented
 * 413.
 *
 * The replacement, used by all three capped readers (POST /api/events,
 * POST /permission, POST /permission-response) so they stay in lockstep:
 *
 *   1. Stop consuming WITHOUT buffering past the cap: drop the 'data'
 *      listeners and pause the stream. An attacker that keeps streaming now
 *      backs up into the kernel receive buffer (TCP backpressure), not our
 *      heap.
 *   2. Send the 413 with `Connection: close`. The close header marks this
 *      response as the socket's last (`res._last`), so once it flushes Node
 *      tears the connection down itself via `socket.destroySoon()` — i.e.
 *      the FIN goes out AFTER the 413 bytes, never before.
 *   3. Belt-and-braces: on response 'finish', destroySoon the socket
 *      ourselves in case anything upstream stripped the close semantics.
 *      destroySoon (not destroy) so a still-flushing response is never cut
 *      off; it is idempotent alongside Node's own teardown.
 *
 * Callers must treat the request as answered: their 'end'/'close' handlers
 * should no-op when the oversize flag is set.
 */
export function sendOversizeResponse(req, res, payload = { error: 'body too large' }) {
  req.removeAllListeners('data')
  req.pause()
  // Captured now — Node detaches res.socket before user 'finish' listeners run.
  const socket = res.socket
  try {
    res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' })
    res.end(JSON.stringify(payload))
  } catch {
    // Socket already torn down — nothing left to deliver the 413 to.
    return
  }
  res.once('finish', () => {
    try {
      if (socket && !socket.destroyed && typeof socket.destroySoon === 'function') {
        socket.destroySoon()
      }
    } catch { /* already gone */ }
  })
}
