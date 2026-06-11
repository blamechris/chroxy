/**
 * useWindowedRange — dependency-free variable-height windowing for the
 * dashboard ChatView (#5561).
 *
 * Why hand-rolled instead of a dep
 * --------------------------------
 * The dashboard already ships zero list-virtualization deps (react-window /
 * virtua / @tanstack/virtual are all absent from package.json), and the chat
 * list has exactly one consumer. A ~150-line measure-cache windowing hook keeps
 * the dependency tree (and the audited bundle) unchanged while delivering the
 * one behaviour the issue asks for: stop mapping the entire message array to the
 * DOM on long sessions. Mobile uses FlashList because RN has no DOM scroller;
 * the web has `scrollTop` + `ResizeObserver`, so a small native implementation
 * is the right tool here.
 *
 * How it works
 * ------------
 * - Rows are variable height (markdown, tool results), so we cannot assume a
 *   fixed row size. We keep a per-id height cache that the row component feeds
 *   via a `ResizeObserver`; unmeasured rows use `estimatedRowHeight`.
 * - From `scrollTop` + viewport height we walk the cumulative offsets to find
 *   the first and last rows intersecting the viewport, then pad the range by
 *   `overscan` rows on each side so scrolling reveals already-mounted rows.
 * - The caller renders a top spacer (height = summed heights of skipped leading
 *   rows) and a bottom spacer (summed heights of skipped trailing rows) so the
 *   scrollbar geometry — and therefore scroll position when appending above —
 *   stays correct.
 * - Below `threshold` items the hook returns the full range and zero spacers,
 *   so short histories render exactly as before (no behaviour change, no
 *   measurement overhead).
 *
 * The hook is intentionally pure-ish: it derives the visible range from
 * `scrollTop`/`viewportHeight` state that the caller updates on scroll/resize.
 * It owns the height cache (a ref) and exposes a stable `measureRow` callback.
 */
import { useCallback, useMemo, useRef, useState } from 'react'

export interface WindowedRangeOptions {
  /** Total number of rows in the list. */
  itemCount: number
  /** Current scroll offset of the scroll container. */
  scrollTop: number
  /** Visible height of the scroll container. */
  viewportHeight: number
  /** Height assumed for rows that have not been measured yet. */
  estimatedRowHeight?: number
  /** Extra rows mounted above/below the viewport to smooth fast scrolls. */
  overscan?: number
  /**
   * Only virtualize once the list grows past this many rows. Below it the hook
   * renders everything (start=0, end=itemCount) with no spacers, so short
   * conversations behave identically to the pre-#5561 full-map render.
   */
  threshold?: number
  /**
   * The flex `gap` (px) between rows in the scroll container. `measureRow`
   * reports the bare `offsetHeight`; the gap that the column layout adds
   * between each row is folded in here so the spacer heights match the real
   * scroll geometry. Defaults to 0 (no gap).
   */
  rowGap?: number
  /**
   * Stable key for each row by index — the measurement cache is keyed by this
   * so a row's height survives reordering / windowing churn (an index-keyed
   * cache would mis-attribute heights as rows shift).
   */
  keyAt: (index: number) => string
}

export interface WindowedRange {
  /** First row index to render (inclusive). */
  startIndex: number
  /** One past the last row index to render (exclusive). */
  endIndex: number
  /** Spacer height above the rendered slice (px). */
  topSpacer: number
  /** Spacer height below the rendered slice (px). */
  bottomSpacer: number
  /** True when windowing is active (itemCount > threshold). */
  virtualized: boolean
  /** Record a measured row height. Stable identity. */
  measureRow: (key: string, height: number) => void
}

const DEFAULT_ESTIMATED_ROW_HEIGHT = 80
const DEFAULT_OVERSCAN = 6
const DEFAULT_THRESHOLD = 40

export function useWindowedRange({
  itemCount,
  scrollTop,
  viewportHeight,
  estimatedRowHeight = DEFAULT_ESTIMATED_ROW_HEIGHT,
  overscan = DEFAULT_OVERSCAN,
  threshold = DEFAULT_THRESHOLD,
  rowGap = 0,
  keyAt,
}: WindowedRangeOptions): WindowedRange {
  // Per-id measured heights. A ref (not state) so a measurement never triggers
  // a re-render on its own — the scroll/resize state changes drive recompute.
  const heightCacheRef = useRef<Map<string, number>>(new Map())
  // A monotonically bumped tick so a *new* measurement (height we did not have
  // before, or a changed height) can opt into a recompute without making every
  // identical re-measure churn the range.
  const [measureTick, setMeasureTick] = useState(0)

  // Below the threshold the list renders in full and no spacers/range math
  // runs, so row heights are irrelevant — a no-op `measureRow` keeps short
  // conversations from scheduling re-renders on every row mount (and preserves
  // the #4398 hidden-memoization contract: renderMessage fires exactly once on
  // first mount).
  const virtualizing = itemCount > threshold

  const measureRow = useCallback(
    (key: string, height: number) => {
      if (!virtualizing) return
      const cache = heightCacheRef.current
      const prev = cache.get(key)
      // Ignore sub-pixel noise from ResizeObserver so streaming reflows don't
      // spin the recompute loop.
      if (prev !== undefined && Math.abs(prev - height) < 1) return
      cache.set(key, height)
      setMeasureTick((t) => t + 1)
    },
    [virtualizing],
  )

  // Each row occupies its measured (or estimated) height plus the column gap
  // that follows it. Folding the gap in here keeps the spacer sums aligned with
  // the real `scrollHeight` so scroll position is anchored correctly when
  // content appends above the viewport.
  const heightAt = useCallback(
    (index: number): number =>
      (heightCacheRef.current.get(keyAt(index)) ?? estimatedRowHeight) + rowGap,
    [keyAt, estimatedRowHeight, rowGap],
  )

  return useMemo<WindowedRange>(() => {
    // Touch measureTick so the memo recomputes when a row is (re)measured.
    void measureTick

    if (!virtualizing) {
      return {
        startIndex: 0,
        endIndex: itemCount,
        topSpacer: 0,
        bottomSpacer: 0,
        virtualized: false,
        measureRow,
      }
    }

    // Walk cumulative offsets to find the first row whose bottom edge is past
    // the top of the viewport, and the last row whose top edge is above the
    // bottom of the viewport. Linear in itemCount; for a chat list that is
    // cheap and avoids a parallel prefix-sum array that would need rebuilding
    // on every measure.
    const top = Math.max(0, scrollTop)
    const bottom = top + Math.max(0, viewportHeight)

    let offset = 0
    let firstVisible = 0
    let i = 0
    for (; i < itemCount; i++) {
      const h = heightAt(i)
      if (offset + h > top) {
        firstVisible = i
        break
      }
      offset += h
    }
    if (i === itemCount) {
      // Scrolled past the end (can happen mid-resize) — clamp to the last row.
      firstVisible = itemCount - 1
    }

    // `offset` is the top edge of `firstVisible`. A row is visible while its
    // top edge is above the viewport bottom; once a row starts at/below
    // `bottom` it (and everything after) is off-screen, so stop BEFORE counting
    // it as visible.
    let lastVisible = firstVisible
    for (let j = firstVisible; j < itemCount; j++) {
      if (offset >= bottom) break
      lastVisible = j
      offset += heightAt(j)
    }

    const startIndex = Math.max(0, firstVisible - overscan)
    const endIndex = Math.min(itemCount, lastVisible + 1 + overscan)

    // Convert the trimmed leading/trailing rows back into spacer heights.
    let leadingHeight = 0
    for (let k = 0; k < startIndex; k++) leadingHeight += heightAt(k)
    let trailingHeight = 0
    for (let k = endIndex; k < itemCount; k++) trailingHeight += heightAt(k)

    return {
      startIndex,
      endIndex,
      topSpacer: leadingHeight,
      bottomSpacer: trailingHeight,
      virtualized: true,
      measureRow,
    }
  }, [
    itemCount,
    scrollTop,
    viewportHeight,
    virtualizing,
    overscan,
    heightAt,
    measureRow,
    measureTick,
  ])
}

export { DEFAULT_ESTIMATED_ROW_HEIGHT, DEFAULT_OVERSCAN, DEFAULT_THRESHOLD }
