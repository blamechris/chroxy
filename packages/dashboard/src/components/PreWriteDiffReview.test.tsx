/**
 * PreWriteDiffReview (#6543 PR-3) — the per-hunk pre-write review. Covers the
 * diff derivation per tool, that dropping a hunk emits the narrowed content on
 * the ONE whitelisted field, all-kept emits null, and non-reviewable tools
 * render nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { PreWriteDiffReview, isReviewableTool } from './PreWriteDiffReview'

afterEach(cleanup)

describe('PreWriteDiffReview (#6543)', () => {
  it('isReviewableTool: Write/Edit are reviewable, others are not', () => {
    expect(isReviewableTool('Write')).toBe(true)
    expect(isReviewableTool('Edit')).toBe(true)
    expect(isReviewableTool('Bash')).toBe(false)
    expect(isReviewableTool('Read')).toBe(false)
  })

  it('Edit: diffs old→new; dropping the hunk emits its range, not content (#8446)', () => {
    const onChange = vi.fn()
    render(<PreWriteDiffReview tool="Edit" input={{ old_string: 'a\nb\nc', new_string: 'a\nB\nc' }} onEditedInputChange={onChange} />)
    expect(screen.getByTestId('prewrite-diff-review')).toBeTruthy()
    const toggles = screen.getAllByTestId('hunk-toggle')
    expect(toggles.length).toBeGreaterThan(0)
    fireEvent.click(toggles[0]!) // drop the only hunk
    // The diff is over the REDACTED tool input, so only WHICH hunk leaves the
    // client; the server rebuilds the text from the raw input.
    expect(onChange).toHaveBeenLastCalledWith({ droppedHunks: [{ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 }] })
  })

  it('Write: diffs ""→content; dropping the hunk emits its range (#8446)', () => {
    const onChange = vi.fn()
    render(<PreWriteDiffReview tool="Write" input={{ content: 'x\ny\nz' }} onEditedInputChange={onChange} />)
    const toggles = screen.getAllByTestId('hunk-toggle')
    fireEvent.click(toggles[0]!) // drop the all-additions hunk
    expect(onChange).toHaveBeenLastCalledWith({ droppedHunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 }] })
  })

  it('#8446: never sends text, so a redaction placeholder in the reviewed copy cannot be sent back', () => {
    const onChange = vi.fn()
    const input = { old_string: 'a\nkey = [REDACTED]\nc', new_string: 'a\nkey = [REDACTED]\nC' }
    render(<PreWriteDiffReview tool="Edit" input={input} onEditedInputChange={onChange} />)
    fireEvent.click(screen.getAllByTestId('hunk-toggle')[0]!)
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]!
    expect(JSON.stringify(last).includes('REDACTED')).toBe(false)
    expect(Object.keys(last[0])).toEqual(['droppedHunks'])
  })

  it('emits null when every hunk is kept (a plain Allow)', () => {
    const onChange = vi.fn()
    render(<PreWriteDiffReview tool="Edit" input={{ old_string: 'a\nb', new_string: 'a\nB' }} onEditedInputChange={onChange} />)
    const toggle = screen.getAllByTestId('hunk-toggle')[0]!
    fireEvent.click(toggle) // drop
    fireEvent.click(toggle) // re-add → all kept again
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('#6555: warns clearly when ALL hunks are dropped (empty write)', () => {
    render(<PreWriteDiffReview tool="Write" input={{ content: 'x\ny\nz' }} onEditedInputChange={vi.fn()} />)
    const toggles = screen.getAllByTestId('hunk-toggle')
    toggles.forEach((t) => fireEvent.click(t)) // drop every hunk
    const hint = screen.getByTestId('prewrite-diff-hint')
    expect(hint.textContent).toContain('empty file')
    expect(hint.className).toContain('prewrite-diff-hint-warn')
  })

  it('renders nothing for a non-reviewable tool', () => {
    const { container } = render(<PreWriteDiffReview tool="Bash" input={{ command: 'ls' }} onEditedInputChange={vi.fn()} />)
    expect(container.querySelector('[data-testid="prewrite-diff-review"]')).toBeNull()
  })

  it('renders nothing when there is no diff (proposed === base)', () => {
    const { container } = render(<PreWriteDiffReview tool="Write" input={{ content: '' }} onEditedInputChange={vi.fn()} />)
    expect(container.querySelector('[data-testid="prewrite-diff-review"]')).toBeNull()
  })

  it('shows a "dropped" hint once a hunk is unchecked', () => {
    // Changes 12 lines apart → two separate hunks (beyond the 2·context merge window).
    const lines = Array.from({ length: 13 }, (_, i) => `line${i}`)
    const edited = [...lines]
    edited[0] = 'CHANGED0'
    edited[12] = 'CHANGED12'
    render(<PreWriteDiffReview tool="Edit" input={{ old_string: lines.join('\n'), new_string: edited.join('\n') }} onEditedInputChange={vi.fn()} />)
    const toggles = screen.getAllByTestId('hunk-toggle')
    expect(toggles.length).toBe(2)
    fireEvent.click(toggles[0]!)
    expect(screen.getByTestId('prewrite-diff-hint').textContent).toContain('1 hunk dropped')
  })
})
