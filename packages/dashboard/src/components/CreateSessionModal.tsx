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
import { buildProviderLimitationNote } from '@chroxy/store-core'
import {
  CODEX_PROVIDER,
  CODEX_SANDBOX_MODE_META,
  type CodexSandboxMode,
} from '@chroxy/protocol'
import type { DirectoryListing, DirectoryEntry, ModelInfo } from '../store/types'
import { PROVIDER_LABELS } from '../lib/provider-labels'

export interface CreateSessionData {
  name: string
  cwd: string
  provider?: string
  permissionMode?: string
  model?: string
  worktree?: boolean
  environmentId?: string
  // #6689/#6903: per-session Codex sandbox mode. `undefined` means "use the
  // daemon's configured sandbox" (CHROXY_CODEX_SANDBOX, else workspace-write) —
  // the picker's "Default" option. Only set when the selected provider is
  // `codex`; undefined for all other providers (the server ignores it anyway).
  // Narrowed to the wire enum so an invalid value can't compile (Copilot #6900).
  codexSandbox?: CodexSandboxMode
  // #4208: spawn the claude TUI with --dangerously-skip-permissions and
  // elide chroxy's permission hook entirely. Only the `claude-tui`
  // provider honours this — the checkbox is hidden for other providers
  // so users don't think they're configuring a flag that does nothing.
  skipPermissions?: boolean
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
const EMPTY_MODELS: ModelInfo[] = []

// #5629: the programmatic-credit era boundary, MIRRORED from the server's
// PROGRAMMATIC_CREDIT_ERA_START (packages/server/src/billing-class.js). The
// server-driven `auth.detail` is always preferred; this constant only date-
// gates the STATIC fallback copy below (shown before the live provider list
// arrives). Keep the two boundaries in sync if this ever moves. 2026-06-15
// 00:00:00 UTC — Date.UTC month arg is 0-indexed so `5` is June.
const PROGRAMMATIC_CREDIT_ERA_START = Date.UTC(2026, 5, 15)

/** Client-side mirror of the server's isProgrammaticCreditEra (injectable now). */
function isProgrammaticCreditEra(now: number = Date.now()): boolean {
  return now >= PROGRAMMATIC_CREDIT_ERA_START
}

/**
 * Billing context per provider — helps users understand cost implications.
 *
 * Date-gated only for the HOST providers that flip from a flat subscription to
 * the metered programmatic-credit pool on 2026-06-15 (claude-cli / claude-sdk).
 * docker-cli / docker-sdk forward an ANTHROPIC_API_KEY into the container with
 * no OAuth fallback, so they are always api-key (the host credit pool never
 * applies inside the container) — NOT date-gated. This is only the STATIC
 * fallback; the live server `auth.detail` (itself era-gated server-side) takes
 * precedence at the render site below.
 */
function providerBillingFallback(provider: string, now: number = Date.now()): string | undefined {
  const era = isProgrammaticCreditEra(now)
  const STATIC: Record<string, string> = {
    'claude-sdk': era
      ? 'Programmatic credit pool — monthly metered credits'
      : 'Uses your Claude subscription',
    'claude-cli': era
      ? 'Programmatic credit pool — monthly metered credits'
      : 'Uses your Claude subscription',
    'claude-tui': 'Uses your Claude subscription (interactive TUI — bypasses programmatic credit metering)',
    'claude-byok': 'Direct Anthropic API — per-token billing with your own ANTHROPIC_API_KEY. No claude binary required.',
    'docker-cli': 'Docker-isolated — Anthropic API (your ANTHROPIC_API_KEY forwarded to the container)',
    'docker-sdk': 'Docker-isolated — Anthropic API (your ANTHROPIC_API_KEY forwarded to the container)',
    // #5026: docker-byok runs the BYOK agent loop on the host (so chroxy talks
    // to api.anthropic.com directly) while file/Bash tool execution happens
    // inside an isolated Docker container. Trade-off vs. claude-byok: same
    // billing (your ANTHROPIC_API_KEY), but tool side-effects are sandboxed.
    'docker-byok': 'Direct Anthropic API (your ANTHROPIC_API_KEY) — tool execution sandboxed in a Docker container. Same billing as claude-byok, isolated filesystem.',
    'codex': 'Uses OpenAI API credits',
    'gemini': 'Uses Google API credits',
  }
  return STATIC[provider]
}

/** Short labels for capability badges. */
const CAPABILITY_BADGES: [keyof import('../store/types').ProviderCapabilities, string][] = [
  // #5026: containerized first so the most-distinctive capability of
  // docker-* providers reads at a glance. Stays hidden for host-only
  // providers (capabilities.containerized is falsy on those).
  ['containerized', 'Containerized'],
  ['resume', 'Resume'],
  ['planMode', 'Plan'],
  ['permissions', 'Permissions'],
  ['terminal', 'Terminal'],
]

/**
 * Render a hint string with backtick-wrapped tokens promoted to `<code>` so
 * snippets like `codex login` or `OPENAI_API_KEY` format as code rather
 * than rendering as literal backticks (#4340). A pure helper so the parsed
 * tree is easy to unit-test.
 *
 * Only single-backtick code spans are recognised — that's all the server
 * hint strings use today. Backtick handling is intentionally tolerant: an
 * unmatched trailing backtick falls back to literal text so an
 * accidentally-malformed hint still renders.
 */
export function renderHintWithCode(hint: string): Array<string | { code: string }> {
  if (!hint) return []
  const out: Array<string | { code: string }> = []
  let i = 0
  while (i < hint.length) {
    const start = hint.indexOf('`', i)
    if (start === -1) {
      out.push(hint.slice(i))
      break
    }
    if (start > i) out.push(hint.slice(i, start))
    const end = hint.indexOf('`', start + 1)
    if (end === -1) {
      // Unmatched backtick — fall back to literal text, including the tick.
      out.push(hint.slice(start))
      break
    }
    out.push({ code: hint.slice(start + 1, end) })
    i = end + 1
  }
  return out
}

export function resolveCreateSessionModel(
  provider: string,
  defaultModel: string | null | undefined,
  availableModels: ModelInfo[],
  availableModelsProvider: string | null,
): string | undefined {
  const model = typeof defaultModel === 'string' ? defaultModel.trim() : ''
  if (!model) return undefined
  // The dashboard default model is not yet provider-scoped. Only apply it when
  // the current provider-scoped catalog proves the selected provider accepts it.
  if (availableModelsProvider !== provider) return undefined
  return availableModels.some(m => m.id === model || m.fullId === model)
    ? model
    : undefined
}

export function CreateSessionModal({ open, onClose, onCreate, initialCwd, knownCwds = EMPTY_STRINGS, existingNames = EMPTY_STRINGS, serverError, isCreating }: CreateSessionModalProps) {
  const defaultProvider = useConnectionStore(s => s.defaultProvider)
  const defaultModel = useConnectionStore(s => s.defaultModel)
  const availableModels = useConnectionStore(s => s.availableModels) || EMPTY_MODELS
  const availableModelsProvider = useConnectionStore(s => s.availableModelsProvider)
  const availableProviders = useConnectionStore(s => s.availableProviders)
  // #4019: read the server's PERMISSION_MODES list (including the
  // `description` field) so the picker + hint stay in lockstep with the
  // server's source of truth. Pre-#4019 the modal hardcoded its own copy
  // of the description strings as a ternary chain, which drifted.
  const availablePermissionModes = useConnectionStore(s => s.availablePermissionModes)
  const [name, setName] = useState('')
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false)
  const [cwd, setCwd] = useState('')
  const [provider, setProvider] = useState(defaultProvider)
  const [nameError, setNameError] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [permissionMode, setPermissionMode] = useState('')
  const [worktree, setWorktree] = useState(false)
  // #6689/#6903: per-session Codex sandbox mode. '' is the "Default" option — it
  // forwards no `codexSandbox`, so the daemon's CHROXY_CODEX_SANDBOX floor (else
  // workspace-write) is honored, matching the mobile app's Default-provider omit
  // path. Only surfaced/forwarded for the `codex` provider.
  const [codexSandbox, setCodexSandbox] = useState<'' | CodexSandboxMode>('')
  // #4208/#4244: TUI-only opt-in to spawn claude with
  // --dangerously-skip-permissions. Tri-state (#4244) so the modal can
  // submit an explicit `false` and override a server-wide
  // `defaultSkipPermissions: true` (#4209) on a per-session basis:
  //   - 'inherit' → emits undefined; server applies defaultSkipPermissions
  //   - 'on'      → emits true; always skip prompts
  //   - 'off'     → emits false; never skip prompts, even if server default is true
  // Reset to 'inherit' whenever the modal re-opens (alongside permissionMode
  // / worktree below) so a previous session's choice doesn't leak into the
  // next create.
  const [skipPermissions, setSkipPermissions] = useState<'inherit' | 'on' | 'off'>('inherit')
  const [environmentId, setEnvironmentId] = useState('')
  const environments = useConnectionStore(s => s.environments)
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
  // #5553: per-repo session preset disclosure. When the chosen cwd has an
  // ACTIVE preset, surface a compact, expandable indicator so the operator can
  // never be surprised by an invisibly-injected preamble. Pending presets are
  // surfaced too (so the operator knows one is awaiting approval in the drawer).
  const requestSessionPreset = useConnectionStore(s => s.requestSessionPreset)
  const sessionPresetSnapshots = useConnectionStore(s => s.sessionPresetSnapshots)
  const [presetExpanded, setPresetExpanded] = useState(false)
  // Defensive: tests mock the store with a partial slice; treat a missing
  // action/map as "feature unavailable" rather than crashing the modal.
  const requestSessionPresetSafe = typeof requestSessionPreset === 'function' ? requestSessionPreset : undefined

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

  // #5553: debounced preset lookup for the chosen cwd. Requesting on every
  // keystroke would spam the server, so wait 400ms after the cwd settles. The
  // reply lands in `sessionPresetSnapshots[cwd]` and the disclosure below reads
  // from there. Only fires when the modal is open and a cwd is present.
  const trimmedCwd = cwd.trim()
  useEffect(() => {
    if (!open || !trimmedCwd || !requestSessionPresetSafe) return
    const t = setTimeout(() => { requestSessionPresetSafe(trimmedCwd) }, 400)
    return () => clearTimeout(t)
  }, [open, trimmedCwd, requestSessionPresetSafe])

  // The resolved preset for the current cwd (undefined = not fetched; null = no
  // preset). Collapse the expanded preview whenever the cwd changes.
  const currentPreset = trimmedCwd ? sessionPresetSnapshots?.[trimmedCwd] : undefined
  useEffect(() => { setPresetExpanded(false) }, [trimmedCwd])

  const prevOpenRef = useRef(false)
  useEffect(() => {
    // Only reset form state on fresh open (closed → open transition).
    // Without this guard, store updates to existingNames or availableProviders
    // while the modal is already open would wipe the user's in-progress edits.
    const freshOpen = open && !prevOpenRef.current
    prevOpenRef.current = open
    if (!freshOpen) return

    const cwdValue = initialCwd || ''
    setCwd(cwdValue)
    cwdValRef.current = cwdValue
    setNameManuallyEdited(false)
    setNameError('')
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
    setCodexSandbox('')
    setSkipPermissions('inherit')
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
  }, [open, initialCwd, existingNames, availableProviders, defaultProvider])

  // Keep provider in sync while modal is open: if availableProviders changes
  // and the current provider is no longer valid, fall back to first available.
  // This runs independently of the fresh-open guard above (#2679).
  useEffect(() => {
    if (!open || availableProviders.length === 0) return
    if (!availableProviders.some(p => p.name === provider)) {
      setProvider(availableProviders[0]!.name)
    }
  }, [open, availableProviders, provider])

  // #4245: reset skipPermissions whenever the provider changes. The
  // checkbox is hidden for non-TUI providers, but the underlying state
  // survives a provider switch — so a user who ticks the box for
  // claude-tui, tabs to claude-sdk, then tabs back to claude-tui would
  // see the checkbox pre-checked with no fresh warning. Force a
  // re-confirmation by clearing the state on every provider change. The
  // submit-time guard (`provider === 'claude-tui' && skipPermissions`)
  // still acts as belt + braces in case this reset races a submit.
  useEffect(() => {
    setSkipPermissions('inherit')
    // #6689: reset the codex sandbox to the default on every provider change so
    // a stale (e.g. danger-full-access) selection can't survive a provider
    // round-trip and silently apply to a fresh codex session.
    setCodexSandbox('')
  }, [provider])

  // #4340: gate the Create button on the selected provider being ready.
  // Pre-#4340 the dropdown disabled unready options so they couldn't be
  // selected; now we let the user navigate to any provider to read its
  // fix-hint, but still refuse to submit until auth.ready === true. We
  // resolve `selectedProviderUnready` once and reuse it for the panel +
  // submit gate + button disabled state.
  const selectedProviderInfo = availableProviders.find(p => p.name === provider)
  const selectedProviderUnready = selectedProviderInfo?.auth?.ready === false

  const submit = useCallback(() => {
    const trimmed = nameValRef.current.trim()
    if (!trimmed) {
      flushSync(() => setNameError('Session name is required'))
      return
    }
    // #4340: refuse to create a session against an unready provider. The
    // fix-hint panel tells the user what to do; the Create button is also
    // visually disabled, but the click path checks here for defence in
    // depth (e.g. keyboard activation racing a store update).
    if (selectedProviderUnready) return
    const model = resolveCreateSessionModel(provider, defaultModel, availableModels, availableModelsProvider)
    // #4208/#4244: gate on the TUI provider at submit time as well as in the
    // UI. The radio group is hidden for non-TUI providers, but a user who
    // flips provider AFTER changing state would otherwise carry the stale
    // value forward — and the server-side handler doesn't gate by provider
    // (forwards via providerOpts; non-TUI providers ignore it). Belt +
    // braces: undefined unless the active provider is `claude-tui`.
    // Tri-state mapping: 'inherit' → undefined (server default wins), 'on'
    // → true (force skip), 'off' → false (force require, overrides a server
    // launched with --dangerously-skip-permissions).
    const skipPermissionsOut: boolean | undefined = provider === 'claude-tui'
      ? (skipPermissions === 'on' ? true : skipPermissions === 'off' ? false : undefined)
      : undefined
    // #6689/#6903: only forward the sandbox mode for codex, and only when the
    // user explicitly picked one — '' is the "Default" option → omit so the
    // daemon's CHROXY_CODEX_SANDBOX floor (else workspace-write) is honored
    // instead of being silently overridden. Other providers never forward it.
    const codexSandboxOut: CodexSandboxMode | undefined =
      provider === CODEX_PROVIDER && codexSandbox ? codexSandbox : undefined
    onCreate({ name: trimmed, cwd: cwdValRef.current.trim(), provider, permissionMode: permissionMode || undefined, model, worktree: worktree || undefined, environmentId: environmentId || undefined, skipPermissions: skipPermissionsOut, codexSandbox: codexSandboxOut })
  }, [onCreate, provider, permissionMode, defaultModel, availableModels, availableModelsProvider, worktree, environmentId, skipPermissions, codexSandbox, selectedProviderUnready])

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
    <Modal open={open} onClose={onClose} title="New Session" closeOnBackdrop={false}>
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
          {currentPreset && (
            <div className="repo-preset-disclosure" data-testid="repo-preset-disclosure">
              <button
                type="button"
                className="repo-preset-summary"
                data-testid="repo-preset-summary"
                onClick={() => setPresetExpanded(v => !v)}
                aria-expanded={presetExpanded}
              >
                {currentPreset.trustState === 'pending' ? (
                  <span>Repo preset pending review — approve it in the repo drawer to apply</span>
                ) : currentPreset.active ? (
                  <span>
                    Repo preset applies: preamble {currentPreset.preambleLength} chars
                    {currentPreset.seedLength > 0 ? ` · seed ${currentPreset.seedLength} chars` : ' · no seed'}
                    {currentPreset.capped ? ' · capped' : ''} — view
                  </span>
                ) : (
                  <span>Repo preset present but disabled</span>
                )}
              </button>
              {presetExpanded && (
                <div className="repo-preset-detail" data-testid="repo-preset-detail">
                  {currentPreset.preamble && (
                    <div className="repo-preset-field">
                      <div className="repo-preset-label">Preamble (system prompt, every turn)</div>
                      <pre className="repo-preset-text" data-testid="repo-preset-preamble">{currentPreset.preamble}</pre>
                    </div>
                  )}
                  {currentPreset.seed && (
                    <div className="repo-preset-field">
                      <div className="repo-preset-label">Seed (staged editable into the composer)</div>
                      <pre className="repo-preset-text" data-testid="repo-preset-seed">{currentPreset.seed}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
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
              ? availableProviders.map(p => {
                  const unready = p.auth?.ready === false
                  // #4340: keep <option> labels short. Pre-#4340 the full
                  // auth.hint was inlined here ("Codex (CLI) — set
                  // OPENAI_API_KEY or run `codex login`"); native <select>
                  // rendering truncated long labels in some browser/OS
                  // combos and backticks rendered as literal characters.
                  // The hint now surfaces in the help panel below the
                  // dropdown — see provider-fix-hint. We keep the option
                  // enabled (vs the pre-#4340 disabled=true) so the user
                  // can navigate to any provider to read its fix-hint;
                  // submit is gated separately on auth.ready.
                  const baseLabel = PROVIDER_LABELS[p.name] || p.name
                  const optionLabel = unready ? `${baseLabel} (unavailable)` : baseLabel
                  // Mirror the live detail via title= so desktop hover
                  // tooltips still work for users who don't navigate to
                  // the option. Mobile/touch users see the panel instead.
                  const tooltip = unready ? (p.auth?.detail || p.auth?.hint || 'credentials missing') : undefined
                  return (
                    <option
                      key={p.name}
                      value={p.name}
                      title={tooltip}
                    >
                      {optionLabel}
                    </option>
                  )
                })
              : <>
                  <option value="claude-sdk">Claude Code (SDK)</option>
                  <option value="claude-cli">Claude Code (CLI)</option>
                </>
            }
          </select>
          {/* Live auth detail from the server (#3404 audit F5) wins over the
              static date-gated fallback so the user sees the actual billing
              identity, not a generic "uses API credits" hint. The fallback
              itself is era-gated client-side (#5629) so a client that renders
              before the live provider list arrives still shows the right
              subscription-vs-credit-pool copy. Suppressed when the selected
              provider is unready — the fix-hint panel below replaces it so the
              user isn't reading billing copy for a provider they can't launch. */}
          {selectedProviderUnready ? null : (() => {
            const live = availableProviders.find(p => p.name === provider)?.auth
            const text = live?.detail || providerBillingFallback(provider)
            if (!text) return null
            return (
              <span
                className="provider-billing-hint"
                data-testid="provider-billing-hint"
                data-source={live?.source ?? 'static'}
              >
                {text}
              </span>
            )
          })()}
        </div>
        {/* #4340: richer fix-hint affordance for disabled providers. The
            pre-#4340 inline `<option>` label couldn't render long hints
            cleanly (truncation + literal backticks + hover-only title).
            This panel appears under the dropdown when the selected
            provider is unready, surfacing the full auth.detail / auth.hint
            with backtick-wrapped tokens promoted to `<code>` so commands
            like `codex login` look like commands. */}
        {selectedProviderUnready && (() => {
          const live = availableProviders.find(p => p.name === provider)?.auth
          const hint = live?.hint || 'credentials missing'
          const detail = live?.detail
          return (
            <div
              className="provider-fix-hint"
              data-testid="provider-fix-hint"
              role="status"
              aria-live="polite"
            >
              <span className="provider-fix-hint-label">How to enable:</span>{' '}
              <span className="provider-fix-hint-body">
                {renderHintWithCode(hint).map((part, i) =>
                  typeof part === 'string'
                    ? <span key={i}>{part}</span>
                    : <code key={i}>{part.code}</code>,
                )}
              </span>
              {detail && detail !== hint && (
                <span className="provider-fix-hint-detail">
                  {renderHintWithCode(detail).map((part, i) =>
                    typeof part === 'string'
                      ? <span key={i}>{part}</span>
                      : <code key={i}>{part.code}</code>,
                  )}
                </span>
              )}
            </div>
          )
        })()}
        {availableProviders.length > 0 && (() => {
          const selected = availableProviders.find(p => p.name === provider)
          if (!selected?.capabilities) return null
          const badges = CAPABILITY_BADGES.filter(([key]) => selected.capabilities[key])
          if (badges.length === 0) return null
          return (
            <div className="provider-capabilities" data-testid="provider-capabilities">
              {badges.map(([key, label]) => (
                // #5026: data-capability lets CSS pick out the
                // containerized badge for a distinct chrome so the eye
                // reads "this provider is sandboxed" at a glance,
                // without changing how the other badges render.
                <span
                  key={label}
                  className="capability-badge"
                  data-capability={key}
                >{label}</span>
              ))}
            </div>
          )
        })()}
        {/* #6312: a non-blocking limitation note for a reduced-capability
            provider (notably claude-tui — no plan mode / streaming / model
            switch). Explains the absent affordances rather than leaving the
            user to infer the gap from a missing control. */}
        {availableProviders.length > 0 && (() => {
          const selected = availableProviders.find(p => p.name === provider)
          const note = buildProviderLimitationNote(selected?.capabilities)
          if (!note) return null
          return (
            <div className="provider-limitation-note" data-testid="provider-limitation-note">
              {note}
            </div>
          )
        })()}
        {/* #5026: when a containerized provider is selected and the
            user hasn't yet picked an environment, hint at the Environments
            panel as the path for customising image / memory / cpu /
            containerUser. The provider will fall back to its built-in
            defaults (node:22-slim, 2g, 2 cpus, chroxy user) when launched
            without an environmentId. Once an environment is selected we
            hide the hint — the Environment dropdown's own form-hint
            ("Connect to a persistent environment container") takes over
            and tells the user what they'll get. (#5036 Copilot review:
            without the !environmentId gate, the hint and the dropdown
            both ended up describing the same thing.) */}
        {availableProviders.length > 0 && selectedProviderInfo?.capabilities?.containerized && !selectedProviderUnready && !environmentId && (
          <div
            className="provider-container-hint"
            data-testid="provider-container-hint"
            role="note"
          >
            <span className="provider-container-hint-label">Container settings:</span>{' '}
            <span className="provider-container-hint-body">
              {environments.length > 0
                ? 'Pick an Environment in Advanced to use its image / memory / CPU. Otherwise the provider defaults apply (node:22-slim, 2g RAM, 2 CPUs).'
                : 'Uses the provider defaults (node:22-slim, 2g RAM, 2 CPUs). Open the Environments panel to create one with a custom image / memory / CPU / container user.'}
            </span>
          </div>
        )}
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
              aria-describedby="permission-mode-hint"
            >
              <option value="">Server default</option>
              {/* #4019: options driven by availablePermissionModes from the
                  store so the labels stay in sync with the server's
                  PERMISSION_MODES table. Cold-start fallback labels match
                  server PERMISSION_MODES (handler-utils.js:19-22) exactly
                  — so the selected option text doesn't flicker mid-init
                  when the available_permission_modes message lands.
                  (#4211 Copilot review.) */}
              {(availablePermissionModes.length > 0 ? availablePermissionModes : [
                { id: 'approve', label: 'Approve' },
                { id: 'acceptEdits', label: 'Accept Edits' },
                { id: 'auto', label: 'Auto (skip all prompts)' },
                { id: 'plan', label: 'Plan' },
              ]).map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <span id="permission-mode-hint" className="form-hint">
              {/* #4019: hint sourced from availablePermissionModes[].description
                  (server's PERMISSION_MODES table). Falls back to the
                  pre-#4019 hardcoded strings when the server didn't send a
                  description for the selected mode (older server or empty
                  selection). */}
              {(() => {
                const selected = availablePermissionModes.find((m) => m.id === permissionMode)
                if (selected?.description) return selected.description
                if (permissionMode === 'auto') {
                  return 'Equivalent to `claude --dangerously-skip-permissions`. Every tool call auto-approves with no prompt.'
                }
                if (permissionMode === 'acceptEdits') {
                  return 'Read/Write/Edit/Grep/Glob/NotebookEdit auto-approve. Bash, MCP, and other tools still gate on approval.'
                }
                if (permissionMode === 'plan') {
                  return 'Claude is asked to plan before acting; each tool call still gates on your approval.'
                }
                if (permissionMode === 'approve') {
                  return 'Default. Each tool call gates on your approval in the dashboard or mobile app.'
                }
                return 'Uses whatever the server’s --default-permission-mode was set to (usually Approve).'
              })()}
            </span>
          </div>
          {/* #6689: Codex-only sandbox selector. Codex applies the sandbox at
              thread start, so this is a create-time choice; changing it later
              needs a new session (see docs/design/codex-permission-model.md §5).
              Hidden for every non-codex provider (they ignore the field). The
              options + labels are single-sourced from CODEX_SANDBOX_MODE_META so
              the picker can't drift from the wire enum. */}
          {provider === CODEX_PROVIDER && (
            <div className="form-field" data-testid="codex-sandbox-field">
              <label htmlFor="codex-sandbox-select">Codex sandbox</label>
              <select
                id="codex-sandbox-select"
                data-testid="codex-sandbox-select"
                value={codexSandbox}
                onChange={e => setCodexSandbox(e.target.value as '' | CodexSandboxMode)}
                aria-label="Codex sandbox mode"
                aria-describedby="codex-sandbox-hint"
              >
                {/* #6903: "Default" forwards no codexSandbox, so the daemon's
                    CHROXY_CODEX_SANDBOX floor (else workspace-write) is honored
                    — matching the mobile app's Default-provider omit path. */}
                <option value="">Default</option>
                {CODEX_SANDBOX_MODE_META.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <span id="codex-sandbox-hint" className="form-hint">
                {codexSandbox === ''
                  ? "Use the daemon's configured sandbox (CHROXY_CODEX_SANDBOX, else workspace-write)."
                  : CODEX_SANDBOX_MODE_META.find((m) => m.id === codexSandbox)?.description
                    ?? 'Controls how much of the filesystem the Codex sandbox may write.'}
              </span>
            </div>
          )}
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
              <span className="label-text">Isolate filesystem (worktree)</span>
            </label>
            <span id="worktree-hint" className="form-hint">
              {worktree
                ? 'CWD must point to an existing git repository'
                : 'Runs in an isolated git worktree — requires a git repo CWD'}
            </span>
          </div>
          {/* #4208/#4244: TUI-only opt-in to spawn `claude --dangerously-skip-permissions`.
              Hidden for non-TUI providers because:
                - claude-sdk / claude-byok don't accept the flag (different bin)
                - claude-cli already has its own `--dangerously-skip-permissions`
                  wiring on `chroxy resume`, not on create_session
                - docker-* and codex/gemini don't have a comparable concept
              Tri-state radio group (#4244) so the user can submit an explicit
              `false` to override a server launched with
              `chroxy start --dangerously-skip-permissions` (server-wide
              defaultSkipPermissions: true). The submit handler double-checks
              the provider before forwarding the flag. */}
          {provider === 'claude-tui' && (
            <div className="form-field" data-testid="skip-permissions-field" role="radiogroup" aria-labelledby="skip-permissions-legend" aria-describedby="skip-permissions-hint">
              <span id="skip-permissions-legend" className="form-field-label">
                Permission prompts
              </span>
              <label className="radio-label">
                <input
                  type="radio"
                  name="skip-permissions"
                  data-testid="skip-permissions-radio-inherit"
                  value="inherit"
                  checked={skipPermissions === 'inherit'}
                  onChange={() => setSkipPermissions('inherit')}
                />
                <span className="label-text">Use server default</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="skip-permissions"
                  data-testid="skip-permissions-radio-off"
                  value="off"
                  checked={skipPermissions === 'off'}
                  onChange={() => setSkipPermissions('off')}
                />
                <span className="label-text">Require permission prompts (override server default)</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="skip-permissions"
                  data-testid="skip-permissions-radio-on"
                  value="on"
                  checked={skipPermissions === 'on'}
                  onChange={() => setSkipPermissions('on')}
                />
                <span className="label-text">Skip permission prompts (dangerous)</span>
              </label>
              <span id="skip-permissions-hint" className="form-hint form-hint--warning">
                &ldquo;Skip&rdquo; spawns the claude TUI with <code>--dangerously-skip-permissions</code> and
                disables chroxy&rsquo;s tool-call gate entirely. Every tool runs with no
                prompt and no audit trail. Use only in trusted contexts (e.g. isolated
                workspace, throwaway worktree, or container).
              </span>
            </div>
          )}
          {environments.length > 0 && (
            <div className="form-field">
              <label htmlFor="env-select">Environment</label>
              <select
                id="env-select"
                value={environmentId}
                onChange={e => setEnvironmentId(e.target.value)}
                aria-describedby="env-hint"
              >
                <option value="">None (ephemeral container)</option>
                {environments.filter(e => e.status === 'running').map(e => (
                  <option key={e.id} value={e.id}>{e.name} ({e.image})</option>
                ))}
              </select>
              <span id="env-hint" className="form-hint">
                Connect to a persistent environment container
              </span>
            </div>
          )}
        </div>
      )}
      {serverError && (
        <span className="form-error" role="alert">{serverError}</span>
      )}
      <div className="modal-buttons">
        <button className="btn-modal-cancel" onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className="btn-modal-create"
          onClick={submit}
          type="button"
          disabled={isCreating || selectedProviderUnready}
          title={selectedProviderUnready ? 'Selected provider is not configured — see fix-hint above' : undefined}
        >
          {isCreating ? 'Creating...' : 'Create'}
        </button>
      </div>
    </Modal>
  )
}
