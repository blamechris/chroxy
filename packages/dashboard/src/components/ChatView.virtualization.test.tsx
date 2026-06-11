/**
 * ChatView virtualization — #5561
 *
 * Pins the behaviours the issue requires of the windowed dashboard ChatView:
 *
 *  1. Above the threshold only the rows intersecting the viewport (plus
 *     overscan) mount — the entire message array is no longer mapped to the DOM.
 *  2. Below the threshold every row renders (no behaviour change for short
 *     histories).
 *  3. Bottom-pinning: a new message appended while the user is at the bottom
 *     scrolls the container to the new bottom.
 *  4. Expand state of a tool bubble survives the row scrolling out of the window
 *     and back (id-keyed registry, mirroring mobile #5534).
 *
 * jsdom reports 0 for layout geometry, so we stub `offsetHeight` (per-row
 * height), and the container's `clientHeight` / `scrollHeight` / `scrollTop`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { useState } from 'react'
import { ChatView, type ChatViewMessage } from './ChatView'
import { ToolBubble } from './ToolBubble'

afterEach(cleanup)

const ROW_HEIGHT = 80
const VIEWPORT = 400
// ChatView folds the `.chat-messages` gap (12px) into each row's windowing
// height, so a windowed-out row reserves ROW_HEIGHT + ROW_GAP of spacer.
const ROW_GAP = 12
const ROW_SLOT = ROW_HEIGHT + ROW_GAP

/**
 * Stub layout geometry. Every element reports ROW_HEIGHT as offsetHeight (rows
 * are uniform for the test); the scroll container reports a fixed viewport and a
 * scrollHeight derived from the row count, with a settable scrollTop.
 */
function installLayoutStubs(rowCount: number) {
  const offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(ROW_HEIGHT)
  const clientHeight = vi
    .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
    .mockReturnValue(VIEWPORT)
  const scrollHeight = vi
    .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
    .mockReturnValue(rowCount * ROW_HEIGHT)
  return () => {
    offsetHeight.mockRestore()
    clientHeight.mockRestore()
    scrollHeight.mockRestore()
  }
}

function setScrollTop(el: HTMLElement, value: number) {
  Object.defineProperty(el, 'scrollTop', { value, writable: true, configurable: true })
}

function makeMessages(count: number): ChatViewMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    type: 'response' as const,
    content: `Message ${i}`,
    timestamp: 1000 + i,
  }))
}

describe('ChatView virtualization (#5561)', () => {
  it('renders every row below the threshold (no behaviour change)', () => {
    const restore = installLayoutStubs(10)
    try {
      render(<ChatView messages={makeMessages(10)} isStreaming={false} />)
      // All 10 rows present; no spacers.
      expect(screen.getAllByTestId(/^msg-msg-\d+$/).length).toBe(10)
      expect(screen.queryByTestId('chat-window-top-spacer')).not.toBeInTheDocument()
      expect(screen.queryByTestId('chat-window-bottom-spacer')).not.toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it('renders only the visible window above the threshold', async () => {
    const restore = installLayoutStubs(200)
    try {
      render(<ChatView messages={makeMessages(200)} isStreaming={false} />)
      const container = screen.getByTestId('chat-messages')
      // Scroll to the middle and let the windowing recompute.
      setScrollTop(container, 4000)
      await act(async () => {
        fireEvent.scroll(container)
      })
      const rendered = screen.getAllByTestId(/^msg-msg-\d+$/)
      // Far fewer than 200 rows are in the DOM.
      expect(rendered.length).toBeLessThan(40)
      expect(rendered.length).toBeGreaterThan(0)
      // Spacers reserve the windowed-out rows.
      expect(screen.getByTestId('chat-window-top-spacer')).toBeInTheDocument()
      expect(screen.getByTestId('chat-window-bottom-spacer')).toBeInTheDocument()
      // A row near the scroll offset (≈ row 50) is present; row 0 is windowed out.
      expect(screen.getByTestId('msg-msg-50')).toBeInTheDocument()
      expect(screen.queryByTestId('msg-msg-0')).not.toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it('keeps the top spacer height equal to the windowed-out leading rows', async () => {
    const restore = installLayoutStubs(200)
    try {
      render(<ChatView messages={makeMessages(200)} isStreaming={false} />)
      const container = screen.getByTestId('chat-messages')
      setScrollTop(container, 8000)
      await act(async () => {
        fireEvent.scroll(container)
      })
      const topSpacer = screen.getByTestId('chat-window-top-spacer')
      const bottomSpacer = screen.getByTestId('chat-window-bottom-spacer')
      const topPx = parseInt(topSpacer.style.height, 10)
      const bottomPx = parseInt(bottomSpacer.style.height, 10)
      const renderedCount = screen.getAllByTestId(/^msg-msg-\d+$/).length
      // Reserved + rendered slots ≈ total list slots (row + gap each).
      expect(topPx + renderedCount * ROW_SLOT + bottomPx).toBe(200 * ROW_SLOT)
      // Top spacer is an exact multiple of the windowed-out leading row slots.
      expect(topPx % ROW_SLOT).toBe(0)
      // We scrolled down, so there is meaningful leading reserved space.
      expect(topPx).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  it('pins to the bottom when a message is appended while at the bottom', async () => {
    const restore = installLayoutStubs(60)
    try {
      const { rerender } = render(<ChatView messages={makeMessages(60)} isStreaming={false} />)
      const container = screen.getByTestId('chat-messages')
      // Make scrollTop settable and place the user at the bottom.
      setScrollTop(container, 60 * ROW_HEIGHT - VIEWPORT)
      await act(async () => {
        fireEvent.scroll(container)
      })
      // scrollHeight grows when a message is appended.
      const grown = installLayoutStubs(61)
      try {
        rerender(<ChatView messages={makeMessages(61)} isStreaming={false} />)
        await act(async () => {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
        })
        // The count-change auto-scroll snapped the container to the new bottom.
        expect(container.scrollTop).toBe(61 * ROW_HEIGHT)
      } finally {
        grown()
      }
    } finally {
      restore()
    }
  })

  it('does not yank a scrolled-up reader to the bottom on append', async () => {
    const restore = installLayoutStubs(60)
    try {
      const { rerender } = render(<ChatView messages={makeMessages(60)} isStreaming={false} />)
      const container = screen.getByTestId('chat-messages')
      // User scrolled up to the top.
      setScrollTop(container, 0)
      await act(async () => {
        fireEvent.scroll(container)
      })
      expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument()
      const grown = installLayoutStubs(61)
      try {
        rerender(<ChatView messages={makeMessages(61)} isStreaming={false} />)
        await act(async () => {
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
        })
        // Reading position preserved — the new message did not snap us down.
        expect(container.scrollTop).toBe(0)
      } finally {
        grown()
      }
    } finally {
      restore()
    }
  })

  it('preserves tool-bubble expand state across a scroll-out / scroll-in', async () => {
    const restore = installLayoutStubs(200)
    try {
      // A tool bubble lives near the top (row 5). renderMessage surfaces it as
      // a real ToolBubble (the production path) so its expand state is governed
      // by the ChatView-held registry.
      const messages: ChatViewMessage[] = makeMessages(200)
      const renderMessage = (m: ChatViewMessage) =>
        m.id === 'msg-5' ? (
          <ToolBubble toolName="Bash" toolUseId="tool-5" input="ls -la" result="output" />
        ) : null

      render(
        <ChatView messages={messages} isStreaming={false} renderMessage={renderMessage} />,
      )
      const container = screen.getByTestId('chat-messages')

      // ChatView scrolls to the bottom on mount; scroll back to the top so the
      // row-5 bubble is inside the window.
      setScrollTop(container, 0)
      await act(async () => {
        fireEvent.scroll(container)
      })

      // The bubble is collapsed by default — expand it.
      const bubble = screen.getByTestId('tool-bubble-tool-5')
      expect(bubble).not.toHaveClass('expanded')
      await act(async () => {
        fireEvent.click(bubble)
      })
      expect(screen.getByTestId('tool-bubble-tool-5')).toHaveClass('expanded')

      // Scroll far down so the bubble's row windows out and unmounts.
      setScrollTop(container, 12000)
      await act(async () => {
        fireEvent.scroll(container)
      })
      expect(screen.queryByTestId('tool-bubble-tool-5')).not.toBeInTheDocument()

      // Scroll back to the top — the bubble remounts and must re-read its
      // expanded flag from the registry (id-keyed, mirror of mobile #5534).
      setScrollTop(container, 0)
      await act(async () => {
        fireEvent.scroll(container)
      })
      const remounted = screen.getByTestId('tool-bubble-tool-5')
      expect(remounted).toHaveClass('expanded')
    } finally {
      restore()
    }
  })

  it('compensates scrollTop when an above-viewport row re-measures taller (WKWebView has no native scroll anchoring)', async () => {
    // jsdom has no ResizeObserver, so install a controllable one: it records the
    // (element, callback) pairs and lets the test fire a re-measure for a chosen
    // row — the production path by which a tool bubble / streaming markdown grows
    // an already-mounted row's height. We give each row a per-id height (the
    // anchor row keeps its estimate; an above-viewport row in the overscan band
    // corrects taller), then fire its observer and assert the layout effect added
    // exactly the height delta back into scrollTop so the anchor stays pinned.
    type Entry = { el: HTMLElement; cb: ResizeObserverCallback }
    const observers: Entry[] = []
    class MockRO {
      cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) { this.cb = cb }
      observe(el: Element) { observers.push({ el: el as HTMLElement, cb: this.cb }) }
      unobserve() {}
      disconnect() {}
    }
    const origRO = globalThis.ResizeObserver
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      MockRO as unknown as typeof ResizeObserver

    // Per-row height store, keyed by the `data-row-key` MeasuredRow stamps on its
    // element. Defaults to ROW_HEIGHT; we mutate a single row to grow it.
    const rowHeights = new Map<string, number>()
    const offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      const key = this.getAttribute('data-row-key')
      if (key && rowHeights.has(key)) return rowHeights.get(key) as number
      return ROW_HEIGHT
    })
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT)
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200 * ROW_HEIGHT)
    try {
      render(<ChatView messages={makeMessages(200)} isStreaming={false} />)
      const container = screen.getByTestId('chat-messages')

      // Land mid-history scrolled up. Anchor ≈ row 50 (scrollTop / ROW_SLOT).
      setScrollTop(container, 50 * ROW_SLOT)
      await act(async () => {
        fireEvent.scroll(container)
      })
      expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument()
      const scrollTopBefore = container.scrollTop

      // Pick a mounted row ABOVE the anchor (in the overscan band) and grow it by
      // +60px, then fire its ResizeObserver — the real reflow path.
      const aboveRow = observers.find((o) => {
        const key = o.el.getAttribute('data-row-key')
        if (!key) return false
        const idx = Number(key.replace('msg-msg-', '').replace('msg-', ''))
        return idx < 50 && idx >= 44 // overscan band above the anchor
      })
      expect(aboveRow).toBeTruthy()
      const grownKey = aboveRow!.el.getAttribute('data-row-key') as string
      rowHeights.set(grownKey, ROW_HEIGHT + 60)
      await act(async () => {
        aboveRow!.cb([], aboveRow as unknown as ResizeObserver)
      })

      // Compensation added the +60 above-viewport delta back into scrollTop so the
      // anchor row stays under the same pixel (WKWebView would have left it at
      // scrollTopBefore and jumped the content up by 60px).
      expect(container.scrollTop).toBe(scrollTopBefore + 60)
      // Still scrolled up — compensation must not flip us to pinned/bottom.
      expect(screen.queryByTestId('scroll-to-bottom')).toBeInTheDocument()
    } finally {
      offsetHeight.mockRestore()
      clientHeight.mockRestore()
      scrollHeight.mockRestore()
      ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = origRO
    }
  })

  it('does not compensate (or jump) while pinned to the bottom', async () => {
    // At the bottom the dedicated streaming/count-change effects own scrollTop;
    // the compensation effect must stay out of their way even when an
    // above-viewport row re-measures.
    type Entry = { el: HTMLElement; cb: ResizeObserverCallback }
    const observers: Entry[] = []
    class MockRO {
      cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) { this.cb = cb }
      observe(el: Element) { observers.push({ el: el as HTMLElement, cb: this.cb }) }
      unobserve() {}
      disconnect() {}
    }
    const origRO = globalThis.ResizeObserver
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      MockRO as unknown as typeof ResizeObserver
    const rowHeights = new Map<string, number>()
    const offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      const key = this.getAttribute('data-row-key')
      if (key && rowHeights.has(key)) return rowHeights.get(key) as number
      return ROW_HEIGHT
    })
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT)
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200 * ROW_HEIGHT)
    try {
      render(<ChatView messages={makeMessages(200)} isStreaming={false} />)
      const container = screen.getByTestId('chat-messages')
      // Pin to the bottom.
      setScrollTop(container, 200 * ROW_HEIGHT - VIEWPORT)
      await act(async () => {
        fireEvent.scroll(container)
      })
      expect(screen.queryByTestId('scroll-to-bottom')).not.toBeInTheDocument()
      const before = container.scrollTop
      const anyRow = observers.find((o) => o.el.getAttribute('data-row-key'))
      if (anyRow) {
        const key = anyRow.el.getAttribute('data-row-key') as string
        rowHeights.set(key, ROW_HEIGHT + 60)
        await act(async () => {
          anyRow.cb([], anyRow as unknown as ResizeObserver)
        })
      }
      // Compensation stayed out of the pinned path — no jump from the layout effect.
      expect(container.scrollTop).toBe(before)
    } finally {
      offsetHeight.mockRestore()
      clientHeight.mockRestore()
      scrollHeight.mockRestore()
      ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = origRO
    }
  })

  it('resets expand state when ChatView remounts (registry is per-instance)', async () => {
    // Sanity guard: the registry is scoped to a ChatView instance, so a fresh
    // ChatView starts every bubble collapsed. (A new session unmounts/remounts.)
    const restore = installLayoutStubs(10)
    try {
      function Harness() {
        const [key, setKey] = useState(0)
        return (
          <>
            <button onClick={() => setKey((k) => k + 1)}>remount</button>
            <ChatView
              key={key}
              messages={makeMessages(10)}
              isStreaming={false}
              renderMessage={(m) =>
                m.id === 'msg-2' ? (
                  <ToolBubble toolName="Bash" toolUseId="tool-2" input="x" result="y" />
                ) : null
              }
            />
          </>
        )
      }
      render(<Harness />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('tool-bubble-tool-2'))
      })
      expect(screen.getByTestId('tool-bubble-tool-2')).toHaveClass('expanded')
      await act(async () => {
        fireEvent.click(screen.getByText('remount'))
      })
      expect(screen.getByTestId('tool-bubble-tool-2')).not.toHaveClass('expanded')
    } finally {
      restore()
    }
  })
})
