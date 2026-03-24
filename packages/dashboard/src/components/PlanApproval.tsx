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
}

export function PlanApproval({ planHtml, onApprove, onFeedback }: PlanApprovalProps) {
  if (!planHtml) return null

  return (
    <div className="plan-approval" data-testid="plan-approval">
      <div
        className="plan-content"
        data-testid="plan-content"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(planHtml) }}
      />
      <div className="plan-buttons">
        <button className="btn-plan-approve" onClick={onApprove} type="button">
          Approve
        </button>
        <button className="btn-plan-feedback" onClick={onFeedback} type="button">
          Feedback
        </button>
      </div>
    </div>
  )
}
