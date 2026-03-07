/**
 * DiffViewerPanel — tests for diff viewer UI and interactions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { DiffViewerPanel } from './DiffViewerPanel'

const mockSetDiffCallback = vi.fn()
const mockRequestDiff = vi.fn()

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
    }
    return selector(store)
  },
}))

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
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
})
