/**
 * #9198: CommandPalette registers as a modal overlay, and Escape over an open
 * Modal closes only the palette (the Modal's topmost-overlay check must see the
 * palette, which is later in the DOM).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { CommandPalette, type Command } from './CommandPalette'
import { Modal } from './Modal'
import { getModalOverlayCount } from '../hooks/useModalOverlay'

afterEach(cleanup)

const commands: Command[] = [{ id: 'a', name: 'Alpha', category: 'Cat', action: vi.fn() }]

describe('CommandPalette overlay registration (#9198)', () => {
  it('registers while open, carries the overlay attribute, and unregisters on close and unmount', () => {
    expect(getModalOverlayCount()).toBe(0)
    const { rerender, unmount } = render(<CommandPalette commands={commands} isOpen onClose={vi.fn()} />)
    expect(getModalOverlayCount()).toBe(1)
    expect(screen.getByTestId('command-palette').hasAttribute('data-modal-overlay')).toBe(true)
    rerender(<CommandPalette commands={commands} isOpen={false} onClose={vi.fn()} />)
    expect(getModalOverlayCount()).toBe(0)
    rerender(<CommandPalette commands={commands} isOpen onClose={vi.fn()} />)
    expect(getModalOverlayCount()).toBe(1)
    unmount()
    expect(getModalOverlayCount()).toBe(0)
  })
})

describe('Escape with a palette open over a Modal (#9198)', () => {
  it('closes only the palette; the Modal stays open', () => {
    const onModalClose = vi.fn()
    const onPaletteClose = vi.fn()
    render(
      <>
        <Modal open onClose={onModalClose} title="M"><p>body</p></Modal>
        <CommandPalette commands={commands} isOpen onClose={onPaletteClose} />
      </>,
    )
    expect(getModalOverlayCount()).toBe(2)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(onPaletteClose).toHaveBeenCalledTimes(1)
    expect(onModalClose).not.toHaveBeenCalled()
  })

  it('once the palette is gone, Escape closes the Modal', () => {
    const onModalClose = vi.fn()
    const { rerender } = render(
      <>
        <Modal open onClose={onModalClose} title="M"><p>body</p></Modal>
        <CommandPalette commands={commands} isOpen onClose={vi.fn()} />
      </>,
    )
    rerender(
      <>
        <Modal open onClose={onModalClose} title="M"><p>body</p></Modal>
        <CommandPalette commands={commands} isOpen={false} onClose={vi.fn()} />
      </>,
    )
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onModalClose).toHaveBeenCalledTimes(1)
  })
})
