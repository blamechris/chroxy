/**
 * StreamStallChip tests — #4476
 *
 * Asserts the distinct affordance (chip, not generic red bubble) renders,
 * the retry button surfaces and fires onRetry, the raw error text is
 * preserved via the title attribute for diagnostics, and the retry button
 * stays hidden when onRetry is omitted (historical / replayed entries).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { StreamStallChip } from './StreamStallChip'

afterEach(cleanup)

describe('StreamStallChip (#4476)', () => {
  it('renders the chip text', () => {
    render(<StreamStallChip errorText="Stream stalled — no response for 5 minutes" />)
    const chip = screen.getByTestId('stream-stall-chip')
    expect(chip).toBeInTheDocument()
    expect(chip.textContent).toMatch(/Stream stalled/i)
    expect(chip.textContent).toMatch(/retry/i)
  })

  it('preserves the raw server error text via the title attribute', () => {
    // Operators investigating a stall pattern need the underlying server
    // message — the chip's prose is friendly, but the diagnostic detail
    // must remain accessible without losing it.
    const raw = 'Stream stalled — no response for 5 minutes (provider=claude-sdk session=abc)'
    render(<StreamStallChip errorText={raw} />)
    const chip = screen.getByTestId('stream-stall-chip')
    expect(chip.getAttribute('title')).toBe(raw)
  })

  it('shows a Retry button when onRetry is provided', () => {
    const onRetry = vi.fn()
    render(<StreamStallChip errorText="x" onRetry={onRetry} />)
    expect(screen.getByTestId('stream-stall-chip-retry')).toBeInTheDocument()
  })

  it('hides the Retry button when onRetry is omitted', () => {
    // For historical/replayed entries the original user input is no longer
    // the obvious target to resend — render the chip without the button
    // rather than wire it to a misleading action.
    render(<StreamStallChip errorText="x" />)
    expect(screen.queryByTestId('stream-stall-chip-retry')).toBeNull()
  })

  it('invokes onRetry when the Retry button is clicked', () => {
    const onRetry = vi.fn()
    render(<StreamStallChip errorText="x" onRetry={onRetry} />)
    fireEvent.click(screen.getByTestId('stream-stall-chip-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('uses role="status" so assistive tech announces the stall', () => {
    // The chip's purpose is to make a recoverable failure visible — give
    // screen readers a live-region announcement so users not watching the
    // chat aren't stuck guessing why the assistant went silent.
    render(<StreamStallChip errorText="x" />)
    const chip = screen.getByTestId('stream-stall-chip')
    expect(chip.getAttribute('role')).toBe('status')
  })
})
