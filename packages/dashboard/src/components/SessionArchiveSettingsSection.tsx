/**
 * SessionArchiveSettingsSection — Settings → "Session archive" (#8869).
 *
 * Edits the daemon's archive retention policy (`sessionArchive` in the chroxy
 * config): on/off, max sessions, max age, max size. A save is validated here
 * with the SAME rules the daemon enforces (config.js `validateSessionArchivePolicy`
 * — the daemon re-checks, this is the early, inline copy), persisted by the
 * daemon and applied to the running archive without a restart.
 *
 * Turning archiving OFF offers "Also delete existing archives (N)". Off alone
 * only stops NEW records (existing ones stay until deleted or aged out), so the
 * permanent delete is its own explicit, labelled choice and is never implied.
 *
 * Only the primary (unbound) client can change the policy; a pairing-bound
 * device's snapshot is `refused` and gets the explanation instead of controls.
 *
 * STYLING: class names only (theme/components.css), 44px floors via the shared
 * `.settings-field-checkbox` rule and the rules added beside it.
 */
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConnectionStore } from '../store/connection'
import { ARCHIVE_REFUSED_TEXT } from './ArchivedSessionsSection'

/**
 * Mirrors SESSION_ARCHIVE_MAX_ENTRIES in the server (session-archive-limits.js).
 * The daemon is the authority: a drift here only moves where the error appears.
 */
export const ARCHIVE_MAX_ENTRIES = 1000

export interface ArchivePolicyDraft {
  enabled: boolean
  maxEntries: string
  maxAgeDays: string
  maxMegabytes: string
}

export interface ArchivePolicyFieldErrors {
  maxEntries?: string
  maxAgeDays?: string
  maxMegabytes?: string
}

/** The daemon's rules, applied to the text the operator typed. */
export function validateArchivePolicyDraft(draft: ArchivePolicyDraft): ArchivePolicyFieldErrors {
  const errors: ArchivePolicyFieldErrors = {}
  const entries = draft.maxEntries.trim() === '' ? NaN : Number(draft.maxEntries)
  if (!Number.isInteger(entries) || entries <= 0) errors.maxEntries = 'Enter a whole number of at least 1.'
  else if (entries > ARCHIVE_MAX_ENTRIES) errors.maxEntries = `At most ${ARCHIVE_MAX_ENTRIES} sessions.`
  for (const key of ['maxAgeDays', 'maxMegabytes'] as const) {
    const v = draft[key].trim() === '' ? NaN : Number(draft[key])
    if (!Number.isFinite(v) || v <= 0) errors[key] = 'Enter a number greater than 0.'
  }
  return errors
}

export function SessionArchiveSettingsSection() {
  const { snapshot, connected, saving, error, requestArchivedSessions, setSessionArchivePolicy } = useConnectionStore(
    useShallow((s) => ({
      snapshot: s.archivedSessions,
      connected: s.connectionPhase === 'connected',
      saving: s.sessionArchivePolicySaving,
      error: s.sessionArchivePolicyError,
      requestArchivedSessions: s.requestArchivedSessions,
      setSessionArchivePolicy: s.setSessionArchivePolicy,
    })),
  )

  // Ask whenever nothing is known and the socket is up: on mount, once a late
  // connection lands, and after a reconnect resets the snapshot (the Control
  // Room tab / sidebar may already have asked).
  const unknown = snapshot === null
  useEffect(() => {
    if (unknown && connected) requestArchivedSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on unknown/connected only
  }, [unknown, connected])

  const refused = snapshot?.refused === true
  const policy = snapshot && !refused ? snapshot.policy : null
  const rosterCount = snapshot && !refused && Array.isArray(snapshot.sessions) ? snapshot.sessions.length : 0
  const truncated = snapshot?.truncated === true

  const fromPolicy = (p: NonNullable<typeof policy>): ArchivePolicyDraft => ({
    enabled: p.enabled,
    maxEntries: String(p.maxEntries),
    maxAgeDays: String(p.maxAgeDays),
    maxMegabytes: String(p.maxMegabytes),
  })
  const [draft, setDraft] = useState<ArchivePolicyDraft | null>(policy ? fromPolicy(policy) : null)
  const [purge, setPurge] = useState(false)

  // Follow the daemon: when the policy it reports changes (first load, our own
  // save, another client's save), the form restarts from it.
  const policyKey = policy ? `${policy.enabled}|${policy.maxEntries}|${policy.maxAgeDays}|${policy.maxMegabytes}` : null
  useEffect(() => {
    setDraft(policy ? fromPolicy(policy) : null)
    setPurge(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the policy VALUES
  }, [policyKey])

  const fieldErrors = useMemo(() => (draft ? validateArchivePolicyDraft(draft) : {}), [draft])
  const valid = Object.keys(fieldErrors).length === 0

  return (
    <section className="settings-section" data-testid="session-archive-section">
      <h3>Session archive</h3>
      {refused ? (
        <p className="settings-hint" data-testid="session-archive-refused">{ARCHIVE_REFUSED_TEXT}</p>
      ) : !policy || !draft ? (
        <p className="settings-hint" data-testid="session-archive-loading">Loading…</p>
      ) : (
        <>
          <p className="settings-hint">
            Ended sessions are kept on this machine so their history stays readable. Changes apply to the running
            daemon right away and are saved to its config.
          </p>
          <div className="settings-field settings-field-checkbox">
            <label htmlFor="session-archive-enabled">
              <input
                id="session-archive-enabled"
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => {
                  setDraft({ ...draft, enabled: e.target.checked })
                  if (e.target.checked) setPurge(false)
                }}
                data-testid="session-archive-enabled"
              />
              Keep an archive of ended sessions
            </label>
          </div>
          {!draft.enabled && (
            <div className="settings-field settings-field-checkbox">
              <label htmlFor="session-archive-purge">
                <input
                  id="session-archive-purge"
                  type="checkbox"
                  checked={purge}
                  onChange={(e) => setPurge(e.target.checked)}
                  data-testid="session-archive-purge"
                />
                {`Also delete existing archives (${rosterCount}${truncated ? '+' : ''}) — permanent`}
              </label>
              <p className="settings-hint">
                Turning archiving off only stops new records; existing ones stay until deleted or aged out.
                Checking this deletes every archived session, and it cannot be undone.
              </p>
            </div>
          )}
          {([
            ['maxEntries', 'Max sessions', 'session-archive-max-entries', '1', '1'],
            ['maxAgeDays', 'Max age (days)', 'session-archive-max-age', 'any', '0'],
            ['maxMegabytes', 'Max size (MB)', 'session-archive-max-size', 'any', '0'],
          ] as const).map(([key, label, testId, step, min]) => (
            <div className="settings-field" key={key}>
              <label htmlFor={testId}>{label}</label>
              <input
                id={testId}
                type="number"
                inputMode="decimal"
                step={step}
                min={min}
                value={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                aria-invalid={fieldErrors[key] ? true : undefined}
                aria-describedby={fieldErrors[key] ? `${testId}-error` : undefined}
                data-testid={testId}
              />
              {fieldErrors[key] && (
                <p className="settings-hint settings-field-error" id={`${testId}-error`} data-testid={`${testId}-error`}>
                  {fieldErrors[key]}
                </p>
              )}
            </div>
          ))}
          {error && (
            <p className="settings-error" role="alert" data-testid="session-archive-error">
              {error.refused ? ARCHIVE_REFUSED_TEXT : (error.message ?? 'Could not save the archive settings.')}
            </p>
          )}
          <div className="settings-field">
            <button
              type="button"
              className="settings-secondary-button session-archive-save"
              disabled={
                !connected ||
                saving ||
                !valid ||
                !(
                  purge ||
                  draft.enabled !== policy.enabled ||
                  Number(draft.maxEntries) !== policy.maxEntries ||
                  Number(draft.maxAgeDays) !== policy.maxAgeDays ||
                  Number(draft.maxMegabytes) !== policy.maxMegabytes
                )
              }
              onClick={() =>
                setSessionArchivePolicy(
                  {
                    enabled: draft.enabled,
                    maxEntries: Number(draft.maxEntries),
                    maxAgeDays: Number(draft.maxAgeDays),
                    maxMegabytes: Number(draft.maxMegabytes),
                  },
                  { purge: !draft.enabled && purge },
                )
              }
              data-testid="session-archive-save"
            >
              {saving ? 'Saving…' : !draft.enabled && purge ? 'Save and delete archives' : 'Save'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
