/**
 * #9168: toasts draw beneath an open modal and their timers pause until it closes.
 */
import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Toast, type ToastItem } from './Toast'
import { Modal } from './Modal'
import { ShortcutHelp } from './ShortcutHelp'
import { getModalOverlayCount } from '../hooks/useModalOverlay'
import { fullScreenLayers, declaredZIndex } from '../hooks/overlayRoster.testSupport'

afterEach(cleanup)

const items: ToastItem[] = [{ id: 't0', message: 'Heads up' }]
const BEHIND = 'toast-container-behind-modal'

function Harness({ open, onDismiss }: { open: boolean; onDismiss: (id: string) => void }) {
  return (
    <>
      <Toast items={items} onDismiss={onDismiss} />
      <Modal open={open} onClose={() => {}} title="M"><p>body</p></Modal>
    </>
  )
}

describe('toast stack vs modal overlay (#9168)', () => {
  it('adds the behind-modal class while a modal is open and drops it on close', () => {
    const { rerender } = render(<Harness open={false} onDismiss={vi.fn()} />)
    const container = screen.getByTestId('toast-container')
    expect(container.classList.contains(BEHIND)).toBe(false)
    rerender(<Harness open onDismiss={vi.fn()} />)
    expect(container.classList.contains(BEHIND)).toBe(true)
    rerender(<Harness open={false} onDismiss={vi.fn()} />)
    expect(container.classList.contains(BEHIND)).toBe(false)
  })

  describe('timers', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers() })

    it('pauses while a modal is open and resumes with the REMAINING time', async () => {
      const onDismiss = vi.fn()
      const { rerender } = render(<Harness open={false} onDismiss={onDismiss} />)
      await act(async () => { vi.advanceTimersByTime(2000) })
      rerender(<Harness open onDismiss={onDismiss} />)
      await act(async () => { vi.advanceTimersByTime(20000) })
      expect(onDismiss).not.toHaveBeenCalled()
      expect(screen.getByTestId('toast-t0')).toBeInTheDocument()
      rerender(<Harness open={false} onDismiss={onDismiss} />)
      await act(async () => { vi.advanceTimersByTime(2999) })
      expect(onDismiss).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(onDismiss).toHaveBeenCalledWith('t0')
    })

    it('hover and modal compose: closing the modal while still hovered stays paused', async () => {
      const onDismiss = vi.fn()
      const { rerender } = render(<Harness open={false} onDismiss={onDismiss} />)
      const toast = screen.getByTestId('toast-t0')
      await act(async () => { vi.advanceTimersByTime(1000) })
      fireEvent.mouseEnter(toast)
      rerender(<Harness open onDismiss={onDismiss} />)
      rerender(<Harness open={false} onDismiss={onDismiss} />)
      await act(async () => { vi.advanceTimersByTime(20000) })
      expect(onDismiss).not.toHaveBeenCalled()
      fireEvent.mouseLeave(toast)
      await act(async () => { vi.advanceTimersByTime(3999) })
      expect(onDismiss).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(onDismiss).toHaveBeenCalledWith('t0')
    })
  })

  it('StrictMode mount/unmount of a Modal leaves the registry at 0', () => {
    expect(getModalOverlayCount()).toBe(0)
    const { unmount } = render(
      <StrictMode><Modal open onClose={() => {}} title="M"><p>x</p></Modal></StrictMode>,
    )
    expect(getModalOverlayCount()).toBe(1)
    unmount()
    expect(getModalOverlayCount()).toBe(0)
  })
})

function Stack({ toasts, modal = false, help = false, onDismiss }: {
  toasts: ToastItem[]; modal?: boolean; help?: boolean; onDismiss: (id: string) => void
}) {
  return (
    <>
      <Toast items={toasts} onDismiss={onDismiss} />
      <Modal open={modal} onClose={() => {}} title="M"><p>body</p></Modal>
      <ShortcutHelp isOpen={help} onClose={() => {}} shortcuts={[]} />
    </>
  )
}

describe('toast timers vs overlays, extended (#9168)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { cleanup(); vi.runOnlyPendingTimers(); vi.useRealTimers() })
  const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms) })

  it('a toast added while a modal is open outlives 5s and gets its FULL 5s after close', async () => {
    const onDismiss = vi.fn()
    const { rerender } = render(<Stack toasts={[]} modal onDismiss={onDismiss} />)
    rerender(<Stack toasts={items} modal onDismiss={onDismiss} />)
    await advance(30000)
    expect(onDismiss).not.toHaveBeenCalled()
    rerender(<Stack toasts={items} modal={false} onDismiss={onDismiss} />)
    await advance(4999)
    expect(onDismiss).not.toHaveBeenCalled()
    await advance(1)
    expect(onDismiss).toHaveBeenCalledWith('t0')
  })

  it('two overlays: closing one keeps toasts paused, closing both resumes', async () => {
    const onDismiss = vi.fn()
    const { rerender } = render(<Stack toasts={items} onDismiss={onDismiss} />)
    await advance(1000)
    rerender(<Stack toasts={items} modal help onDismiss={onDismiss} />)
    expect(screen.getByTestId('toast-container').classList.contains(BEHIND)).toBe(true)
    rerender(<Stack toasts={items} modal help={false} onDismiss={onDismiss} />)
    expect(screen.getByTestId('toast-container').classList.contains(BEHIND)).toBe(true)
    await advance(30000)
    expect(onDismiss).not.toHaveBeenCalled()
    rerender(<Stack toasts={items} onDismiss={onDismiss} />)
    expect(screen.getByTestId('toast-container').classList.contains(BEHIND)).toBe(false)
    await advance(3999)
    expect(onDismiss).not.toHaveBeenCalled()
    await advance(1)
    expect(onDismiss).toHaveBeenCalledWith('t0')
  })

  it('toast timers: counted while running, none added while paused, gone on removal/unmount, never fire after', async () => {
    const onDismiss = vi.fn()
    // (1) the counter sees a toast timer: with NO modal, adding a toast adds >= 1
    const free = render(<Stack toasts={[]} onDismiss={onDismiss} />)
    const freeBase = vi.getTimerCount()
    free.rerender(<Stack toasts={items} onDismiss={onDismiss} />)
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(freeBase + 1)
    // (3a) removing a running toast returns to baseline
    free.rerender(<Stack toasts={[]} onDismiss={onDismiss} />)
    expect(vi.getTimerCount()).toBe(freeBase)
    // (3b) unmounting with a running toast returns to baseline
    free.rerender(<Stack toasts={items} onDismiss={onDismiss} />)
    free.unmount()
    expect(vi.getTimerCount()).toBe(freeBase)
    // (2) while a modal is open, adding a toast adds NO timer
    const paused = render(<Stack toasts={[]} modal onDismiss={onDismiss} />)
    const base = vi.getTimerCount()
    paused.rerender(<Stack toasts={items} modal onDismiss={onDismiss} />)
    expect(vi.getTimerCount()).toBe(base)
    // (3c) removing the paused toast and unmounting return to baseline
    paused.rerender(<Stack toasts={[]} modal onDismiss={onDismiss} />)
    expect(vi.getTimerCount()).toBe(base)
    paused.rerender(<Stack toasts={items} modal onDismiss={onDismiss} />)
    paused.unmount()
    // (4) nothing the toast armed can fire afterwards
    await advance(30000)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('actionDisabled composes with the modal pause', async () => {
    const onDismiss = vi.fn()
    const action = { label: 'Retry', onClick: vi.fn() }
    const disabled: ToastItem[] = [{ id: 'a', message: 'x', action, actionDisabled: true }]
    const enabled: ToastItem[] = [{ id: 'a', message: 'x', action, actionDisabled: false }]
    const { rerender } = render(<Stack toasts={disabled} modal onDismiss={onDismiss} />)
    // re-enabled while the modal is still open: timer must not run
    rerender(<Stack toasts={enabled} modal onDismiss={onDismiss} />)
    await advance(30000)
    expect(onDismiss).not.toHaveBeenCalled()
    // modal closes: full 5s from resume
    rerender(<Stack toasts={enabled} onDismiss={onDismiss} />)
    await advance(4999)
    expect(onDismiss).not.toHaveBeenCalled()
    await advance(1)
    expect(onDismiss).toHaveBeenCalledWith('a')
  })

  it('actionDisabled stays paused after the modal closes until re-enabled', async () => {
    const onDismiss = vi.fn()
    const action = { label: 'Retry', onClick: vi.fn() }
    const disabled: ToastItem[] = [{ id: 'a', message: 'x', action, actionDisabled: true }]
    const { rerender } = render(<Stack toasts={disabled} modal onDismiss={onDismiss} />)
    rerender(<Stack toasts={disabled} onDismiss={onDismiss} />)
    await advance(30000)
    expect(onDismiss).not.toHaveBeenCalled()
  })
})

describe('overlay layering (#9168)', () => {
  // Overlay layers (class + z-index) derived from EVERY stylesheet, not hardcoded.
  it('behind-modal z-index is below every overlay z-index', () => {
    const layers = fullScreenLayers()
    expect(layers.length).toBeGreaterThan(0)
    const behind = declaredZIndex('.toast-container.toast-container-behind-modal')
    for (const l of layers) expect(behind, l.selector).toBeLessThan(l.z)
  })
})
