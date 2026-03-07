/**
 * ShortcutHelp tests (#1115)
 *
 * Tests the keyboard shortcut help overlay triggered by pressing '?'.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ShortcutHelp, type ShortcutEntry } from './ShortcutHelp'

afterEach(cleanup)

const testShortcuts: ShortcutEntry[] = [
  { keys: 'Cmd+N', description: 'New session', section: 'Global' },
  { keys: 'Cmd+B', description: 'Toggle sidebar', section: 'Global' },
  { keys: 'Cmd+Enter', description: 'Send message', section: 'Session' },
  { keys: '?', description: 'Show shortcuts', section: 'Global' },
]

describe('ShortcutHelp', () => {
  it('does not render when closed', () => {
    render(<ShortcutHelp isOpen={false} onClose={vi.fn()} shortcuts={testShortcuts} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders when open', () => {
    render(<ShortcutHelp isOpen={true} onClose={vi.fn()} shortcuts={testShortcuts} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument()
  })

  it('shows all shortcut entries', () => {
    render(<ShortcutHelp isOpen={true} onClose={vi.fn()} shortcuts={testShortcuts} />)
    expect(screen.getByText('New session')).toBeInTheDocument()
    expect(screen.getByText('Toggle sidebar')).toBeInTheDocument()
    expect(screen.getByText('Send message')).toBeInTheDocument()
  })

  it('groups shortcuts by section', () => {
    render(<ShortcutHelp isOpen={true} onClose={vi.fn()} shortcuts={testShortcuts} />)
    expect(screen.getByText('Global')).toBeInTheDocument()
    expect(screen.getByText('Session')).toBeInTheDocument()
  })

  it('displays key badges', () => {
    render(<ShortcutHelp isOpen={true} onClose={vi.fn()} shortcuts={testShortcuts} />)
    expect(screen.getByText('Cmd+N')).toBeInTheDocument()
    expect(screen.getByText('Cmd+B')).toBeInTheDocument()
  })

  it('closes on Escape key', () => {
    const onClose = vi.fn()
    render(<ShortcutHelp isOpen={true} onClose={onClose} shortcuts={testShortcuts} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on backdrop click', () => {
    const onClose = vi.fn()
    render(<ShortcutHelp isOpen={true} onClose={onClose} shortcuts={testShortcuts} />)
    const backdrop = document.querySelector('[data-modal-overlay]')!
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('has data-modal-overlay on backdrop', () => {
    render(<ShortcutHelp isOpen={true} onClose={vi.fn()} shortcuts={testShortcuts} />)
    const backdrop = document.querySelector('[data-modal-overlay]')
    expect(backdrop).toBeInTheDocument()
  })

  it('does not close on Escape when another overlay is on top', () => {
    const onClose = vi.fn()
    render(<ShortcutHelp isOpen={true} onClose={onClose} shortcuts={testShortcuts} />)
    // Add another overlay on top
    const topOverlay = document.createElement('div')
    topOverlay.setAttribute('data-modal-overlay', '')
    document.body.appendChild(topOverlay)
    try {
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      topOverlay.remove()
    }
  })
})
