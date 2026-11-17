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

  it('#9175: the server capability decides when present, the name only when absent', () => {
    const n = { model: 'opus-4-6' }
    const fam = (v: boolean) => ({ capabilities: { thinkingLevelLegacyFallback: v } })
    // claude-byok has no `claude-sdk`-style special case: the capability says yes
    expect(sessionDefaultsNoticeApplies(n, 'claude-byok', fam(true))).toBe(true)
    // a provider whose name does not match the pattern but is Claude-family
    expect(sessionDefaultsNoticeApplies(n, 'my-claude-proxy', fam(true))).toBe(true)
    // explicit false beats a matching name
    expect(sessionDefaultsNoticeApplies(n, 'claude-lookalike', fam(false))).toBe(false)
    for (const p of ['codex', 'gemini', 'ollama', 'deepseek', 'openai-compatible']) {
      expect(sessionDefaultsNoticeApplies(n, p, fam(false))).toBe(false)
    }
    // field absent (older daemon): name fallback
    expect(sessionDefaultsNoticeApplies(n, 'claude-byok', { capabilities: {} })).toBe(true)
    expect(sessionDefaultsNoticeApplies(n, 'ollama', { capabilities: {} })).toBe(false)
  })

  it('#9175: renders the notice on a byok provider the name pattern would skip', () => {
    mockStoreState.availableProviders = [
      { name: 'my-byok', capabilities: { thinkingLevelLegacyFallback: true }, auth: READY },
      { name: 'codex', capabilities: { thinkingLevelLegacyFallback: false }, auth: READY },
    ]
    mockStoreState.defaultProvider = 'my-byok'
    mockStoreState.sessionDefaultsNotice = { model: 'opus-4-6' }
    renderModal()
    expect(screen.getByTestId('session-defaults-notice')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Select provider'), { target: { value: 'codex' } })
    expect(screen.queryByTestId('session-defaults-notice')).not.toBeInTheDocument()
  })

  it('#9175: every select and option the modal can render carries a title, for every provider', () => {
    const ENVS = [{ id: 'e1', name: 'Env One', image: 'img:1', status: 'running' }]
    const walk = (label: string) => {
      const selects = Array.from(document.querySelectorAll('.modal-content--session-form select'))
      expect(selects.length, label).toBeGreaterThan(0)
      for (const sel of selects) {
        expect((sel as HTMLSelectElement).title, `${label} ${sel.id}`).not.toBe('')
        const opts = Array.from(sel.querySelectorAll('option'))
        expect(opts.length, `${label} ${sel.id} options`).toBeGreaterThan(0)
        for (const opt of opts) {
          expect(opt.title, `${label} ${sel.id} option "${opt.value}"`).not.toBe('')
        }
      }
      return selects.map(s => s.id)
    }
    const seen = new Set<string>()
    const names = [...PROVIDERS_WITH_CODEX.map(p => p.name), null]
    for (const name of names) {
      mockStoreState.availableProviders = name === null
        ? []
        : PROVIDERS_WITH_CODEX.map(p => ({ ...p, capabilities: { ...p.capabilities, containerized: true } }))
      mockStoreState.defaultProvider = name ?? 'claude-sdk'
      mockStoreState.environments = ENVS
      const { unmount } = renderModal()
      fireEvent.click(document.querySelector('.advanced-toggle-btn') as HTMLElement)
      walk(String(name)).forEach(id => seen.add(id))
      unmount()
    }
    // the roster the walk must have reached, so a select that stops rendering
    // cannot silently shrink the coverage
    for (const id of ['provider-select', 'permission-mode-select', 'codex-sandbox-select', 'env-select']) {
      expect(seen.has(id), id).toBe(true)
    }
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

describe('CreateSessionModal first open after the saved default changes (#9181)', () => {
  it('preselects the newly saved provider, not availableProviders[0]', () => {
    const roster = [
      { name: 'claude-cli', capabilities: {}, auth: READY },
      { name: 'codex', capabilities: {}, auth: READY },
      { name: 'gemini', capabilities: {}, auth: READY },
    ]
    mockStoreState.availableProviders = roster
    // Modal state initialises from a saved override this server does not offer...
    mockStoreState.defaultProvider = 'docker-cli'
    const { rerender } = render(
      <CreateSessionModal open={false} onClose={vi.fn()} onCreate={vi.fn()} initialCwd="/tmp/x" knownCwds={[]} existingNames={[]} />,
    )
    // ...then Settings saves an offered provider, and New Session opens for the first time.
    mockStoreState.defaultProvider = 'gemini'
    rerender(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} initialCwd="/tmp/x" knownCwds={[]} existingNames={[]} />,
    )
    expect((screen.getByLabelText('Select provider') as HTMLSelectElement).value).toBe('gemini')
  })

  it('still falls back to the first offered provider when the saved default is not offered', () => {
    mockStoreState.availableProviders = [
      { name: 'codex', capabilities: {}, auth: READY },
      { name: 'gemini', capabilities: {}, auth: READY },
    ]
    mockStoreState.defaultProvider = 'docker-cli'
    renderModal()
    expect((screen.getByLabelText('Select provider') as HTMLSelectElement).value).toBe('codex')
  })
})
