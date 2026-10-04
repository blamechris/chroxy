/**
 * AuthRequiredChip tests — #8223
 *
 * The dedicated chip (not the generic red bubble) for `error{code:
 * 'AUTH_REQUIRED'}`: the registry headline, the server's message as the body,
 * and the one command that fixes it in a <code> element with a Copy button.
 * Retrying cannot help, so there is deliberately no Retry control.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { getErrorPresentation } from '@chroxy/store-core'

vi.mock('../utils/clipboard', () => ({ writeText: vi.fn() }))

import { writeText } from '../utils/clipboard'
import { AuthRequiredChip, AUTH_LOGIN_COMMAND } from './AuthRequiredChip'

const SERVER_TEXT = 'Claude is not logged in on this host, or its login expired. Run `claude auth login` in a terminal on the host (or `/login` inside claude), then retry.'

beforeEach(() => {
  vi.mocked(writeText).mockReset()
  vi.mocked(writeText).mockResolvedValue(true)
})
afterEach(cleanup)

describe('AuthRequiredChip (#8223)', () => {
  it('renders the registry headline, the server message as the body, and the command in a code element', () => {
    render(<AuthRequiredChip errorText={SERVER_TEXT} />)
    expect(screen.getByTestId('auth-required-chip-headline').textContent)
      .toBe(getErrorPresentation('AUTH_REQUIRED').headline)
    expect(screen.getByTestId('auth-required-chip-body').textContent).toBe(SERVER_TEXT)
    const command = screen.getByTestId('auth-required-chip-command')
    expect(command.tagName).toBe('CODE')
    expect(command.textContent).toBe('claude auth login')
    expect(AUTH_LOGIN_COMMAND).toBe('claude auth login')
  })

  it('is an assertive alert, with the raw server text in the title tooltip', () => {
    render(<AuthRequiredChip errorText={SERVER_TEXT} />)
    const chip = screen.getByTestId('auth-required-chip')
    expect(chip.getAttribute('role')).toBe('alert')
    expect(chip.getAttribute('title')).toBe(SERVER_TEXT)
  })

  it('has no Retry control — resending cannot help until someone signs in', () => {
    render(<AuthRequiredChip errorText={SERVER_TEXT} />)
    expect(screen.queryByText(/retry/i, { selector: 'button' })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('omits the body slot when the server text is empty rather than rendering an empty line', () => {
    render(<AuthRequiredChip errorText="" />)
    expect(screen.queryByTestId('auth-required-chip-body')).toBeNull()
    expect(screen.getByTestId('auth-required-chip-command')).toBeInTheDocument()
  })

  it('Copy writes the command to the clipboard and then reads "Copied"', async () => {
    render(<AuthRequiredChip errorText={SERVER_TEXT} />)
    const button = screen.getByTestId('auth-required-chip-copy')
    expect(button.textContent).toBe('Copy')
    fireEvent.click(button)
    expect(writeText).toHaveBeenCalledWith('claude auth login')
    await waitFor(() => expect(button.textContent).toBe('Copied'))
  })

  it('does not claim "Copied" when the clipboard write failed', async () => {
    const written = Promise.resolve(false)
    vi.mocked(writeText).mockReturnValue(written)
    render(<AuthRequiredChip errorText={SERVER_TEXT} />)
    const button = screen.getByTestId('auth-required-chip-copy')
    // act() flushes the chip's `.then` continuation (and any state update it
    // makes) before the assertion, so the negative below cannot pass merely
    // because React has not rendered yet.
    await act(async () => {
      fireEvent.click(button)
      await written
    })
    expect(writeText).toHaveBeenCalledWith('claude auth login')
    expect(button.textContent).toBe('Copy')
  })
})
