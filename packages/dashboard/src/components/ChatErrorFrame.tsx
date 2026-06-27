/**
 * ChatErrorFrame — the single inline error-chip shell (chat redesign, Phase 2).
 *
 * StreamStallChip / AskUserQuestionStallChip / ResumeUnknownChip all delegate
 * to this frame so the `stream-stall-chip` DOM + ARIA structure live in ONE
 * place instead of being copy-pasted three times. The per-error wrappers stay
 * thin: they source `role` + the default `headline` from store-core's
 * {@link getErrorPresentation} registry, and keep their own dynamic bits — the
 * stall chip's timeout/provider headline, the resume chip's "Attempted id:"
 * subtext — plus their action buttons.
 *
 * Each wrapper passes its own `testId` (and the resume chip its `variant`), so
 * existing unit + E2E selectors (`stream-stall-chip`, `resume-unknown-chip`,
 * the `*-retry` buttons, `data-variant`) are unchanged — this is a pure DOM
 * extraction, not a visual change.
 */
import type { ReactNode } from 'react'

export interface ChatErrorFrameProps {
  /** data-testid for the frame root — each wrapper keeps its own anchor
   *  (`stream-stall-chip` / `ask-user-question-stall-chip` / `resume-unknown-chip`). */
  testId: string
  /** ARIA live politeness — `status` (polite, recoverable) or `alert`
   *  (assertive, terminal). Sourced from `getErrorPresentation` by the wrapper. */
  role: 'status' | 'alert'
  /** Headline copy. Wrappers pass the registry default or a dynamic override
   *  (e.g. the stall chip's "No response for 5 minutes — retry?"). */
  headline: string
  /** Raw server error text → `title` tooltip, so diagnostics aren't lost. */
  title?: string
  /** Optional `data-variant` attribute (the resume chip's recoverable/exhausted).
   *  Omitted from the DOM when undefined. */
  variant?: string
  /** Optional sub-line under the headline (the resume chip's "Attempted id: …"). */
  subtext?: ReactNode
  /** Action affordances rendered after the headline (Retry / View logs …). */
  children?: ReactNode
}

export function ChatErrorFrame({
  testId,
  role,
  headline,
  title,
  variant,
  subtext,
  children,
}: ChatErrorFrameProps) {
  return (
    <div
      className="stream-stall-chip"
      data-testid={testId}
      data-variant={variant}
      role={role}
      title={title}
    >
      <span className="stream-stall-chip-text">{headline}</span>
      {subtext}
      {children}
    </div>
  )
}
