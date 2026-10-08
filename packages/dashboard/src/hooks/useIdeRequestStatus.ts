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
 * moment it is available again (the connection edge) fires `reissue` once. It is
 * edge/flag based, not "available and nothing current", because each palette
 * already issues its own first request (on open, or debounced on typing) and a
 * state-based rule would double it.
 *
 *  - Closing the palette DISARMS it. The palettes stay mounted, so an armed flag
 *    would otherwise outlive the close and fire on the reopen, on top of the
 *    palette's own open request (and, for references, over the file-ranked one
 *    the click carried). A palette reopened while still unavailable re-arms.
 *  - A result that is already current is not re-asked. The rows stay on screen
 *    through the outage and the reconnect (a references re-ask would blank them
 *    until the reply landed); a new query or a reopen refreshes as it always did.
 */
import { useEffect, useRef } from 'react'
import { useConnectionStore } from '../store/connection'

export type IdeRequestStatus = 'searching' | 'ready' | 'offline'

export interface UseIdeRequestStatusOptions {
  /** The palette is open (and, for the debounced one, is able to ask at all). */
  active: boolean
  /** The store's `*Loading` flag for this palette's request. */
  loading: boolean
  /** The stored reply matches what the palette is currently asking for. */
  isCurrent: boolean
  /** Re-issue this palette's request. Called at most once per reconnect. */
  reissue: () => void
}

export function useIdeRequestStatus({ active, loading, isCurrent, reissue }: UseIdeRequestStatusOptions): IdeRequestStatus {
  const connected = useConnectionStore(s => s.connectionPhase === 'connected')
  const ideOn = useConnectionStore(s => s.serverCapabilities?.ide === true)
  const available = connected && ideOn
  // Always call the latest closure (it captures the current query / symbol)
  // without making the effect below re-run when its identity changes.
  const reissueRef = useRef(reissue)
  reissueRef.current = reissue
  const isCurrentRef = useRef(isCurrent)
  isCurrentRef.current = isCurrent
  const reissueArmed = useRef(false)

  useEffect(() => {
    if (!active) { reissueArmed.current = false; return }
    if (!available) {
      reissueArmed.current = true
    } else if (reissueArmed.current) {
      reissueArmed.current = false
      if (!isCurrentRef.current) reissueRef.current()
    }
  }, [active, available])

  if (available) return loading || !isCurrent ? 'searching' : 'ready'
  return isCurrent ? 'ready' : 'offline'
}
