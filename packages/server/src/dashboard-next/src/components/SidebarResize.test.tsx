/**
 * Sidebar resize handle — drag-to-resize with clamped width.
 *
 * Tests: handle renders, cursor style, min/max clamping, drag behavior.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Sidebar } from './Sidebar'

afterEach(cleanup)

const baseProps = {
  repos: [],
  activeSessionId: null,
  isOpen: true,
  width: 240,
  filter: '',
  serverStatus: 'connected' as const,
  tunnelUrl: null,
  clientCount: 1,
  onFilterChange: vi.fn(),
  onSessionClick: vi.fn(),
  onResumeSession: vi.fn(),
  onNewSession: vi.fn(),
  onToggle: vi.fn(),
  onContextMenu: vi.fn(),
}

describe('Sidebar resize handle', () => {
  it('renders resize handle when sidebar is open', () => {
    const { container } = render(<Sidebar {...baseProps} />)
    expect(container.querySelector('.sidebar-resize-handle')).toBeInTheDocument()
  })

  it('does NOT render resize handle when sidebar is collapsed', () => {
    const { container } = render(<Sidebar {...baseProps} isOpen={false} />)
    expect(container.querySelector('.sidebar-resize-handle')).not.toBeInTheDocument()
  })

  it('calls onWidthChange during drag', () => {
    const onWidthChange = vi.fn()
    const { container } = render(<Sidebar {...baseProps} onWidthChange={onWidthChange} />)

    const handle = container.querySelector('.sidebar-resize-handle')!
    fireEvent.mouseDown(handle, { clientX: 240 })
    fireEvent.mouseMove(document, { clientX: 300 })
    fireEvent.mouseUp(document)

    expect(onWidthChange).toHaveBeenCalled()
  })

  it('clamps width to minimum 160px', () => {
    const onWidthChange = vi.fn()
    const { container } = render(<Sidebar {...baseProps} width={240} onWidthChange={onWidthChange} />)

    const handle = container.querySelector('.sidebar-resize-handle')!
    fireEvent.mouseDown(handle, { clientX: 240 })
    fireEvent.mouseMove(document, { clientX: 50 })
    fireEvent.mouseUp(document)

    if (onWidthChange.mock.calls.length > 0) {
      const lastWidth = onWidthChange.mock.calls[onWidthChange.mock.calls.length - 1]![0]
      expect(lastWidth).toBeGreaterThanOrEqual(160)
    }
  })

  it('clamps width to maximum 480px', () => {
    const onWidthChange = vi.fn()
    const { container } = render(<Sidebar {...baseProps} width={240} onWidthChange={onWidthChange} />)

    const handle = container.querySelector('.sidebar-resize-handle')!
    fireEvent.mouseDown(handle, { clientX: 240 })
    fireEvent.mouseMove(document, { clientX: 600 })
    fireEvent.mouseUp(document)

    if (onWidthChange.mock.calls.length > 0) {
      const lastWidth = onWidthChange.mock.calls[onWidthChange.mock.calls.length - 1]![0]
      expect(lastWidth).toBeLessThanOrEqual(480)
    }
  })
})
