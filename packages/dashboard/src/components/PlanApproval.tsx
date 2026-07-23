/**
 * PlanApproval — plan review card with approve/feedback buttons.
 *
 * Ports plan_ready handler from dashboard-app.js (lines 1655-1662, 1811-1820).
 * Renders plan content and wires Approve/Feedback buttons to the provided callbacks.
 */
import DOMPurify from 'dompurify'

export interface PlanApprovalProps {
  /** Plan HTML content (sanitized before rendering). */
  planHtml: string
  onApprove: () => void
  onFeedback: () => void
  /**
   * #6774 — combined "approve + auto-accept edits" action: approves the plan
   * AND switches the session into `acceptEdits` in one step. Only wired (and
   * only rendered, gated by {@link showAcceptEdits}) where the active
   * provider supports permission-mode switching.
   */
  onApproveAcceptEdits?: () => void
  /**
   * Whether to render the combined "Approve & auto-accept edits" button.
   * Mirrors the mode-picker gating (`caps?.permissionModeSwitch !== false`);
   * providers that can't switch mode (e.g. claude-tui) don't get the button.
   */
  showAcceptEdits?: boolean
}

export function PlanApproval({
  planHtml,
  onApprove,
  onFeedback,
  onApproveAcceptEdits,
  showAcceptEdits,
}: PlanApprovalProps) {
  if (!planHtml) return null

  return (
    // #5731 (a11y): a plan appearing is a blocking decision point; the bare div
    // announced nothing to a screen-reader user. Mark it as a labelled live
    // region so its arrival is spoken (polite — a plan isn't as time-critical as
    // the auto-denying permission prompt, which is assertive).
    <div
      className="plan-approval"
      data-testid="plan-approval"
      role="region"
      aria-label="Plan ready for approval"
      aria-live="polite"
    >
      <div
        className="plan-content"
        data-testid="plan-content"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(planHtml) }}
      />
      <div className="plan-buttons">
        <button className="btn-plan-approve" onClick={onApprove} type="button">
          Approve
        </button>
        {showAcceptEdits && onApproveAcceptEdits && (
          <button
            className="btn-plan-approve-accept-edits"
            data-testid="btn-plan-approve-accept-edits"
            onClick={onApproveAcceptEdits}
            type="button"
            title="Approve this plan and auto-accept file edits for the work that follows"
          >
            Approve &amp; auto-accept edits
          </button>
        )}
        <button className="btn-plan-feedback" onClick={onFeedback} type="button">
          Feedback
        </button>
      </div>
    </div>
  )
}
