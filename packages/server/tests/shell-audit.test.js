import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatShellAuditLine } from '../src/shell-audit.js'

/**
 * #5985 (epic #5982) — shell-audit line formatting. The create/destroy audit
 * helpers (auditShellCreate / auditShellDestroy) emit a single greppable line
 * via the 'shell-audit' logger; formatShellAuditLine is the pure formatter they
 * share, asserted directly here. The create/destroy WIRING (handler +
 * SessionManager) is covered by their own suites.
 */
describe('shell-audit — formatShellAuditLine (#5985)', () => {
  it('prefixes the event and renders provided fields as key=value', () => {
    const line = formatShellAuditLine('user_shell_create', {
      sessionId: 'sess-1',
      clientId: 'client-ab12',
      tokenClass: 'primary',
      cwd: '/home/me/project',
      shell: '/bin/zsh',
    })
    assert.match(line, /^event=user_shell_create /)
    assert.match(line, /sessionId="sess-1"/)
    assert.match(line, /clientId="client-ab12"/)
    assert.match(line, /tokenClass="primary"/)
    assert.match(line, /cwd="\/home\/me\/project"/)
    assert.match(line, /shell="\/bin\/zsh"/)
  })

  it('drops null / undefined / empty-string fields (no dangling keys)', () => {
    const line = formatShellAuditLine('user_shell_destroy', {
      sessionId: 'sess-2',
      exitCode: null,
      reason: 'destroyed',
      shell: '',
      deviceName: undefined,
    })
    assert.equal(line, 'event=user_shell_destroy sessionId="sess-2" reason="destroyed"')
    // Match field KEYS (`exitCode=`), not bare substrings — "user_shell_destroy"
    // itself contains "shell".
    assert.doesNotMatch(line, /exitCode=/)
    assert.doesNotMatch(line, /shell=/)
    assert.doesNotMatch(line, /deviceName=/)
  })

  it('keeps a zero exit code and renders numbers unquoted', () => {
    const line = formatShellAuditLine('user_shell_destroy', { sessionId: 'sess-3', exitCode: 0, reason: 'exit' })
    assert.match(line, /exitCode=0(\s|$)/)
    assert.doesNotMatch(line, /exitCode="0"/)
  })

  it('quotes values with spaces so each field stays one token', () => {
    const line = formatShellAuditLine('user_shell_create', { cwd: '/tmp/with space', deviceName: 'My Phone' })
    assert.match(line, /cwd="\/tmp\/with space"/)
    assert.match(line, /deviceName="My Phone"/)
  })
})
