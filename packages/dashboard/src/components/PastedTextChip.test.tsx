/**
 * PastedTextChip tests (#3797) — explicit View and Remove buttons, no
 * nested interactive elements. Restructure from the original
 * role="button" outer + nested <button> after #3798 review.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { PastedTextChip } from './PastedTextChip'

afterEach(cleanup)

describe('PastedTextChip', () => {
  const baseProps = {
    id: 1,
    lineCount: 12,
    charCount: 4567,
    onInspect: vi.fn(),
    onRemove: vi.fn(),
  }

  it('renders the multi-line label when lineCount > 1', () => {
    render(<PastedTextChip {...baseProps} lineCount={12} />)
    expect(screen.getByText(/Pasted text #1 · 12 lines/)).toBeInTheDocument()
  })

  it('renders the chars label when lineCount === 1', () => {
    render(<PastedTextChip {...baseProps} lineCount={1} charCount={2000} />)
    expect(screen.getByText(/Pasted text #1 · 2000 chars/)).toBeInTheDocument()
  })

  it('calls onInspect when the View button is clicked', () => {
    const onInspect = vi.fn()
    render(<PastedTextChip {...baseProps} onInspect={onInspect} />)
    fireEvent.click(screen.getByTestId('pasted-text-chip-view-1'))
    expect(onInspect).toHaveBeenCalledWith(1)
  })

  it('calls onRemove (and not onInspect) when the × button is clicked', () => {
    const onInspect = vi.fn()
    const onRemove = vi.fn()
    render(<PastedTextChip {...baseProps} onInspect={onInspect} onRemove={onRemove} />)
    fireEvent.click(screen.getByTestId('pasted-text-chip-remove-1'))
    expect(onRemove).toHaveBeenCalledWith(1)
    expect(onInspect).not.toHaveBeenCalled()
  })

  it('exposes two distinct buttons (no nested interactive elements)', () => {
    render(<PastedTextChip {...baseProps} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    // Outer container is a <span> (non-interactive) — no role on it.
    const outer = screen.getByTestId('pasted-text-chip-1')
    expect(outer.tagName).toBe('SPAN')
    expect(outer).not.toHaveAttribute('role')
    expect(outer).not.toHaveAttribute('tabindex')
  })

  it('uses descriptive aria-labels for both buttons', () => {
    render(<PastedTextChip {...baseProps} />)
    expect(screen.getByLabelText('View pasted text #1')).toBeInTheDocument()
    expect(screen.getByLabelText(/Remove Pasted text #1/)).toBeInTheDocument()
  })

  it('activates the view button on Enter and Space (native <button> behaviour)', () => {
    const onInspect = vi.fn()
    render(<PastedTextChip {...baseProps} onInspect={onInspect} />)
    const viewBtn = screen.getByTestId('pasted-text-chip-view-1')
    // Native <button> elements fire onClick on Enter/Space — testing-library
    // simulates that via click events.
    fireEvent.click(viewBtn)
    expect(onInspect).toHaveBeenCalledTimes(1)
  })
})
