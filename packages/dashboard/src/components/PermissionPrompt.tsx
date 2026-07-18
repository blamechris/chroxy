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
import { useConnectionStore, isRuleEligibleTool, isRuleEligibleProvider } from '../store/connection'
import type { PermissionDecision } from '../store/types'
import { isMacPlatform } from '../utils/platform'
import { PreWriteDiffReview, isReviewableTool } from './PreWriteDiffReview'

export interface PermissionPromptProps {
  requestId: string
  tool: string
  description: string
  remainingMs: number
  /**
   * #6543 (feature B): `editedInput` carries the operator's per-hunk narrowing
   * for an approve (omitted for a plain Allow / a Deny). The server whitelists
   * which fields it merges.
   */
  onRespond: (requestId: string, decision: PermissionDecision, editedInput?: Record<string, string> | null) => void
  /**
   * #5667 — human label for the session that asked (e.g. "ltl · CLI"),
   * derived by the renderer from the message's `originSessionId`. Rendered as
   * a badge so an operator running multiple agents can tell which one is
   * requesting before approving. Omitted when only one session exists (no
   * ambiguity to disambiguate).
   */
  sessionLabel?: string
}

function formatCountdown(ms: number): string {
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`
}

export function PermissionPrompt({ requestId, tool, description, remainingMs, onRespond, sessionLabel }: PermissionPromptProps) {
  const [remaining, setRemaining] = useState(remainingMs)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // #3619: anchor on monotonic `performance.now()` so an NTP sync /
  // manual wall-clock change doesn't make the countdown snap or drift.
  // `remainingMs` is a delta computed by the parent against a local
  // wall-clock receipt-time anchor (the dashboard store sets
  // `expiresAt = Date.now() + msg.remainingMs` in message-handler.ts on
  // `permission_request` arrival — see #3619 for the receipt-time
  // boundary). Only the in-component countdown needs the monotonic
  // clock; the receipt-time anchor stays on `Date.now()`.
  const expiresAtRef = useRef(performance.now() + remainingMs)
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

  // #5699 — only allow answering while connected. The store's
  // sendPermissionResponse refuses to send (or optimistically resolve) a
  // permission answer when the socket is down, because the server expires the
  // request on disconnect and a queued answer is silently lost. Disable the
  // buttons so the operator gets visible feedback instead of a dead click.
  const connected = useConnectionStore((s) => s.connectionPhase === 'connected')

  // #3072: gate the "Allow for Session" affordance on whether the active
  // session's provider supports session-scoped permission rules. Without
  // this, the button shows for every prompt and clicking on a non-supporting
  // provider (codex, gemini, claude-cli) hits a server "not supported" error.
  const activeProvider = useConnectionStore((s) => {
    const id = s.activeSessionId
    if (!id) return null
    const session = s.sessions.find((sess) => sess.sessionId === id)
    return session?.provider ?? null
  })
  const availableProviders = useConnectionStore((s) => s.availableProviders)
  const providerSupportsRules = isRuleEligibleProvider(activeProvider, availableProviders)

  // #6543 (feature B): per-hunk pre-write review. Gated on the server's `ide`
  // capability (features.ide) + a reviewable tool (Write/Edit). When eligible we
  // PULL the full redacted tool input (the broadcast one is truncated), then
  // render a diff whose dropped hunks become `editedInput` on Approve.
  const ideEnabled = useConnectionStore((s) => Boolean(s.serverCapabilities?.ide))
  const requestPermissionInput = useConnectionStore((s) => s.requestPermissionInput)
  const pulledInput = useConnectionStore((s) => s.permissionInputs?.[requestId])
  const reviewEligible = ideEnabled && isReviewableTool(tool)
  const [editedInput, setEditedInput] = useState<Record<string, string> | null>(null)

  // Pull the input once when a reviewable prompt appears (before it's answered).
  useEffect(() => {
    if (reviewEligible && !answered && pulledInput === undefined) {
      requestPermissionInput(requestId)
    }
  }, [reviewEligible, answered, pulledInput, requestPermissionInput, requestId])

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    setRemaining(remainingMs)

    // #2852: if the prompt is already resolved at mount (tab-switch remount
    // of an answered prompt), skip the 1s interval entirely — the countdown
    // won't render and the ticks would just cause wasted re-renders.
    if (remainingMs <= 0 || answered) {
      return
    }
    expiresAtRef.current = performance.now() + remainingMs

    intervalRef.current = setInterval(() => {
      const left = Math.max(0, expiresAtRef.current - performance.now())
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
    // #5699: also bail when disconnected — this is the single choke point for
    // BOTH the buttons and the keyboard shortcuts (Cmd+Y / Cmd+Shift+Y / Escape).
    // sendPermissionResponse refuses to send/resolve while the socket is down, so
    // if we latched `submitting` here the prompt would wedge permanently
    // (`submitting` only resets when `answered` flips, which never happens). Bail
    // before the latch so the prompt stays actionable once reconnected.
    if (submittingRef.current || answered || remaining <= 0 || !connected) return
    submittingRef.current = true
    setSubmitting(true)
    // 'allowSession' / 'allowAlways' (#6771) are only meaningful when both the
    // tool is rule-eligible (#2834) AND the active provider supports session
    // rules (#3072). Either gate failing means the server would reject the rule;
    // silently coerce to a plain 'allow' so keyboard shortcut users on an
    // ineligible prompt still get an Allow-equivalent decision.
    const ruleOk = isRuleEligibleTool(tool) && providerSupportsRules
    const effective: PermissionDecision =
      (decision === 'allowSession' || decision === 'allowAlways') && !ruleOk ? 'allow' : decision
    if (intervalRef.current) clearInterval(intervalRef.current)
    // #6543: carry the per-hunk edits on an approve only (never on deny).
    onRespond(requestId, effective, effective === 'deny' ? null : editedInput)
  }, [requestId, onRespond, answered, remaining, tool, providerSupportsRules, connected, editedInput])

  // #6287 — the Cmd/Ctrl+Y, Cmd/Ctrl+Shift+Y and Escape keyboard shortcuts moved
  // to a SINGLE document-level listener (useChatKeyboard, wired in App.tsx) that
  // targets only the FIRST unanswered prompt in the active session. Each
  // PermissionPrompt previously registered its own keydown listener, so with
  // multiple live prompts (parallel SDK tool calls) one keystroke answered EVERY
  // mounted prompt at once — a security hazard. The buttons below still call
  // `respond` directly.

  const isExpired = remaining <= 0
  const isUrgent = remaining > 0 && remaining <= 30000
  const showButtons = !answered && !isExpired
  const showAllowSession = showButtons && isRuleEligibleTool(tool) && providerSupportsRules
  // #6771 — "Always allow (this project)" shares the same eligibility gate as
  // "Allow for Session" (rule-eligible tool + provider that supports rules).
  const showAllowAlways = showAllowSession
  const [dismissed, setDismissed] = useState(false)

  // #2840: keyboard hint labels near the Allow / Allow-for-Session buttons
  // so the Cmd/Ctrl+Y and Cmd/Ctrl+Shift+Y shortcuts are discoverable.
  const isMac = isMacPlatform()
  const allowHint = isMac ? '\u2318Y' : 'Ctrl+Y'
  const allowSessionHint = isMac ? '\u2318\u21E7Y' : 'Ctrl+Shift+Y'

  if (dismissed) return null

  return (
    // #5731 (a11y): a permission request is a time-critical decision that
    // auto-DENIES on timeout, but the bare div announced nothing to a
    // screen-reader user reading the dashboard. Mark it as an assertive
    // alertdialog with an accessible name + description so it's spoken the moment
    // it appears (the OS-notification fallback only fires when the window is
    // unfocused, leaving the in-focus SR case uncovered).
    <div
      className={`permission-prompt${answered ? ' answered' : ''}`}
      data-testid="permission-prompt"
      role="alertdialog"
      aria-live="assertive"
      aria-label={`Permission request${sessionLabel ? ` from ${sessionLabel}` : ''}`}
      aria-describedby={`perm-desc-${requestId}`}
    >
      {sessionLabel && (
        <div className="perm-session" data-testid="perm-session" title={`Requested by ${sessionLabel}`}>
          {sessionLabel}
        </div>
      )}
      <div className="perm-desc" id={`perm-desc-${requestId}`}>
        <span className="perm-tool">{tool}</span>: {description || 'Permission requested'}
      </div>

      {/* #6543 (feature B): per-hunk pre-write review for a Write/Edit when
          features.ide is on. Renders once the pulled input lands; dropped hunks
          become `editedInput` sent on Approve. A refusal / not-yet-pulled state
          simply shows no review (the plain Allow/Deny still work). */}
      {reviewEligible && showButtons && pulledInput?.found && pulledInput.input && (
        <PreWriteDiffReview
          tool={tool}
          input={pulledInput.input as Record<string, unknown>}
          onEditedInputChange={setEditedInput}
        />
      )}

      {!answered && (
        <div
          className={`perm-countdown${isUrgent ? ' urgent' : ''}${isExpired ? ' expired' : ''}`}
          data-testid="perm-countdown"
          // #5731 (a11y): the countdown ticks every second INSIDE the assertive
          // alertdialog container. Without muting it, the live region would
          // re-announce the changing time every second (worse than silence — the
          // #4873 reconnect-storm spam class). aria-live="off" excludes the tick
          // from announcements while the container still announces the request
          // ONCE on appearance. The visual urgent/expired styling is unaffected.
          aria-live="off"
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
              disabled={submitting || !connected}
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
                disabled={submitting || !connected}
              >
                Allow for Session
              </button>
            )}
            {showAllowAlways && (
              <button
                className="btn-allow-always"
                onClick={() => respond('allowAlways')}
                type="button"
                aria-label={`Always allow ${tool} for this project`}
                data-testid="btn-allow-always"
                title="Always allow this tool for this project (persists across restarts)"
                disabled={submitting || !connected}
              >
                Always allow
              </button>
            )}
            <button
              className="btn-deny"
              onClick={() => respond('deny')}
              type="button"
              aria-label={`Deny ${tool}`}
              disabled={submitting || !connected}
            >
              Deny
            </button>
          </div>
          {!connected && (
            // #5699 — explain why the buttons are disabled so a disconnected tap
            // isn't a silent no-op. The prompt stays actionable once reconnected.
            <div className="perm-disconnected-hint" data-testid="perm-disconnected-hint" role="status">
              Disconnected — reconnect to answer.
            </div>
          )}
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
          {answered === 'deny'
            ? 'Denied'
            : answered === 'allowSession'
              ? 'Allowed for session'
              : answered === 'allowAlways'
                ? 'Always allowed (project)'
                : 'Allowed'}
        </div>
      )}
    </div>
  )
}
