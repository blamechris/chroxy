/**
 * Provider billing hint tests (#1677)
 *
 * Verifies billing context is shown below provider dropdown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { CreateSessionModal } from './CreateSessionModal'

// The claude-cli/claude-sdk billing fallback is era-gated (subscription before
// 2026-06-15, programmatic credit pool on/after). Pin the clock to a pre-era
// instant so these assertions are deterministic regardless of the run date.
const PRE_ERA = Date.UTC(2026, 5, 14) // 2026-06-14, before the boundary

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      defaultProvider: 'claude-cli',
      availableProviders: [
        { name: 'claude-cli', capabilities: {} },
        { name: 'claude-sdk', capabilities: {} },
        { name: 'codex', capabilities: {} },
        { name: 'gemini', capabilities: {} },
      ],
      defaultCwd: '/home/user',
      setDirectoryListingCallback: vi.fn(),
    }
    return selector(state)
  },
}))

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(PRE_ERA)
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('Provider billing hints (#1677)', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onCreate: vi.fn(),
  }

  it('shows billing hint for CLI provider', () => {
    render(<CreateSessionModal {...defaultProps} />)
    expect(screen.getByTestId('provider-billing-hint')).toHaveTextContent('Uses your Claude subscription')
  })

  it('shows billing hint for SDK provider (pre-era subscription copy)', () => {
    render(<CreateSessionModal {...defaultProps} />)
    const select = screen.getByLabelText('Select provider')
    fireEvent.change(select, { target: { value: 'claude-sdk' } })
    // #5629: before 2026-06-15 the SDK's default OAuth path bills the
    // subscription pool; on/after it flips to "programmatic credit pool".
    expect(screen.getByTestId('provider-billing-hint')).toHaveTextContent('Uses your Claude subscription')
  })

  it('shows billing hint for Codex provider', () => {
    render(<CreateSessionModal {...defaultProps} />)
    const select = screen.getByLabelText('Select provider')
    fireEvent.change(select, { target: { value: 'codex' } })
    expect(screen.getByTestId('provider-billing-hint')).toHaveTextContent('Uses OpenAI API credits')
  })

  it('shows billing hint for Gemini provider', () => {
    render(<CreateSessionModal {...defaultProps} />)
    const select = screen.getByLabelText('Select provider')
    fireEvent.change(select, { target: { value: 'gemini' } })
    expect(screen.getByTestId('provider-billing-hint')).toHaveTextContent('Uses Google API credits')
  })
})
