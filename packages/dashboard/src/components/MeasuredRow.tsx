/**
 * MessageRowShell — the outer `.msg-row` container for one ChatView row, with
 * height measurement wired in for the windowing hook (#5561).
 *
 * This IS the flex child inside `.chat-messages` (it carries the `rowClass` and
 * `data-testid` the rows used before #5561). It attaches a `ResizeObserver` to
 * itself and reports its `offsetHeight` to `measureRow(rowKey, height)` so the
 * windowing hook (`useWindowedRange`) can compute spacers and the visible range
 * for variable-height content. Putting the observer on the layout element (not a
 * nested wrapper) keeps the `.chat-messages` flex layout byte-identical to the
 * pre-#5561 DOM while adding measurement.
 *
 * The shell is memoized on its props, and ChatView hands it a memoized child
 * (`DefaultMessageRow` or the renderMessage node), so a streaming delta that
 * only changes the tail row does not re-run the observer wiring for untouched
 * rows.
 */
import { memo, useCallback, useEffect, useRef, type ReactNode } from 'react'

export interface MessageRowShellProps {
  /** Stable per-row key (message id / group key) — used as the height-cache key. */
  rowKey: string
  /** Reports this row's measured pixel height to the windowing hook. */
  measureRow: (key: string, height: number) => void
  /** Flex row class (`msg-row`, `msg-row-user`, …) or '' for icon-less rows. */
  className: string
  /** Test id for the row container (kept identical to the pre-#5561 `msg-<id>`). */
  testId: string
  /**
   * #6788 — this row matches the active in-session find query. Stamped as a
   * `data-search-match` attribute so the transcript can tint every hit. A
   * plain boolean so the row memo still skips unaffected rows.
   */
  searchMatch?: boolean
  /**
   * #6788 — this row is the CURRENT (focused) find match — the one the list is
   * scrolled to. Stamped as `data-search-active` for a stronger highlight.
   */
  searchActive?: boolean
  children: ReactNode
}

function MessageRowShellImpl({ rowKey, measureRow, className, testId, searchMatch, searchActive, children }: MessageRowShellProps) {
  const ref = useRef<HTMLDivElement>(null)

  const report = useCallback(() => {
    const el = ref.current
    if (el) measureRow(rowKey, el.offsetHeight)
  }, [rowKey, measureRow])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Measure immediately on mount (also covers the no-ResizeObserver test env),
    // then observe for reflows: streaming markdown growth and tool-bubble
    // expand/collapse both change row height and must update the cache.
    report()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => report())
    ro.observe(el)
    return () => ro.disconnect()
  }, [report])

  return (
    <div
      ref={ref}
      className={className || undefined}
      data-testid={testId}
      data-row-key={rowKey}
      data-search-match={searchMatch ? '' : undefined}
      data-search-active={searchActive ? '' : undefined}
    >
      {children}
    </div>
  )
}

export const MessageRowShell = memo(MessageRowShellImpl)
