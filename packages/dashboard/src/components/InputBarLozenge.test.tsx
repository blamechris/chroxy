/**
 * Composer state lozenge tests (chat redesign #6389/#6391, Phase 1 —
 * deferred item now shipping).
 *
 * The lozenge ("◐ streaming · +2 queued") is a pure text formatter
 * (`formatComposerLozenge` in `@chroxy/store-core`) keyed off the same
 * `chatActivityState` + queued-follow-up count that already drive the
 * composer's live hairline. These tests cover the three cases called out
 * in the design doc's signature moment: streaming with queued follow-ups,
 * streaming with none, and hidden at idle.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { InputBar } from './InputBar'

afterEach(cleanup)

describe('InputBar composer state lozenge (chat redesign #6391)', () => {
  it('shows "◐ streaming · +N queued" when thinking with queued follow-ups', () => {
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        chatActivityState="thinking"
        queuedCount={2}
      />,
    )
    expect(screen.getByTestId('input-bar-lozenge')).toHaveTextContent('◐ streaming · +2 queued')
  })

  it('shows "◐ streaming" with no queued suffix when thinking with none queued', () => {
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        chatActivityState="thinking"
        queuedCount={0}
      />,
    )
    expect(screen.getByTestId('input-bar-lozenge')).toHaveTextContent('◐ streaming')
  })

  it('hides the lozenge entirely at idle, even with a stale queued count', () => {
    render(
      <InputBar
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        chatActivityState="idle"
        queuedCount={3}
      />,
    )
    expect(screen.queryByTestId('input-bar-lozenge')).not.toBeInTheDocument()
  })

  it('hides the lozenge when chatActivityState is omitted (default idle behavior)', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
    expect(screen.queryByTestId('input-bar-lozenge')).not.toBeInTheDocument()
  })

  it('labels the busy and waiting states distinctly from streaming', () => {
    const { rerender } = render(
      <InputBar onSend={vi.fn()} onInterrupt={vi.fn()} chatActivityState="busy" queuedCount={1} />,
    )
    expect(screen.getByTestId('input-bar-lozenge')).toHaveTextContent('◐ busy · +1 queued')

    rerender(
      <InputBar onSend={vi.fn()} onInterrupt={vi.fn()} chatActivityState="waiting" queuedCount={0} />,
    )
    expect(screen.getByTestId('input-bar-lozenge')).toHaveTextContent('◐ waiting')
  })

  it('is presentational — marked aria-hidden so it does not duplicate other live-region announcements', () => {
    render(
      <InputBar onSend={vi.fn()} onInterrupt={vi.fn()} chatActivityState="thinking" queuedCount={1} />,
    )
    expect(screen.getByTestId('input-bar-lozenge')).toHaveAttribute('aria-hidden', 'true')
  })
})
