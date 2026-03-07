/**
 * CreateSessionModal — new session form with name and CWD picker.
 *
 * The CWD field is a combobox: shows known directories from existing sessions
 * as suggestions, but also accepts free-form typed paths.
 */
import { useState, useEffect, useCallback, useRef, useMemo, useId, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { Modal } from './Modal'
import { usePathAutocomplete } from '../hooks/usePathAutocomplete'
import { DirectoryBrowser } from './DirectoryBrowser'
import { useConnectionStore } from '../store/connection'
import type { DirectoryListing, DirectoryEntry } from '../store/types'

export interface CreateSessionData {
  name: string
  cwd: string
  provider?: string
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

/** Extract the last path segment, handling both POSIX and Windows separators. */
function basename(p: string): string {
  return p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p
}

/** Generate a default session name from a directory path, avoiding collisions. */
function generateDefaultName(cwdPath: string, existingNames: string[]): string {
  const base = basename(cwdPath) || 'Session'
  if (!existingNames.includes(base)) return base
  let n = 2
  while (existingNames.includes(`${base} (${n})`)) n++
  return `${base} (${n})`
}

const EMPTY_STRINGS: string[] = []

/** Human-readable labels for known providers. */
const PROVIDER_LABELS: Record<string, string> = {
  'claude-sdk': 'Claude Code (SDK)',
  'claude-cli': 'Claude Code (CLI)',
  'codex': 'OpenAI Codex',
  'gemini': 'Gemini CLI',
}

/** Short labels for capability badges. */
const CAPABILITY_BADGES: [keyof import('../store/types').ProviderCapabilities, string][] = [
  ['resume', 'Resume'],
  ['planMode', 'Plan'],
  ['permissions', 'Permissions'],
  ['terminal', 'Terminal'],
]

export function CreateSessionModal({ open, onClose, onCreate, initialCwd, knownCwds = EMPTY_STRINGS, existingNames = EMPTY_STRINGS, serverError, isCreating }: CreateSessionModalProps) {
  const defaultProvider = useConnectionStore(s => s.defaultProvider)
  const availableProviders = useConnectionStore(s => s.availableProviders)
  const [name, setName] = useState('')
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false)
  const [cwd, setCwd] = useState('')
  const [provider, setProvider] = useState(defaultProvider)
  const [nameError, setNameError] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1)
  const cwdInputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()

  // Directory browser state
  const [browsing, setBrowsing] = useState(false)
  const [browsePath, setBrowsePath] = useState('')
  const [browseEntries, setBrowseEntries] = useState<DirectoryEntry[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const requestDirectoryListing = useConnectionStore(s => s.requestDirectoryListing)
  const setDirectoryListingCallback = useConnectionStore(s => s.setDirectoryListingCallback)

  // Imperative refs for submit — React 19 resets controlled input DOM values
  // before the next event fires, so we can't read from the DOM in submit.
  const nameValRef = useRef('')
  const cwdValRef = useRef('')

  // Autocomplete suggestions from server
  const { suggestions: autocompleteSuggestions } = usePathAutocomplete(cwd)

  // Merge autocomplete with known cwds, deduplicate and sort
  const suggestions = useMemo(() => {
    const known = knownCwds.filter(p => !cwd || p.toLowerCase().includes(cwd.toLowerCase()))
    const merged = [...new Set([...autocompleteSuggestions, ...known])]
    return merged.sort()
  }, [knownCwds, autocompleteSuggestions, cwd])

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
      // Normalize provider: if server has responded with available providers and
      // the persisted default isn't in the list, fall back to first available
      if (availableProviders.length > 0 && !availableProviders.some(p => p.name === defaultProvider)) {
        setProvider(availableProviders[0]!.name)
      } else {
        setProvider(defaultProvider)
      }
      setShowSuggestions(false)
      setSelectedSuggestion(-1)
      setBrowsing(false)
      setBrowseEntries([])
      setDirectoryListingCallback(null)
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
    onCreate({ name: trimmed, cwd: cwdValRef.current.trim(), provider })
  }, [onCreate, provider])

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

  const handleBrowseNavigate = useCallback((path: string) => {
    setBrowsePath(path)
    setBrowseLoading(true)
    setBrowseEntries([])
    setDirectoryListingCallback((listing: DirectoryListing) => {
      setBrowseLoading(false)
      if (listing.error || !listing.entries) {
        setBrowseEntries([])
      } else {
        setBrowseEntries(listing.entries)
      }
    })
    requestDirectoryListing(path)
  }, [requestDirectoryListing, setDirectoryListingCallback])

  const handleBrowseOpen = useCallback(() => {
    const startPath = cwd || initialCwd || '/'
    setBrowsing(true)
    handleBrowseNavigate(startPath)
  }, [cwd, initialCwd, handleBrowseNavigate])

  const handleBrowseSelect = useCallback((path: string) => {
    setCwd(path)
    cwdValRef.current = path
    setBrowsing(false)
    setDirectoryListingCallback(null)
    if (!nameManuallyEdited) {
      const generated = generateDefaultName(path, existingNames)
      setName(generated)
      nameValRef.current = generated
    }
  }, [nameManuallyEdited, existingNames, setDirectoryListingCallback])

  const handleBrowseCancel = useCallback(() => {
    setBrowsing(false)
    setDirectoryListingCallback(null)
  }, [setDirectoryListingCallback])

  const handleCwdKeyDown = useCallback((e: KeyboardEvent) => {
    // Tab completion — only when dropdown is visible to avoid trapping keyboard focus
    if (e.key === 'Tab' && showSuggestions && suggestions.length > 0) {
      e.preventDefault()
      const idx = selectedSuggestion >= 0 ? selectedSuggestion : 0
      const suggestion = suggestions[idx]!
      const completed = suggestion.endsWith('/') ? suggestion : suggestion + '/'
      selectSuggestion(completed)
      return
    }
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
      {browsing ? (
        <DirectoryBrowser
          entries={browseEntries}
          currentPath={browsePath}
          loading={browseLoading}
          onNavigate={handleBrowseNavigate}
          onSelect={handleBrowseSelect}
          onCancel={handleBrowseCancel}
        />
      ) : (
        <>
          <div className="cwd-input-row">
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
                aria-controls={listboxId}
                aria-autocomplete="list"
                aria-activedescendant={showSuggestions && selectedSuggestion >= 0 ? `${listboxId}-opt-${selectedSuggestion}` : undefined}
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
                <ul id={listboxId} className="cwd-suggestions" role="listbox">
                  {suggestions.map((path, i) => {
                    const label = basename(path)
                    return (
                      <li
                        key={path}
                        id={`${listboxId}-opt-${i}`}
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
            <button
              type="button"
              className="cwd-browse-btn"
              onClick={handleBrowseOpen}
              aria-label="Browse directories"
            >
              Browse...
            </button>
          </div>
          {cwd && !suggestions.includes(cwd) && (
            <span className="cwd-hint">New directory — session will start here</span>
          )}
        </>
      )}
      <div className="provider-select">
        <label htmlFor="provider-select">Provider</label>
        <select
          id="provider-select"
          value={provider}
          onChange={e => setProvider(e.target.value)}
          aria-label="Select provider"
        >
          {availableProviders.length > 0
            ? availableProviders.map(p => (
                <option key={p.name} value={p.name}>
                  {PROVIDER_LABELS[p.name] || p.name}
                </option>
              ))
            : <>
                <option value="claude-sdk">Claude Code (SDK)</option>
                <option value="claude-cli">Claude Code (CLI)</option>
              </>
          }
        </select>
        {availableProviders.length > 0 && (() => {
          const selected = availableProviders.find(p => p.name === provider)
          if (!selected?.capabilities) return null
          const badges = CAPABILITY_BADGES.filter(([key]) => selected.capabilities[key])
          if (badges.length === 0) return null
          return (
            <div className="provider-capabilities">
              {badges.map(([, label]) => (
                <span key={label} className="capability-badge">{label}</span>
              ))}
            </div>
          )
        })()}
      </div>
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
