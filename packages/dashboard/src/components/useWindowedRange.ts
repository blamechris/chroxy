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
  /**
   * Spacer height above the rendered slice (px). Reserves the skipped leading
   * rows' heights MINUS one `rowGap` — the column gap at the spacer↔first-row
   * seam is rendered by the DOM, so folding it into the spacer too would
   * double-count it. Zero when no leading rows are skipped.
   */
  topSpacer: number
  /**
   * Spacer height below the rendered slice (px). Same boundary-gap correction
   * as `topSpacer`: skipped trailing rows' heights minus one `rowGap` for the
   * last-row↔spacer seam. Zero when no trailing rows are skipped.
   */
  bottomSpacer: number
  /** True when windowing is active (itemCount > threshold). */
  virtualized: boolean
  /** Record a measured row height. Stable identity. */
  measureRow: (key: string, height: number) => void
  /**
   * Index of the first row whose bottom edge is past the top of the viewport —
   * i.e. the topmost row the user is actually looking at. Used as the scroll
   * anchor for engine-independent scroll compensation (see ChatView).
   */
  firstVisibleIndex: number
  /**
   * Cumulative height (px) of every row strictly above `firstVisibleIndex` —
   * the content-space offset of that row's top edge. When a height-cache
   * correction above the viewport changes this value, the delta is the amount
   * the viewport content shifted and must be added back to `scrollTop` so the
   * anchor row stays put (WKWebView has no native scroll anchoring).
   */
  firstVisibleOffset: number
  /**
   * Content-space top edge (px) of the row at `index` — the cumulative height of
   * every row above it given the CURRENT height cache. ChatView anchors scroll
   * compensation on a *fixed* row index across renders (the row identity does
   * not move in the array between re-measures), so it reads this for the
   * remembered anchor index even after a remeasure shifts which row is
   * first-visible. Recomputes a prefix sum on each call (O(index)); only invoked
   * once per render for the anchor, so cheap for a chat list.
   */
  offsetAt: (index: number) => number
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

  // Cumulative height of all rows above `index` from the live cache — the
  // content-space top edge of that row. Re-created when `heightAt` changes; the
  // caller (ChatView) reads it inside the same render the windowed range is
  // computed, so it always reflects the current measureTick.
  const offsetAt = useCallback(
    (index: number): number => {
      const clamped = Math.max(0, Math.min(index, itemCount))
      let sum = 0
      for (let k = 0; k < clamped; k++) sum += heightAt(k)
      return sum
    },
    [heightAt, itemCount],
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
        firstVisibleIndex: 0,
        firstVisibleOffset: 0,
        offsetAt,
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
    // `offset` here is the content-space top edge of `firstVisible` — the
    // cumulative height of every row above it. Capture it as the scroll anchor
    // before the visible-row walk mutates `offset` further.
    const firstVisibleOffset = offset

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
    //
    // GAP MATH: each spacer is itself a flex child, so the column `gap` (rowGap)
    // ALSO renders between the spacer and the adjacent rendered row (spacer↔r[s]
    // and r[e-1]↔spacer). `heightAt(k)` folds one rowGap into every row, so
    // naively summing it over the skipped rows over-counts by exactly one rowGap
    // per spacer — the boundary gap is double-counted (once in the spacer sum,
    // once rendered by the DOM at the spacer/row seam). Subtract that single
    // rowGap so the windowed `scrollHeight` matches a non-windowed render
    // exactly: full height = Σ heightAt(i) − rowGap (n−1 gaps, not n).
    //
    // N=0 edge cases: a spacer with no skipped rows is 0 (no boundary gap to
    // render either), so guard each sum on its row count being > 0.
    let leadingHeight = 0
    for (let k = 0; k < startIndex; k++) leadingHeight += heightAt(k)
    if (startIndex > 0) leadingHeight -= rowGap
    let trailingHeight = 0
    for (let k = endIndex; k < itemCount; k++) trailingHeight += heightAt(k)
    if (endIndex < itemCount) trailingHeight -= rowGap

    return {
      startIndex,
      endIndex,
      topSpacer: leadingHeight,
      bottomSpacer: trailingHeight,
      virtualized: true,
      measureRow,
      firstVisibleIndex: firstVisible,
      firstVisibleOffset,
      offsetAt,
    }
  }, [
    itemCount,
    scrollTop,
    viewportHeight,
    virtualizing,
    overscan,
    rowGap,
    heightAt,
    offsetAt,
    measureRow,
    measureTick,
  ])
}

export { DEFAULT_ESTIMATED_ROW_HEIGHT, DEFAULT_OVERSCAN, DEFAULT_THRESHOLD }
