/**
 * ChatView in-session find — #6788
 *
 * Covers the find bar wired into the virtualized dashboard ChatView:
 *   1. Summoning (the openSearchSignal nonce) opens + focuses the bar.
 *   2. Typing shows an N/M counter and message-row-level highlight.
 *   3. Next / previous navigation cycles the active match (wrap-around).
 *   4. A non-matching query shows the "No results" state.
 *   5. Escape and the close button dismiss the bar (and clear the query).
 *   6. Jumping to a match works against the virtualized list — an off-screen
 *      (windowed-out) match is scrolled to and mounted without a manual scroll.
 *
 * jsdom reports 0 for layout geometry, so test 6 stubs offsetHeight / clientHeight
 * / scrollHeight the same way ChatView.virtualization.test.tsx does.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { useState } from 'react'
import { ChatView, type ChatViewMessage } from './ChatView'

afterEach(cleanup)

function makeMessages(count: number): ChatViewMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    type: 'response' as const,
    content: `Message ${i}`,
    timestamp: 1000 + i,
  }))
}

/** Render ChatView with a button that bumps the openSearchSignal nonce. */
function Harness({ messages }: { messages: ChatViewMessage[] }) {
  const [sig, setSig] = useState(0)
  return (
    <>
      <button data-testid="summon" onClick={() => setSig((n) => n + 1)}>
        summon
      </button>
      <ChatView messages={messages} isStreaming={false} openSearchSignal={sig} />
    </>
  )
}

function summon() {
  fireEvent.click(screen.getByTestId('summon'))
}

function type(value: string) {
  fireEvent.change(screen.getByTestId('transcript-search-input'), { target: { value } })
}

describe('ChatView in-session find (#6788)', () => {
  it('is hidden until summoned, then opens and focuses the input', () => {
    render(<Harness messages={makeMessages(5)} />)
    expect(screen.queryByTestId('transcript-search-bar')).not.toBeInTheDocument()
    summon()
    const input = screen.getByTestId('transcript-search-input')
    expect(input).toBeInTheDocument()
    expect(document.activeElement).toBe(input)
  })

  it('shows an N/M counter and highlights matching rows', () => {
    const messages: ChatViewMessage[] = [
      { id: 'm0', type: 'response', content: 'alpha match one', timestamp: 1 },
      { id: 'm1', type: 'response', content: 'beta', timestamp: 2 },
      { id: 'm2', type: 'response', content: 'gamma match two', timestamp: 3 },
      { id: 'm3', type: 'response', content: 'delta', timestamp: 4 },
      { id: 'm4', type: 'response', content: 'epsilon match three', timestamp: 5 },
    ]
    render(<Harness messages={messages} />)
    summon()
    type('match')
    expect(screen.getByTestId('transcript-search-count').textContent).toBe('1/3')
    // Every hit is tinted; the first is the active match.
    expect(document.querySelectorAll('[data-search-match]').length).toBe(3)
    const active = document.querySelector('[data-search-active]')
    expect(active?.getAttribute('data-row-key')).toBe('m0')
  })

  it('next / previous cycle the active match with wrap-around', () => {
    const messages: ChatViewMessage[] = [
      { id: 'm0', type: 'response', content: 'alpha match', timestamp: 1 },
      { id: 'm1', type: 'response', content: 'beta match', timestamp: 2 },
      { id: 'm2', type: 'response', content: 'gamma match', timestamp: 3 },
    ]
    render(<Harness messages={messages} />)
    summon()
    type('match')
    expect(screen.getByTestId('transcript-search-count').textContent).toBe('1/3')

    fireEvent.click(screen.getByTestId('transcript-search-next'))
    expect(screen.getByTestId('transcript-search-count').textContent).toBe('2/3')
    expect(document.querySelector('[data-search-active]')?.getAttribute('data-row-key')).toBe('m1')

    // Wrap forward past the end back to the first match.
    fireEvent.click(screen.getByTestId('transcript-search-next'))
    fireEvent.click(screen.getByTestId('transcript-search-next'))
    expect(screen.getByTestId('transcript-search-count').textContent).toBe('1/3')

    // Wrap backward from the first to the last.
    fireEvent.click(screen.getByTestId('transcript-search-prev'))
    expect(screen.getByTestId('transcript-search-count').textContent).toBe('3/3')
    expect(document.querySelector('[data-search-active]')?.getAttribute('data-row-key')).toBe('m2')
  })

  it('Enter advances and Shift+Enter steps back', () => {
    const messages: ChatViewMessage[] = [
      { id: 'm0', type: 'response', content: 'match a', timestamp: 1 },
      { id: 'm1', type: 'response', content: 'match b', timestamp: 2 },
    ]
    render(<Harness messages={messages} />)
    summon()
    type('match')
    const input = screen.getByTestId('transcript-search-input')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTestId('transcript-search-count').textContent).toBe('2/2')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByTestId('transcript-search-count').textContent).toBe('1/2')
  })

  it('shows "No results" for a non-matching query', () => {
    render(<Harness messages={makeMessages(5)} />)
    summon()
    type('zzz-nope')
    expect(screen.getByTestId('transcript-search-count').textContent).toBe('No results')
    expect(document.querySelector('[data-search-active]')).toBeNull()
  })

  it('Escape closes the bar and clears the query', () => {
    render(<Harness messages={makeMessages(5)} />)
    summon()
    type('Message')
    fireEvent.keyDown(screen.getByTestId('transcript-search-input'), { key: 'Escape' })
    expect(screen.queryByTestId('transcript-search-bar')).not.toBeInTheDocument()
    // Re-summon: the query was cleared, so no active match lingers.
    summon()
    expect(screen.getByTestId('transcript-search-input')).toHaveValue('')
    expect(document.querySelector('[data-search-active]')).toBeNull()
  })

  it('the close button dismisses the bar', () => {
    render(<Harness messages={makeMessages(5)} />)
    summon()
    expect(screen.getByTestId('transcript-search-bar')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('transcript-search-close'))
    expect(screen.queryByTestId('transcript-search-bar')).not.toBeInTheDocument()
  })

  it('jumps the virtualized list to an off-screen match and mounts it', async () => {
    const ROW_HEIGHT = 80
    const VIEWPORT = 400
    const offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(ROW_HEIGHT)
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT)
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200 * ROW_HEIGHT)
    try {
      // 200 rows (well past the windowing threshold); only row 150 has "needle".
      const messages = makeMessages(200)
      messages[150] = { id: 'msg-150', type: 'response', content: 'the needle in the haystack', timestamp: 2000 }

      render(<Harness messages={messages} />)
      // Off-screen precondition: row 150 is windowed out (not in the DOM).
      expect(screen.queryByTestId('msg-msg-150')).not.toBeInTheDocument()

      summon()
      await act(async () => {
        type('needle')
        // Flush the scroll-to-match effect + its next-frame correction pass.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
      })

      // The windowed list scrolled to the match and mounted it — no manual
      // scrolling required (the AC the issue calls out for the virtualized list).
      const row = screen.getByTestId('msg-msg-150')
      expect(row).toBeInTheDocument()
      expect(row).toHaveAttribute('data-search-active')
      expect(screen.getByTestId('transcript-search-count').textContent).toBe('1/1')
    } finally {
      offsetHeight.mockRestore()
      clientHeight.mockRestore()
      scrollHeight.mockRestore()
    }
  })
})
