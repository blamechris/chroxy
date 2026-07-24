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

// A structurally-identical clone of DIFF_FILES[0] — a different object/array
// reference but the same content, simulating a no-op reconnect re-landing the
// same diff (#6961).
const DIFF_FILES_0_CLONE = JSON.parse(JSON.stringify(DIFF_FILES[0]))

// DIFF_FILES[0] with one line's content changed — simulates a genuine diff
// change (e.g. positions shifted) landing on a reconnect (#6946).
const DIFF_FILES_0_CHANGED = {
  ...DIFF_FILES[0]!,
  hunks: [
    {
      ...DIFF_FILES[0]!.hunks[0]!,
      lines: DIFF_FILES[0]!.hunks[0]!.lines.map((l, i) =>
        i === 2 ? { ...l, content: 'const y = 99' } : l,
      ),
    },
  ],
}

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

  it('exposes a comment affordance on the split view lines too', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))
    fireEvent.click(screen.getByText('Split'))
    // Each non-empty split cell is commentable, but a context line (same
    // target on both sides) contributes exactly ONE button, on the new-file
    // (right) side (#6947) — not two. The 2 context lines contribute 1 each,
    // the deletion + its paired addition are one button each, and the
    // standalone second addition adds one more → 1 + 2 + 1 + 1 = 5 buttons
    // across the 4 split rows.
    expect(screen.getAllByTestId('diff-line-comment-btn')).toHaveLength(5)
  })

  it('shows exactly one comment affordance for a context line in split view (#6947)', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))
    fireEvent.click(screen.getByText('Split'))

    // The two context rows (index 0 and 4 in the fixture hunk) each carry a
    // SINGLE comment target shared by both columns — assert only one gutter
    // button renders per context row, not one per side.
    const rows = screen.getAllByTestId('split-row')
    const contextRows = [rows[0]!, rows[3]!]
    for (const row of contextRows) {
      expect(row.querySelectorAll('[data-testid="diff-line-comment-btn"]')).toHaveLength(1)
    }
  })

  it('queues and submits a comment made in the split view', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))
    fireEvent.click(screen.getByText('Split'))

    // Button order follows the split rows: [ctx0-R, del1-L, add2-R, add3-R,
    // ctx4-R] (context rows now contribute a single right-side button —
    // #6947). Index 2 is the addition `const y = 3` (new-file line 11) on
    // the right side of the second row.
    fireEvent.click(screen.getAllByTestId('diff-line-comment-btn')[2]!)
    fireEvent.change(screen.getByTestId('diff-comment-input'), {
      target: { value: 'use a const enum' },
    })
    fireEvent.click(screen.getByTestId('diff-comment-save'))

    // The comment renders full-width below the row and the toolbar exposes the
    // submit control (still in split view — never toggled back to unified).
    expect(screen.getByTestId('diff-line-comment-note').textContent).toContain('use a const enum')
    fireEvent.click(screen.getByTestId('diff-submit-comments-btn'))

    expect(mockSendInput).toHaveBeenCalledTimes(1)
    const prompt = mockSendInput.mock.calls[0]![0] as string
    expect(prompt).toContain('review comment')
    expect(prompt).toContain('src/utils/helper.ts:')
    expect(prompt).toContain('use a const enum')
    expect(prompt).toContain('Line 11')
  })

  it('shows a comment added in unified view when switched to split (shared state)', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))

    // Add a comment on the addition (index 2) in the default unified view.
    fireEvent.click(screen.getAllByTestId('diff-line-comment-btn')[2]!)
    fireEvent.change(screen.getByTestId('diff-comment-input'), {
      target: { value: 'parity note' },
    })
    fireEvent.click(screen.getByTestId('diff-comment-save'))

    // The same position-keyed comment is present after switching to split.
    fireEvent.click(screen.getByText('Split'))
    expect(screen.getByTestId('diff-line-comment-note').textContent).toContain('parity note')
    // The commented line's cell carries the has-comment accent in split too.
    expect(document.querySelector('.diff-split-cell-has-comment')).toBeTruthy()
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

  it('drops queued comments when an auto-refresh/reconnect pushes a genuinely CHANGED diff, not just manual Refresh (#6946)', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))

    fireEvent.click(screen.getAllByTestId('diff-line-comment-btn')[0]!)
    fireEvent.change(screen.getByTestId('diff-comment-input'), { target: { value: 'note' } })
    fireEvent.click(screen.getByTestId('diff-comment-save'))
    expect(screen.getByTestId('diff-submit-comments-btn')).toBeTruthy()

    // Simulate an auto-refresh/reconnect diff push driven by the store — the
    // same `capturedCallback` the connection layer invokes on every diff
    // (re)request — WITHOUT going through the manual Refresh button. The
    // landed diff has genuinely changed content (positions may have shifted),
    // which is the case #6946 targets — as opposed to a no-op re-delivery of
    // the identical diff, which #6961 below asserts is now spared.
    act(() => capturedCallback!({ files: [DIFF_FILES_0_CHANGED as typeof DIFF_FILES[0]], error: null }))
    expect(screen.queryByTestId('diff-submit-comments-btn')).toBeNull()
  })

  it('preserves queued comments and an open draft across a no-op reconnect landing (identical diff) (#6961)', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))

    // Queue a saved comment on the first line.
    fireEvent.click(screen.getAllByTestId('diff-line-comment-btn')[0]!)
    fireEvent.change(screen.getByTestId('diff-comment-input'), { target: { value: 'note' } })
    fireEvent.click(screen.getByTestId('diff-comment-save'))
    expect(screen.getByTestId('diff-submit-comments-btn')).toBeTruthy()

    // Open a SECOND line's editor and leave an unsaved draft in it.
    fireEvent.click(screen.getAllByTestId('diff-line-comment-btn')[1]!)
    fireEvent.change(screen.getByTestId('diff-comment-input'), { target: { value: 'unsaved draft' } })

    // A routine WS reconnect re-lands a byte-identical diff — same content,
    // different object/array reference (as a fresh WS payload would be).
    act(() => capturedCallback!({ files: [DIFF_FILES_0_CLONE], error: null }))

    // The queued comment survives...
    expect(screen.getByTestId('diff-submit-comments-btn')).toBeTruthy()
    // ...and the open editor + its unsaved draft survive too.
    expect((screen.getByTestId('diff-comment-input') as HTMLTextAreaElement).value).toBe('unsaved draft')
  })

  it('clears queued comments and the open draft when a diff-landing genuinely changes (#6946 still holds)', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))

    fireEvent.click(screen.getAllByTestId('diff-line-comment-btn')[0]!)
    fireEvent.change(screen.getByTestId('diff-comment-input'), { target: { value: 'note' } })
    fireEvent.click(screen.getByTestId('diff-comment-save'))
    expect(screen.getByTestId('diff-submit-comments-btn')).toBeTruthy()

    // Open a second line's editor with an unsaved draft.
    fireEvent.click(screen.getAllByTestId('diff-line-comment-btn')[1]!)
    fireEvent.change(screen.getByTestId('diff-comment-input'), { target: { value: 'unsaved draft' } })

    // A reconnect that lands genuinely different diff content (positions may
    // have shifted) still invalidates position-keyed comments + the open
    // draft — the #6946 behavior is unchanged for the real-change case.
    act(() => capturedCallback!({ files: [DIFF_FILES_0_CHANGED as typeof DIFF_FILES[0]], error: null }))

    expect(screen.queryByTestId('diff-submit-comments-btn')).toBeNull()
    expect(screen.queryByTestId('diff-comment-input')).toBeNull()
  })

  it('clears queued comments on manual Refresh even though the returned diff turns out unchanged', () => {
    render(<DiffViewerPanel />)
    act(() => capturedCallback!({ files: [DIFF_FILES[0]!], error: null }))

    fireEvent.click(screen.getAllByTestId('diff-line-comment-btn')[0]!)
    fireEvent.change(screen.getByTestId('diff-comment-input'), { target: { value: 'note' } })
    fireEvent.click(screen.getByTestId('diff-comment-save'))
    expect(screen.getByTestId('diff-submit-comments-btn')).toBeTruthy()

    // Manual Refresh clears synchronously, regardless of what the diff
    // eventually turns out to contain when it lands.
    fireEvent.click(screen.getByText('Refresh'))
    expect(screen.queryByTestId('diff-submit-comments-btn')).toBeNull()

    // Even if the diff that lands afterward is identical to what was shown
    // before the refresh, the comments stay cleared (there's nothing to
    // preserve — handleRefresh already dropped them as an explicit user
    // action).
    act(() => capturedCallback!({ files: [DIFF_FILES_0_CLONE], error: null }))
    expect(screen.queryByTestId('diff-submit-comments-btn')).toBeNull()
  })
})
