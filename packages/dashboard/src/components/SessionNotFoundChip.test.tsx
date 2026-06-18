/**
 * #4982 — SessionNotFoundChip render tests.
 *
 * Parity with ResumeUnknownChip.test.tsx (#4947) — pins the conditional
 * id-subtext slot and the dismiss-button wiring so future refactors
 * don't silently degrade the chip into either a broken "Attempted id: "
 * empty slot OR a dismissless banner the operator can't escape.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { SessionNotFoundChip } from './SessionNotFoundChip'

afterEach(() => { cleanup() })

describe('<SessionNotFoundChip>', () => {
  it('renders the headline + attempted id when attemptedSessionId is provided', () => {
    render(
      <SessionNotFoundChip
        message="Session not found: sess-abc-123"
        attemptedSessionId="sess-abc-123"
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByTestId('session-not-found-chip')).toBeInTheDocument()
    expect(screen.getByTestId('session-not-found-chip-id')).toHaveTextContent('Attempted id: sess-abc-123')
  })

  it('omits the id subtext when attemptedSessionId is null', () => {
    render(
      <SessionNotFoundChip
        message="Session not found"
        attemptedSessionId={null}
        onDismiss={() => {}}
      />,
    )
    expect(screen.queryByTestId('session-not-found-chip-id')).toBeNull()
  })

  it('omits the id subtext when attemptedSessionId is undefined (pre-#4979 server)', () => {
    render(
      <SessionNotFoundChip
        message="Session not found"
        onDismiss={() => {}}
      />,
    )
    expect(screen.queryByTestId('session-not-found-chip-id')).toBeNull()
  })

  it('omits the id subtext when attemptedSessionId is whitespace-only (defensive)', () => {
    // Mirrors the ResumeUnknownChip defensive guard — a stale empty value
    // shouldn't degrade the headline into a broken "Attempted id: " slot.
    render(
      <SessionNotFoundChip
        message="Session not found"
        attemptedSessionId="   "
        onDismiss={() => {}}
      />,
    )
    expect(screen.queryByTestId('session-not-found-chip-id')).toBeNull()
  })

  it('preserves the raw error message in the title attribute for operator triage', () => {
    const verbatim = 'Session not found: server raw text with [brackets] and "quotes"'
    render(
      <SessionNotFoundChip
        message={verbatim}
        attemptedSessionId="x"
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByTestId('session-not-found-chip')).toHaveAttribute('title', verbatim)
  })

  it('calls onDismiss when the Dismiss button is clicked', () => {
    const onDismiss = vi.fn()
    render(
      <SessionNotFoundChip
        message="Session not found"
        attemptedSessionId="x"
        onDismiss={onDismiss}
      />,
    )
    fireEvent.click(screen.getByTestId('session-not-found-chip-dismiss'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('uses the stream-stall-chip CSS class (shared amber-recoverable palette)', () => {
    // Stream-stall / resume-unknown / session-not-found share the chip
    // visual language so the user learns the affordance once. If a future
    // refactor switches to a custom class, this test reminds the author
    // to also update the chip CSS so the user experience stays consistent.
    render(
      <SessionNotFoundChip
        message="Session not found"
        attemptedSessionId="x"
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByTestId('session-not-found-chip')).toHaveClass('stream-stall-chip')
  })
})
