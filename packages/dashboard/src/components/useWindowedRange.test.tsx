/**
 * useWindowedRange — windowing math (#5561)
 *
 * Pins the dependency-free variable-height windowing the dashboard ChatView
 * uses to stop mapping the entire message array to the DOM on long sessions:
 *
 *  1. Below the threshold the hook is a pass-through (full range, no spacers,
 *     not virtualized) — short conversations render exactly as before.
 *  2. Above the threshold only the rows intersecting the viewport (plus
 *     overscan) are in [startIndex, endIndex); the rest become top/bottom
 *     spacer height so scroll geometry is preserved.
 *  3. Measured row heights feed the range so variable-height rows window
 *     correctly.
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWindowedRange } from './useWindowedRange'

const keyAt = (i: number) => `row-${i}`

describe('useWindowedRange (#5561)', () => {
  it('renders the full list with no spacers below the threshold', () => {
    const { result } = renderHook(() =>
      useWindowedRange({
        itemCount: 10,
        scrollTop: 0,
        viewportHeight: 500,
        threshold: 40,
        keyAt,
      }),
    )
    expect(result.current.virtualized).toBe(false)
    expect(result.current.startIndex).toBe(0)
    expect(result.current.endIndex).toBe(10)
    expect(result.current.topSpacer).toBe(0)
    expect(result.current.bottomSpacer).toBe(0)
  })

  it('windows to the visible range (plus overscan) above the threshold', () => {
    // 200 rows × 80px estimated = 16000px tall. Viewport 400px scrolled to
    // 4000px shows rows ~50..54; with overscan 2 the window is ~48..57.
    const { result } = renderHook(() =>
      useWindowedRange({
        itemCount: 200,
        scrollTop: 4000,
        viewportHeight: 400,
        threshold: 40,
        overscan: 2,
        estimatedRowHeight: 80,
        keyAt,
      }),
    )
    expect(result.current.virtualized).toBe(true)
    // Only a small slice of the 200 rows is rendered.
    const rendered = result.current.endIndex - result.current.startIndex
    expect(rendered).toBeLessThan(20)
    // First visible row (scrollTop 4000 / 80 = 50) minus overscan 2.
    expect(result.current.startIndex).toBe(48)
    // Spacers reserve the height of the windowed-out rows.
    expect(result.current.topSpacer).toBe(48 * 80)
    expect(result.current.bottomSpacer).toBe((200 - result.current.endIndex) * 80)
    // Total reserved + rendered estimate ≈ full list height.
    const renderedEstimate = rendered * 80
    expect(result.current.topSpacer + renderedEstimate + result.current.bottomSpacer).toBe(200 * 80)
  })

  it('starts at the top with a zero top spacer when not scrolled', () => {
    const { result } = renderHook(() =>
      useWindowedRange({
        itemCount: 200,
        scrollTop: 0,
        viewportHeight: 400,
        threshold: 40,
        overscan: 2,
        estimatedRowHeight: 80,
        keyAt,
      }),
    )
    expect(result.current.startIndex).toBe(0)
    expect(result.current.topSpacer).toBe(0)
    expect(result.current.bottomSpacer).toBeGreaterThan(0)
  })

  it('accounts for measured (variable) heights when computing the range', () => {
    // Make the first 10 rows very tall (1000px each) so a 400px viewport at
    // scrollTop 0 shows only the first row regardless of the 80px estimate.
    const { result } = renderHook(() =>
      useWindowedRange({
        itemCount: 200,
        scrollTop: 0,
        viewportHeight: 400,
        threshold: 40,
        overscan: 0,
        estimatedRowHeight: 80,
        keyAt,
      }),
    )
    act(() => {
      for (let i = 0; i < 10; i++) result.current.measureRow(`row-${i}`, 1000)
    })
    // With 1000px rows, only row 0 intersects a 400px viewport.
    expect(result.current.startIndex).toBe(0)
    expect(result.current.endIndex).toBe(1)
    // Bottom spacer reflects the measured tall rows + estimated tail.
    expect(result.current.bottomSpacer).toBe(9 * 1000 + (200 - 10) * 80)
  })

  it('reports the first-visible anchor index and its content-space offset', () => {
    // 200 rows × 80px, viewport 400px scrolled to 4000px: the first row whose
    // bottom edge passes 4000 is row 50 (its top edge is exactly 50×80 = 4000).
    const { result } = renderHook(() =>
      useWindowedRange({
        itemCount: 200,
        scrollTop: 4000,
        viewportHeight: 400,
        threshold: 40,
        overscan: 2,
        estimatedRowHeight: 80,
        keyAt,
      }),
    )
    expect(result.current.firstVisibleIndex).toBe(50)
    // The anchor's top edge in content space = cumulative height of rows 0..49.
    expect(result.current.firstVisibleOffset).toBe(50 * 80)
  })

  it('shifts the anchor when an above-viewport row re-measures, and the +delta scrollTop restores it (WKWebView compensation loop)', () => {
    // Scrolled-up reader: viewport sits over rows ~50+. A row ABOVE the anchor
    // (row 10) corrects from its 80px estimate to 180px (+100px). Without moving
    // scrollTop, the content above the fixed scrollTop now occupies 100px more,
    // so the SAME pixel offset now intersects an EARLIER row — the anchor index
    // drifts down. That drift is the WKWebView jump (no native scroll
    // anchoring). ChatView corrects it by adding the +100 delta to scrollTop,
    // which restores the original anchor row at its new (+100) offset.
    let scrollTop = 4000
    const { result, rerender } = renderHook(
      (props: { scrollTop: number }) =>
        useWindowedRange({
          itemCount: 200,
          scrollTop: props.scrollTop,
          viewportHeight: 400,
          threshold: 40,
          overscan: 0,
          estimatedRowHeight: 80,
          keyAt,
        }),
      { initialProps: { scrollTop } },
    )

    expect(result.current.firstVisibleIndex).toBe(50)
    expect(result.current.firstVisibleOffset).toBe(50 * 80)

    act(() => {
      result.current.measureRow('row-10', 180) // 80 → 180, +100px above the anchor
    })

    // At the unchanged scrollTop the anchor row index drifted earlier (the jump).
    expect(result.current.firstVisibleIndex).toBeLessThan(50)
    const drift = result.current.firstVisibleIndex

    // Apply the compensation ChatView performs: bump scrollTop by exactly the
    // above-viewport height delta (+100). The original anchor row 50 is restored,
    // now sitting 100px lower in content space.
    scrollTop = 4100
    rerender({ scrollTop })
    expect(result.current.firstVisibleIndex).toBe(50)
    expect(result.current.firstVisibleOffset).toBe(50 * 80 + 100)
    expect(drift).toBeLessThan(50) // the uncompensated drift was real
  })

  it('reports a zero-offset anchor below the threshold (no compensation needed)', () => {
    const { result } = renderHook(() =>
      useWindowedRange({
        itemCount: 10,
        scrollTop: 0,
        viewportHeight: 500,
        threshold: 40,
        keyAt,
      }),
    )
    expect(result.current.virtualized).toBe(false)
    expect(result.current.firstVisibleIndex).toBe(0)
    expect(result.current.firstVisibleOffset).toBe(0)
  })
})
