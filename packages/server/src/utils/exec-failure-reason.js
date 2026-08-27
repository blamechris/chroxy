/**
 * Build a human-legible degradation reason from a rejected `execFile` promise.
 *
 * Every CLI-backed survey in the daemon degrades a failed probe to a `reason`
 * string rather than throwing (absence is signal, never an error), and they all
 * want the same thing out of the rejection: the CLI's own first line of stderr
 * when it produced one, else the Error's message. This was defined privately in
 * `control-room/integrations.js` and is now shared, so the session PR/CI survey
 * (#7344) does not become a second copy that drifts from it.
 *
 * @param {unknown} err - the rejection from a promisified `execFile`.
 * @param {string} [label] - the command being described, e.g. 'gh pr list'.
 * @returns {string} `<label> failed: <first stderr line | error message>`
 */
export function execFailureReason(err, label = 'command') {
  const stderr = err && typeof err === 'object' && typeof err.stderr === 'string' ? err.stderr : ''
  const firstLine = stderr.split('\n').map(l => l.trim()).find(l => l.length > 0)
  if (firstLine) return `${label} failed: ${firstLine}`
  const message = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : 'unknown error'
  return `${label} failed: ${message}`
}
