/**
 * #9168: toasts draw beneath an open modal and their timers pause until it closes.
 */
import { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { readFileSync, readdirSync } from 'fs'
import { resolve, join } from 'path'
import { Toast, type ToastItem } from './Toast'
import { Modal } from './Modal'
import { getModalOverlayCount } from '../hooks/useModalOverlay'

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

describe('overlay layering (#9168)', () => {
  const css = readFileSync(resolve(__dirname, '../theme/components.css'), 'utf-8')
  const zOf = (cls: string): number => {
    const m = new RegExp(`(?:^|\\n)${cls.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css)
    if (!m || m[1] === undefined) throw new Error(`rule for ${cls}`)
    const z = /z-index:\s*(\d+)/.exec(m[1])
    if (!z || z[1] === undefined) throw new Error(`z-index in ${cls}`)
    return Number(z[1])
  }

  // Overlay classes derived from the sources that use the hook, not hardcoded.
  const dir = resolve(__dirname)
  const overlayClasses = (): string[] => {
    const out: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.tsx') || f.includes('.test.')) continue
      const src = readFileSync(join(dir, f), 'utf-8')
      let i = src.indexOf('{...overlayProps}')
      while (i !== -1) {
        const start = src.lastIndexOf('<', i)
        const m = /className="([^"]+)"/.exec(src.slice(start, start + 400))
        const cls = m?.[1]?.split(' ')[0]
        if (!cls) throw new Error(`className on overlay in ${f}`)
        out.push('.' + cls)
        i = src.indexOf('{...overlayProps}', i + 1)
      }
    }
    return out
  }

  it('behind-modal z-index is below every overlay z-index', () => {
    const classes = overlayClasses()
    expect(classes.length).toBe(7)
    const behind = zOf('.toast-container.toast-container-behind-modal')
    for (const c of classes) expect(behind, c).toBeLessThan(zOf(c))
  })
})
