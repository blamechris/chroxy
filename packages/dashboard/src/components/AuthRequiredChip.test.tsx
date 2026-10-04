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
import { getErrorPresentation, CLAUDE_LOGIN_COMMAND } from '@chroxy/store-core'

vi.mock('../utils/clipboard', () => ({ writeText: vi.fn() }))

import { writeText } from '../utils/clipboard'
import { AuthRequiredChip } from './AuthRequiredChip'

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
    expect(command.textContent).toBe(CLAUDE_LOGIN_COMMAND)
    expect(command.textContent).toBe('claude auth login')
  })

  it('the alert is the headline and the message ONLY; the raw server text is the chip\'s title tooltip', () => {
    render(<AuthRequiredChip errorText={SERVER_TEXT} />)
    const chip = screen.getByTestId('auth-required-chip')
    const alert = screen.getByTestId('auth-required-chip-alert')
    expect(chip.getAttribute('role')).toBeNull()
    expect(alert.getAttribute('role')).toBe(getErrorPresentation('AUTH_REQUIRED').role)
    expect(alert.getAttribute('role')).toBe('alert')
    expect(chip.getAttribute('title')).toBe(SERVER_TEXT)
    expect(alert).toContainElement(screen.getByTestId('auth-required-chip-headline'))
    expect(alert).toContainElement(screen.getByTestId('auth-required-chip-body'))
    // Copy and its confirmation are OUTSIDE the alert (an alert is atomic).
    expect(alert).not.toContainElement(screen.getByTestId('auth-required-chip-copy'))
    expect(alert).not.toContainElement(screen.getByTestId('auth-required-chip-copied'))
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

  it('Copy writes the command, and "Copied" is announced by a separate polite status region, not by the alert', async () => {
    render(<AuthRequiredChip errorText={SERVER_TEXT} />)
    const button = screen.getByTestId('auth-required-chip-copy')
    const status = screen.getByTestId('auth-required-chip-copied')
    const alert = screen.getByTestId('auth-required-chip-alert')
    const alertTextBefore = alert.textContent
    expect(status.getAttribute('role')).toBe('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('')
    expect(button.textContent).toBe('Copy')
    expect(button.getAttribute('aria-label')).toBe(`Copy ${CLAUDE_LOGIN_COMMAND}`)

    fireEvent.click(button)
    expect(writeText).toHaveBeenCalledWith(CLAUDE_LOGIN_COMMAND)
    await waitFor(() => expect(status.textContent).toBe('Copied'))
    // Nothing inside the assertive alert changed, so it is not re-announced; the button
    // label is stable too.
    expect(alert.textContent).toBe(alertTextBefore)
    expect(button.textContent).toBe('Copy')
    expect(button.getAttribute('aria-label')).toBe(`Copy ${CLAUDE_LOGIN_COMMAND}`)
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
    expect(screen.getByTestId('auth-required-chip-copied').textContent).toBe('')
  })
})
