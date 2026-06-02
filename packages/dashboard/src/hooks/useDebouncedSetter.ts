/**
 * useDebouncedSetter — shared debounce + dirty + conflict primitive (#4739).
 *
 * Extracted from the duplicated pattern that grew between the per-session
 * preamble editor (#4660 / #4662 / #4738) and QuietHoursEditor (#4570).
 * Both call sites independently re-implemented:
 *
 *   - a debounce timer to coalesce keystrokes into one WS write
 *   - a `dirty` flag with a ref mirror so the hydration effect can read
 *     it without re-running when it flips
 *   - a parked-snapshot conflict UX for multi-client mid-edit broadcasts
 *   - cancel on unmount AND cancel on scope-key change (session id,
 *     snapshot scope, …)
 *
 * Two modes are supported:
 *
 *   - **Debounced** (`debounceMs > 0`, default 400) — `setDraft` schedules
 *     a flush of the latest value after the debounce window. Used by the
 *     per-session preamble text area.
 *   - **Manual** (`debounceMs === 0`) — `setDraft` updates local draft
 *     only; the caller invokes `flush()` explicitly (e.g. a Save button).
 *     Used by QuietHoursEditor where field edits buffer until the user
 *     clicks Save.
 *
 * Conflict semantics:
 *
 *   - When `serverValue` changes AND the editor is dirty AND the new
 *     value diverges from the local draft (per `equals` if provided,
 *     otherwise `Object.is`), we hold the snapshot in `conflict` and
 *     preserve the draft so the caller can render a banner with
 *     accept / discard buttons.
 *   - When `serverValue` matches the draft (own echo), we silently clear
 *     dirty — no banner.
 *   - When the editor is clean, we apply the snapshot directly (mirroring
 *     the server-confirmed value into the draft).
 *   - When `scopeKey` changes (session switch, snapshot scope change,
 *     …) we always re-hydrate from `serverValue`, cancel any pending
 *     debounce, and clear dirty + conflict — leaking the previous
 *     scope's draft onto the new scope is the bug class that prompted
 *     the extraction (#4662 gap 1).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseDebouncedSetterOptions<T> {
  /** The server-confirmed value. Mirrored into the draft on clean apply. */
  serverValue: T
  /**
   * Stable key identifying which scope the draft belongs to (session id,
   * snapshot scope, …). When this changes we cancel any pending debounce
   * and re-hydrate the draft from `serverValue` — otherwise the timer
   * would fire against the new scope with the previous scope's draft.
   */
  scopeKey: string | null
  /**
   * Debounce window in ms. Default `400`. Set to `0` for manual mode
   * (caller invokes `flush()` explicitly via e.g. a Save button).
   */
  debounceMs?: number
  /** Fires with the latest draft after the debounce window (or via `flush()`). */
  onFlush: (value: T) => void
  /**
   * Equality predicate used for own-echo detection AND scope-change
   * re-hydration short-circuit. Defaults to `Object.is`, which is fine
   * for strings/numbers/booleans. Object/array payloads should provide
   * a structural equals so a fresh-reference echo from the server
   * doesn't trip the conflict banner.
   */
  equals?: (a: T, b: T) => boolean
}

export interface UseDebouncedSetterResult<T> {
  /** Current local draft. Initialised to `serverValue`, updated by `setDraft`. */
  draft: T
  /** Update the draft. Schedules a flush in debounced mode; pure setter in manual mode. */
  setDraft: (next: T) => void
  /** True after the first `setDraft` call; clears on flush / scope-change / discard. */
  dirty: boolean
  /**
   * Parked snapshot from a divergent server broadcast while editor was
   * dirty. `undefined` when there's no conflict. Caller renders an
   * "another client edited this" banner when this is defined.
   */
  conflict: T | undefined
  /** Dismiss the parked snapshot; keep the local draft. */
  acceptDraft: () => void
  /** Replace the draft with the parked snapshot; clear dirty + conflict; cancel pending debounce. */
  discardDraft: () => void
  /**
   * Explicitly fire `onFlush(draft)` now. Cancels any pending debounce.
   * Primary use is the manual mode Save button; debounced mode callers
   * may use it for "save now" affordances.
   */
  flush: () => void
}

const DEFAULT_DEBOUNCE_MS = 400

export function useDebouncedSetter<T>(
  opts: UseDebouncedSetterOptions<T>
): UseDebouncedSetterResult<T> {
  const {
    serverValue,
    scopeKey,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    onFlush,
    equals,
  } = opts

  // Default equality matches the bare-string / boolean callsites without
  // forcing them to pass `equals: Object.is`. Custom equals is required
  // for object payloads (QuietHoursEditor window: {start,end,timezone}).
  const eq = equals ?? Object.is

  const [draft, setDraftState] = useState<T>(serverValue)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState<T | undefined>(undefined)

  // Refs mirror state so the hydration effect can read current dirty +
  // conflict without depending on them (which would re-run the effect
  // every time they flipped, defeating the "skip apply when dirty"
  // contract). Mirrors the pattern documented at the original call sites.
  const dirtyRef = useRef(dirty)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  const conflictRef = useRef(conflict)
  useEffect(() => { conflictRef.current = conflict }, [conflict])
  const draftRef = useRef(draft)
  useEffect(() => { draftRef.current = draft }, [draft])

  // The active scope. Compared against `scopeKey` inside the hydration
  // effect to distinguish "scope changed → re-hydrate + cancel" from
  // "same scope, new snapshot → apply / park / echo-clear".
  const scopeRef = useRef<string | null>(scopeKey)

  // Pending debounce timer. Survives re-renders without forcing one.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Latest onFlush (without re-creating setDraft / flush every render).
  const onFlushRef = useRef(onFlush)
  useEffect(() => { onFlushRef.current = onFlush }, [onFlush])

  // Latest equals.
  const eqRef = useRef(eq)
  useEffect(() => { eqRef.current = eq }, [eq])

  // Helper — cancel pending debounce. Used by unmount, scope change,
  // discard, and `flush()`. Centralised so we never miss the null
  // reassignment (a leftover handle would fail to clear on the next
  // schedule if the timer ID has been reused by the runtime).
  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Hydration effect. Two distinct cases:
  //   1. Scope changed — always re-hydrate AND cancel pending debounce.
  //      The leaked draft would otherwise fire against the new scope.
  //   2. Same scope, new snapshot — if dirty AND divergent, park it
  //      for the conflict banner. If matching draft (own echo), clear
  //      dirty silently. If clean, apply.
  useEffect(() => {
    const sameScope = scopeRef.current === scopeKey
    if (!sameScope) {
      cancelTimer()
      scopeRef.current = scopeKey
      setDraftState(serverValue)
      setDirty(false)
      setConflict(undefined)
      return
    }
    const isDirty = dirtyRef.current
    const matchesDraft = eqRef.current(serverValue, draftRef.current)
    if (isDirty && !matchesDraft) {
      // Park the snapshot for the caller to resolve via the banner.
      setConflict(serverValue)
      return
    }
    // Clean apply (or own echo).
    setDraftState(serverValue)
    setDirty(false)
    setConflict(undefined)
  }, [scopeKey, serverValue, cancelTimer])

  // Unmount cleanup — drop any pending timer so we don't fire a stale
  // WS send after the component unmounts.
  useEffect(() => () => { cancelTimer() }, [cancelTimer])

  const setDraft = useCallback((next: T) => {
    setDraftState(next)
    setDirty(true)
    if (debounceMs <= 0) {
      // Manual mode — caller invokes flush() explicitly.
      return
    }
    // Capture the scope at schedule-time so a mid-debounce scope switch
    // can't fire against the wrong scope even if the hydration effect's
    // cancel races. Belt-and-braces — the scope effect cancels the
    // timer too, but the closure check inside the timer callback closes
    // the race window for any caller that bypasses the effect timing.
    const scheduledScope = scopeRef.current
    cancelTimer()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (scopeRef.current !== scheduledScope) return
      setDirty(false)
      onFlushRef.current(next)
    }, debounceMs)
  }, [debounceMs, cancelTimer])

  const acceptDraft = useCallback(() => {
    setConflict(undefined)
  }, [])

  const discardDraft = useCallback(() => {
    const snap = conflictRef.current
    if (snap === undefined) return
    cancelTimer()
    setDraftState(snap)
    setDirty(false)
    setConflict(undefined)
  }, [cancelTimer])

  const flush = useCallback(() => {
    cancelTimer()
    setDirty(false)
    onFlushRef.current(draftRef.current)
  }, [cancelTimer])

  return { draft, setDraft, dirty, conflict, acceptDraft, discardDraft, flush }
}
