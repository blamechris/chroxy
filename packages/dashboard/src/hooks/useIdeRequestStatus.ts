/**
 * useIdeRequestStatus — the one rule the IDE palettes (symbol search, find in
 * project, find references) use to decide between "Searching…", a result, and a
 * settled "not connected" state (#8404, follow-up to #8378 / #8402).
 *
 * ## The defect this locks out
 *
 * Each palette showed its spinner while `loading || !isCurrent` (or
 * `symbols === null`). #8402 made a transport drop clear every `*Loading` flag,
 * but `isCurrent` / "has a table" depend on the REPLY, and a reply that was in
 * flight when the socket died never arrives. So the second half of the condition
 * stayed true and the palette spun until it was reopened or a new query was
 * typed.
 *
 * ## The rule
 *
 * A reply can only arrive on a live, authenticated connection to a daemon whose
 * IDE surface is on (`serverCapabilities.ide`; with it off the handlers fail
 * closed WITHOUT replying, so a request could never clear its spinner). So:
 *
 *  - available (connected AND ide): `loading || !current` is a request genuinely
 *    outstanding (or about to be issued) -> `'searching'`; otherwise `'ready'`.
 *  - NOT available: nothing can be outstanding. A result that is already current
 *    is kept -> `'ready'`; anything else -> `'offline'`, a settled state with no
 *    spinner.
 *
 * ## The retry path
 *
 * Going unavailable while the palette is open arms a re-request, and the first
 * moment it is available again (the connection edge) fires `reissue` once, IF
 * the palette's last request did not complete on a live connection. That is
 * decided from what happened to the request as well as from the stored result,
 * because a result can be "current" (same query / a retained table) and still stale (#8429):
 *
 *  - a request was in flight at the drop: seen as `loading` while available, and
 *    cleared only when the stored result is REPLACED (`result` identity changes).
 *    `loading` itself is not trusted, since #8402's sweep clears it a few store
 *    writes before the phase leaves 'connected';
 *  - the result is not for what the palette is asking (`!isCurrent`): a reply to an
 *    OLDER request also replaces `result`, so it can end the in-flight mark while a
 *    newer request was lost;
 *  - a request was attempted while unavailable: the palette sends through `ask`,
 *    which records the attempt the store's sender silently dropped.
 *
 * A palette whose result is current and whose last request completed is not
 * re-asked (#8427): the rows stay on screen through the outage. It is edge/flag
 * based, not "available and not current", because each palette already issues its
 * own first request (on open, or debounced on typing) and a state-based rule would
 * double it; a debounced request still pending at the edge sends itself, so the
 * palette's `reissue` skips the re-ask then (see CodeSearchPalette).
 *
 *  - Closing the palette DISARMS it and forgets the attempt / in-flight marks.
 *    The palettes stay mounted, so an armed flag would otherwise outlive the close
 *    and fire on the reopen, on top of the palette's own open request (and, for
 *    references, over the file-ranked one the click carried). A palette reopened
 *    while still unavailable re-arms, and its open request (through `ask`) is the
 *    recorded attempt.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useConnectionStore } from '../store/connection'

export type IdeRequestStatus = 'searching' | 'ready' | 'offline'
/** Why a palette cannot ask: no live connection, or a connected daemon with the IDE surface off. */
export type IdeUnavailableReason = 'disconnected' | 'ide-off'

export interface UseIdeRequestStatusOptions {
  /** The palette is open (and, for the debounced one, is able to ask at all). */
  active: boolean
  /** The store's `*Loading` flag for this palette's request. */
  loading: boolean
  /** The stored reply matches what the palette is currently asking for. */
  isCurrent: boolean
  /**
   * The stored reply object. Every reply REPLACES it, so a change of identity is
   * "an answer landed"; that, not `loading`, is what ends an in-flight request.
   */
  result: unknown
  /** Re-issue this palette's request. Called at most once per reconnect. */
  reissue: () => void
}

export interface IdeRequestStatusResult {
  status: IdeRequestStatus
  /** Why nothing can be asked right now; null when a request can go out. */
  unavailable: IdeUnavailableReason | null
  /**
   * Send one of the palette's own requests (the open request, the debounced
   * search). Records the attempt when it cannot go out, so the reconnect edge
   * knows a request is owed even though the stored result looks current.
   */
  ask: (send: () => void) => void
}

export function useIdeRequestStatus({ active, loading, isCurrent, result, reissue }: UseIdeRequestStatusOptions): IdeRequestStatusResult {
  const connected = useConnectionStore(s => s.connectionPhase === 'connected')
  const ideOn = useConnectionStore(s => s.serverCapabilities?.ide === true)
  const available = connected && ideOn
  // Always call the latest closure (it captures the current query / symbol)
  // without making the effect below re-run when its identity changes.
  const reissueRef = useRef(reissue)
  reissueRef.current = reissue
  const availableRef = useRef(available)
  availableRef.current = available
  const reissueArmed = useRef(false)
  /** A palette request was attempted while nothing could be asked. */
  const attemptedOffline = useRef(false)
  /** A request went out on a live connection and its answer has not replaced `result`. */
  const inFlight = useRef(false)
  const lastResult = useRef(result)
  const isCurrentRef = useRef(isCurrent)
  isCurrentRef.current = isCurrent

  // Runs after every render and reads only the committed values, so it sees the
  // store writes of a drop one at a time and must not infer "answered" from
  // `loading` going false (see the docblock).
  useEffect(() => {
    if (result !== lastResult.current) {
      lastResult.current = result
      // A reply can only land on a live connection, so no availability guard.
      inFlight.current = false
    }
    if (available && active && loading) inFlight.current = true
  })

  useEffect(() => {
    if (!active) {
      reissueArmed.current = false
      attemptedOffline.current = false
      inFlight.current = false
      return
    }
    if (!available) {
      reissueArmed.current = true
    } else if (reissueArmed.current) {
      reissueArmed.current = false
      // `!isCurrent` stays an owed re-ask: a reply to an OLDER request replaces
      // `result` and ends `inFlight` while a newer one was lost, and a palette on a
      // result that is not for what it asks for would otherwise spin for ever.
      const owed = attemptedOffline.current || inFlight.current || !isCurrentRef.current
      attemptedOffline.current = false
      inFlight.current = false
      if (owed) reissueRef.current()
    }
  }, [active, available])

  const ask = useCallback((send: () => void) => {
    if (!availableRef.current) attemptedOffline.current = true
    send()
  }, [])

  const unavailable: IdeUnavailableReason | null = !connected ? 'disconnected' : !ideOn ? 'ide-off' : null
  if (available) return { status: loading || !isCurrent ? 'searching' : 'ready', unavailable, ask }
  return { status: isCurrent ? 'ready' : 'offline', unavailable, ask }
}
