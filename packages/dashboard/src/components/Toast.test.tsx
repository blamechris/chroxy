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

  it('applies toast-warning class for warning-level items (#4148)', () => {
    const items: ToastItem[] = [{ id: 'w1', message: 'Tool round cap reached', level: 'warning' }]
    const { container } = render(<Toast items={items} onDismiss={vi.fn()} />)
    const toast = container.querySelector('.toast')
    expect(toast?.classList.contains('toast-warning')).toBe(true)
    expect(toast?.classList.contains('toast-error')).toBe(false)
    expect(toast?.classList.contains('toast-info')).toBe(false)
  })

  it('uses status role + polite aria-live for warning-level items (not assertive alert) (#4148)', () => {
    const items: ToastItem[] = [{ id: 'w2', message: 'Recoverable warning', level: 'warning' }]
    const { container } = render(<Toast items={items} onDismiss={vi.fn()} />)
    const toast = container.querySelector('.toast')
    expect(toast?.getAttribute('role')).toBe('status')
    expect(toast?.getAttribute('aria-live')).toBe('polite')
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


  // #3604: pause auto-dismiss timer on hover/focus, resume with the
  // *remaining* time on mouseleave/blur.
  describe('pause-on-hover (#3604)', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers() })

    it('pauses auto-dismiss while the toast is hovered', async () => {
      const onDismiss = vi.fn()
      render(<Toast items={makeItems('Hover me')} onDismiss={onDismiss} />)
      const toast = screen.getByTestId('toast-toast-0')
      // Hover after 2s, then advance another 5s — without pause the
      // toast would have dismissed at the 5s mark.
      await act(async () => { vi.advanceTimersByTime(2000) })
      fireEvent.mouseEnter(toast)
      await act(async () => { vi.advanceTimersByTime(5000) })
      expect(onDismiss).not.toHaveBeenCalled()
    })

    it('resumes with remaining time after mouseleave (not a fresh 5s)', async () => {
      const onDismiss = vi.fn()
      render(<Toast items={makeItems('Hover me')} onDismiss={onDismiss} />)
      const toast = screen.getByTestId('toast-toast-0')
      // Elapse 2s, hover (3s remaining), hold for 10s, leave.
      await act(async () => { vi.advanceTimersByTime(2000) })
      fireEvent.mouseEnter(toast)
      await act(async () => { vi.advanceTimersByTime(10000) })
      fireEvent.mouseLeave(toast)
      // Resume should fire after the 3s remaining, not a new 5s.
      await act(async () => { vi.advanceTimersByTime(2999) })
      expect(onDismiss).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(onDismiss).toHaveBeenCalledWith('toast-0')
    })

    it('survives multiple hover/leave cycles without leaking grace time', async () => {
      const onDismiss = vi.fn()
      render(<Toast items={makeItems('Hover repeatedly')} onDismiss={onDismiss} />)
      const toast = screen.getByTestId('toast-toast-0')
      // 1s elapsed, hover, leave (4s remaining).
      await act(async () => { vi.advanceTimersByTime(1000) })
      fireEvent.mouseEnter(toast)
      await act(async () => { vi.advanceTimersByTime(2000) })
      fireEvent.mouseLeave(toast)
      // 1s of resumed time elapsed (3s remaining), hover again.
      await act(async () => { vi.advanceTimersByTime(1000) })
      fireEvent.mouseEnter(toast)
      await act(async () => { vi.advanceTimersByTime(5000) })
      fireEvent.mouseLeave(toast)
      // Final 3s should fire dismiss.
      await act(async () => { vi.advanceTimersByTime(2999) })
      expect(onDismiss).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(onDismiss).toHaveBeenCalledWith('toast-0')
    })

    it('keyboard focus on a toast button pauses the timer', async () => {
      const onDismiss = vi.fn()
      const items: ToastItem[] = [{
        id: 'k1',
        message: 'Focus me',
        action: { label: 'Try again', onClick: vi.fn() },
      }]
      render(<Toast items={items} onDismiss={onDismiss} />)
      // Focus bubbles to the toast wrapper via React's onFocus.
      await act(async () => { vi.advanceTimersByTime(2000) })
      const actionBtn = screen.getByTestId('toast-action-k1')
      actionBtn.focus()
      await act(async () => { vi.advanceTimersByTime(5000) })
      expect(onDismiss).not.toHaveBeenCalled()
      actionBtn.blur()
      // 3s remaining after blur.
      await act(async () => { vi.advanceTimersByTime(2999) })
      expect(onDismiss).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(onDismiss).toHaveBeenCalledWith('k1')
    })

    it('manual close while hovered still dismisses immediately', () => {
      const onDismiss = vi.fn()
      render(<Toast items={makeItems('Hover then close')} onDismiss={onDismiss} />)
      const toast = screen.getByTestId('toast-toast-0')
      fireEvent.mouseEnter(toast)
      fireEvent.click(screen.getByTestId('toast-close-toast-0'))
      expect(onDismiss).toHaveBeenCalledWith('toast-0')
      expect(onDismiss).toHaveBeenCalledTimes(1)
    })

    it('resumes correctly when pause happens at the boundary of the 5s window', async () => {
      const onDismiss = vi.fn()
      render(<Toast items={[{ id: 'e0', message: 'Edge' }]} onDismiss={onDismiss} />)
      const toast = screen.getByTestId('toast-e0')
      await act(async () => { vi.advanceTimersByTime(4999) })
      fireEvent.mouseEnter(toast)
      // 1ms remaining. Hold 10s under hover.
      await act(async () => { vi.advanceTimersByTime(10000) })
      expect(onDismiss).not.toHaveBeenCalled()
      fireEvent.mouseLeave(toast)
      // Resume schedules the final 1ms.
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(onDismiss).toHaveBeenCalledWith('e0')
    })

    // Copilot review (PR #3610): hover + focus must be tracked as
    // independent pause reasons — mouseleave while still focused must
    // NOT resume the timer.
    it('hover→focus→mouseleave stays paused while focus is still active', async () => {
      const onDismiss = vi.fn()
      const items: ToastItem[] = [{
        id: 'hf1',
        message: 'Hover then focus',
        action: { label: 'Act', onClick: vi.fn() },
      }]
      render(<Toast items={items} onDismiss={onDismiss} />)
      const toast = screen.getByTestId('toast-hf1')
      const actionBtn = screen.getByTestId('toast-action-hf1')
      // 1s elapsed, then hover (paused, 4s remaining).
      await act(async () => { vi.advanceTimersByTime(1000) })
      fireEvent.mouseEnter(toast)
      // Focus the action button while still hovered. Paused by both.
      await act(async () => { vi.advanceTimersByTime(2000) })
      actionBtn.focus()
      // Mouse leaves but focus remains — must stay paused.
      fireEvent.mouseLeave(toast)
      await act(async () => { vi.advanceTimersByTime(10000) })
      expect(onDismiss).not.toHaveBeenCalled()
      // Blur clears the last pause reason; remaining 4s resumes.
      actionBtn.blur()
      await act(async () => { vi.advanceTimersByTime(3999) })
      expect(onDismiss).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(onDismiss).toHaveBeenCalledWith('hf1')
    })

    // #3614: focus moving *within* the same toast (e.g. tab from action
    // button to close button) bubbles a blur on the wrapper followed by
    // a focus. The blur handler should detect intra-toast focus moves
    // via `relatedTarget` and skip the resume so we don't burn a tick
    // on a wasteful resume→pause cycle.
    it('intra-toast focus move (action → close) does not resume the timer', async () => {
      const onDismiss = vi.fn()
      const items: ToastItem[] = [{
        id: 'it1',
        message: 'Tab between buttons',
        action: { label: 'Act', onClick: vi.fn() },
      }]
      render(<Toast items={items} onDismiss={onDismiss} />)
      const toast = screen.getByTestId('toast-it1')
      const actionBtn = screen.getByTestId('toast-action-it1')
      const closeBtn = screen.getByTestId('toast-close-it1')

      // 1s elapsed, focus action button (paused, 4s remaining).
      await act(async () => { vi.advanceTimersByTime(1000) })
      actionBtn.focus()

      // Tab from action → close: synthesize a blur on the wrapper with
      // relatedTarget pointing at the close button (same toast). The
      // wrapper's onBlur should NOT call resumeTimer because focus is
      // still within the toast. We don't need to fire the matching
      // focus event — the relatedTarget-aware blur handler is the only
      // path under test here.
      fireEvent.blur(toast, { relatedTarget: closeBtn })
      // If the timer had been resumed, advancing 4s would dismiss.
      // It must remain paused.
      await act(async () => { vi.advanceTimersByTime(10000) })
      expect(onDismiss).not.toHaveBeenCalled()

      // Now actually leave the toast (blur to something outside): the
      // remaining 4s should resume.
      fireEvent.blur(toast, { relatedTarget: document.body })
      await act(async () => { vi.advanceTimersByTime(3999) })
      expect(onDismiss).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(onDismiss).toHaveBeenCalledWith('it1')
    })

    it('blur out of toast (relatedTarget outside) resumes the timer', async () => {
      const onDismiss = vi.fn()
      const items: ToastItem[] = [{
        id: 'it2',
        message: 'Tab away',
        action: { label: 'Act', onClick: vi.fn() },
      }]
      render(<Toast items={items} onDismiss={onDismiss} />)
      const toast = screen.getByTestId('toast-it2')
      const actionBtn = screen.getByTestId('toast-action-it2')

      // 1s elapsed, focus action button (paused, 4s remaining).
      await act(async () => { vi.advanceTimersByTime(1000) })
      actionBtn.focus()
      await act(async () => { vi.advanceTimersByTime(2000) })

      // Tab outside the toast — relatedTarget is something not contained
      // by the wrapper. Resume should fire and the remaining 4s should
      // play out.
      fireEvent.blur(toast, { relatedTarget: document.body })
      await act(async () => { vi.advanceTimersByTime(3999) })
      expect(onDismiss).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(onDismiss).toHaveBeenCalledWith('it2')
    })

    // #3614: blur with relatedTarget === null (e.g. focus moved to
    // another window, devtools, the URL bar) should also resume —
    // there's no descendant being focused, so it's a real blur out.
    it('blur with null relatedTarget resumes the timer', async () => {
      const onDismiss = vi.fn()
      const items: ToastItem[] = [{
        id: 'it3',
        message: 'Tab to nothing',
        action: { label: 'Act', onClick: vi.fn() },
      }]
      render(<Toast items={items} onDismiss={onDismiss} />)
      const toast = screen.getByTestId('toast-it3')
      const actionBtn = screen.getByTestId('toast-action-it3')

      await act(async () => { vi.advanceTimersByTime(1000) })
      actionBtn.focus()
      await act(async () => { vi.advanceTimersByTime(2000) })

      fireEvent.blur(toast, { relatedTarget: null })
      await act(async () => { vi.advanceTimersByTime(3999) })
      expect(onDismiss).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(onDismiss).toHaveBeenCalledWith('it3')
    })

    it('focus→hover→blur stays paused while still hovered', async () => {
      const onDismiss = vi.fn()
      const items: ToastItem[] = [{
        id: 'fh1',
        message: 'Focus then hover',
        action: { label: 'Act', onClick: vi.fn() },
      }]
      render(<Toast items={items} onDismiss={onDismiss} />)
      const toast = screen.getByTestId('toast-fh1')
      const actionBtn = screen.getByTestId('toast-action-fh1')
      await act(async () => { vi.advanceTimersByTime(1000) })
      actionBtn.focus()
      await act(async () => { vi.advanceTimersByTime(2000) })
      fireEvent.mouseEnter(toast)
      // Blur but mouse is still over toast.
      actionBtn.blur()
      await act(async () => { vi.advanceTimersByTime(10000) })
      expect(onDismiss).not.toHaveBeenCalled()
      // Mouseleave clears the last pause reason.
      fireEvent.mouseLeave(toast)
      await act(async () => { vi.advanceTimersByTime(3999) })
      expect(onDismiss).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(onDismiss).toHaveBeenCalledWith('fh1')
    })
  })

  // #5039 — secondary sub-line under the main toast message, surfaced
  // for the PR #5037 error-path partial-cost ("This turn cost $X").
  // Rendered as a small `<span data-testid="toast-partial-cost-{id}">`
  // inside the existing `.toast-msg` flex column so the action + close
  // buttons stay aligned; absent for every error path that didn't carry
  // partials so the single-line layout is preserved.
  describe('subMessage sub-line (#5039)', () => {
    it('renders the sub-line with a testID when subMessage is set', () => {
      const items: ToastItem[] = [
        { id: 'pc1', message: 'Stream error', subMessage: 'This turn cost $0.087 (1.2K in · 3.4K out)' },
      ]
      render(<Toast items={items} onDismiss={vi.fn()} />)
      const sub = screen.getByTestId('toast-partial-cost-pc1')
      expect(sub).toBeInTheDocument()
      expect(sub.textContent).toBe('This turn cost $0.087 (1.2K in · 3.4K out)')
    })

    it('does NOT render the sub-line element when subMessage is absent', () => {
      // Preserve the pre-#5039 single-line layout for every error path
      // that doesn't carry partials — no empty `<span class="toast-submsg">`
      // wrapper should leak into the DOM.
      const items: ToastItem[] = [{ id: 'pc2', message: 'Plain error' }]
      const { container } = render(<Toast items={items} onDismiss={vi.fn()} />)
      expect(screen.queryByTestId('toast-partial-cost-pc2')).toBeNull()
      expect(container.querySelector('.toast-submsg')).toBeNull()
    })

    it('keeps the main message text rendered alongside the sub-line', () => {
      // Belt-and-braces: the sub-line must NOT replace the main
      // message — both must surface so the user sees the error context
      // AND the failed-turn cost.
      const items: ToastItem[] = [
        { id: 'pc3', message: 'Stream error', subMessage: 'This turn cost $0.050' },
      ]
      render(<Toast items={items} onDismiss={vi.fn()} />)
      expect(screen.getByText('Stream error')).toBeInTheDocument()
      expect(screen.getByTestId('toast-partial-cost-pc3')).toBeInTheDocument()
    })

    it('does not interfere with action button rendering when both are present', () => {
      // The sub-line lives inside `.toast-msg`, the action button is a
      // sibling of `.toast-msg` — both must surface without one
      // hiding the other.
      const items: ToastItem[] = [
        {
          id: 'pc4',
          message: 'Stream error',
          subMessage: 'This turn cost $0.050',
          action: { label: 'Retry', onClick: vi.fn() },
        },
      ]
      render(<Toast items={items} onDismiss={vi.fn()} />)
      expect(screen.getByTestId('toast-partial-cost-pc4')).toBeInTheDocument()
      expect(screen.getByTestId('toast-action-pc4')).toBeInTheDocument()
    })
  })
})
