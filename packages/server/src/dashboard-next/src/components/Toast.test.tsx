/**
 * Toast component tests (#1723)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
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

  it('renders each toast message', () => {
    render(<Toast items={makeItems('Error one', 'Error two')} onDismiss={vi.fn()} />)
    expect(screen.getByText('Error one')).toBeInTheDocument()
    expect(screen.getByText('Error two')).toBeInTheDocument()
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

  it('renders nothing when items array is empty', () => {
    const { container } = render(<Toast items={[]} onDismiss={vi.fn()} />)
    expect(container.querySelector('.toast')).toBeNull()
  })

  it('auto-dismisses after 5 seconds', async () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(<Toast items={makeItems('Auto dismiss')} onDismiss={onDismiss} />)
    expect(onDismiss).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(onDismiss).toHaveBeenCalledWith('toast-0')
    vi.useRealTimers()
  })

  it('does not auto-dismiss before 5 seconds', async () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(<Toast items={makeItems('Not yet')} onDismiss={onDismiss} />)
    await act(async () => { vi.advanceTimersByTime(4999) })
    expect(onDismiss).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
