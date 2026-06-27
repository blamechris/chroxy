/**
 * ResumeUnknownChip — #4947 / #5006
 *
 * Replaces the generic red error bubble when the server emits one of the
 * two resume-failure codes from CliSession's `_handleChildClose` path:
 *
 *   - `error{code: 'resume_unknown'}` (server PR #4944) — RECOVERABLE.
 *     CliSession has already auto-fallen-back to a fresh conversation by
 *     the time the chip surfaces. The model loses the prior transcript
 *     but the chroxy ring buffer transcript is preserved in the UI. We
 *     render a calm operator-friendly explanation rather than the loud
 *     red crash toast, matching the spirit of StreamStallChip (#4476)
 *     and AskUserQuestionStallChip (#4615): "this is recoverable, here's
 *     what happened, here's what to expect next".
 *
 *   - `error{code: 'resume_unknown_exhausted'}` (server PR #5004) —
 *     TERMINAL. The post-fallback retry ALSO matched the unknown-resume
 *     pattern; the server has stopped auto-respawning and the user must
 *     start a fresh session manually. The chip switches headline copy
 *     and uses an assertive live-region (`role="alert"`) so AT users get
 *     an unambiguous "auto-recovery gave up, action needed" signal —
 *     distinct from the recoverable variant's polite status announce.
 *
 * `attemptedResumeId` (when provided) renders as small mono-spaced subtext
 * for operator correlation against the persisted state file
 * (`resumeConversationId` in ~/.chroxy/session-state.json) — answers "which
 * conversation did we lose?" without forcing the operator to grep logs.
 * Surfaces on both variants because the correlation use case is identical.
 *
 * Reuses the `stream-stall-chip` CSS classes — the amber-warning palette
 * already conveys "recoverable" and the three stall chips share a single
 * visual language so the user learns the affordance once. Distinct
 * `data-testid` makes the chip targetable from integration / E2E tests.
 */
import type { CSSProperties } from 'react'
import { getErrorPresentation } from '@chroxy/store-core'
import { ChatErrorFrame } from './ChatErrorFrame'

export interface ResumeUnknownChipProps {
  /**
   * The raw error text from the server (e.g. "Previous Claude conversation
   * could not be resumed (the id is unknown to the local claude CLI — ...)").
   * Preserved verbatim in the title attribute for operator triage.
   */
  errorText: string
  /**
   * #4947 — the conversation id chroxy passed to `claude --resume <id>`
   * before the CLI rejected it. Surfaced as small mono-spaced subtext so
   * operators investigating a recurring resume failure can correlate against
   * the persisted state file (`resumeConversationId` in
   * `~/.chroxy/session-state.json`) without grepping server logs.
   *
   * Empty string and undefined are treated identically — the subtext slot
   * is omitted entirely rather than rendered with no value, which would
   * look like a UI bug.
   */
  attemptedResumeId?: string
  /**
   * #5006 — variant switch matched against the server error code:
   *   - `'recoverable'` (default) — `code: 'resume_unknown'`, chroxy has
   *     already auto-fallen-back; chip renders polite status with the
   *     "starting fresh" headline.
   *   - `'exhausted'` — `code: 'resume_unknown_exhausted'`, auto-recovery
   *     has given up; chip renders an assertive alert with the
   *     "auto-recovery exhausted" headline and a "start a fresh session
   *     manually" call-to-action.
   * Optional + defaulted so existing call sites that pre-date #5006
   * continue to render the recoverable copy unchanged.
   */
  variant?: 'recoverable' | 'exhausted'
}

// #4947 — small mono-spaced subtext for the attempted id slot. Inline to
// avoid touching the theme CSS (the chip reuses `stream-stall-chip` for
// its primary palette and we don't want to bloat components.css with a
// near-duplicate selector). The font-family fallback matches the rest of
// the app's mono usage (see InputBar / ToolBubble code blocks).
const ID_SUBTEXT_STYLE: CSSProperties = {
  display: 'block',
  marginTop: 4,
  fontSize: '0.8em',
  fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
  opacity: 0.75,
}

export function ResumeUnknownChip({
  errorText,
  attemptedResumeId,
  variant = 'recoverable',
}: ResumeUnknownChipProps) {
  // Treat empty / whitespace-only strings as missing so a stale or
  // defensive empty value can't degrade the headline into a broken-looking
  // "Attempted id: " slot.
  const hasId = typeof attemptedResumeId === 'string' && attemptedResumeId.trim().length > 0

  // #5006 / #6392: the variant maps to a resume error code, and the shared
  // error-presentation registry supplies the headline + a11y role for it —
  // recoverable → polite `status` (chroxy already recovered), exhausted →
  // assertive `alert` (the user must act). Same `stream-stall-chip` palette via
  // ChatErrorFrame; the AT role + copy carry the urgency difference.
  const isExhausted = variant === 'exhausted'
  const presentation = getErrorPresentation(
    isExhausted ? 'resume_unknown_exhausted' : 'resume_unknown',
  )

  return (
    <ChatErrorFrame
      testId="resume-unknown-chip"
      variant={variant}
      role={presentation.role}
      title={errorText}
      headline={presentation.headline}
      subtext={
        hasId && (
          <span data-testid="resume-unknown-chip-id" style={ID_SUBTEXT_STYLE}>
            Attempted id: {attemptedResumeId}
          </span>
        )
      }
    />
  )
}
