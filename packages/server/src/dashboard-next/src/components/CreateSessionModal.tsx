/**
 * CreateSessionModal — new session form with name and CWD.
 */
import { useState, useEffect, useCallback, type KeyboardEvent } from 'react'
import { Modal } from './Modal'

export interface CreateSessionData {
  name: string
  cwd: string
}

export interface CreateSessionModalProps {
  open: boolean
  onClose: () => void
  onCreate: (data: CreateSessionData) => void
  initialCwd?: string | null
}

export function CreateSessionModal({ open, onClose, onCreate, initialCwd }: CreateSessionModalProps) {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [nameError, setNameError] = useState('')

  useEffect(() => {
    if (open) {
      setName('')
      setCwd(initialCwd || '')
      setNameError('')
    }
  }, [open, initialCwd])

  const submit = useCallback(() => {
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError('Session name is required')
      return
    }
    onCreate({ name: trimmed, cwd: cwd.trim() })
  }, [name, cwd, onCreate])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }, [submit])

  return (
    <Modal open={open} onClose={onClose} title="New Session">
      <input
        type="text"
        placeholder="Session name"
        aria-label="Session name"
        value={name}
        onChange={e => { setName(e.target.value); setNameError('') }}
        onKeyDown={handleKeyDown}
        autoComplete="off"
        aria-invalid={nameError ? true : undefined}
        aria-describedby={nameError ? 'session-name-error' : undefined}
      />
      {nameError && (
        <span id="session-name-error" className="form-error" role="alert">
          {nameError}
        </span>
      )}
      <input
        type="text"
        placeholder="Working directory (optional)"
        aria-label="Working directory (optional)"
        value={cwd}
        onChange={e => setCwd(e.target.value)}
        onKeyDown={handleKeyDown}
        autoComplete="off"
      />
      <div className="modal-buttons">
        <button className="btn-modal-cancel" onClick={onClose} type="button">
          Cancel
        </button>
        <button className="btn-modal-create" onClick={submit} type="button">
          Create
        </button>
      </div>
    </Modal>
  )
}
