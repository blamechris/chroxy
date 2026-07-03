/**
 * HunkView (#6542, IDE P3.1) — the selectable per-hunk view. Covers the opt-in
 * accept/reject toggle and, critically, that the read-only path (no `selectable`)
 * renders NO checkbox so DiffViewerPanel is unregressed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { DiffHunk } from '@chroxy/store-core'
import { HunkView } from './DiffViewerPanel'

afterEach(cleanup)

const HUNK: DiffHunk = {
  header: '@@ -1,3 +1,3 @@',
  lines: [
    { type: 'context', content: 'a' },
    { type: 'deletion', content: 'b' },
    { type: 'addition', content: 'B' },
    { type: 'context', content: 'c' },
  ],
}

describe('HunkView (#6542)', () => {
  it('read-only (no selectable): renders NO checkbox — DiffViewerPanel unregressed', () => {
    render(<HunkView hunk={HUNK} viewMode="unified" />)
    expect(screen.queryByTestId('hunk-toggle')).toBeNull()
    expect(screen.getByTestId('hunk-header').textContent).toBe('@@ -1,3 +1,3 @@')
  })

  it('selectable + selected: renders a checked toggle beside the header', () => {
    render(<HunkView hunk={HUNK} viewMode="unified" selectable selected onToggle={() => {}} />)
    const box = screen.getByTestId('hunk-toggle') as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(box.getAttribute('aria-label')).toBe('Reject this hunk')
  })

  it('selectable + not selected: unchecked, dimmed (rejected class), accept aria-label', () => {
    const { container } = render(<HunkView hunk={HUNK} viewMode="unified" selectable selected={false} onToggle={() => {}} />)
    const box = screen.getByTestId('hunk-toggle') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(box.getAttribute('aria-label')).toBe('Accept this hunk')
    expect(container.querySelector('.diff-hunk-rejected')).not.toBeNull()
  })

  it('fires onToggle when the checkbox changes', () => {
    const onToggle = vi.fn()
    render(<HunkView hunk={HUNK} viewMode="unified" selectable selected onToggle={onToggle} />)
    fireEvent.click(screen.getByTestId('hunk-toggle'))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('still renders the hunk lines in both view modes when selectable', () => {
    const { rerender } = render(<HunkView hunk={HUNK} viewMode="unified" selectable selected onToggle={() => {}} />)
    expect(screen.getAllByTestId('diff-line').length).toBe(4)
    rerender(<HunkView hunk={HUNK} viewMode="split" selectable selected onToggle={() => {}} />)
    expect(screen.getAllByTestId('split-row').length).toBeGreaterThan(0)
  })
})
