/**
 * RepoPresetDrawer (#5553) — the per-repo settings drawer's first occupant: the
 * session-preset editor. Opens from the Control Room repo-row gear.
 *
 * Two channels, both editable here:
 *   - PREAMBLE — folded into the session's system prompt every turn (model-facing).
 *   - SEED     — staged editable into the composer on session create (operator-facing).
 *
 * Plus an `enabled` toggle and the TRUST state. A repo-local `.chroxy/session.json`
 * is trust-gated: until the operator approves its content hash it is INERT
 * (pending) and never feeds the prompt. A daemon-side override (written from this
 * drawer's editor) is pre-trusted — the operator authored it.
 *
 * The editor writes the DAEMON override (session_preset_set). Approve/Revoke act
 * on a repo-local preset's trust hash (session_preset_approve / _revoke). Reads
 * the resolved preset from `sessionPresetSnapshots[repoPath]`; requests a fresh
 * snapshot on open.
 */
import { useEffect, useState } from 'react'
import { useConnectionStore } from '../store/connection'

export interface RepoPresetDrawerProps {
  /** Absolute repo path the drawer configures. */
  repoPath: string
  /** Display name for the drawer header. */
  repoName: string
  /** Close the drawer. */
  onClose: () => void
}

export function RepoPresetDrawer({ repoPath, repoName, onClose }: RepoPresetDrawerProps) {
  const requestSessionPreset = useConnectionStore(s => s.requestSessionPreset)
  const setSessionPresetOverride = useConnectionStore(s => s.setSessionPresetOverride)
  const approveSessionPreset = useConnectionStore(s => s.approveSessionPreset)
  const revokeSessionPreset = useConnectionStore(s => s.revokeSessionPreset)
  const snapshot = useConnectionStore(s => s.sessionPresetSnapshots[repoPath])

  // Local editable copy of the preamble/seed/enabled fields. Seeded from the
  // resolved snapshot when it first lands (or the repo path changes); the
  // operator's in-progress edits then own the fields until Save re-resolves.
  const [preamble, setPreamble] = useState('')
  const [seed, setSeed] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [hydratedFor, setHydratedFor] = useState<string | null>(null)

  // Request a fresh snapshot on open / repo change.
  useEffect(() => {
    if (repoPath) requestSessionPreset(repoPath)
  }, [repoPath, requestSessionPreset])

  // Hydrate the editor once per repo from the resolved snapshot.
  useEffect(() => {
    if (hydratedFor === repoPath) return
    if (snapshot === undefined) return // not fetched yet
    setPreamble(snapshot?.preamble ?? '')
    setSeed(snapshot?.seed ?? '')
    setEnabled(snapshot ? snapshot.enabled : true)
    setHydratedFor(repoPath)
  }, [snapshot, repoPath, hydratedFor])

  const trustState = snapshot?.trustState ?? null
  const source = snapshot?.source ?? null
  const isPendingRepoLocal = source === 'repo' && trustState === 'pending'

  const handleSave = () => {
    const trimmedPreamble = preamble.trim()
    const trimmedSeed = seed.trim()
    if (!trimmedPreamble && !trimmedSeed) {
      // An empty preset clears the daemon override.
      setSessionPresetOverride(repoPath, null)
    } else {
      setSessionPresetOverride(repoPath, { preamble: trimmedPreamble, seed: trimmedSeed, enabled })
    }
    setHydratedFor(null) // re-hydrate from the re-resolved snapshot
  }

  const handleClear = () => {
    setSessionPresetOverride(repoPath, null)
    setPreamble('')
    setSeed('')
    setEnabled(true)
    setHydratedFor(null)
  }

  return (
    <div className="repo-preset-drawer" data-testid="repo-preset-drawer" role="dialog" aria-label={`Per-repo settings for ${repoName}`}>
      <div className="repo-preset-drawer-header">
        <div>
          <h3 className="repo-preset-drawer-title">{repoName}</h3>
          <div className="repo-preset-drawer-path">{repoPath}</div>
        </div>
        <button type="button" className="repo-preset-drawer-close" data-testid="repo-preset-drawer-close" onClick={onClose} aria-label="Close per-repo settings">
          &#10005;
        </button>
      </div>

      <section className="repo-preset-section">
        <h4>Session preset</h4>

        {snapshot && (
          <div className="repo-preset-trust" data-testid="repo-preset-trust">
            <span>
              Source: <strong>{source === 'daemon' ? 'daemon config' : 'repo file'}</strong> · Trust:{' '}
              <strong data-testid="repo-preset-trust-state">{trustState ?? 'none'}</strong>
              {snapshot.active ? ' · active' : ' · inactive'}
            </span>
            {isPendingRepoLocal && (
              <button
                type="button"
                className="repo-preset-approve"
                data-testid="repo-preset-approve"
                onClick={() => { approveSessionPreset(repoPath); setHydratedFor(null) }}
              >
                Approve
              </button>
            )}
            {source === 'repo' && trustState === 'trusted' && (
              <button
                type="button"
                className="repo-preset-revoke"
                data-testid="repo-preset-revoke"
                onClick={() => { revokeSessionPreset(repoPath); setHydratedFor(null) }}
              >
                Revoke
              </button>
            )}
          </div>
        )}

        {isPendingRepoLocal && (
          <p className="repo-preset-pending-note" data-testid="repo-preset-pending-note">
            This repo ships a checked-in preset. It is inert until you approve its content — review it below, then click Approve.
          </p>
        )}

        <label className="repo-preset-toggle">
          <input
            type="checkbox"
            data-testid="repo-preset-enabled"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
          />
          Enabled
        </label>

        <label className="repo-preset-field-label" htmlFor="repo-preset-preamble-input">
          Preamble — prepended to the system prompt every turn
        </label>
        <textarea
          id="repo-preset-preamble-input"
          data-testid="repo-preset-preamble-input"
          className="repo-preset-textarea"
          value={preamble}
          onChange={e => setPreamble(e.target.value)}
          rows={6}
          placeholder="e.g. Use pnpm, not npm. Always read docs/ARCH.md first."
        />

        <label className="repo-preset-field-label" htmlFor="repo-preset-seed-input">
          Seed — staged editable into the composer on session create (never auto-sent)
        </label>
        <textarea
          id="repo-preset-seed-input"
          data-testid="repo-preset-seed-input"
          className="repo-preset-textarea"
          value={seed}
          onChange={e => setSeed(e.target.value)}
          rows={4}
          placeholder="e.g. Start by summarizing the open work in this repo."
        />

        <div className="repo-preset-actions">
          <button type="button" className="repo-preset-save" data-testid="repo-preset-save" onClick={handleSave}>
            Save override
          </button>
          <button type="button" className="repo-preset-clear" data-testid="repo-preset-clear" onClick={handleClear}>
            Clear override
          </button>
        </div>
        <p className="repo-preset-note">
          Saving writes a daemon-side override in <code>~/.chroxy/config.json</code> (pre-trusted). It wins over a
          checked-in <code>.chroxy/session.json</code>.
        </p>
      </section>
    </div>
  )
}
