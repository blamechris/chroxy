/**
 * request-pairing — the REQUESTER side of the pairing-approval primitive
 * (#5510, epic #5509).
 *
 * A camera-less device (this dashboard, when it knows a server's URL but has no
 * QR/token) opens a short-lived pre-auth WebSocket, sends `pair_request`,
 * displays the 6-digit verify code the server returns, and waits for
 * `pair_result`. On approval the issued session token is delivered over the same
 * connection — the caller then stores it exactly like the existing
 * `chroxy://?pair=` flow (addServer + switchServer).
 *
 * The verify code is generated SERVER-SIDE; this client only ever DISPLAYS it
 * (never sends it back), so a mismatch is impossible by construction.
 *
 * This is intentionally self-contained (its own WS, not the main connection
 * store socket): the requester has no credentials yet, so it cannot use the
 * authenticated reconnect machinery. The socket is closed as soon as the flow
 * reaches a terminal state.
 */
import { PROTOCOL_VERSION } from '@chroxy/protocol'

export type PairRequestPhase =
  | 'requesting' // socket opening / pair_request sent, awaiting code
  | 'code-shown' // verify code received, awaiting host approval
  | 'approved' // pair_result ok:true — token in hand
  | 'denied' // pair_result ok:false reason:denied
  | 'expired' // TTL elapsed before approval
  | 'error' // transport / protocol failure

export interface PairRequestState {
  phase: PairRequestPhase
  verifyCode: string | null
  token: string | null
  reason: string | null
}

export interface PairRequestHandle {
  /** Abort the in-flight request and close the socket. */
  cancel: () => void
}

/** Random 1-of-a-kind correlation id for this pair attempt. */
function newRequestId(): string {
  // crypto.randomUUID is available in all dashboard targets (browser + Tauri).
  try {
    return crypto.randomUUID()
  } catch {
    return `pr-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

/**
 * Drive a single pair-request round-trip.
 *
 * @param wsUrl - normalized ws(s):// URL of the target daemon
 * @param deviceName - human label shown to the approver (capped server-side)
 * @param onState - called on every phase/state transition
 * @returns a handle to cancel the in-flight request
 */
export function requestPairing(
  wsUrl: string,
  deviceName: string,
  onState: (state: PairRequestState) => void,
): PairRequestHandle {
  const requestId = newRequestId()
  let settled = false
  let socket: WebSocket | null = null

  const state: PairRequestState = {
    phase: 'requesting',
    verifyCode: null,
    token: null,
    reason: null,
  }

  const emit = () => onState({ ...state })

  const settle = (phase: PairRequestPhase, extra?: Partial<PairRequestState>) => {
    if (settled) return
    settled = true
    Object.assign(state, { phase }, extra)
    emit()
    try { socket?.close() } catch { /* ignore */ }
    socket = null
  }

  try {
    socket = new WebSocket(wsUrl)
  } catch {
    settle('error', { reason: 'connect_failed' })
    return { cancel: () => settle('error', { reason: 'cancelled' }) }
  }

  socket.onopen = () => {
    if (settled || !socket) return
    socket.send(JSON.stringify({
      type: 'pair_request',
      requestId,
      deviceName: deviceName.slice(0, 64),
      protocolVersion: PROTOCOL_VERSION,
    }))
    emit() // still 'requesting'
  }

  socket.onmessage = (ev) => {
    if (settled) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
    } catch {
      return // ignore unparseable frames
    }
    if (!msg || typeof msg !== 'object') return
    // Ignore frames for other request ids (shouldn't happen on a dedicated
    // socket, but be defensive).
    if (typeof msg.requestId === 'string' && msg.requestId !== requestId) return

    if (msg.type === 'pair_request_pending') {
      if (typeof msg.verifyCode === 'string') {
        state.phase = 'code-shown'
        state.verifyCode = msg.verifyCode
        emit()
      }
      return
    }

    if (msg.type === 'pair_result') {
      if (msg.ok === true && typeof msg.token === 'string') {
        settle('approved', { token: msg.token })
        return
      }
      const reason = typeof msg.reason === 'string' ? msg.reason : 'denied'
      // Map the few terminal reasons to dedicated phases for the UI.
      if (reason === 'expired') settle('expired', { reason })
      else if (reason === 'denied') settle('denied', { reason })
      else settle('error', { reason })
    }
  }

  socket.onerror = () => {
    settle('error', { reason: 'transport_error' })
  }

  socket.onclose = () => {
    // If the socket closed before a terminal result, treat it as an error so
    // the UI doesn't hang in 'requesting' / 'code-shown' forever.
    if (!settled) settle('error', { reason: 'connection_closed' })
  }

  return {
    cancel: () => settle('error', { reason: 'cancelled' }),
  }
}
