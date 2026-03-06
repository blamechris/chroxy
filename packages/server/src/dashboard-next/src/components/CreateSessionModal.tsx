/**
 * CreateSessionModal — new session form with name and CWD picker.
 *
 * The CWD field is a combobox: shows known directories from existing sessions
 * as suggestions, but also accepts free-form typed paths.
 */
import { useState, useEffect, useCallback, useRef, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
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
  knownCwds?: string[]
  existingNames?: string[]
  serverError?: string
  isCreating?: boolean
}

/** Generate a default session name from a directory path, avoiding collisions. */
function generateDefaultName(cwdPath: string, existingNames: string[]): string {
  const base = cwdPath.replace(/\/+$/, '').split('/').pop() || 'Session'
  if (!existingNames.includes(base)) return base
  let n = 2
  while (existingNames.includes(`${base} (${n})`)) n++
  return `${base} (${n})`
}

const EMPTY_STRINGS: string[] = []

export function CreateSessionModal({ open, onClose, onCreate, initialCwd, knownCwds = EMPTY_STRINGS, existingNames = EMPTY_STRINGS, serverError, isCreating }: CreateSessionModalProps) {
  const [name, setName] = useState('')
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false)
  const [cwd, setCwd] = useState('')
  const [nameError, setNameError] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1)
  const cwdInputRef = useRef<HTMLInputElement>(null)

  // Imperative refs for submit — React 19 resets controlled input DOM values
  // before the next event fires, so we can't read from the DOM in submit.
  const nameValRef = useRef('')
  const cwdValRef = useRef('')

  // Deduplicate and sort known cwds
  const suggestions = [...new Set(knownCwds)].sort()

  const prevOpenRef = useRef(false)
  useEffect(() => {
    if (open) {
      const cwdValue = initialCwd || ''
      setCwd(cwdValue)
      cwdValRef.current = cwdValue
      setNameManuallyEdited(false)
      // Only clear error when modal freshly opens (not on every effect run)
      if (!prevOpenRef.current) {
        setNameError('')
      }
      setShowSuggestions(false)
      setSelectedSuggestion(-1)
      if (cwdValue) {
        const generated = generateDefaultName(cwdValue, existingNames)
        setName(generated)
        nameValRef.current = generated
      } else {
        setName('')
        nameValRef.current = ''
      }
    }
    prevOpenRef.current = open
  }, [open, initialCwd, existingNames])

  const submit = useCallback(() => {
    const trimmed = nameValRef.current.trim()
    if (!trimmed) {
      flushSync(() => setNameError('Session name is required'))
      return
    }
    onCreate({ name: trimmed, cwd: cwdValRef.current.trim() })
  }, [onCreate])

  const selectSuggestion = useCallback((path: string) => {
    setCwd(path)
    cwdValRef.current = path
    setShowSuggestions(false)
    setSelectedSuggestion(-1)
    if (!nameManuallyEdited) {
      const generated = generateDefaultName(path, existingNames)
      setName(generated)
      nameValRef.current = generated
    }
  }, [nameManuallyEdited, existingNames])

  const handleCwdKeyDown = useCallback((e: KeyboardEvent) => {
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedSuggestion(i => Math.min(i + 1, suggestions.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedSuggestion(i => Math.max(i - 1, -1))
        return
      }
      if (e.key === 'Enter' && selectedSuggestion >= 0) {
        e.preventDefault()
        selectSuggestion(suggestions[selectedSuggestion]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowSuggestions(false)
        return
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }, [showSuggestions, suggestions, selectedSuggestion, selectSuggestion, submit])

  const handleNameKeyDown = useCallback((e: KeyboardEvent) => {
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
        onChange={e => {
          const val = e.target.value
          setName(val)
          nameValRef.current = val
          setNameManuallyEdited(true)
          setNameError('')
        }}
        onKeyDown={handleNameKeyDown}
        autoComplete="off"
        aria-invalid={nameError ? true : undefined}
        aria-describedby={nameError ? 'session-name-error' : undefined}
      />
      {nameError && (
        <span id="session-name-error" className="form-error" role="alert">
          {nameError}
        </span>
      )}
      <div className="cwd-combobox">
        <input
          ref={cwdInputRef}
          type="text"
          placeholder="Working directory (optional)"
          aria-label="Working directory"
          value={cwd}
          onChange={e => {
            const val = e.target.value
            setCwd(val)
            cwdValRef.current = val
            setShowSuggestions(true)
            setSelectedSuggestion(-1)
          }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => {
            // Delay to allow click on suggestion
            setTimeout(() => setShowSuggestions(false), 150)
          }}
          onKeyDown={handleCwdKeyDown}
          autoComplete="off"
          role="combobox"
          aria-expanded={showSuggestions && suggestions.length > 0}
          aria-controls="cwd-suggestions"
          aria-autocomplete="list"
        />
        {suggestions.length > 0 && (
          <button
            type="button"
            className="cwd-dropdown-toggle"
            tabIndex={-1}
            aria-label="Show directory suggestions"
            onClick={() => {
              setShowSuggestions(!showSuggestions)
              cwdInputRef.current?.focus()
            }}
          >
            <span className="cwd-dropdown-arrow" />
          </button>
        )}
        {showSuggestions && suggestions.length > 0 && (
          <ul id="cwd-suggestions" className="cwd-suggestions" role="listbox">
            {suggestions.map((path, i) => {
              const label = path.split('/').pop() || path
              return (
                <li
                  key={path}
                  role="option"
                  aria-selected={i === selectedSuggestion}
                  className={`cwd-suggestion${i === selectedSuggestion ? ' selected' : ''}`}
                  onMouseDown={e => {
                    e.preventDefault()
                    selectSuggestion(path)
                  }}
                >
                  <span className="cwd-suggestion-name">{label}</span>
                  <span className="cwd-suggestion-path">{path}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {cwd && !suggestions.includes(cwd) && (
        <span className="cwd-hint">New directory — session will start here</span>
      )}
      {serverError && (
        <span className="form-error" role="alert">{serverError}</span>
      )}
      <div className="modal-buttons">
        <button className="btn-modal-cancel" onClick={onClose} type="button">
          Cancel
        </button>
        <button className="btn-modal-create" onClick={submit} type="button" disabled={isCreating}>
          {isCreating ? 'Creating...' : 'Create'}
        </button>
      </div>
    </Modal>
  )
}
