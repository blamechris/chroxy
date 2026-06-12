import { describe, it, expect } from 'vitest'
import { buildAutoModeConfirmMessage } from './auto-mode-confirm'

describe('buildAutoModeConfirmMessage (#5609)', () => {
  it('warns about interrupting the turn when the provider interrupts AND a turn is streaming', () => {
    const msg = buildAutoModeConfirmMessage({ interruptsTurn: true, isStreaming: true })
    expect(msg).toMatch(/INTERRUPT/)
    expect(msg).toMatch(/restart the session/)
    // still explains the bypass consequence
    expect(msg).toMatch(/without asking for permission/)
  })

  it('uses the plain copy when the provider interrupts but no turn is in flight', () => {
    const msg = buildAutoModeConfirmMessage({ interruptsTurn: true, isStreaming: false })
    expect(msg).not.toMatch(/INTERRUPT/)
    expect(msg).toMatch(/Tools will run without asking for permission/)
  })

  it('uses the plain copy for non-interrupting providers (SDK/TUI) even mid-turn', () => {
    const msg = buildAutoModeConfirmMessage({ interruptsTurn: false, isStreaming: true })
    expect(msg).not.toMatch(/INTERRUPT/)
    expect(msg).toMatch(/Tools will run without asking for permission/)
  })

  it('treats an undefined capability flag as non-interrupting', () => {
    const msg = buildAutoModeConfirmMessage({ interruptsTurn: undefined, isStreaming: true })
    expect(msg).not.toMatch(/INTERRUPT/)
    expect(msg).toMatch(/Tools will run without asking for permission/)
  })
})
