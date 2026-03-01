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
}

export function CreateSessionModal({ open, onClose, onCreate }: CreateSessionModalProps) {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')

  useEffect(() => {
    if (open) {
      setName('')
      setCwd('')
    }
  }, [open])

  const submit = useCallback(() => {
    const trimmed = name.trim()
    if (!trimmed) return
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
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={handleKeyDown}
        autoComplete="off"
      />
      <input
        type="text"
        placeholder="Working directory (optional)"
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
