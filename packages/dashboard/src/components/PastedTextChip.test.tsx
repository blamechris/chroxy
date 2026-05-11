/**
 * PastedTextChip tests (#3797) — chip body opens inspect, × removes,
 * keyboard activation works, the label shape switches between lines and
 * chars depending on line count.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { PastedTextChip } from './PastedTextChip'

afterEach(cleanup)

describe('PastedTextChip', () => {
  const baseProps = {
    id: 1,
    lineCount: 12,
    charCount: 4567,
    onInspect: vi.fn(),
    onRemove: vi.fn(),
  }

  it('renders the multi-line label when lineCount > 1', () => {
    render(<PastedTextChip {...baseProps} lineCount={12} />)
    expect(screen.getByText(/Pasted text #1 · 12 lines/)).toBeInTheDocument()
  })

  it('renders the chars label when lineCount === 1', () => {
    render(<PastedTextChip {...baseProps} lineCount={1} charCount={2000} />)
    expect(screen.getByText(/Pasted text #1 · 2000 chars/)).toBeInTheDocument()
  })

  it('calls onInspect when the chip body is clicked', () => {
    const onInspect = vi.fn()
    render(<PastedTextChip {...baseProps} onInspect={onInspect} />)
    fireEvent.click(screen.getByTestId('pasted-text-chip-1'))
    expect(onInspect).toHaveBeenCalledWith(1)
  })

  it('calls onRemove (and not onInspect) when the × button is clicked', () => {
    const onInspect = vi.fn()
    const onRemove = vi.fn()
    render(<PastedTextChip {...baseProps} onInspect={onInspect} onRemove={onRemove} />)
    fireEvent.click(screen.getByTestId('pasted-text-chip-remove-1'))
    expect(onRemove).toHaveBeenCalledWith(1)
    expect(onInspect).not.toHaveBeenCalled()
  })

  it('activates on Enter and Space (not on repeated Space)', () => {
    const onInspect = vi.fn()
    render(<PastedTextChip {...baseProps} onInspect={onInspect} />)
    const chip = screen.getByTestId('pasted-text-chip-1')
    fireEvent.keyDown(chip, { key: 'Enter' })
    expect(onInspect).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(chip, { key: ' ' })
    expect(onInspect).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(chip, { key: ' ', repeat: true })
    expect(onInspect).toHaveBeenCalledTimes(2)
  })

  it('uses a tabindex so the chip is keyboard-reachable', () => {
    render(<PastedTextChip {...baseProps} />)
    expect(screen.getByTestId('pasted-text-chip-1')).toHaveAttribute('tabindex', '0')
  })
})
