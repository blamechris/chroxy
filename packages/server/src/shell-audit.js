/**
 * shell-audit.js (#5985, epic #5982) — an audit trail for embedded user-shell
 * sessions.
 *
 * A user-shell is a raw `$SHELL` PTY — arbitrary host code execution over the
 * tunnel — so its lifecycle must be traceable: who opened a shell (token class
 * + client), where (cwd), which shell, and how it ended. Entries are emitted as
 * single greppable `[shell-audit]` log lines (filter the server log on that
 * component) at create and destroy.
 *
 * This is the lifecycle audit required by #5985's acceptance criteria
 * ("create/destroy audited, with the token class"). Per-keystroke command-input
 * auditing is deliberately out of scope (volume + privacy); the create/destroy
 * pair with the token class is the traceability anchor.
 *
 * Entries are emitted via the logger's always-on `audit()` path (#6001), so the
 * trail survives a quiet `LOG_LEVEL` (warn/error) — a security record for a
 * host-RCE capability must not vanish just because the operator turned down
 * ordinary logging. Lines are tagged `[AUDIT] [shell-audit]`.
 */
import { createLogger } from './logger.js'

const log = createLogger('shell-audit')

/**
 * Build a stable, greppable `key=value` audit line. Pure (no I/O) so it can be
 * asserted directly in tests. Null / undefined / empty-string fields are
 * dropped; numbers render unquoted, everything else is JSON-quoted so a value
 * containing spaces stays a single token.
 *
 * @param {string} event - e.g. 'user_shell_create' / 'user_shell_destroy'
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
export function formatShellAuditLine(event, fields = {}) {
  const parts = [`event=${event}`]
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue
    const rendered = typeof v === 'number' ? v : JSON.stringify(String(v))
    parts.push(`${k}=${rendered}`)
  }
  return parts.join(' ')
}

/**
 * Audit a user-shell session creation. `tokenClass` records the bearer-token
 * class that authorized the spawn (always 'primary' today — the create gate
 * rejects every other class, #5985b — but recorded explicitly so a future
 * widening of the authz is captured in the trail).
 */
export function auditShellCreate({ sessionId, clientId, tokenClass, cwd, shell, deviceName } = {}) {
  log.audit(formatShellAuditLine('user_shell_create', { sessionId, clientId, tokenClass, cwd, shell, deviceName }))
}

/**
 * Audit a user-shell session teardown. `exitCode` is the shell's natural exit
 * code when it ended on its own before the session was destroyed; null when the
 * session is destroyed while the shell is still live (it's then SIGTERM-killed
 * asynchronously). `reason` is the shell's own exit reason or 'destroyed'.
 */
export function auditShellDestroy({ sessionId, exitCode, reason } = {}) {
  log.audit(formatShellAuditLine('user_shell_destroy', { sessionId, exitCode, reason }))
}
