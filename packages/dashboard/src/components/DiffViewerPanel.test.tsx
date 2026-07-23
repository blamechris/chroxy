/**
 * DiffViewerPanel — tests for diff viewer UI and interactions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { DiffViewerPanel } from './DiffViewerPanel'

const mockSetDiffCallback = vi.fn()
const mockRequestDiff = vi.fn()
const mockSendInput = vi.fn((_input: string) => 'sent' as 'sent' | 'queued' | false)

let storeState: Record<string, unknown> = {}
let capturedCallback: ((result: any) => void) | null = null

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: any) => {
    const store = {
      setDiffCallback: (cb: any) => {
        capturedCallback = cb
        mockSetDiffCallback(cb)
      },
      requestDiff: mockRequestDiff,
      connectionPhase: storeState.connectionPhase ?? 'connected',
      sendInput: mockSendInput,
    }
    return selector(store)
  },
}))

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
  mockSendInput.mockReturnValue('sent')
  storeState = { connectionPhase: 'connected' }
  capturedCallback = null
})

const DIFF_FILES = [
  {
    path: 'src/utils/helper.ts',
    status: 'modified' as const,
    additions: 5,
    deletions: 2,
    hunks: [
      {
        header: '@@ -10,6 +10,9 @@',
        lines: [
          { type: 'context' as const, content: 'const x = 1' },
          { type: 'deletion' as const, content: 'const y = 2' },
          { type: 'addition' as const, content: 'const y = 3' },
          { type: 'addition' as const, content: 'const z = 4' },
          { type: 'context' as const, content: 'export { x }' },
        ],
      },
    ],
  },
  {
    path: 'src/new-file.ts',
    status: 'added' as const,
    additions: 10,
    deletions: 0,
    hunks: [
      {
        header: '@@ -0,0 +1,10 @@',
        lines: [
          { type: 'addition' as const, content: 'export const foo = 1' },
        ],
      },
    ],
  },
]

describe('DiffViewerPanel', () => {
  it('requests diff on mount', () => {
    render(<DiffViewerPanel />)
    expect(mockRequestDiff).toHaveBeenCalledOnce()
  })

  it('shows loading state initially', () => {
    render(<DiffViewerPanel />)
    expect(screen.getByText('Loading diff...')).toBeTruthy()
  })

  it('shows empty state when no changes', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [], error: null }))
    expect(screen.getByText('No uncommitted changes.')).toBeTruthy()
  })

  it('shows error state', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [], error: 'Git not available' }))
    expect(screen.getByText('Git not available')).toBeTruthy()
  })

  it('renders file sidebar with file names', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: DIFF_FILES, error: null }))

    const sidebar = screen.getByTestId('diff-sidebar')
    expect(sidebar).toBeTruthy()
    expect(sidebar.textContent).toContain('helper.ts')
    expect(sidebar.textContent).toContain('new-file.ts')
  })

  it('renders diff file views with hunks', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: DIFF_FILES, error: null }))

    const fileViews = screen.getAllByTestId('diff-file-view')
    expect(fileViews).toHaveLength(2)

    const hunkHeaders = screen.getAllByTestId('hunk-header')
    expect(hunkHeaders).toHaveLength(2)
    expect(hunkHeaders[0]!.textContent).toBe('@@ -10,6 +10,9 @@')
  })

  it('renders diff lines with correct prefixes', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))

    const lines = screen.getAllByTestId('diff-line')
    // 5 lines: context, deletion, addition, addition, context
    expect(lines).toHaveLength(5)

    // Check prefixes
    expect(lines[0]!.textContent).toContain(' const x = 1')
    expect(lines[1]!.textContent).toContain('-const y = 2')
    expect(lines[2]!.textContent).toContain('+const y = 3')
  })

  it('shows file stats in toolbar', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: DIFF_FILES, error: null }))

    expect(screen.getByText(/2 files/)).toBeTruthy()
    expect(screen.getAllByText('+15').length).toBeGreaterThan(0)
    expect(screen.getAllByText('-2').length).toBeGreaterThan(0)
  })

  it('switches to split view', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))

    fireEvent.click(screen.getByText('Split'))
    const rows = screen.getAllByTestId('split-row')
    expect(rows.length).toBeGreaterThan(0)
  })

  it('refreshes diff on Refresh click', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [], error: null }))
    mockRequestDiff.mockClear()

    fireEvent.click(screen.getByText('Refresh'))
    expect(mockRequestDiff).toHaveBeenCalledOnce()
  })

  it('highlights selected file in sidebar', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: DIFF_FILES, error: null }))

    const sidebar = screen.getByTestId('diff-sidebar')
    const items = sidebar.querySelectorAll('.diff-sidebar-item')
    fireEvent.click(items[1]!)
    expect(items[1]!.classList.contains('active')).toBe(true)
  })

  it('shows addition/deletion stats per file', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: DIFF_FILES, error: null }))

    const fileViews = screen.getAllByTestId('diff-file-view')
    expect(fileViews[0]!.textContent).toContain('+5')
    expect(fileViews[0]!.textContent).toContain('-2')
    expect(fileViews[1]!.textContent).toContain('+10')
  })

  it('shows status badges', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: DIFF_FILES, error: null }))

    const fileViews = screen.getAllByTestId('diff-file-view')
    expect(fileViews[0]!.textContent).toContain('M')
    expect(fileViews[1]!.textContent).toContain('A')
  })

  // ---- #6800: inline comments + review triggers ----

  it('exposes a comment affordance on each unified line', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))
    // 5 lines in the fixture hunk → 5 comment buttons.
    expect(screen.getAllByTestId('diff-line-comment-btn')).toHaveLength(5)
  })

  it('does not render comment buttons in split view', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))
    fireEvent.click(screen.getByText('Split'))
    expect(screen.queryByTestId('diff-line-comment-btn')).toBeNull()
  })

  it('opens an inline editor and queues a comment, showing the submit control', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))

    // Open the editor on the second line (the deletion `const y = 2`).
    fireEvent.click(screen.getAllByTestId('diff-line-comment-btn')[1]!)
    const input = screen.getByTestId('diff-comment-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'why remove this?' } })
    fireEvent.click(screen.getByTestId('diff-comment-save'))

    // The note is shown and the toolbar exposes a single-comment submit button.
    expect(screen.getByTestId('diff-line-comment-note').textContent).toContain('why remove this?')
    expect(screen.getByTestId('diff-submit-comments-btn').textContent).toContain('Submit 1 comment')
  })

  it('submits queued comments as a composed prompt via sendInput', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))

    fireEvent.click(screen.getAllByTestId('diff-line-comment-btn')[2]!) // addition `const y = 3`
    fireEvent.change(screen.getByTestId('diff-comment-input'), {
      target: { value: 'use a const enum' },
    })
    fireEvent.click(screen.getByTestId('diff-comment-save'))
    fireEvent.click(screen.getByTestId('diff-submit-comments-btn'))

    expect(mockSendInput).toHaveBeenCalledTimes(1)
    const prompt = mockSendInput.mock.calls[0]![0] as string
    expect(prompt).toContain('review comment')
    expect(prompt).toContain('src/utils/helper.ts:')
    expect(prompt).toContain('use a const enum')
    // The derived new-file line number for the first addition is 11.
    expect(prompt).toContain('Line 11')

    // After a successful send the queue clears and a confirmation shows.
    expect(screen.queryByTestId('diff-submit-comments-btn')).toBeNull()
    expect(screen.getByTestId('diff-toolbar-sent')).toBeTruthy()
  })

  it('keeps queued comments when the send fails', () => {
    mockSendInput.mockReturnValue(false as any)
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))

    fireEvent.click(screen.getAllByTestId('diff-line-comment-btn')[0]!)
    fireEvent.change(screen.getByTestId('diff-comment-input'), { target: { value: 'note' } })
    fireEvent.click(screen.getByTestId('diff-comment-save'))
    fireEvent.click(screen.getByTestId('diff-submit-comments-btn'))

    expect(screen.getByTestId('diff-submit-comments-btn')).toBeTruthy()
  })

  it('removes a queued comment', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))

    fireEvent.click(screen.getAllByTestId('diff-line-comment-btn')[0]!)
    fireEvent.change(screen.getByTestId('diff-comment-input'), { target: { value: 'note' } })
    fireEvent.click(screen.getByTestId('diff-comment-save'))
    expect(screen.getByTestId('diff-submit-comments-btn')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Remove comment'))
    expect(screen.queryByTestId('diff-submit-comments-btn')).toBeNull()
  })

  it('triggers a one-click review over the whole diff via sendInput', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: DIFF_FILES, error: null }))

    fireEvent.click(screen.getByTestId('diff-review-btn'))
    expect(mockSendInput).toHaveBeenCalledTimes(1)
    const prompt = mockSendInput.mock.calls[0]![0] as string
    expect(prompt).toContain('review the current uncommitted changes')
    expect(prompt).toContain('src/utils/helper.ts')
    expect(prompt).toContain('src/new-file.ts')
  })

  it('drops queued comments on refresh (positions may have shifted)', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))

    fireEvent.click(screen.getAllByTestId('diff-line-comment-btn')[0]!)
    fireEvent.change(screen.getByTestId('diff-comment-input'), { target: { value: 'note' } })
    fireEvent.click(screen.getByTestId('diff-comment-save'))
    expect(screen.getByTestId('diff-submit-comments-btn')).toBeTruthy()

    fireEvent.click(screen.getByText('Refresh'))
    expect(screen.queryByTestId('diff-submit-comments-btn')).toBeNull()
  })
})
