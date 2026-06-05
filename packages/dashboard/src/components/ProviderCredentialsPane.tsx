/**
 * Provider Credentials pane (#3855).
 *
 * Settings section that lets the user view, set, rotate, test, and remove
 * provider API keys / OAuth tokens from the dashboard — without dropping to a
 * terminal to export env vars. Surfaces OAuth status read-only.
 *
 * The raw key is never stored in the dashboard store — it lives only in this
 * component's local input state until Save sends it, and the server replies
 * with the masked status only.
 */
import { useCallback, useEffect, useState } from 'react'
import { useConnectionStore } from '../store/connection'
import type { ProviderCredentialEntry } from '../store/types'

const WS_CLOSED_MESSAGE =
  'Not connected to the server — your change was not saved. Reconnect and try again.'

function statusLabel(entry: ProviderCredentialEntry): string {
  if (entry.status === 'set') {
    if (entry.source === 'env') return 'Set (environment)'
    if (entry.source === 'store') return 'Set (stored)'
    return 'Set'
  }
  if (entry.source === 'oauth') return 'OAuth (subscription)'
  return 'Missing'
}

function CredentialRow({ entry }: { entry: ProviderCredentialEntry }) {
  const setCredential = useConnectionStore((s) => s.setCredential)
  const deleteCredential = useConnectionStore((s) => s.deleteCredential)
  const testCredential = useConnectionStore((s) => s.testCredential)
  const testResult = useConnectionStore((s) => s.credentialTestResults[entry.key])

  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [wsClosed, setWsClosed] = useState<string | null>(null)

  // `source === 'env'` means a shell export currently wins — the stored value
  // is shadowed and editing it here would have no effect until the env var is
  // unset. Keep the row read-only with a hint (matches the BYOK env behaviour).
  const envWins = entry.source === 'env'

  const handleSave = useCallback(() => {
    setError(null)
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      setError('Enter a value.')
      return
    }
    const sent = setCredential(entry.key, trimmed)
    if (sent) {
      setWsClosed(null)
      setValue('')
      setEditing(false)
    } else {
      setWsClosed(WS_CLOSED_MESSAGE)
    }
  }, [value, setCredential, entry.key])

  const handleDelete = useCallback(() => {
    setError(null)
    const sent = deleteCredential(entry.key)
    if (sent) setWsClosed(null)
    else setWsClosed(WS_CLOSED_MESSAGE)
  }, [deleteCredential, entry.key])

  const handleTest = useCallback(() => {
    setError(null)
    const sent = testCredential(entry.key)
    if (!sent) setWsClosed(WS_CLOSED_MESSAGE)
    else setWsClosed(null)
  }, [testCredential, entry.key])

  return (
    <div className="settings-field" data-testid={`credential-row-${entry.key}`}>
      <div>
        <strong>{entry.provider}</strong> — <code>{entry.key}</code>
      </div>
      <div data-testid={`credential-status-${entry.key}`}>
        Status: {statusLabel(entry)}
        {entry.status === 'set' && entry.source !== 'oauth' && entry.masked
          ? ` — ${entry.masked}`
          : ''}
      </div>

      {envWins && (
        <p className="settings-hint" data-testid={`credential-env-hint-${entry.key}`}>
          Defined in your shell environment. Override by setting it here, or unset the
          env var. (The shell export takes precedence over a stored value.)
        </p>
      )}

      {editing && !envWins && (
        <>
          <div className="settings-field">
            <label htmlFor={`credential-input-${entry.key}`}>{entry.label}</label>
            <input
              id={`credential-input-${entry.key}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              data-testid={`credential-input-${entry.key}`}
            />
          </div>
          {error && (
            <p
              className="settings-hint"
              data-testid={`credential-error-${entry.key}`}
              style={{ color: 'var(--error, #f00)' }}
            >
              {error}
            </p>
          )}
          <div className="settings-field">
            <button
              type="button"
              onClick={handleSave}
              disabled={value.trim().length === 0}
              data-testid={`credential-save-${entry.key}`}
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setValue('')
                setError(null)
              }}
              data-testid={`credential-cancel-${entry.key}`}
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {!editing && (
        <div className="settings-field">
          {!envWins && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              data-testid={`credential-edit-${entry.key}`}
            >
              {entry.status === 'set' && entry.source === 'store' ? 'Edit' : 'Set key'}
            </button>
          )}
          <button
            type="button"
            onClick={handleTest}
            data-testid={`credential-test-${entry.key}`}
          >
            Test
          </button>
          {/* Remove is keyed on a stored value being present (source 'store'),
              mirroring the BYOK Remove gate. An env-sourced value cannot be
              removed from here — the user must unset the shell export. */}
          {entry.source === 'store' && (
            <button
              type="button"
              onClick={handleDelete}
              data-testid={`credential-remove-${entry.key}`}
            >
              Remove
            </button>
          )}
        </div>
      )}

      {testResult && (
        <p
          className="settings-hint"
          role="status"
          data-testid={`credential-test-result-${entry.key}`}
          style={{ color: testResult.ok ? 'var(--success-fg, #4ade80)' : 'var(--error, #f00)' }}
        >
          {testResult.ok
            ? `OK${testResult.model ? ` (${testResult.model})` : ''}${
                typeof testResult.latencyMs === 'number' ? ` — ${testResult.latencyMs}ms` : ''
              }`
            : `Failed: ${testResult.error ?? 'unknown error'}`}
        </p>
      )}

      {wsClosed && (
        <p
          className="settings-hint"
          role="alert"
          data-testid={`credential-ws-closed-${entry.key}`}
          style={{ color: 'var(--error, #f00)' }}
        >
          {wsClosed}
        </p>
      )}
    </div>
  )
}

export function ProviderCredentialsPane({ isOpen }: { isOpen: boolean }) {
  const credentialsStatus = useConnectionStore((s) => s.credentialsStatus)
  const refreshCredentialsStatus = useConnectionStore((s) => s.refreshCredentialsStatus)

  // Pull the latest status whenever the panel opens so it's accurate after an
  // out-of-band change (another dashboard, or an edit to credentials.json).
  // Ignore the boolean return — a closed socket on open is the common case.
  useEffect(() => {
    if (!isOpen) return
    refreshCredentialsStatus()
  }, [isOpen, refreshCredentialsStatus])

  const entries = credentialsStatus?.credentials ?? []

  return (
    <section className="settings-section" data-testid="provider-credentials-section">
      <h3>Provider Credentials</h3>
      <p className="settings-hint">
        Manage provider API keys and OAuth tokens here instead of exporting shell env
        vars. Keys are saved to <code>~/.chroxy/credentials.json</code> (mode 0600,
        owner-only) and are never shown again after saving — only a masked preview. A
        matching environment variable always takes precedence over a stored value.
      </p>

      {credentialsStatus?.fileError && (
        <p
          className="settings-hint"
          data-testid="provider-credentials-file-error"
          style={{ color: 'var(--warning-fg, #fbbf24)' }}
        >
          {credentialsStatus.fileError}
        </p>
      )}

      {entries.length === 0 ? (
        <p className="settings-hint" data-testid="provider-credentials-loading">
          Loading credential status…
        </p>
      ) : (
        entries.map((entry) => <CredentialRow key={entry.key} entry={entry} />)
      )}

      <p className="settings-hint">
        OAuth status is read-only. To sign in with a Claude subscription, run{' '}
        <code>claude login</code> in a terminal — see the providers docs.
      </p>
    </section>
  )
}
