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
import { PROVIDER_LABELS } from '../lib/provider-labels'

export interface CreateSessionData {
  name: string
  cwd: string
  provider?: string
  permissionMode?: string
  model?: string
  worktree?: boolean
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

/** Normalize a browse path for comparison: strip trailing slashes. */
function normalizeBrowsePath(p: string): string {
  if (!p || p === '/') return p
  return p.replace(/\/+$/, '')
}

/** Check if two browse paths refer to the same directory, accounting for server normalization. */
function browsePathsMatch(requested: string, response: string): boolean {
  if (!response) return true // no path to compare — accept
  if (normalizeBrowsePath(response) === normalizeBrowsePath(requested)) return true
  // Server expands ~ to home dir — if request started with ~, accept the server's canonical path
  if (requested.startsWith('~')) return true
  return false
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

/** Billing context per provider — helps users understand cost implications. */
const PROVIDER_BILLING: Record<string, string> = {
  'claude-sdk': 'Uses Anthropic API credits',
  'claude-cli': 'Uses your Claude subscription',
  'gemini': 'Uses Google API credits',
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
  const defaultModel = useConnectionStore(s => s.defaultModel)
  const availableProviders = useConnectionStore(s => s.availableProviders)
  const [name, setName] = useState('')
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false)
  const [cwd, setCwd] = useState('')
  const [provider, setProvider] = useState(defaultProvider)
  const [nameError, setNameError] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [permissionMode, setPermissionMode] = useState('')
  const [worktree, setWorktree] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1)
  const cwdInputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()

  // Directory browser state
  const [browsing, setBrowsing] = useState(false)
  const [browsePath, setBrowsePath] = useState('')
  const [browseEntries, setBrowseEntries] = useState<DirectoryEntry[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const requestDirectoryListing = useConnectionStore(s => s.requestDirectoryListing)
  const setDirectoryListingCallback = useConnectionStore(s => s.setDirectoryListingCallback)
  const defaultCwd = useConnectionStore(s => s.defaultCwd)

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
      setShowAdvanced(false)
      setPermissionMode('')
      setWorktree(false)
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
    onCreate({ name: trimmed, cwd: cwdValRef.current.trim(), provider, permissionMode: permissionMode || undefined, model: defaultModel || undefined, worktree: worktree || undefined })
  }, [onCreate, provider, permissionMode, defaultModel, worktree])

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
    setBrowseError(null)
    const requestedPath = path
    setDirectoryListingCallback((listing: DirectoryListing) => {
      // Guard: ignore stale responses from previous navigations (#1584)
      // Normalize paths before comparing — server may expand ~ or add/strip slashes (#1592)
      const responsePath = listing.path || listing.parentPath || ''
      if (!browsePathsMatch(requestedPath, responsePath)) return // stale
      // Update browsePath to the server's canonical path when it differs
      if (responsePath && responsePath !== requestedPath) {
        setBrowsePath(responsePath)
      }
      setBrowseLoading(false)
      if (listing.error) {
        setBrowseError(listing.error)
        setBrowseEntries([])
      } else if (!listing.entries) {
        setBrowseEntries([])
      } else {
        setBrowseError(null)
        setBrowseEntries(listing.entries)
      }
    })
    requestDirectoryListing(path)
  }, [requestDirectoryListing, setDirectoryListingCallback])

  const handleBrowseOpen = useCallback(async () => {
    // In Tauri context, use native OS folder picker via IPC command.
    // Detect via __TAURI_INTERNALS__ (consistent with useTauriIPC.ts) rather than
    // __TAURI__ (useTauriEvents.ts) since we need the internals for invoke.
    const tauriInternals = typeof window !== 'undefined'
      ? (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ as
        { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } | undefined
      : undefined
    if (tauriInternals) {
      try {
        const selected = await tauriInternals.invoke('pick_directory', {
          defaultPath: cwd || initialCwd || defaultCwd || undefined,
        }) as string | null
        if (selected) {
          setCwd(selected)
          cwdValRef.current = selected
          if (!nameManuallyEdited) {
            const generated = generateDefaultName(selected, existingNames)
            setName(generated)
            nameValRef.current = generated
          }
        }
        return
      } catch {
        // Fall through to server-based browser on error
      }
    }
    // Web context (or Tauri fallback): use server-based directory browser
    const startPath = cwd || initialCwd || defaultCwd || '/'
    setBrowsing(true)
    handleBrowseNavigate(startPath)
  }, [cwd, initialCwd, defaultCwd, handleBrowseNavigate, nameManuallyEdited, existingNames])

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
          error={browseError}
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
      <div className="provider-section">
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
          {PROVIDER_BILLING[provider] && (
            <span className="provider-billing-hint" data-testid="provider-billing-hint">
              {PROVIDER_BILLING[provider]}
            </span>
          )}
        </div>
        {availableProviders.length > 0 && (() => {
          const selected = availableProviders.find(p => p.name === provider)
          if (!selected?.capabilities) return null
          const badges = CAPABILITY_BADGES.filter(([key]) => selected.capabilities[key])
          if (badges.length === 0) return null
          return (
            <div className="provider-capabilities" data-testid="provider-capabilities">
              {badges.map(([, label]) => (
                <span key={label} className="capability-badge">{label}</span>
              ))}
            </div>
          )
        })()}
      </div>
      <div className="advanced-toggle">
        <button
          type="button"
          className="advanced-toggle-btn"
          onClick={() => setShowAdvanced(!showAdvanced)}
          aria-expanded={showAdvanced}
        >
          {showAdvanced ? '\u25BC' : '\u25B6'} Advanced
        </button>
      </div>
      {showAdvanced && (
        <div className="advanced-section" data-testid="advanced-section">
          <div className="form-field">
            <label htmlFor="permission-mode-select">Permission mode</label>
            <select
              id="permission-mode-select"
              value={permissionMode}
              onChange={e => setPermissionMode(e.target.value)}
              aria-label="Permission mode"
            >
              <option value="">Server default</option>
              <option value="approve">Approve</option>
              <option value="acceptEdits">Accept Edits</option>
              <option value="auto">Auto (bypass)</option>
              <option value="plan">Plan</option>
            </select>
          </div>
          <div className="form-field form-field--checkbox">
            <label className="checkbox-label">
              <input
                type="checkbox"
                id="worktree-checkbox"
                checked={worktree}
                onChange={e => setWorktree(e.target.checked)}
                disabled={!cwdValRef.current.trim()}
                aria-describedby="worktree-hint"
              />
              Isolate filesystem (worktree)
            </label>
            <span id="worktree-hint" className="form-hint">
              Runs in an isolated git worktree — requires a git repo CWD
            </span>
          </div>
        </div>
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
