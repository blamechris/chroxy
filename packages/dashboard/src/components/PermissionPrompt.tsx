/**
 * PermissionPrompt — tool permission request with countdown timer.
 *
 * Ports addPermissionPrompt() from dashboard-app.js (lines 685-753).
 * Countdown, urgent styling at <=30s, expired state, allow/deny buttons.
 *
 * #2833: the resolved decision is read from the dashboard store
 * (`resolvedPermissions[requestId]`) so tab switches that unmount/remount
 * the component preserve the answered state instead of re-rendering as
 * an unanswered prompt.
 *
 * #2834: adds a third "Allow for Session" button for rule-eligible tools
 * (Read, Write, Edit, NotebookEdit, Glob, Grep) that mirrors the mobile
 * app's pattern — sends wire decision 'allow' plus a follow-up
 * set_permission_rules message (handled in sendPermissionResponse).
 *
 * #2852: guards Allow / Deny / Allow for Session and the keyboard shortcuts
 * behind a local `submitting` flag so double-click and key-repeat cannot
 * fire onRespond twice before the store's answered state catches up.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useConnectionStore, isRuleEligibleTool } from '../store/connection'
import type { PermissionDecision } from '../store/types'

export interface PermissionPromptProps {
  requestId: string
  tool: string
  description: string
  remainingMs: number
  onRespond: (requestId: string, decision: PermissionDecision) => void
}

function formatCountdown(ms: number): string {
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`
}

/**
 * #2840: detect Mac vs non-Mac for keyboard hint rendering. Falls back to
 * non-Mac shortcut label when `navigator` is unavailable (SSR / tests).
 */
function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /Mac|iPod|iPhone|iPad/.test(ua)
}

export function PermissionPrompt({ requestId, tool, description, remainingMs, onRespond }: PermissionPromptProps) {
  const [remaining, setRemaining] = useState(remainingMs)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const expiresAtRef = useRef(Date.now() + remainingMs)
  // #2852: guard against double-click / key-repeat races. The store-backed
  // `answered` flag only flips after sendPermissionResponse -> markPermissionResolved
  // completes a React render cycle, so rapid clicks or held-Enter can fire
  // onRespond twice before the store state updates. Synchronous ref flips
  // immediately on the first click and blocks subsequent invocations.
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)

  // Read the answered state from the store (#2833). Falls back to null when
  // no resolution is recorded yet. Selecting by requestId keeps this a
  // primitive subscription — useShallow / stable refs not needed.
  const answered = useConnectionStore((s) => s.resolvedPermissions?.[requestId] ?? null)

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    setRemaining(remainingMs)

    // #2852: if the prompt is already resolved at mount (tab-switch remount
    // of an answered prompt), skip the 1s interval entirely — the countdown
    // won't render and the ticks would just cause wasted re-renders.
    if (remainingMs <= 0 || answered) {
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
  }, [remainingMs, answered])

  const respond = useCallback((decision: PermissionDecision) => {
    // #2852: submittingRef short-circuits duplicate invocations from
    // double-click or keyboard auto-repeat before React re-renders with the
    // store's answered state.
    if (submittingRef.current || answered || remaining <= 0) return
    submittingRef.current = true
    setSubmitting(true)
    // 'allowSession' is only meaningful for rule-eligible tools; for other
    // tools the server would reject the follow-up set_permission_rules.
    // Silently coerce to a plain 'allow' so keyboard shortcut users on an
    // ineligible prompt still get an Allow-equivalent decision.
    const effective: PermissionDecision =
      decision === 'allowSession' && !isRuleEligibleTool(tool) ? 'allow' : decision
    if (intervalRef.current) clearInterval(intervalRef.current)
    onRespond(requestId, effective)
  }, [requestId, onRespond, answered, remaining, tool])

  // Keyboard shortcuts:
  //   Cmd/Ctrl+Y         -> allow
  //   Cmd/Ctrl+Shift+Y   -> allowSession (rule-eligible tools only, #2834)
  //   Escape             -> deny (skipped when a Modal overlay is open, #1230)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip when focus is in an input, textarea, or select
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.key.toLowerCase() === 'y' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (e.shiftKey) {
          // Allow for Session — no-op when the tool is not rule-eligible (#2834).
          if (isRuleEligibleTool(tool)) {
            respond('allowSession')
          }
        } else {
          respond('allow')
        }
      } else if (e.key === 'Escape') {
        // Skip if a modal overlay is open — let Modal handle Escape (#1230)
        if (document.querySelector('[data-modal-overlay]')) return
        respond('deny')
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [respond, tool])

  const isExpired = remaining <= 0
  const isUrgent = remaining > 0 && remaining <= 30000
  const showButtons = !answered && !isExpired
  const showAllowSession = showButtons && isRuleEligibleTool(tool)
  const [dismissed, setDismissed] = useState(false)

  // #2840: keyboard hint labels near the Allow / Allow-for-Session buttons
  // so the Cmd/Ctrl+Y and Cmd/Ctrl+Shift+Y shortcuts are discoverable.
  const isMac = isMacPlatform()
  const allowHint = isMac ? '\u2318Y' : 'Ctrl+Y'
  const allowSessionHint = isMac ? '\u2318\u21E7Y' : 'Ctrl+Shift+Y'

  if (dismissed) return null

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
        <>
          <div className="perm-buttons">
            <button
              className="btn-allow"
              onClick={() => respond('allow')}
              type="button"
              aria-label={`Allow ${tool}`}
              title={`Allow (${allowHint})`}
              disabled={submitting}
            >
              Allow
            </button>
            {showAllowSession && (
              <button
                className="btn-allow-session"
                onClick={() => respond('allowSession')}
                type="button"
                aria-label={`Allow ${tool} for this session`}
                data-testid="btn-allow-session"
                title={`Allow for Session (${allowSessionHint})`}
                disabled={submitting}
              >
                Allow for Session
              </button>
            )}
            <button
              className="btn-deny"
              onClick={() => respond('deny')}
              type="button"
              aria-label={`Deny ${tool}`}
              disabled={submitting}
            >
              Deny
            </button>
          </div>
          <div className="perm-shortcut-hints" data-testid="perm-shortcut-hints" aria-hidden="true">
            <span className="perm-shortcut">
              <kbd className="perm-kbd">{allowHint}</kbd>
              <span className="perm-shortcut-label">allow</span>
            </span>
            {showAllowSession && (
              <span className="perm-shortcut">
                <kbd className="perm-kbd">{allowSessionHint}</kbd>
                <span className="perm-shortcut-label">session</span>
              </span>
            )}
          </div>
        </>
      )}

      {isExpired && !answered && (
        <div className="perm-expired-info" data-testid="perm-expired-info">
          <span className="perm-expired-msg">Permission expired — Claude will continue without this tool</span>
          <button className="btn-dismiss" onClick={() => setDismissed(true)} type="button" aria-label="Dismiss expired permission">
            Dismiss
          </button>
        </div>
      )}

      {answered && (
        <div className="perm-answer" data-testid="perm-answer">
          {answered === 'deny' ? 'Denied' : answered === 'allowSession' ? 'Allowed for session' : 'Allowed'}
        </div>
      )}
    </div>
  )
}
