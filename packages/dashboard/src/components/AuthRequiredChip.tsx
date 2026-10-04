/**
 * AuthRequiredChip — #8223
 *
 * Replaces the generic red error bubble when the server emits
 * `error{code: 'AUTH_REQUIRED'}`: the claude CLI on the host is logged out or
 * its login expired (claude-tui's PTY scan or its `claude auth status` probe,
 * claude-sdk's `authentication_failed`). Retrying cannot help — someone has to
 * sign in on the host — so unlike the stall chips this carries no Retry button;
 * it says what is wrong, what the server told the operator, and the one command
 * that fixes it.
 *
 * The command runs on the HOST, not in this browser, so the Copy button is a
 * convenience for pasting it into a host terminal; the raw server text stays in
 * the title attribute like the sibling chips.
 *
 * Headline + ARIA role come from store-core's `getErrorPresentation` registry
 * (`AUTH_REQUIRED` → role `alert`, the user must act), so the dashboard and the
 * mobile app cannot drift.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getErrorPresentation } from '@chroxy/store-core'
import { writeText } from '../utils/clipboard'

/** The command that fixes it — claude 2.1.x's `auth login` (plain `claude login` is stale). */
export const AUTH_LOGIN_COMMAND = 'claude auth login'

// How long the button reads "Copied" before it goes back to "Copy".
const COPIED_FEEDBACK_MS = 2000

export interface AuthRequiredChipProps {
  /** The server's message — shown as the body and kept verbatim in the title tooltip. */
  errorText: string
}

export function AuthRequiredChip({ errorText }: AuthRequiredChipProps) {
  const presentation = getErrorPresentation('AUTH_REQUIRED')
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const handleCopy = useCallback(() => {
    // writeText resolves true only when the OS clipboard was actually written
    // (#4673), so "Copied" is never shown for a write that no-oped.
    void writeText(AUTH_LOGIN_COMMAND).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    })
  }, [])

  return (
    <div
      className="auth-required-chip"
      data-testid="auth-required-chip"
      role={presentation.role}
      title={errorText}
    >
      <span className="auth-required-chip-headline" data-testid="auth-required-chip-headline">
        {presentation.headline}
      </span>
      {errorText && (
        <span className="auth-required-chip-body" data-testid="auth-required-chip-body">
          {errorText}
        </span>
      )}
      <span className="auth-required-chip-command-row">
        <code className="auth-required-chip-command" data-testid="auth-required-chip-command">
          {AUTH_LOGIN_COMMAND}
        </code>
        <button
          type="button"
          className="auth-required-chip-copy"
          data-testid="auth-required-chip-copy"
          onClick={handleCopy}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
    </div>
  )
}
