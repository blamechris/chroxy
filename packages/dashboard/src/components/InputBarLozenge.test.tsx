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

  // #7368 — the lozenge straddles the composer's top edge out of flow, so the
  // composer reserves its overhang or it covers the ActivityIndicator /
  // CheckInChip strip above. jsdom has no layout: assert the class that
  // carries the reservation (present only while the lozenge is) and that the
  // stylesheet gives it a margin-top derived from the lozenge height.
  describe('overhang reservation (#7368)', () => {
    it.each(['thinking', 'busy', 'waiting', 'error'] as const)(
      'marks the composer to reserve the overhang while %s',
      (state) => {
        render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} chatActivityState={state} />)
        expect(screen.getByTestId('input-bar')).toHaveClass('input-bar--with-lozenge')
        expect(screen.getByTestId('input-bar-lozenge')).toBeInTheDocument()
      },
    )

    it('does not reserve anything at idle or when the state is omitted', () => {
      const { rerender } = render(
        <InputBar onSend={vi.fn()} onInterrupt={vi.fn()} chatActivityState="idle" queuedCount={2} />,
      )
      expect(screen.getByTestId('input-bar')).not.toHaveClass('input-bar--with-lozenge')
      rerender(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      expect(screen.getByTestId('input-bar')).not.toHaveClass('input-bar--with-lozenge')
    })

    it('drops the reservation when the turn ends', () => {
      const { rerender } = render(
        <InputBar onSend={vi.fn()} onInterrupt={vi.fn()} chatActivityState="thinking" />,
      )
      expect(screen.getByTestId('input-bar')).toHaveClass('input-bar--with-lozenge')
      rerender(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} chatActivityState="idle" />)
      expect(screen.getByTestId('input-bar')).not.toHaveClass('input-bar--with-lozenge')
    })

    it('the stylesheet turns the class into a margin-top of half the lozenge height', async () => {
      const { readFileSync } = await import('node:fs')
      const { resolve } = await import('node:path')
      const css = readFileSync(resolve(__dirname, '../theme/components.css'), 'utf8')
      const rule = css.match(/\.input-bar--with-lozenge\s*\{([^}]+)\}/)
      expect(rule, 'the reservation rule exists').toBeTruthy()
      expect(/margin-top:\s*calc\(var\(--input-bar-lozenge-height\)\s*\/\s*2/.test(rule?.[1] ?? '')).toBe(true)
    })
  })
})
