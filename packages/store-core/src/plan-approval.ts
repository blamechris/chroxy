/**
 * #6774 — shared "approve plan + auto-accept edits" combined action.
 *
 * The plan-approval card in both clients (dashboard `PlanApproval.tsx`,
 * mobile `PlanApprovalCard` in `ChatView.tsx`) offers a second affirmative
 * action alongside the plain "Approve": approve the plan AND switch the
 * session into `acceptEdits` permission mode in one step, so the
 * implementation turn that follows runs with edits auto-accepted (desktop-app
 * ExitPlanMode parity).
 *
 * The load-bearing detail is the ORDERING, which is why it lives here (single
 * source of truth) rather than being open-coded twice: the mode switch MUST be
 * dispatched BEFORE the approval. The server silently rejects a mid-turn
 * permission-mode change (`packages/server/src/handlers/settings-handlers.js`
 * — `set_permission_mode` no-ops with `PERMISSION_MODE_NOT_APPLIED` when the
 * session is busy). Sending `approve` first starts the implementation turn, so
 * a mode switch that arrived after it would land mid-turn and be dropped —
 * leaving the user in `plan`/`approve` mode while believing edits are being
 * auto-accepted. Switching first (while the session is idle, awaiting plan
 * approval) guarantees `acceptEdits` is in effect before the turn begins.
 *
 * Gating (only offer the combined action for providers that support
 * permission-mode switching) stays at each call site, mirroring the existing
 * mode-picker gating (`caps?.permissionModeSwitch !== false`).
 */

/** The permission mode the combined plan-approval action switches into. */
export const ACCEPT_EDITS_MODE = 'acceptEdits';

export interface ApprovePlanWithAcceptEditsDeps {
  /**
   * Switch the active session's permission mode. Invoked with
   * {@link ACCEPT_EDITS_MODE}. This is each client's existing
   * `setPermissionMode` store action.
   */
  setPermissionMode: (mode: string) => void;
  /**
   * Register the plan approval — each client's existing plain-"Approve"
   * handler (the dashboard `sendInput('approve')` path, the mobile
   * `addUserMessage` + `sendInput` + `clearPlanState` path). Reusing it here
   * keeps the plain and combined actions from drifting.
   */
  approve: () => void;
}

/**
 * Run the combined "approve + auto-accept edits" action.
 *
 * Switches the session into {@link ACCEPT_EDITS_MODE} FIRST, then registers the
 * approval — see the module comment for why the order is not interchangeable.
 * Both dependencies are supplied by the caller so this stays a pure,
 * client-agnostic orchestration of two side effects that is trivially testable.
 */
export function approvePlanWithAcceptEdits(deps: ApprovePlanWithAcceptEditsDeps): void {
  deps.setPermissionMode(ACCEPT_EDITS_MODE);
  deps.approve();
}
