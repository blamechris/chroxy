/**
 * Modal, CreateSessionModal, Toast tests (#1164)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Modal } from './Modal'
import { CreateSessionModal } from './CreateSessionModal'
import { Toast, type ToastItem } from './Toast'

afterEach(cleanup)

describe('Modal', () => {
  it('renders children when open', () => {
    render(
      <Modal open onClose={vi.fn()} title="Test Modal">
        <p>Modal content</p>
      </Modal>
    )
    expect(screen.getByText('Test Modal')).toBeInTheDocument()
    expect(screen.getByText('Modal content')).toBeInTheDocument()
  })

  it('does not render when closed', () => {
    render(
      <Modal open={false} onClose={vi.fn()} title="Hidden">
        <p>Hidden content</p>
      </Modal>
    )
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument()
  })

  it('has role=dialog and aria-modal on content (#1186)', () => {
    render(
      <Modal open onClose={vi.fn()} title="Accessible Modal">
        <p>Content</p>
      </Modal>
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('has aria-labelledby pointing at modal title (#1186)', () => {
    render(
      <Modal open onClose={vi.fn()} title="Labeled Modal">
        <p>Content</p>
      </Modal>
    )
    const dialog = screen.getByRole('dialog')
    const labelId = dialog.getAttribute('aria-labelledby')
    expect(labelId).toBeTruthy()
    const title = document.getElementById(labelId!)
    expect(title).toHaveTextContent('Labeled Modal')
  })

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="Closable">
        <p>Content</p>
      </Modal>
    )
    fireEvent.click(screen.getByTestId('modal-overlay'))
    expect(onClose).toHaveBeenCalled()
  })

  it('does not close when modal content clicked', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="Closable">
        <p>Content</p>
      </Modal>
    )
    fireEvent.click(screen.getByText('Content'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape key', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="Escapable">
        <p>Content</p>
      </Modal>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('only closes the topmost modal on Escape when nested (#1179)', () => {
    const onCloseOuter = vi.fn()
    const onCloseInner = vi.fn()
    render(
      <Modal open onClose={onCloseOuter} title="Outer">
        <Modal open onClose={onCloseInner} title="Inner">
          <p>Nested content</p>
        </Modal>
      </Modal>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCloseInner).toHaveBeenCalledTimes(1)
    expect(onCloseOuter).not.toHaveBeenCalled()
  })

  it('single modal Escape behavior unchanged after nested fix (#1179)', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="Solo">
        <p>Content</p>
      </Modal>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('CreateSessionModal', () => {
  it('renders form fields', () => {
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    expect(screen.getByPlaceholderText('Session name')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/working directory/i)).toBeInTheDocument()
  })

  it('has explicit aria-label on each input (#1185)', () => {
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    expect(screen.getByLabelText('Session name')).toBeInTheDocument()
    expect(screen.getByLabelText('Working directory (optional)')).toBeInTheDocument()
  })

  it('calls onCreate with name and cwd on submit', () => {
    const onCreate = vi.fn()
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={onCreate} />
    )
    fireEvent.change(screen.getByPlaceholderText('Session name'), { target: { value: 'My Session' } })
    fireEvent.change(screen.getByPlaceholderText(/working directory/i), { target: { value: '/home/user' } })
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith({ name: 'My Session', cwd: '/home/user' })
  })

  it('does not submit with empty name', () => {
    const onCreate = vi.fn()
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={onCreate} />
    )
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('shows validation error when submitting empty name (#1184)', () => {
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    fireEvent.click(screen.getByText('Create'))
    expect(screen.getByText('Session name is required')).toBeInTheDocument()
  })

  it('sets aria-invalid on name input when validation fails (#1184)', () => {
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    fireEvent.click(screen.getByText('Create'))
    const nameInput = screen.getByPlaceholderText('Session name')
    expect(nameInput).toHaveAttribute('aria-invalid', 'true')
    expect(nameInput).toHaveAttribute('aria-describedby', 'session-name-error')
  })

  it('clears validation error when user types (#1184)', () => {
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    fireEvent.click(screen.getByText('Create'))
    expect(screen.getByText('Session name is required')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Session name'), { target: { value: 'a' } })
    expect(screen.queryByText('Session name is required')).not.toBeInTheDocument()
  })

  it('clears validation error when modal reopens (#1184)', () => {
    const { rerender } = render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    fireEvent.click(screen.getByText('Create'))
    expect(screen.getByText('Session name is required')).toBeInTheDocument()
    rerender(<CreateSessionModal open={false} onClose={vi.fn()} onCreate={vi.fn()} />)
    rerender(<CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.queryByText('Session name is required')).not.toBeInTheDocument()
  })

  it('submits on Enter key', () => {
    const onCreate = vi.fn()
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={onCreate} />
    )
    const nameInput = screen.getByPlaceholderText('Session name')
    fireEvent.change(nameInput, { target: { value: 'Quick' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledWith({ name: 'Quick', cwd: '' })
  })

  it('calls onClose when Cancel clicked', () => {
    const onClose = vi.fn()
    render(
      <CreateSessionModal open onClose={onClose} onCreate={vi.fn()} />
    )
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('clears fields when opened', () => {
    const { rerender } = render(
      <CreateSessionModal open={false} onClose={vi.fn()} onCreate={vi.fn()} />
    )
    rerender(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    const nameInput = screen.getByPlaceholderText('Session name') as HTMLInputElement
    expect(nameInput.value).toBe('')
  })
})

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders toast messages', () => {
    const items: ToastItem[] = [
      { id: '1', message: 'Error occurred' },
    ]
    render(<Toast items={items} onDismiss={vi.fn()} />)
    expect(screen.getByText('Error occurred')).toBeInTheDocument()
  })

  it('renders multiple toasts', () => {
    const items: ToastItem[] = [
      { id: '1', message: 'First' },
      { id: '2', message: 'Second' },
    ]
    render(<Toast items={items} onDismiss={vi.fn()} />)
    expect(screen.getByText('First')).toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
  })

  it('calls onDismiss when close button clicked', () => {
    const onDismiss = vi.fn()
    const items: ToastItem[] = [{ id: '1', message: 'Closable toast' }]
    render(<Toast items={items} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByTestId('toast-close-1'))
    expect(onDismiss).toHaveBeenCalledWith('1')
  })

  it('auto-dismisses after 5 seconds', () => {
    const onDismiss = vi.fn()
    const items: ToastItem[] = [{ id: '1', message: 'Auto dismiss' }]
    render(<Toast items={items} onDismiss={onDismiss} />)

    act(() => { vi.advanceTimersByTime(5000) })
    expect(onDismiss).toHaveBeenCalledWith('1')
  })

  it('renders empty when no items', () => {
    const { container } = render(<Toast items={[]} onDismiss={vi.fn()} />)
    expect(container.querySelector('[data-testid="toast-container"]')).toBeInTheDocument()
    expect(container.querySelectorAll('.toast').length).toBe(0)
  })

  it('has alert role on each toast item', () => {
    const items: ToastItem[] = [
      { id: '1', message: 'First' },
      { id: '2', message: 'Second' },
    ]
    render(<Toast items={items} onDismiss={vi.fn()} />)
    expect(screen.getAllByRole('alert')).toHaveLength(2)
  })

  it('container has no role and uses aria-live="assertive" (#1177)', () => {
    const items: ToastItem[] = [{ id: '1', message: 'Alert' }]
    const { container } = render(<Toast items={items} onDismiss={vi.fn()} />)
    const toastContainer = container.querySelector('[data-testid="toast-container"]')!
    // Container should have no role (items carry their own role="alert")
    expect(toastContainer).not.toHaveAttribute('role')
    // Container is a stable live region for reliable screen reader support
    expect(toastContainer).toHaveAttribute('aria-live', 'assertive')
  })

  it('clears auto-dismiss timer when manually closed (#1187)', () => {
    const onDismiss = vi.fn()
    const items: ToastItem[] = [{ id: '1', message: 'Manual close' }]
    render(<Toast items={items} onDismiss={onDismiss} />)

    // Manually close the toast
    fireEvent.click(screen.getByTestId('toast-close-1'))
    expect(onDismiss).toHaveBeenCalledTimes(1)

    // Advance past auto-dismiss timeout — should NOT trigger a second call
    act(() => { vi.advanceTimersByTime(6000) })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
