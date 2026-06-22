/**
 * Shared Control Room survey/exec tunables (epic #5530).
 *
 * `EXEC_TIMEOUT_MS` and `DEFAULT_CONCURRENCY` were copy-defined with identical
 * values across the control-room survey + action modules (simulators / wsl /
 * containers / emulators / integrations / survey / runners / host-prune /
 * skills-inventory). Every copy carried a "Kept consistent with the sibling
 * surveys" comment — i.e. they were hand-synced, which is exactly the drift
 * hazard a single source removes. Centralised here so one edit moves them all.
 *
 * NOT here: `EXEC_MAX_BUFFER`. It legitimately varies per command (8 MB where a
 * probe emits a few JSON lines, 16 MB where a survey can emit a large `git
 * status --porcelain` / device list), so it stays a per-module constant.
 */

/**
 * Bound every control-room probe subprocess so a stuck daemon / wedged service
 * manager / network blip rejects in finite time instead of hanging the survey
 * forever — which would also pin the handler's per-client in-flight guard. Each
 * survey already degrades a rejected probe to a null / "not available" state, so
 * the timeout just guarantees the rejection (#5259).
 */
export const EXEC_TIMEOUT_MS = 20000

/** Default per-target / per-repo concurrency cap for control-room surveys. */
export const DEFAULT_CONCURRENCY = 5
