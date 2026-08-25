/**
 * Unit tests for the pure copy-selection helper.
 *
 * #7335: these pin the helper only. The `isBusy` input is where the defect
 * actually lived, so the guard that matters is the CALL-SITE suite in
 * `store/auto-mode-confirm-busy.test.ts` — every case below passed on the
 * broken build.
 */
import { describe, it, expect } from 'vitest'
import { buildAutoModeConfirmMessage } from './auto-mode-confirm'

describe('buildAutoModeConfirmMessage (#5609)', () => {
  it('warns about interrupting the turn when the provider interrupts AND the session is busy', () => {
    const msg = buildAutoModeConfirmMessage({ interruptsTurn: true, isBusy: true })
    expect(msg).toMatch(/INTERRUPT/)
    expect(msg).toMatch(/restart the session/)
    // still explains the bypass consequence
    expect(msg).toMatch(/without asking for permission/)
  })

  it('uses the plain copy when the provider interrupts but there is no work at risk', () => {
    const msg = buildAutoModeConfirmMessage({ interruptsTurn: true, isBusy: false })
    expect(msg).not.toMatch(/INTERRUPT/)
    expect(msg).toMatch(/Tools will run without asking for permission/)
  })

  it('uses the plain copy for non-interrupting providers (SDK/TUI) even when busy', () => {
    const msg = buildAutoModeConfirmMessage({ interruptsTurn: false, isBusy: true })
    expect(msg).not.toMatch(/INTERRUPT/)
    expect(msg).toMatch(/Tools will run without asking for permission/)
  })

  it('treats an undefined capability flag as non-interrupting', () => {
    const msg = buildAutoModeConfirmMessage({ interruptsTurn: undefined, isBusy: true })
    expect(msg).not.toMatch(/INTERRUPT/)
    expect(msg).toMatch(/Tools will run without asking for permission/)
  })
})
