/**
 * PlanApproval — plan review card with approve/feedback buttons.
 *
 * Ports plan_ready handler from dashboard-app.js (lines 1655-1662, 1811-1820).
 * Renders plan content, approve sends "Looks good, proceed."
 */

export interface PlanApprovalProps {
  plan: string
  onApprove: () => void
  onFeedback: () => void
}

export function PlanApproval({ plan, onApprove, onFeedback }: PlanApprovalProps) {
  if (!plan) return null

  return (
    <div className="plan-approval" data-testid="plan-approval">
      <div
        className="plan-content"
        data-testid="plan-content"
        dangerouslySetInnerHTML={{ __html: plan }}
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
