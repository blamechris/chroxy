/**
 * CreateSessionModal permission-mode hint precedence (#4214 / #4019 follow-up)
 *
 * PR #4211 wired the hint paragraph under the Permission Mode picker to
 * prefer `availablePermissionModes[].description` (server-provided) over
 * the pre-#4019 hardcoded fallback strings. Without these tests the
 * precedence is not pinned: a future refactor could re-break the order
 * (e.g. "always use fallback") and only show up on a customer report.
 *
 * Pins:
 *   1. description-wins — when the selected mode carries a server
 *      description, the hint renders the description (NOT the fallback).
 *   2. fallback-wins — when the selected mode has no description (older
 *      server, or a mode the server hasn't enumerated), the hint renders
 *      the hardcoded fallback string for that mode id.
 *   3. server-default-wins — when no mode is selected (empty-string
 *      "Server default" option), the hint renders the
 *      `--default-permission-mode` explainer copy rather than blank.
 *
 * All assertions read the hint via the `#permission-mode-hint` span
 * (the same selector the modal's aria-describedby points at).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'

// The mock reads this shared object so each test can install its own
// store snapshot before render. vi.mock() is hoisted, so the mock
// implementation can only close over module-scope state — not test-local
// closures.
const mockStoreState: Record<string, unknown> = {}

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(mockStoreState),
}))

import { CreateSessionModal, type CreateSessionModalProps } from './CreateSessionModal'

beforeEach(() => {
  // Reset to a known-empty baseline. Individual tests overwrite the
  // fields they care about. Without this reset the second test would
  // inherit the first test's availablePermissionModes value.
  for (const k of Object.keys(mockStoreState)) delete mockStoreState[k]
  Object.assign(mockStoreState, {
    defaultProvider: 'claude-sdk',
    defaultModel: null,
    modelsByProvider: {},
    availableProviders: [{
      name: 'claude-sdk',
      capabilities: { permissionFloor: true, autoPermissionMode: true },
    }],
    availablePermissionModes: [],
    sessions: [{ sessionId: 'active-session', provider: 'claude-sdk' }],
    activeSessionId: 'active-session',
    environments: [],
    requestDirectoryListing: () => {},
    setDirectoryListingCallback: () => {},
    defaultCwd: null,
  })
})

afterEach(cleanup)

function renderModal(props: Partial<CreateSessionModalProps> = {}) {
  const onCreate = vi.fn()
  const onClose = vi.fn()
  const defaultProps: CreateSessionModalProps = {
    open: true,
    onClose,
    onCreate,
    initialCwd: '',
    knownCwds: [],
    existingNames: [],
    ...props,
  }
  return render(<CreateSessionModal {...defaultProps} />)
}

function getHint(container: HTMLElement): string {
  const hint = container.querySelector('#permission-mode-hint')
  expect(hint, 'hint span must be present in the modal').toBeTruthy()
  return (hint?.textContent ?? '').trim()
}

function expandAdvanced(container: HTMLElement) {
  // The permission-mode picker lives inside the collapsed "Advanced"
  // section, which defaults to closed. Click the toggle once so the
  // select + hint span actually mount. Use the toggle's CSS class
  // (advanced-toggle-btn) — querying `[aria-expanded]` would also
  // pick up the cwd combobox input.
  const toggle = container.querySelector('.advanced-toggle-btn') as HTMLElement | null
  expect(toggle, 'advanced-section toggle must be present').toBeTruthy()
  if (toggle?.getAttribute('aria-expanded') === 'false') {
    fireEvent.click(toggle)
  }
}

function selectPermissionMode(container: HTMLElement, modeId: string) {
  expandAdvanced(container)
  const select = container.querySelector('select[aria-label="Permission mode"]') as HTMLSelectElement | null
  expect(select, 'permission-mode select must be present').toBeTruthy()
  fireEvent.change(select!, { target: { value: modeId } })
}

describe('CreateSessionModal permission-mode hint (#4214)', () => {
  it('disables Auto when the selected provider adapter cannot enforce the floor', () => {
    mockStoreState.defaultProvider = 'codex'
    mockStoreState.availableProviders = [
      { name: 'claude-sdk', capabilities: { permissionFloor: true, autoPermissionMode: true } },
      { name: 'codex', label: 'Codex', capabilities: { permissionFloor: false, autoPermissionMode: false } },
    ]
    mockStoreState.availablePermissionModes = [
      { id: 'approve', label: 'Approve', supported: true, enforcement: 'chroxy' },
      { id: 'auto', label: 'Auto', supported: true, enforcement: 'chroxy' },
    ]
    const { container } = renderModal()
    expandAdvanced(container)
    const auto = container.querySelector('option[value="auto"]') as HTMLOptionElement | null
    expect(auto?.disabled).toBe(true)
    expect(auto?.textContent).toMatch(/unavailable/i)
  })

  it('keeps SDK Auto available when the active-session roster came from unsupported Codex Auto', () => {
    mockStoreState.defaultProvider = 'claude-sdk'
    mockStoreState.sessions = [{ sessionId: 'active-session', provider: 'codex' }]
    mockStoreState.availableProviders = [
      { name: 'claude-sdk', label: 'Claude SDK', capabilities: { permissionFloor: true, autoPermissionMode: true } },
      { name: 'codex', capabilities: { permissionFloor: false, autoPermissionMode: false } },
    ]
    mockStoreState.availablePermissionModes = [
      { id: 'approve', label: 'Approve', supported: true, enforcement: 'chroxy' },
      { id: 'auto', label: 'Auto (unavailable)', supported: false, enforcement: 'unsupported' },
    ]
    const { container } = renderModal()
    expandAdvanced(container)
    const auto = container.querySelector('option[value="auto"]') as HTMLOptionElement | null
    expect(auto?.disabled).toBe(false)
  })

  it('renders the server-provided description when the selected mode has one', () => {
    // Custom description that does NOT overlap with any hardcoded
    // fallback substring — proves the description path produced the
    // text, not the fallback (which would have its own distinct copy).
    mockStoreState.availablePermissionModes = [
      { id: 'approve', label: 'Approve', description: 'SERVER-PROVIDED DESCRIPTION FOR APPROVE.', supported: true, enforcement: 'chroxy' },
      { id: 'plan',    label: 'Plan',    description: 'SERVER-PROVIDED DESCRIPTION FOR PLAN.', supported: true, enforcement: 'chroxy' },
    ]
    const { container } = renderModal()

    selectPermissionMode(container, 'approve')
    expect(getHint(container)).toBe('SERVER-PROVIDED DESCRIPTION FOR APPROVE.')

    selectPermissionMode(container, 'plan')
    expect(getHint(container)).toBe('SERVER-PROVIDED DESCRIPTION FOR PLAN.')
  })

  it('falls back to the hardcoded string when the selected mode has no description', () => {
    // Mode is enumerated by the server but `description` is missing —
    // this is the pre-#4018 server shape. Verifies the fallback chain
    // is still wired and matches each mode id.
    mockStoreState.availablePermissionModes = [
      { id: 'approve',     label: 'Approve' },
      { id: 'auto',        label: 'Auto' },
      { id: 'acceptEdits', label: 'Accept Edits' },
      { id: 'plan',        label: 'Plan' },
    ]
    const { container } = renderModal()

    selectPermissionMode(container, 'auto')
    expect(getHint(container)).toMatch(/Protected paths and secret reads always require a Chroxy prompt/)

    selectPermissionMode(container, 'acceptEdits')
    expect(getHint(container)).toMatch(/Read\/Write\/Edit\/NotebookEdit\/Glob\/Grep/)

    selectPermissionMode(container, 'plan')
    expect(getHint(container)).toMatch(/asked to plan before acting/)

    selectPermissionMode(container, 'approve')
    expect(getHint(container)).toMatch(/Tool approval requests sent by the provider are shown/)
  })

  it('uses selected-provider copy for every supported mode when the active roster belongs to SDK', () => {
    mockStoreState.defaultProvider = 'codex'
    mockStoreState.availableProviders = [
      { name: 'claude-sdk', capabilities: { permissionFloor: true, autoPermissionMode: true } },
      { name: 'codex', capabilities: { permissionFloor: false, autoPermissionMode: false } },
    ]
    mockStoreState.availablePermissionModes = [
      { id: 'approve', label: 'Approve', description: 'STALE SDK APPROVE', supported: true, enforcement: 'chroxy' },
      { id: 'acceptEdits', label: 'Accept Edits', description: 'STALE SDK EDIT', supported: true, enforcement: 'chroxy' },
      { id: 'auto', label: 'Auto', description: 'STALE SDK AUTO', supported: true, enforcement: 'chroxy' },
      { id: 'plan', label: 'Plan', description: 'STALE SDK PLAN', supported: true, enforcement: 'chroxy' },
    ]
    const { container } = renderModal()

    for (const [mode, expected] of [
      ['approve', /sandbox-authorized actions may run without a request/],
      ['acceptEdits', /apply_patch/],
      ['plan', /has no plan enforcement/],
    ] as const) {
      selectPermissionMode(container, mode)
      expect(getHint(container)).toMatch(expected)
      expect(getHint(container)).toMatch(/enforcement is not reported by this provider/i)
      expect(getHint(container)).not.toMatch(/STALE SDK/)
    }

    const auto = container.querySelector('option[value="auto"]') as HTMLOptionElement | null
    expect(auto?.disabled).toBe(true)
    expect(auto?.textContent).toMatch(/unavailable/i)
  })

  it('uses selected-provider copy for all four modes when the active roster belongs to Codex', () => {
    mockStoreState.defaultProvider = 'claude-sdk'
    mockStoreState.sessions = [{ sessionId: 'active-session', provider: 'codex' }]
    mockStoreState.availableProviders = [
      { name: 'claude-sdk', capabilities: { permissionFloor: true, autoPermissionMode: true } },
      { name: 'codex', capabilities: { permissionFloor: false, autoPermissionMode: false } },
    ]
    mockStoreState.availablePermissionModes = [
      { id: 'approve', label: 'Approve', description: 'STALE CODEX APPROVE', supported: true, enforcement: 'unknown' },
      { id: 'acceptEdits', label: 'Accept Edits', description: 'STALE CODEX EDIT', supported: true, enforcement: 'unknown' },
      { id: 'auto', label: 'Auto (unavailable)', description: 'STALE CODEX AUTO', supported: false, enforcement: 'unsupported' },
      { id: 'plan', label: 'Plan', description: 'STALE CODEX PLAN', supported: true, enforcement: 'unknown' },
    ]
    const { container } = renderModal()

    for (const mode of ['approve', 'acceptEdits', 'auto', 'plan']) {
      selectPermissionMode(container, mode)
      expect(getHint(container)).toMatch(/always require a Chroxy prompt/i)
      expect(getHint(container)).not.toMatch(/STALE CODEX/)
      expect(getHint(container)).not.toMatch(/enforcement is not reported/i)
    }
    const auto = container.querySelector('option[value="auto"]') as HTMLOptionElement | null
    expect(auto?.disabled).toBe(false)
    expect(auto?.textContent).toBe('Auto')
  })

  it('keeps Auto available but uses conservative copy for an unknown provider', () => {
    mockStoreState.defaultProvider = 'future-provider'
    mockStoreState.availableProviders = [
      { name: 'claude-sdk', capabilities: { permissionFloor: true, autoPermissionMode: true } },
      { name: 'future-provider', capabilities: { autoPermissionMode: true } },
    ]
    mockStoreState.availablePermissionModes = [
      { id: 'auto', label: 'Auto', description: 'STALE SDK AUTO', supported: true, enforcement: 'chroxy' },
    ]
    const { container } = renderModal()

    selectPermissionMode(container, 'auto')
    expect(getHint(container)).toMatch(/enforcement is not reported by this provider/i)
    expect(getHint(container)).not.toMatch(/always require a Chroxy prompt/i)
    expect(getHint(container)).not.toMatch(/STALE SDK/)
    const auto = container.querySelector('option[value="auto"]') as HTMLOptionElement | null
    expect(auto?.disabled).toBe(false)
  })

  it('does not reuse provider-specific copy when both providers report unknown enforcement', () => {
    mockStoreState.defaultProvider = 'future-provider'
    mockStoreState.sessions = [{ sessionId: 'active-session', provider: 'codex' }]
    mockStoreState.availableProviders = [
      { name: 'codex', capabilities: { permissionFloor: false, autoPermissionMode: false } },
      { name: 'future-provider', capabilities: { autoPermissionMode: true } },
    ]
    mockStoreState.availablePermissionModes = [
      {
        id: 'approve',
        label: 'Approve',
        description: 'Codex-specific stale copy: sandbox-authorized actions may run.',
        supported: true,
        enforcement: 'unknown',
      },
    ]
    const { container } = renderModal()

    selectPermissionMode(container, 'approve')
    expect(getHint(container)).toMatch(/Tool approval requests sent by the provider are shown/)
    expect(getHint(container)).toMatch(/enforcement is not reported by this provider/i)
    expect(getHint(container)).not.toMatch(/Codex-specific stale copy/)
  })

  it('falls back to the server-default copy when no mode is selected', () => {
    // The empty-string "Server default" option preserves whatever the
    // server's --default-permission-mode was. This is the initial
    // state — the user hasn't picked anything yet — and the hint must
    // explain it rather than render blank.
    mockStoreState.availablePermissionModes = []
    const { container } = renderModal()
    expandAdvanced(container)
    expect(getHint(container)).toMatch(/Uses whatever the server.s --default-permission-mode/)
  })
})
