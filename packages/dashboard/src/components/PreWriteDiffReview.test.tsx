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

  it('Edit: diffs old→new; dropping the hunk emits the reduced new_string', () => {
    const onChange = vi.fn()
    render(<PreWriteDiffReview tool="Edit" input={{ old_string: 'a\nb\nc', new_string: 'a\nB\nc' }} onEditedInputChange={onChange} />)
    expect(screen.getByTestId('prewrite-diff-review')).toBeTruthy()
    const toggles = screen.getAllByTestId('hunk-toggle')
    expect(toggles.length).toBeGreaterThan(0)
    fireEvent.click(toggles[0]!) // drop the only hunk → result is the original old_string
    expect(onChange).toHaveBeenLastCalledWith({ new_string: 'a\nb\nc' })
  })

  it('Write: diffs ""→content; dropping the hunk emits reduced content', () => {
    const onChange = vi.fn()
    render(<PreWriteDiffReview tool="Write" input={{ content: 'x\ny\nz' }} onEditedInputChange={onChange} />)
    const toggles = screen.getAllByTestId('hunk-toggle')
    fireEvent.click(toggles[0]!) // drop the all-additions hunk → empty content
    expect(onChange).toHaveBeenLastCalledWith({ content: '' })
  })

  it('emits null when every hunk is kept (a plain Allow)', () => {
    const onChange = vi.fn()
    render(<PreWriteDiffReview tool="Edit" input={{ old_string: 'a\nb', new_string: 'a\nB' }} onEditedInputChange={onChange} />)
    const toggle = screen.getAllByTestId('hunk-toggle')[0]!
    fireEvent.click(toggle) // drop
    fireEvent.click(toggle) // re-add → all kept again
    expect(onChange).toHaveBeenLastCalledWith(null)
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
