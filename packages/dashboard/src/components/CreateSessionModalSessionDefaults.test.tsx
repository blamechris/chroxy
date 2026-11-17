/**
 * #8265 — New Session says where its provider came from, warns on claude-cli,
 * and shows the one-time notice when a legacy saved default was cleared.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, fireEvent, cleanup, screen } from '@testing-library/react'

const mockStoreState: Record<string, unknown> = {}

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(mockStoreState),
}))

import { CreateSessionModal, sessionDefaultsNoticeText, sessionDefaultsNoticeApplies } from './CreateSessionModal'

const READY = { ready: true, source: 'login', envVar: null, envVars: [], detail: '', hint: '' }
const PROVIDERS = [
  { name: 'claude-sdk', capabilities: {}, auth: READY },
  { name: 'claude-cli', capabilities: {}, auth: READY },
  { name: 'claude-tui', capabilities: {}, auth: READY },
]

beforeEach(() => {
  for (const k of Object.keys(mockStoreState)) delete mockStoreState[k]
  Object.assign(mockStoreState, {
    defaultProvider: 'claude-sdk',
    defaultProviderSource: 'server',
    sessionDefaultsNotice: null,
    dismissSessionDefaultsNotice: vi.fn(),
    defaultModel: '',
    modelsByProvider: {},
    availableProviders: PROVIDERS,
    permissionModesByProvider: {},
    environments: [],
    requestDirectoryListing: () => {},
    setDirectoryListingCallback: () => {},
    defaultCwd: null,
  })
})

afterEach(cleanup)

function renderModal() {
  return render(
    <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} initialCwd="/tmp/x" knownCwds={[]} existingNames={[]} />,
  )
}

describe('CreateSessionModal session-default source (#8265)', () => {
  it('labels an inherited preselection "Server default"', () => {
    renderModal()
    expect(screen.getByTestId('provider-default-source').textContent).toBe('Server default')
  })

  it('labels a deliberate override as the user\'s own', () => {
    mockStoreState.defaultProviderSource = 'user'
    renderModal()
    expect(screen.getByTestId('provider-default-source').textContent).toMatch(/Your default, from Settings/)
  })

  it('says nothing before the daemon has answered (built-in fallback)', () => {
    mockStoreState.defaultProviderSource = 'builtin'
    renderModal()
    expect(screen.queryByTestId('provider-default-source')).not.toBeInTheDocument()
  })

  it('drops the source line once the user picks another provider in the dialog', () => {
    renderModal()
    fireEvent.change(screen.getByLabelText('Select provider'), { target: { value: 'claude-tui' } })
    expect(screen.queryByTestId('provider-default-source')).not.toBeInTheDocument()
  })
})

describe('CreateSessionModal claude-cli warning (#8265)', () => {
  it('is absent for claude-sdk and present for claude-cli', () => {
    renderModal()
    expect(screen.queryByTestId('provider-user-settings-warning')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Select provider'), { target: { value: 'claude-cli' } })
    expect(screen.getByTestId('provider-user-settings-warning').textContent).toMatch(/user-level Claude settings/)
  })

  it('shows on a deliberate claude-cli override too, next to the source line', () => {
    mockStoreState.defaultProvider = 'claude-cli'
    mockStoreState.defaultProviderSource = 'user'
    renderModal()
    expect(screen.getByTestId('provider-user-settings-warning')).toBeInTheDocument()
    expect(screen.getByTestId('provider-default-source').textContent).toMatch(/Your default/)
  })
})

describe('CreateSessionModal migration notice (#8265)', () => {
  it('renders the cleared legacy values and dismisses through the store', () => {
    const dismiss = vi.fn()
    mockStoreState.sessionDefaultsNotice = { provider: 'claude-cli', model: 'opus-4-6' }
    mockStoreState.dismissSessionDefaultsNotice = dismiss
    renderModal()
    const notice = screen.getByTestId('session-defaults-notice')
    expect(notice.textContent).toMatch(/Claude Code \(CLI\)/)
    expect(notice.textContent).toMatch(/opus-4-6/)
    fireEvent.click(screen.getByTestId('session-defaults-notice-dismiss'))
    expect(dismiss).toHaveBeenCalledTimes(1)
  })

  it('is absent when nothing was migrated', () => {
    renderModal()
    expect(screen.queryByTestId('session-defaults-notice')).not.toBeInTheDocument()
  })

  it('copy names only what was cleared', () => {
    expect(sessionDefaultsNoticeText({ model: 'opus-4-6' })).toBe(
      "A saved default from an older version was cleared (model opus-4-6). New sessions now use the provider's own default model. To keep the old choice, pick it again in Settings → Session Defaults.",
    )
    expect(sessionDefaultsNoticeText({ provider: 'claude-tui' })).toMatch(/\(provider .+\)\. New sessions now use the server's default provider\./)
  })
})

describe('CreateSessionModal migration notice scoping (#8611)', () => {
  const PROVIDERS_WITH_CODEX = [...PROVIDERS, { name: 'codex', capabilities: {}, auth: READY }]

  it('shows for a Claude provider and hides after switching to Codex', () => {
    mockStoreState.availableProviders = PROVIDERS_WITH_CODEX
    mockStoreState.sessionDefaultsNotice = { model: 'opus-4-6' }
    renderModal()
    expect(screen.getByTestId('session-defaults-notice')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Select provider'), { target: { value: 'codex' } })
    expect(screen.queryByTestId('session-defaults-notice')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Select provider'), { target: { value: 'claude-sdk' } })
    expect(screen.getByTestId('session-defaults-notice')).toBeInTheDocument()
  })

  it('stays dismissed: a null store notice renders nothing on any provider', () => {
    mockStoreState.availableProviders = PROVIDERS_WITH_CODEX
    mockStoreState.sessionDefaultsNotice = null
    renderModal()
    expect(screen.queryByTestId('session-defaults-notice')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Select provider'), { target: { value: 'codex' } })
    fireEvent.change(screen.getByLabelText('Select provider'), { target: { value: 'claude-sdk' } })
    expect(screen.queryByTestId('session-defaults-notice')).not.toBeInTheDocument()
  })

  it('applies to Claude-family and docker providers only', () => {
    const n = { model: 'opus-4-6' }
    expect(sessionDefaultsNoticeApplies(n, 'claude-sdk')).toBe(true)
    expect(sessionDefaultsNoticeApplies(n, 'docker-byok')).toBe(true)
    expect(sessionDefaultsNoticeApplies(n, 'codex')).toBe(false)
    expect(sessionDefaultsNoticeApplies(n, 'gemini')).toBe(false)
    expect(sessionDefaultsNoticeApplies(null, 'claude-sdk')).toBe(false)
  })
})

describe('CreateSessionModal select styling (#8611)', () => {
  it('every select sits inside the session-form box that carries the dark control style', () => {
    mockStoreState.availableProviders = [{ name: 'codex', capabilities: {}, auth: READY }]
    mockStoreState.defaultProvider = 'codex'
    renderModal()
    fireEvent.click(screen.getByText(/Advanced/))
    const selects = document.querySelectorAll('select')
    expect(selects.length).toBeGreaterThanOrEqual(3)
    selects.forEach(s => expect(s.closest('.modal-content--session-form')).not.toBeNull())
  })
})

describe('CreateSessionModal effective provider (#8277)', () => {
  it('falls back to the first offered provider when the saved default is not offered', () => {
    mockStoreState.availableProviders = [{ name: 'codex', capabilities: {}, auth: READY }, { name: 'claude-sdk', capabilities: {}, auth: READY }]
    mockStoreState.defaultProvider = 'claude-tui'
    // The notice only applies to Claude-family providers, so its absence proves
    // the form's provider STATE is codex, not just what the select displays.
    mockStoreState.sessionDefaultsNotice = { model: 'opus-4-6' }
    renderModal()
    expect((screen.getByLabelText('Select provider') as HTMLSelectElement).value).toBe('codex')
    expect(screen.queryByTestId('session-defaults-notice')).not.toBeInTheDocument()
  })
})
