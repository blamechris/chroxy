/**
 * PastedTextModal tests (#3797) — render the full paste content, close on
 * Escape / overlay click / Close button, remove via the explicit remove
 * action. The shared `Modal` component handles focus trap, aria-modal,
 * and topmost-only Escape; this test exercises the PastedTextModal
 * surface (title formatting, body content, remove button).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { PastedTextModal } from './PastedTextModal'

afterEach(cleanup)

describe('PastedTextModal', () => {
  const baseProps = {
    id: 7,
    content: 'line one\nline two\nline three',
    onClose: vi.fn(),
    onRemove: vi.fn(),
  }

  it('renders the full content', () => {
    render(<PastedTextModal {...baseProps} />)
    expect(screen.getByTestId('pasted-text-modal-body')).toHaveTextContent('line one line two line three')
  })

  it('renders title with line count and char count', () => {
    render(<PastedTextModal {...baseProps} />)
    expect(screen.getByText(/Pasted text #7/)).toHaveTextContent('3 lines')
    expect(screen.getByText(/Pasted text #7/)).toHaveTextContent('28 chars')
  })

  it('uses "1 line" (singular) for a single-line paste', () => {
    render(<PastedTextModal {...baseProps} content="single line" />)
    expect(screen.getByText(/Pasted text #7/)).toHaveTextContent('1 line')
  })

  it('calls onClose when the Close button is clicked', () => {
    const onClose = vi.fn()
    render(<PastedTextModal {...baseProps} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('pasted-text-modal-close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when the modal overlay is clicked (shared Modal behaviour)', () => {
    const onClose = vi.fn()
    render(<PastedTextModal {...baseProps} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('modal-overlay'))
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Escape (via shared Modal)', () => {
    const onClose = vi.fn()
    render(<PastedTextModal {...baseProps} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onRemove(id) and onClose when "Remove paste" is clicked', () => {
    const onRemove = vi.fn()
    const onClose = vi.fn()
    render(<PastedTextModal {...baseProps} onRemove={onRemove} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('pasted-text-modal-remove'))
    expect(onRemove).toHaveBeenCalledWith(7)
    expect(onClose).toHaveBeenCalled()
  })

  it('renders inside the shared Modal (aria-modal="true" + role="dialog")', () => {
    render(<PastedTextModal {...baseProps} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })
})
