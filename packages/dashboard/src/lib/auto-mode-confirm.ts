/**
 * auto-mode-confirm — build the confirm-dialog copy for switching the active
 * session's permission mode to "Auto" (bypass-permissions).
 *
 * #5609: switching to Auto mid-turn is destructive ONLY on the CLI provider,
 * where it respawns the `claude -p` subprocess and drops the in-flight turn
 * (the #3729 "panic-button"). SDK and TUI apply the same switch in-place and
 * leave the running turn alone. Before this helper the dashboard showed one
 * generic confirm ("Tools will run without asking for permission.") that never
 * mentioned the kill — a silent footgun where flipping to Auto to stop being
 * prompted would instead destroy the agent's running response, and only on
 * CLI. This centralizes the wording so the copy reflects the ACTUAL
 * per-provider consequence + whether a turn is currently in flight.
 *
 * The panic-button itself is preserved: the user can still confirm and
 * interrupt a wedged CLI turn. This only makes the consequence explicit.
 */

export interface AutoModeConfirmInput {
  /**
   * Whether switching to Auto interrupts the running turn on the active
   * session's provider. True for CLI (subprocess respawn), false/undefined for
   * SDK/TUI (in-place). Sourced from the provider's
   * `capabilities.interruptsTurnOnAutoSwitch`.
   */
  interruptsTurn?: boolean
  /**
   * Whether the active session has in-flight work the switch would destroy.
   * When false, even a CLI switch has no turn to interrupt, so the destructive
   * warning is omitted.
   *
   * #7335: this was named `isStreaming`, and the name was the bug — the call
   * site dutifully fed it `!!streamingMessageId`, which the #554 stream-split
   * clears the moment a permission prompt arrives, so a session PAUSED on a
   * prompt looked idle and got benign copy while the CLI respawn dropped its
   * turn. Callers must source this from `hasInterruptibleWork` (lib/session-busy),
   * never from the streaming flag alone.
   */
  isBusy: boolean
}

const BASE_COPY = 'Switch to Auto mode? Tools will run without asking for permission.'

const DESTRUCTIVE_COPY =
  'Switch to Auto mode?\n\n' +
  'This session is mid-response. On this provider, switching to Auto will ' +
  'INTERRUPT the running turn and restart the session — the in-flight ' +
  'response will be dropped.\n\n' +
  'Tools will then run without asking for permission. Continue?'

/**
 * Returns the confirm-dialog message for the Auto switch. When the active
 * provider interrupts the turn on auto-switch AND a turn is in flight, the
 * message names the consequence (interrupt + restart). Otherwise it returns
 * the standard non-destructive copy.
 */
export function buildAutoModeConfirmMessage(input: AutoModeConfirmInput): string {
  if (input.interruptsTurn && input.isBusy) {
    return DESTRUCTIVE_COPY
  }
  return BASE_COPY
}
