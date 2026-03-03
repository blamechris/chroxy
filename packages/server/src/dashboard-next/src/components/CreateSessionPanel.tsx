/**
 * CreateSessionPanel — inline session creation form for the sidebar.
 *
 * Replaces the modal pattern for sidebar-initiated session creation.
 * Pre-fills CWD from the repo path, shows model and permission selectors.
 * Submits on Enter, cancels on Escape.
 */
import { useState, useCallback, type KeyboardEvent } from 'react'

export interface CreateSessionPanelProps {
  cwd: string
  models: { id: string; label: string }[]
  permissionModes: { id: string; label: string }[]
  onCreate: (data: { cwd: string; model: string; permissionMode: string }) => void
  onCancel: () => void
  className?: string
}

export function CreateSessionPanel({
  cwd,
  models,
  permissionModes,
  onCreate,
  onCancel,
  className,
}: CreateSessionPanelProps) {
  const [cwdValue, setCwdValue] = useState(cwd)
  const [model, setModel] = useState(models[0]?.id ?? '')
  const [permMode, setPermMode] = useState(permissionModes[0]?.id ?? '')

  const submit = useCallback(() => {
    onCreate({
      cwd: cwdValue.trim() || cwd,
      model,
      permissionMode: permMode,
    })
  }, [cwdValue, cwd, model, permMode, onCreate])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }, [submit, onCancel])

  return (
    <div
      className={`create-session-panel${className ? ` ${className}` : ''}`}
      data-testid="create-session-panel"
    >
      <label className="create-session-field">
        <span className="create-session-label">Working directory</span>
        <input
          type="text"
          aria-label="Working directory"
          value={cwdValue}
          onChange={e => setCwdValue(e.target.value)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          autoFocus
        />
      </label>

      {models.length > 0 && (
        <label className="create-session-field">
          <span className="create-session-label">Model</span>
          <select
            aria-label="Model"
            value={model}
            onChange={e => setModel(e.target.value)}
          >
            {models.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
      )}

      {permissionModes.length > 0 && (
        <label className="create-session-field">
          <span className="create-session-label">Permission mode</span>
          <select
            aria-label="Permission mode"
            value={permMode}
            onChange={e => setPermMode(e.target.value)}
          >
            {permissionModes.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
      )}

      <div className="create-session-buttons">
        <button
          type="button"
          className="btn-create-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn-create-submit"
          onClick={submit}
        >
          Create
        </button>
      </div>
    </div>
  )
}
