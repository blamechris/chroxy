/**
 * The production wiring of the agent-principal brakes (agent-principals.md section 10):
 * the persistent kill switch and the "principal access requires file-backed audit
 * logging" gate, handed to the principal store so that `store.state()` (the one choke
 * point every credential check goes through) refuses while either brake is on.
 *
 * Kept apart from principal-store.js so that module does not import the kill switch,
 * which imports the store's label pattern. The daemon attaches them with
 * `store.attachBrakes(createPrincipalBrakes())` right after `createPrincipalStore()`.
 */
import { PrincipalKillSwitch } from './principal-kill-switch.js'
import { getAuditLogPath } from './logger.js'

/**
 * @param {object} [opts]
 * @param {PrincipalKillSwitch} [opts.killSwitch]
 * @param {() => boolean} [opts.auditAvailable]  defaults to "the audit log file is writable-configured"
 */
export function createPrincipalBrakes({ killSwitch = new PrincipalKillSwitch(), auditAvailable = () => getAuditLogPath() !== null } = {}) {
  return { killSwitch, auditAvailable }
}
