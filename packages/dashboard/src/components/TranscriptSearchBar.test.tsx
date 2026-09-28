/**
 * TranscriptSearchBar (#6788) — the in-session find bar overlaid on ChatView.
 * Keyboard: Enter -> next, Shift+Enter -> previous, Escape -> close.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TranscriptSearchBar, type TranscriptSearchBarProps } from './TranscriptSearchBar'

afterEach(cleanup)

function renderBar(overrides: Partial<TranscriptSearchBarProps> = {}) {
  const props: TranscriptSearchBarProps = {
    query: 'foo',
    currentIndex: 0,
    matchCount: 3,
    onQueryChange: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<TranscriptSearchBar {...props} />) }
}

describe('TranscriptSearchBar (#6788)', () => {
  it('renders the query and match counter', () => {
    renderBar({ query: 'foo', currentIndex: 1, matchCount: 3 })
    const input = screen.getByTestId('transcript-search-input') as HTMLInputElement
    expect(input.value).toBe('foo')
    expect(screen.getByTestId('transcript-search-count')).toHaveTextContent('2/3')
  })

  it('Enter advances to the next match', () => {
    const onNext = vi.fn()
    renderBar({ onNext })
    fireEvent.keyDown(screen.getByTestId('transcript-search-input'), { key: 'Enter' })
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('Shift+Enter steps to the previous match', () => {
    const onPrev = vi.fn()
    renderBar({ onPrev })
    fireEvent.keyDown(screen.getByTestId('transcript-search-input'), { key: 'Enter', shiftKey: true })
    expect(onPrev).toHaveBeenCalledTimes(1)
  })

  it('Escape closes the find bar', () => {
    const onClose = vi.fn()
    renderBar({ onClose })
    fireEvent.keyDown(screen.getByTestId('transcript-search-input'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // #8064 — the Enter that commits an IME composition must not be read as
  // "jump to the next match".
  it('does not advance to the next match on Enter during IME composition', () => {
    const onNext = vi.fn()
    renderBar({ onNext })
    fireEvent.keyDown(screen.getByTestId('transcript-search-input'), { key: 'Enter', isComposing: true })
    expect(onNext).not.toHaveBeenCalled()
  })

  // #8064 — Safari fallback: keyCode 229 must suppress it too.
  it('does not advance to the next match on Enter with keyCode 229 (Safari fallback)', () => {
    const onNext = vi.fn()
    renderBar({ onNext })
    fireEvent.keyDown(screen.getByTestId('transcript-search-input'), { key: 'Enter', keyCode: 229 })
    expect(onNext).not.toHaveBeenCalled()
  })
})
