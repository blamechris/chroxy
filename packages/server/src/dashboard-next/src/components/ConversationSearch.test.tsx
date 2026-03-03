import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { ConversationSearch } from './ConversationSearch'
import type { SearchResult } from '../store/types'

describe('ConversationSearch (#1077)', () => {
  const mockSearchConversations = vi.fn()
  const mockClearSearchResults = vi.fn()
  const mockOnResumeSession = vi.fn()

  const sampleResults: SearchResult[] = [
    {
      conversationId: 'conv-1',
      projectName: 'my-project',
      project: '/home/user/my-project',
      cwd: '/home/user/my-project',
      preview: 'Fix authentication bug',
      snippet: '...found the auth bug in login.ts...',
      matchCount: 3,
    },
    {
      conversationId: 'conv-2',
      projectName: 'other-project',
      project: '/home/user/other-project',
      cwd: '/home/user/other-project',
      preview: 'Add tests for auth',
      snippet: '...testing the auth module...',
      matchCount: 1,
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders search input', () => {
    render(
      <ConversationSearch
        searchResults={[]}
        searchLoading={false}
        searchQuery=""
        searchConversations={mockSearchConversations}
        clearSearchResults={mockClearSearchResults}
        onResumeSession={mockOnResumeSession}
      />,
    )
    expect(screen.getByPlaceholderText('Search conversations...')).toBeInTheDocument()
  })

  it('calls searchConversations after debounce when typing', async () => {
    vi.useFakeTimers()
    render(
      <ConversationSearch
        searchResults={[]}
        searchLoading={false}
        searchQuery=""
        searchConversations={mockSearchConversations}
        clearSearchResults={mockClearSearchResults}
        onResumeSession={mockOnResumeSession}
      />,
    )

    const input = screen.getByPlaceholderText('Search conversations...')
    fireEvent.change(input, { target: { value: 'auth bug' } })

    // Should not have called yet (debounce)
    expect(mockSearchConversations).not.toHaveBeenCalled()

    // Advance past debounce
    act(() => { vi.advanceTimersByTime(350) })

    expect(mockSearchConversations).toHaveBeenCalledWith('auth bug')
  })

  it('clears results when input is cleared', async () => {
    vi.useFakeTimers()
    const { getByPlaceholderText } = render(
      <ConversationSearch
        searchResults={sampleResults}
        searchLoading={false}
        searchQuery="auth"
        searchConversations={mockSearchConversations}
        clearSearchResults={mockClearSearchResults}
        onResumeSession={mockOnResumeSession}
      />,
    )

    const input = getByPlaceholderText('Search conversations...')
    // Type something first, then clear
    fireEvent.change(input, { target: { value: 'auth' } })
    act(() => { vi.advanceTimersByTime(350) })
    mockClearSearchResults.mockClear()

    fireEvent.change(input, { target: { value: '' } })
    act(() => { vi.advanceTimersByTime(350) })

    expect(mockClearSearchResults).toHaveBeenCalled()
  })

  it('renders search results with preview and snippet', () => {
    render(
      <ConversationSearch
        searchResults={sampleResults}
        searchLoading={false}
        searchQuery="auth"
        searchConversations={mockSearchConversations}
        clearSearchResults={mockClearSearchResults}
        onResumeSession={mockOnResumeSession}
      />,
    )

    expect(screen.getByText('Fix authentication bug')).toBeInTheDocument()
    expect(screen.getByText('...found the auth bug in login.ts...')).toBeInTheDocument()
    expect(screen.getByText('Add tests for auth')).toBeInTheDocument()
  })

  it('shows loading state', () => {
    render(
      <ConversationSearch
        searchResults={[]}
        searchLoading={true}
        searchQuery="auth"
        searchConversations={mockSearchConversations}
        clearSearchResults={mockClearSearchResults}
        onResumeSession={mockOnResumeSession}
      />,
    )

    expect(screen.getByText('Searching...')).toBeInTheDocument()
  })

  it('calls onResumeSession when clicking a result', () => {
    render(
      <ConversationSearch
        searchResults={sampleResults}
        searchLoading={false}
        searchQuery="auth"
        searchConversations={mockSearchConversations}
        clearSearchResults={mockClearSearchResults}
        onResumeSession={mockOnResumeSession}
      />,
    )

    fireEvent.click(screen.getByText('Fix authentication bug'))
    expect(mockOnResumeSession).toHaveBeenCalledWith('conv-1', '/home/user/my-project')
  })

  it('shows "no results" when search returns empty', () => {
    render(
      <ConversationSearch
        searchResults={[]}
        searchLoading={false}
        searchQuery="nonexistent"
        searchConversations={mockSearchConversations}
        clearSearchResults={mockClearSearchResults}
        onResumeSession={mockOnResumeSession}
      />,
    )

    expect(screen.getByText('No results found')).toBeInTheDocument()
  })
})
