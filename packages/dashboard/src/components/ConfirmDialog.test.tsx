/**
 * ConfirmDialog tests (#5206)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ConfirmDialog } from './ConfirmDialog'

afterEach(cleanup)

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    render(
      <ConfirmDialog
        open={false}
        title="Close?"
        message="Are you sure?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  })

  it('renders title, message, and the default button labels when open', () => {
    render(
      <ConfirmDialog
        open
        title="Close session?"
        message="The Claude process will be terminated."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText('Close session?')).toBeInTheDocument()
    expect(screen.getByTestId('confirm-dialog-message')).toHaveTextContent(
      'The Claude process will be terminated.'
    )
    expect(screen.getByTestId('confirm-dialog-confirm')).toHaveTextContent('Confirm')
    expect(screen.getByTestId('confirm-dialog-cancel')).toHaveTextContent('Cancel')
  })

  it('uses custom button labels', () => {
    render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        confirmLabel="Close session"
        cancelLabel="Keep it"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByTestId('confirm-dialog-confirm')).toHaveTextContent('Close session')
    expect(screen.getByTestId('confirm-dialog-cancel')).toHaveTextContent('Keep it')
  })

  it('applies the danger class to the confirm button when danger', () => {
    render(
      <ConfirmDialog open danger title="t" message="m" onConfirm={vi.fn()} onCancel={vi.fn()} />
    )
    expect(screen.getByTestId('confirm-dialog-confirm')).toHaveClass('btn-modal-danger')
  })

  it('uses the non-danger class by default', () => {
    render(
      <ConfirmDialog open title="t" message="m" onConfirm={vi.fn()} onCancel={vi.fn()} />
    )
    expect(screen.getByTestId('confirm-dialog-confirm')).toHaveClass('btn-modal-create')
  })

  it('fires onConfirm when the confirm button is clicked', () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog open title="t" message="m" onConfirm={onConfirm} onCancel={vi.fn()} />
    )
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel when the cancel button is clicked', () => {
    const onCancel = vi.fn()
    render(
      <ConfirmDialog open title="t" message="m" onConfirm={vi.fn()} onCancel={onCancel} />
    )
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel when Escape is pressed (Modal contract)', () => {
    const onCancel = vi.fn()
    render(
      <ConfirmDialog open title="t" message="m" onConfirm={vi.fn()} onCancel={onCancel} />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
