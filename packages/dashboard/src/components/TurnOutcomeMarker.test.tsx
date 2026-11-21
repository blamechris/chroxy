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

  describe('stopped before a reply (#9241)', () => {
    // 2023-11-14T22:13:20Z; asserted against the local clock the component formats with
    const ts = 1700000000000
    const hhmm = (() => {
      const d = new Date(ts)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    })()

    it('renders the label and the time, quietly, with the sentence as its tooltip', () => {
      render(<TurnOutcomeMarker outcome="stopped_before_output" timestamp={ts} />)
      const chip = screen.getByTestId('turn-outcome-marker')
      expect(chip).toHaveTextContent(`Stopped before a reply \u00b7 ${hhmm}`)
      expect(chip).toHaveAttribute('data-outcome', 'stopped_before_output')
      expect(chip.className).toContain('turn-outcome-marker-stopped_before_output')
      expect(chip.getAttribute('title')).toContain('before the model produced any output')
    })

    it('shows the bare label when there is no timestamp', () => {
      render(<TurnOutcomeMarker outcome="stopped_before_output" />)
      expect(screen.getByTestId('turn-outcome-marker').textContent).not.toContain('\u00b7')
    })

    it('CONTROL: a plain Stopped chip never shows a time, whatever timestamp it is handed', () => {
      render(<TurnOutcomeMarker outcome="stopped" timestamp={ts} />)
      const chip = screen.getByTestId('turn-outcome-marker')
      expect(chip).toHaveTextContent('Stopped')
      expect(chip.textContent).not.toContain(hhmm)
    })
  })

  it('is a status line, not a control (so the 44px tap floor does not apply)', () => {
    render(<TurnOutcomeMarker outcome="truncated" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
