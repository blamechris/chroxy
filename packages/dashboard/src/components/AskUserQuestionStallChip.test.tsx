/**
 * AskUserQuestionStallChip tests — #4615
 *
 * Asserts the dedicated chip (not the generic red toast) renders for
 * `error{code: 'ASK_USER_QUESTION_STALL'}` (server emits this when the
 * Claude TUI never acknowledges an AskUserQuestion answer — multi-question
 * form wedge). Mirrors the StreamStallChip pattern (#4476): action-oriented
 * copy, Retry button that re-fires the last user message, raw server text
 * preserved on the tooltip for diagnostics.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { AskUserQuestionStallChip } from './AskUserQuestionStallChip'

afterEach(cleanup)

describe('AskUserQuestionStallChip (#4615)', () => {
  it('renders an action-oriented headline', () => {
    render(<AskUserQuestionStallChip errorText="Couldn't deliver your answers." />)
    const chip = screen.getByTestId('ask-user-question-stall-chip')
    expect(chip).toBeInTheDocument()
    // Action-oriented: prompts the user to retry, not jargon-y "stall".
    expect(chip.textContent).toMatch(/retry/i)
  })

  it('preserves the raw server error text via the title attribute', () => {
    // Operators investigating the wedge need the original server message —
    // the chip's prose is friendly, but the diagnostic must remain
    // accessible via tooltip.
    const raw = 'Couldn\'t deliver your answers. Tap Retry to resend your original request.'
    render(<AskUserQuestionStallChip errorText={raw} />)
    const chip = screen.getByTestId('ask-user-question-stall-chip')
    expect(chip.getAttribute('title')).toBe(raw)
  })

  it('shows a Retry button when onRetry is provided', () => {
    const onRetry = vi.fn()
    render(<AskUserQuestionStallChip errorText="x" onRetry={onRetry} />)
    expect(screen.getByTestId('ask-user-question-stall-chip-retry')).toBeInTheDocument()
  })

  it('hides the Retry button when onRetry is omitted', () => {
    // For historical/replayed entries the original user input is no longer
    // the obvious target to resend — render the chip without the button
    // rather than wire it to a misleading action. Mirrors StreamStallChip.
    render(<AskUserQuestionStallChip errorText="x" />)
    expect(screen.queryByTestId('ask-user-question-stall-chip-retry')).toBeNull()
  })

  it('invokes onRetry when the Retry button is clicked', () => {
    const onRetry = vi.fn()
    render(<AskUserQuestionStallChip errorText="x" onRetry={onRetry} />)
    fireEvent.click(screen.getByTestId('ask-user-question-stall-chip-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('uses role="status" so assistive tech announces the stall', () => {
    // Same accessibility rationale as StreamStallChip: a recoverable
    // failure must be announced to users not actively watching the chat.
    render(<AskUserQuestionStallChip errorText="x" />)
    const chip = screen.getByTestId('ask-user-question-stall-chip')
    expect(chip.getAttribute('role')).toBe('status')
  })

  it('does not collide with the StreamStallChip testID', () => {
    // Both chips are amber-warning variants; the testID disambiguates so
    // E2E tests can target the correct affordance.
    render(<AskUserQuestionStallChip errorText="x" />)
    expect(screen.queryByTestId('stream-stall-chip')).toBeNull()
  })
})
