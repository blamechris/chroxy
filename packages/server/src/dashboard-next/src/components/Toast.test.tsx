/**
 * Toast component tests (#1723)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Toast, type ToastItem } from './Toast'

afterEach(cleanup)

const makeItems = (...messages: string[]): ToastItem[] =>
  messages.map((m, i) => ({ id: `toast-${i}`, message: m }))

describe('Toast', () => {
  it('renders toast container', () => {
    render(<Toast items={[]} onDismiss={vi.fn()} />)
    expect(screen.getByTestId('toast-container')).toBeInTheDocument()
  })

  it('has aria-live="assertive" for urgent announcements', () => {
    render(<Toast items={[]} onDismiss={vi.fn()} />)
    expect(screen.getByTestId('toast-container')).toHaveAttribute('aria-live', 'assertive')
  })

  it('container has no role (items carry role="alert")', () => {
    render(<Toast items={makeItems('Alert')} onDismiss={vi.fn()} />)
    expect(screen.getByTestId('toast-container')).not.toHaveAttribute('role')
  })

  it('renders each toast message', () => {
    render(<Toast items={makeItems('Error one', 'Error two')} onDismiss={vi.fn()} />)
    expect(screen.getByText('Error one')).toBeInTheDocument()
    expect(screen.getByText('Error two')).toBeInTheDocument()
  })

  it('each toast item has role="alert"', () => {
    render(<Toast items={makeItems('First', 'Second')} onDismiss={vi.fn()} />)
    expect(screen.getAllByRole('alert')).toHaveLength(2)
  })

  it('renders close button for each toast', () => {
    render(<Toast items={makeItems('Msg')} onDismiss={vi.fn()} />)
    expect(screen.getByTestId('toast-close-toast-0')).toBeInTheDocument()
  })

  it('calls onDismiss when close button clicked', () => {
    const onDismiss = vi.fn()
    render(<Toast items={makeItems('Msg')} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByTestId('toast-close-toast-0'))
    expect(onDismiss).toHaveBeenCalledWith('toast-0')
  })

  it('renders no toasts when items array is empty', () => {
    const { container } = render(<Toast items={[]} onDismiss={vi.fn()} />)
    expect(container.querySelector('.toast')).toBeNull()
  })

  it('applies toast-info class for info-level items', () => {
    const items: ToastItem[] = [{ id: 'i1', message: 'Update available', level: 'info' }]
    const { container } = render(<Toast items={items} onDismiss={vi.fn()} />)
    const toast = container.querySelector('.toast')
    expect(toast?.classList.contains('toast-info')).toBe(true)
    expect(toast?.classList.contains('toast-error')).toBe(false)
  })

  it('applies toast-error class for error-level items (default)', () => {
    const items: ToastItem[] = [{ id: 'e1', message: 'Something broke' }]
    const { container } = render(<Toast items={items} onDismiss={vi.fn()} />)
    const toast = container.querySelector('.toast')
    expect(toast?.classList.contains('toast-error')).toBe(true)
    expect(toast?.classList.contains('toast-info')).toBe(false)
  })

  describe('timer behaviour', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers() })

    it('auto-dismisses after 5 seconds', async () => {
      const onDismiss = vi.fn()
      render(<Toast items={makeItems('Auto dismiss')} onDismiss={onDismiss} />)
      expect(onDismiss).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(5000) })
      expect(onDismiss).toHaveBeenCalledWith('toast-0')
    })

    it('does not auto-dismiss before 5 seconds', async () => {
      const onDismiss = vi.fn()
      render(<Toast items={makeItems('Not yet')} onDismiss={onDismiss} />)
      await act(async () => { vi.advanceTimersByTime(4999) })
      expect(onDismiss).not.toHaveBeenCalled()
    })

    it('clears auto-dismiss timer when manually closed', async () => {
      const onDismiss = vi.fn()
      const items: ToastItem[] = [{ id: '1', message: 'Manual close' }]
      render(<Toast items={items} onDismiss={onDismiss} />)
      fireEvent.click(screen.getByTestId('toast-close-1'))
      expect(onDismiss).toHaveBeenCalledTimes(1)
      await act(async () => { vi.advanceTimersByTime(6000) })
      expect(onDismiss).toHaveBeenCalledTimes(1)
    })
  })
})
