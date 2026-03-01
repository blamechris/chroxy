/**
 * PermissionPrompt — tool permission request with countdown timer.
 *
 * Ports addPermissionPrompt() from dashboard-app.js (lines 685-753).
 * Countdown, urgent styling at <=30s, expired state, allow/deny buttons.
 */
import { useState, useEffect, useRef, useCallback } from 'react'

export interface PermissionPromptProps {
  requestId: string
  tool: string
  description: string
  remainingMs: number
  onRespond: (requestId: string, decision: 'allow' | 'deny') => void
}

function formatCountdown(ms: number): string {
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`
}

export function PermissionPrompt({ requestId, tool, description, remainingMs, onRespond }: PermissionPromptProps) {
  const [remaining, setRemaining] = useState(remainingMs)
  const [answered, setAnswered] = useState<'allow' | 'deny' | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const expiresAtRef = useRef(Date.now() + remainingMs)

  useEffect(() => {
    setRemaining(remainingMs)
    if (remainingMs <= 0) {
      return
    }
    expiresAtRef.current = Date.now() + remainingMs

    intervalRef.current = setInterval(() => {
      const left = Math.max(0, expiresAtRef.current - Date.now())
      setRemaining(left)
      if (left <= 0 && intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }, 1000)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [remainingMs])

  const respond = useCallback((decision: 'allow' | 'deny') => {
    if (remaining <= 0) return
    if (intervalRef.current) clearInterval(intervalRef.current)
    setAnswered(decision)
    onRespond(requestId, decision)
  }, [requestId, onRespond, remaining])

  const isExpired = remaining <= 0
  const isUrgent = remaining > 0 && remaining <= 30000
  const showButtons = !answered && !isExpired

  return (
    <div className={`permission-prompt${answered ? ' answered' : ''}`} data-testid="permission-prompt">
      <div className="perm-desc">
        <span className="perm-tool">{tool}</span>: {description || 'Permission requested'}
      </div>

      {!answered && (
        <div
          className={`perm-countdown${isUrgent ? ' urgent' : ''}${isExpired ? ' expired' : ''}`}
          data-testid="perm-countdown"
        >
          {isExpired ? 'Timed out' : formatCountdown(remaining)}
        </div>
      )}

      {showButtons && (
        <div className="perm-buttons">
          <button className="btn-allow" onClick={() => respond('allow')} type="button">
            Allow
          </button>
          <button className="btn-deny" onClick={() => respond('deny')} type="button">
            Deny
          </button>
        </div>
      )}

      {answered && (
        <div className="perm-answer">
          {answered === 'allow' ? 'Allowed' : 'Denied'}
        </div>
      )}
    </div>
  )
}
