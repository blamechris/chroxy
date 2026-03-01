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
})

describe('CreateSessionModal', () => {
  it('renders form fields', () => {
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    expect(screen.getByPlaceholderText('Session name')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/working directory/i)).toBeInTheDocument()
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

  it('has accessible role', () => {
    const items: ToastItem[] = [{ id: '1', message: 'Alert' }]
    render(<Toast items={items} onDismiss={vi.fn()} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
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
