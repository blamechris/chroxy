/**
 * ConversationSearch keyboard navigation tests (#1407)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ConversationSearch } from './ConversationSearch'
import type { SearchResult } from '../store/types'

afterEach(cleanup)

const sampleResults: SearchResult[] = [
  {
    conversationId: 'conv-1',
    projectName: 'project-a',
    project: '/home/user/project-a',
    cwd: '/home/user/project-a',
    preview: 'Fix auth bug',
    snippet: '...auth bug fix...',
    matchCount: 2,
  },
  {
    conversationId: 'conv-2',
    projectName: 'project-b',
    project: '/home/user/project-b',
    cwd: '/home/user/project-b',
    preview: 'Add tests',
    snippet: '...adding tests...',
    matchCount: 1,
  },
  {
    conversationId: 'conv-3',
    projectName: 'project-c',
    project: '/home/user/project-c',
    cwd: '/home/user/project-c',
    preview: 'Refactor utils',
    snippet: '...refactoring...',
    matchCount: 4,
  },
]

function renderSearch(results = sampleResults) {
  const onResume = vi.fn()
  const onView = vi.fn()
  const ret = render(
    <ConversationSearch
      searchResults={results}
      searchLoading={false}
      searchQuery="test"
      searchConversations={vi.fn()}
      clearSearchResults={vi.fn()}
      onResumeSession={onResume}
      onViewConversation={onView}
    />,
  )
  return { ...ret, onResume, onView }
}

describe('ConversationSearch keyboard navigation (#1407)', () => {
  it('results list has role="listbox"', () => {
    renderSearch()
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('result items have role="option"', () => {
    renderSearch()
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
  })

  it('ArrowDown from input focuses first result', () => {
    renderSearch()
    const input = screen.getByPlaceholderText('Search conversations...')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const options = screen.getAllByRole('option')
    expect(document.activeElement).toBe(options[0])
  })

  it('ArrowDown moves focus to next result', () => {
    renderSearch()
    const options = screen.getAllByRole('option')
    options[0]!.focus()
    fireEvent.keyDown(options[0]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(options[1])
  })

  it('ArrowUp moves focus to previous result', () => {
    renderSearch()
    const options = screen.getAllByRole('option')
    options[1]!.focus()
    fireEvent.keyDown(options[1]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(options[0])
  })

  it('ArrowUp from first result returns focus to input', () => {
    renderSearch()
    const options = screen.getAllByRole('option')
    const input = screen.getByPlaceholderText('Search conversations...')
    options[0]!.focus()
    fireEvent.keyDown(options[0]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(input)
  })

  it('Enter on focused result calls onResumeSession', () => {
    const { onResume, onView } = renderSearch()
    const options = screen.getAllByRole('option')
    options[1]!.focus()
    fireEvent.keyDown(options[1]!, { key: 'Enter' })
    expect(onResume).toHaveBeenCalledWith('conv-2', '/home/user/project-b')
    // #6863 — Enter must keep resuming only; it must never fire View.
    expect(onView).not.toHaveBeenCalled()
  })
})

/**
 * #7000 CRITICAL 2 — the row's keydown handler must not swallow keys aimed at
 * its action buttons.
 *
 * The View / Resume buttons are tabbable children of the `role="option"` row,
 * and keydown bubbles. With an unscoped row handler, Enter on **View** ran the
 * row's Enter case: it dispatched a RESUME (a real provider spawn, the exact
 * opposite of the read-only action the user asked for) and its
 * `preventDefault()` also cancelled the button's own native Enter → click
 * activation, so View never fired. The pre-existing tests only ever fired
 * keydown on the row, which is why this passed.
 */
describe('ConversationSearch row keydown scoping (#7000 C2)', () => {
  /**
   * Models a real browser's handling of an activation key: dispatch keydown
   * (Space additionally keyup), and — only if nothing called
   * `preventDefault()` — perform the default action a native <button> takes,
   * i.e. activation → click. jsdom's `fireEvent` synthesizes neither the
   * activation nor the cancellation, so both halves are applied here; that is
   * precisely what makes the regression observable, since the old row handler
   * cancelled the event.
   */
  function pressActivationKey(el: HTMLElement, key: 'Enter' | ' ') {
    const notPrevented = fireEvent.keyDown(el, { key })
    if (key === ' ') fireEvent.keyUp(el, { key })
    if (notPrevented && el.tagName === 'BUTTON') fireEvent.click(el)
    return notPrevented
  }

  for (const key of ['Enter', ' '] as const) {
    const label = key === ' ' ? 'Space' : 'Enter'

    it(`${label} on the View button activates View and never resumes`, () => {
      const { onResume, onView } = renderSearch()
      const view = screen.getByTestId('conversation-search-view-conv-2')
      view.focus()

      pressActivationKey(view, key)

      expect(onView).toHaveBeenCalledTimes(1)
      expect(onView).toHaveBeenCalledWith('conv-2', '/home/user/project-b')
      // The whole point: no provider spawn.
      expect(onResume).not.toHaveBeenCalled()
    })

    it(`${label} on the Resume button resumes exactly once`, () => {
      const { onResume, onView } = renderSearch()
      const resume = screen.getByTestId('conversation-search-resume-conv-3')
      resume.focus()

      pressActivationKey(resume, key)

      expect(onResume).toHaveBeenCalledTimes(1)
      expect(onResume).toHaveBeenCalledWith('conv-3', '/home/user/project-c')
      expect(onView).not.toHaveBeenCalled()
    })
  }

  it('the row itself still resumes on Enter (unchanged behavior)', () => {
    const { onResume, onView } = renderSearch()
    const row = screen.getAllByRole('option')[0]!
    row.focus()

    // Still cancelled on the row (it owns Enter/Space there).
    expect(pressActivationKey(row, 'Enter')).toBe(false)
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onResume).toHaveBeenCalledWith('conv-1', '/home/user/project-a')
    expect(onView).not.toHaveBeenCalled()
  })

  it('the row itself still resumes on Space (unchanged behavior)', () => {
    const { onResume, onView } = renderSearch()
    const row = screen.getAllByRole('option')[1]!
    row.focus()

    pressActivationKey(row, ' ')
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onResume).toHaveBeenCalledWith('conv-2', '/home/user/project-b')
    expect(onView).not.toHaveBeenCalled()
  })

  it('a click on View does not also fire the row click (no double dispatch)', () => {
    const { onResume, onView } = renderSearch()
    fireEvent.click(screen.getByTestId('conversation-search-view-conv-1'))
    expect(onView).toHaveBeenCalledTimes(1)
    expect(onResume).not.toHaveBeenCalled()
  })
})
