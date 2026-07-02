/**
 * CodeSearchPalette — tests for the Cmd+Shift+F find-in-project palette (#6474).
 * Unlike the symbol palette, matching happens server-side, so typing dispatches a
 * (debounced) `requestSearchContent` and results come from `codeSearchResults`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { CodeSearchPalette } from './CodeSearchPalette'

const mockRequestSearchContent = vi.fn()
const mockOpenFileInBrowser = vi.fn()
let mockCodeSearchResults: any = null
let mockCodeSearchLoading = false

vi.mock('../store/connection', () => {
  const storeState = () => ({
    requestSearchContent: mockRequestSearchContent,
    codeSearchResults: mockCodeSearchResults,
    codeSearchLoading: mockCodeSearchLoading,
    openFileInBrowser: mockOpenFileInBrowser,
  })
  const useConnectionStore = Object.assign(
    (selector: any) => selector(storeState()),
    { getState: () => storeState(), setState: () => {} },
  )
  return { useConnectionStore }
})

afterEach(() => cleanup())
beforeEach(() => {
  vi.clearAllMocks()
  mockCodeSearchLoading = false
  mockCodeSearchResults = {
    query: 'target', truncated: false, error: null,
    results: [
      { file: 'src/a.ts', line: 3, column: 7, text: 'const target = 1' },
      { file: 'src/b.ts', line: 9, column: 1, text: 'target()' },
    ],
  }
})

describe('CodeSearchPalette (#6474)', () => {
  it('does not render when closed', () => {
    render(<CodeSearchPalette isOpen={false} onClose={() => {}} />)
    expect(screen.queryByTestId('code-search-palette')).toBeNull()
  })

  it('shows the 2+ char hint on open (empty query) and does not search', () => {
    render(<CodeSearchPalette isOpen={true} onClose={() => {}} />)
    expect(screen.getByTestId('code-search-hint')).toBeTruthy()
    expect(mockRequestSearchContent).not.toHaveBeenCalled()
  })

  it('dispatches a debounced search once the query is 2+ chars', async () => {
    render(<CodeSearchPalette isOpen={true} onClose={() => {}} />)
    const input = await screen.findByTestId('code-search-input')
    fireEvent.change(input, { target: { value: 'target' } })
    await waitFor(() => expect(mockRequestSearchContent).toHaveBeenCalledWith('target'), { timeout: 1000 })
  })

  it('does not search for a single character', () => {
    render(<CodeSearchPalette isOpen={true} onClose={() => {}} />)
    const input = screen.getByTestId('code-search-input')
    fireEvent.change(input, { target: { value: 't' } })
    expect(mockRequestSearchContent).not.toHaveBeenCalled()
    expect(screen.getByTestId('code-search-hint')).toBeTruthy()
  })

  it('renders the result rows for the current query', async () => {
    render(<CodeSearchPalette isOpen={true} onClose={() => {}} />)
    fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: 'target' } })
    await waitFor(() => {
      expect(screen.getByTestId('code-search-item-0')).toBeTruthy()
      expect(screen.getByTestId('code-search-item-1')).toBeTruthy()
    })
  })

  it('ignores stale results whose echoed query does not match the input', () => {
    render(<CodeSearchPalette isOpen={true} onClose={() => {}} />)
    // Type a query the (mock) stored results are NOT for → shows "Searching…", no rows.
    fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: 'different' } })
    expect(screen.queryByTestId('code-search-item-0')).toBeNull()
  })

  it('opens the file at the match line on Enter, then closes', async () => {
    const onClose = vi.fn()
    render(<CodeSearchPalette isOpen={true} onClose={onClose} />)
    const input = screen.getByTestId('code-search-input')
    fireEvent.change(input, { target: { value: 'target' } })
    await waitFor(() => screen.getByTestId('code-search-item-0'))
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockOpenFileInBrowser).toHaveBeenCalledWith('src/a.ts', 3)
    expect(onClose).toHaveBeenCalled()
  })

  it('arrow-down then Enter opens the second match', async () => {
    render(<CodeSearchPalette isOpen={true} onClose={() => {}} />)
    const input = screen.getByTestId('code-search-input')
    fireEvent.change(input, { target: { value: 'target' } })
    await waitFor(() => screen.getByTestId('code-search-item-1'))
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockOpenFileInBrowser).toHaveBeenCalledWith('src/b.ts', 9)
  })

  it('opens a match on click', async () => {
    render(<CodeSearchPalette isOpen={true} onClose={() => {}} />)
    fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: 'target' } })
    const row = await screen.findByTestId('code-search-item-1')
    fireEvent.mouseDown(row)
    expect(mockOpenFileInBrowser).toHaveBeenCalledWith('src/b.ts', 9)
  })

  it('closes on Escape without opening anything', () => {
    const onClose = vi.fn()
    render(<CodeSearchPalette isOpen={true} onClose={onClose} />)
    fireEvent.keyDown(screen.getByTestId('code-search-input'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(mockOpenFileInBrowser).not.toHaveBeenCalled()
  })

  it('shows "No matches" when the current query has an empty result set', async () => {
    mockCodeSearchResults = { query: 'zzz', truncated: false, error: null, results: [] }
    render(<CodeSearchPalette isOpen={true} onClose={() => {}} />)
    fireEvent.change(screen.getByTestId('code-search-input'), { target: { value: 'zzz' } })
    await waitFor(() => expect(screen.getByTestId('code-search-empty')).toBeTruthy())
  })
})
