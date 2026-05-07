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

  it('container has no aria-live (each item carries its own)', () => {
    render(<Toast items={[]} onDismiss={vi.fn()} />)
    expect(screen.getByTestId('toast-container')).not.toHaveAttribute('aria-live')
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

  it('info-level items use role="status" and aria-live="polite"', () => {
    const items: ToastItem[] = [{ id: 'i2', message: 'Info msg', level: 'info' }]
    const { container } = render(<Toast items={items} onDismiss={vi.fn()} />)
    const toast = container.querySelector('.toast')
    expect(toast).toHaveAttribute('role', 'status')
    expect(toast).toHaveAttribute('aria-live', 'polite')
  })

  it('error-level items use role="alert" and aria-live="assertive"', () => {
    const items: ToastItem[] = [{ id: 'e2', message: 'Error msg', level: 'error' }]
    const { container } = render(<Toast items={items} onDismiss={vi.fn()} />)
    const toast = container.querySelector('.toast')
    expect(toast).toHaveAttribute('role', 'alert')
    expect(toast).toHaveAttribute('aria-live', 'assertive')
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

  // #3587: optional inline recovery action — rendered as a button
  // between the message and the close affordance. Click invokes the
  // callback and dismisses the toast.
  describe('action button (#3587)', () => {
    it('does not render an action button when item.action is undefined', () => {
      render(<Toast items={makeItems('No action')} onDismiss={vi.fn()} />)
      expect(screen.queryByTestId('toast-action-toast-0')).not.toBeInTheDocument()
    })

    it('renders the action button label when item.action is set', () => {
      const items: ToastItem[] = [{
        id: 'a1',
        message: 'Owned by alice',
        level: 'error',
        action: { label: 'Try as alice', onClick: vi.fn() },
      }]
      render(<Toast items={items} onDismiss={vi.fn()} />)
      const btn = screen.getByTestId('toast-action-a1')
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveTextContent('Try as alice')
    })

    it('invokes action.onClick when the action button is clicked', () => {
      const onAction = vi.fn()
      const items: ToastItem[] = [{
        id: 'a2',
        message: 'Owned by alice',
        action: { label: 'Try as alice', onClick: onAction },
      }]
      render(<Toast items={items} onDismiss={vi.fn()} />)
      fireEvent.click(screen.getByTestId('toast-action-a2'))
      expect(onAction).toHaveBeenCalledTimes(1)
    })

    it('dismisses the toast after the action runs', () => {
      const onDismiss = vi.fn()
      const items: ToastItem[] = [{
        id: 'a3',
        message: 'Owned by alice',
        action: { label: 'Try as alice', onClick: vi.fn() },
      }]
      render(<Toast items={items} onDismiss={onDismiss} />)
      fireEvent.click(screen.getByTestId('toast-action-a3'))
      expect(onDismiss).toHaveBeenCalledWith('a3')
    })

    it('dismisses the toast even if the action handler throws (swallowed)', () => {
      const onDismiss = vi.fn()
      const onAction = vi.fn(() => { throw new Error('grant failed') })
      const items: ToastItem[] = [{
        id: 'a4',
        message: 'Owned by alice',
        action: { label: 'Try as alice', onClick: onAction },
      }]
      // Quiet the expected console.error from the swallow path so the
      // test doesn't pollute output.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        render(<Toast items={items} onDismiss={onDismiss} />)
        fireEvent.click(screen.getByTestId('toast-action-a4'))
        expect(onAction).toHaveBeenCalled()
        expect(onDismiss).toHaveBeenCalledWith('a4')
        // Error was logged, not thrown.
        expect(errSpy).toHaveBeenCalled()
      } finally {
        errSpy.mockRestore()
      }
    })

    describe('with timers', () => {
      beforeEach(() => { vi.useFakeTimers() })
      afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers() })

      it('clearing the auto-dismiss timer prevents a duplicate dismiss after click', async () => {
        const onDismiss = vi.fn()
        const items: ToastItem[] = [{
          id: 'a5',
          message: 'Owned by alice',
          action: { label: 'Try as alice', onClick: vi.fn() },
        }]
        render(<Toast items={items} onDismiss={onDismiss} />)
        fireEvent.click(screen.getByTestId('toast-action-a5'))
        expect(onDismiss).toHaveBeenCalledTimes(1)
        // Advance past the 5s auto-dismiss — must not double-fire.
        await act(async () => { vi.advanceTimersByTime(6000) })
        expect(onDismiss).toHaveBeenCalledTimes(1)
      })
    })
  })

  // #3603: when the parent reports the WS socket is reconnecting, the
  // action button should render disabled with a clear "Reconnecting…"
  // label so the operator gets feedback instead of a silent no-op.
  describe('actionDisabled (#3603)', () => {
    it('renders the action button disabled when actionDisabled is true', () => {
      const items: ToastItem[] = [{
        id: 'd1',
        message: 'Owned by alice',
        action: { label: 'Try as alice', onClick: vi.fn() },
        actionDisabled: true,
      }]
      render(<Toast items={items} onDismiss={vi.fn()} />)
      const btn = screen.getByTestId('toast-action-d1')
      expect(btn).toBeDisabled()
      expect(btn).toHaveAttribute('aria-disabled', 'true')
    })

    it('renders the action button enabled when actionDisabled is false/undefined', () => {
      const items: ToastItem[] = [{
        id: 'd2',
        message: 'Owned by alice',
        action: { label: 'Try as alice', onClick: vi.fn() },
      }]
      render(<Toast items={items} onDismiss={vi.fn()} />)
      const btn = screen.getByTestId('toast-action-d2')
      expect(btn).not.toBeDisabled()
      expect(btn).not.toHaveAttribute('aria-disabled')
    })

    it('swaps the label to actionDisabledLabel while disabled', () => {
      const items: ToastItem[] = [{
        id: 'd3',
        message: 'Owned by alice',
        action: { label: 'Try as alice', onClick: vi.fn() },
        actionDisabled: true,
        actionDisabledLabel: 'Reconnecting…',
      }]
      render(<Toast items={items} onDismiss={vi.fn()} />)
      expect(screen.getByTestId('toast-action-d3')).toHaveTextContent('Reconnecting…')
    })

    it('falls back to action.label when actionDisabledLabel is omitted', () => {
      const items: ToastItem[] = [{
        id: 'd4',
        message: 'Owned by alice',
        action: { label: 'Try as alice', onClick: vi.fn() },
        actionDisabled: true,
      }]
      render(<Toast items={items} onDismiss={vi.fn()} />)
      expect(screen.getByTestId('toast-action-d4')).toHaveTextContent('Try as alice')
    })

    it('does not invoke onClick or dismiss the toast when clicked while disabled', () => {
      const onAction = vi.fn()
      const onDismiss = vi.fn()
      const items: ToastItem[] = [{
        id: 'd5',
        message: 'Owned by alice',
        action: { label: 'Try as alice', onClick: onAction },
        actionDisabled: true,
        actionDisabledLabel: 'Reconnecting…',
      }]
      render(<Toast items={items} onDismiss={onDismiss} />)
      fireEvent.click(screen.getByTestId('toast-action-d5'))
      expect(onAction).not.toHaveBeenCalled()
      expect(onDismiss).not.toHaveBeenCalled()
    })

    describe('auto-dismiss pause while disabled', () => {
      beforeEach(() => { vi.useFakeTimers() })
      afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers() })

      it('does not auto-dismiss while actionDisabled is true (no matter how long)', async () => {
        const onDismiss = vi.fn()
        const items: ToastItem[] = [{
          id: 'p1',
          message: 'Owned by alice',
          action: { label: 'Try as alice', onClick: vi.fn() },
          actionDisabled: true,
          actionDisabledLabel: 'Reconnecting…',
        }]
        render(<Toast items={items} onDismiss={onDismiss} />)
        // 30 seconds of "reconnect window" — toast must persist.
        await act(async () => { vi.advanceTimersByTime(30000) })
        expect(onDismiss).not.toHaveBeenCalled()
      })

      it('clears an in-flight auto-dismiss timer when actionDisabled flips to true', async () => {
        const onDismiss = vi.fn()
        const baseItem: ToastItem = {
          id: 'p2',
          message: 'Owned by alice',
          action: { label: 'Try as alice', onClick: vi.fn() },
        }
        const { rerender } = render(<Toast items={[baseItem]} onDismiss={onDismiss} />)
        // Run partway through the 5s timer, then disconnect mid-flight.
        await act(async () => { vi.advanceTimersByTime(2000) })
        rerender(<Toast items={[{ ...baseItem, actionDisabled: true }]} onDismiss={onDismiss} />)
        // Advance past the original 5s deadline — must NOT dismiss.
        await act(async () => { vi.advanceTimersByTime(10000) })
        expect(onDismiss).not.toHaveBeenCalled()
      })

      it('starts a fresh 5s timer once actionDisabled flips back to false', async () => {
        const onDismiss = vi.fn()
        const baseItem: ToastItem = {
          id: 'p3',
          message: 'Owned by alice',
          action: { label: 'Try as alice', onClick: vi.fn() },
          actionDisabled: true,
        }
        const { rerender } = render(<Toast items={[baseItem]} onDismiss={onDismiss} />)
        // Long disconnect — no dismiss.
        await act(async () => { vi.advanceTimersByTime(10000) })
        expect(onDismiss).not.toHaveBeenCalled()

        // Reconnect — fresh 5s window starts.
        rerender(<Toast items={[{ ...baseItem, actionDisabled: false }]} onDismiss={onDismiss} />)
        // Just under 5s post-reconnect — still alive.
        await act(async () => { vi.advanceTimersByTime(4999) })
        expect(onDismiss).not.toHaveBeenCalled()
        // Cross the 5s threshold — auto-dismiss fires.
        await act(async () => { vi.advanceTimersByTime(2) })
        expect(onDismiss).toHaveBeenCalledWith('p3')
      })
    })

    it('re-enables and fires the action once actionDisabled flips to false', () => {
      const onAction = vi.fn()
      const onDismiss = vi.fn()
      const baseItem: ToastItem = {
        id: 'd6',
        message: 'Owned by alice',
        action: { label: 'Try as alice', onClick: onAction },
        actionDisabled: true,
        actionDisabledLabel: 'Reconnecting…',
      }
      const { rerender } = render(<Toast items={[baseItem]} onDismiss={onDismiss} />)
      // Click while disabled — no-op.
      fireEvent.click(screen.getByTestId('toast-action-d6'))
      expect(onAction).not.toHaveBeenCalled()

      // Connection recovers — re-render with actionDisabled false.
      rerender(<Toast items={[{ ...baseItem, actionDisabled: false }]} onDismiss={onDismiss} />)
      const btn = screen.getByTestId('toast-action-d6')
      expect(btn).not.toBeDisabled()
      expect(btn).toHaveTextContent('Try as alice')
      fireEvent.click(btn)
      expect(onAction).toHaveBeenCalledTimes(1)
      expect(onDismiss).toHaveBeenCalledWith('d6')
    })
  })
})
