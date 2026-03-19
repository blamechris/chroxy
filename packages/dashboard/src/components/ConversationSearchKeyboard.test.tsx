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
  const ret = render(
    <ConversationSearch
      searchResults={results}
      searchLoading={false}
      searchQuery="test"
      searchConversations={vi.fn()}
      clearSearchResults={vi.fn()}
      onResumeSession={onResume}
    />,
  )
  return { ...ret, onResume }
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
    const { onResume } = renderSearch()
    const options = screen.getAllByRole('option')
    options[1]!.focus()
    fireEvent.keyDown(options[1]!, { key: 'Enter' })
    expect(onResume).toHaveBeenCalledWith('conv-2', '/home/user/project-b')
  })
})
