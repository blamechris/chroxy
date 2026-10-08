/**
 * TurnOutcomeMarker component tests (#7326).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TurnOutcomeMarker } from './TurnOutcomeMarker'

afterEach(cleanup)

describe('TurnOutcomeMarker (#7326)', () => {
  const cases = [
    ['truncated', 'Reply cut off'],
    ['refused', 'The model declined'],
    ['stopped', 'Stopped'],
  ] as const

  for (const [outcome, label] of cases) {
    it(`renders the "${label}" chip for ${outcome}, tagged for the smoke script`, () => {
      render(<TurnOutcomeMarker outcome={outcome} />)
      const chip = screen.getByTestId('turn-outcome-marker')
      expect(chip).toHaveTextContent(label)
      expect(chip).toHaveAttribute('data-outcome', outcome)
      expect(chip).toHaveAttribute('role', 'status')
      // The tooltip / accessible name carries the sentence, not just the label.
      expect(chip.getAttribute('title')!.length).toBeGreaterThan(label.length)
      expect(chip.getAttribute('aria-label')).toContain(label)
    })
  }

  it('is a status line, not a control (so the 44px tap floor does not apply)', () => {
    render(<TurnOutcomeMarker outcome="truncated" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
