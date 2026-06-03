/**
 * ResumeUnknownChip — #4947
 *
 * Replaces the generic red error bubble when the server emits
 * `error{code: 'resume_unknown'}` (server PR #4944). The server fires this
 * code when claude CLI rejects a `--resume <id>` because the conversation
 * id is unknown locally (operator wiped `~/.claude/projects/` between
 * chroxy boots, restored a state file from a different machine, etc.).
 *
 * The CliSession has already auto-fallen-back to a fresh conversation by
 * the time this chip surfaces — the model loses the prior transcript but
 * the chroxy ring buffer transcript is preserved in the UI. So we render a
 * calm operator-friendly explanation rather than the loud red crash toast,
 * matching the spirit of StreamStallChip (#4476) and AskUserQuestionStallChip
 * (#4615): "this is recoverable, here's what happened, here's what to
 * expect next".
 *
 * `attemptedResumeId` (when provided) renders as small mono-spaced subtext
 * for operator correlation against the persisted state file
 * (`resumeConversationId` in ~/.chroxy/session-state.json) — answers "which
 * conversation did we lose?" without forcing the operator to grep logs.
 *
 * Reuses the `stream-stall-chip` CSS classes — the amber-warning palette
 * already conveys "recoverable" and the three stall chips share a single
 * visual language so the user learns the affordance once. Distinct
 * `data-testid` makes the chip targetable from integration / E2E tests.
 */
import type { CSSProperties } from 'react'

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

export function ResumeUnknownChip({ errorText, attemptedResumeId }: ResumeUnknownChipProps) {
  // Treat empty / whitespace-only strings as missing so a stale or
  // defensive empty value can't degrade the headline into a broken-looking
  // "Attempted id: " slot.
  const hasId = typeof attemptedResumeId === 'string' && attemptedResumeId.trim().length > 0

  return (
    <div
      className="stream-stall-chip"
      data-testid="resume-unknown-chip"
      role="status"
      title={errorText}
    >
      <span className="stream-stall-chip-text">
        Previous conversation could not be resumed — starting fresh
      </span>
      {hasId && (
        <span
          data-testid="resume-unknown-chip-id"
          style={ID_SUBTEXT_STYLE}
        >
          Attempted id: {attemptedResumeId}
        </span>
      )}
    </div>
  )
}
