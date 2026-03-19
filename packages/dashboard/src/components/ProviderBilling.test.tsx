/**
 * Provider billing hint tests (#1677)
 *
 * Verifies billing context is shown below provider dropdown.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { CreateSessionModal } from './CreateSessionModal'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      defaultProvider: 'claude-cli',
      availableProviders: [
        { name: 'claude-cli', capabilities: {} },
        { name: 'claude-sdk', capabilities: {} },
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

afterEach(cleanup)

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

  it('shows billing hint for SDK provider', () => {
    render(<CreateSessionModal {...defaultProps} />)
    const select = screen.getByLabelText('Select provider')
    fireEvent.change(select, { target: { value: 'claude-sdk' } })
    expect(screen.getByTestId('provider-billing-hint')).toHaveTextContent('Uses Anthropic API credits')
  })

  it('shows billing hint for Gemini provider', () => {
    render(<CreateSessionModal {...defaultProps} />)
    const select = screen.getByLabelText('Select provider')
    fireEvent.change(select, { target: { value: 'gemini' } })
    expect(screen.getByTestId('provider-billing-hint')).toHaveTextContent('Uses Google API credits')
  })
})
