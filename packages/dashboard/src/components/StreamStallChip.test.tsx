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

  // #4497 — humanised headline. When the server advertises
  // `streamStallTimeoutMs` on auth_ok, the chip swaps the generic phrase
  // for the more informative "No response for ${humanize(ms)} — retry?"
  // so the user knows the actual configured inactivity window. The raw
  // server text on the tooltip must NOT change.
  describe('humanised headline (#4497)', () => {
    it('renders the static phrase when timeoutMs is undefined', () => {
      render(<StreamStallChip errorText="raw server text" />)
      const chip = screen.getByTestId('stream-stall-chip')
      expect(chip.textContent).toMatch(/Stream stalled — retry\?/)
    })

    it('renders "No response for 5 minutes — retry?" for 300_000 ms', () => {
      render(<StreamStallChip errorText="raw server text" timeoutMs={300_000} />)
      const chip = screen.getByTestId('stream-stall-chip')
      expect(chip.textContent).toMatch(/No response for 5 minutes — retry\?/)
      expect(chip.textContent).not.toMatch(/Stream stalled —/)
    })

    it('renders "30 seconds" for sub-minute timeouts', () => {
      render(<StreamStallChip errorText="raw" timeoutMs={30_000} />)
      const chip = screen.getByTestId('stream-stall-chip')
      expect(chip.textContent).toMatch(/No response for 30 seconds — retry\?/)
    })

    it('renders singular "1 minute" for 60_000 ms', () => {
      render(<StreamStallChip errorText="raw" timeoutMs={60_000} />)
      const chip = screen.getByTestId('stream-stall-chip')
      expect(chip.textContent).toMatch(/No response for 1 minute — retry\?/)
    })

    it('renders hours for >= 1h timeouts', () => {
      render(<StreamStallChip errorText="raw" timeoutMs={2 * 60 * 60 * 1000} />)
      const chip = screen.getByTestId('stream-stall-chip')
      expect(chip.textContent).toMatch(/No response for 2 hours — retry\?/)
    })

    it('leaves the tooltip (raw server text) untouched when timeoutMs is provided', () => {
      const raw = 'Stream stalled — no response for 5 minutes (provider=claude-sdk session=abc)'
      render(<StreamStallChip errorText={raw} timeoutMs={300_000} />)
      const chip = screen.getByTestId('stream-stall-chip')
      expect(chip.getAttribute('title')).toBe(raw)
    })

    it('falls back to the static phrase for non-finite or non-positive timeoutMs', () => {
      // Defensive: a malformed prop should never produce
      // "No response for NaN minutes" garbage in the UI.
      for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
        cleanup()
        render(<StreamStallChip errorText="raw" timeoutMs={bad} />)
        const chip = screen.getByTestId('stream-stall-chip')
        expect(chip.textContent).toMatch(/Stream stalled — retry\?/)
      }
    })
  })
})
