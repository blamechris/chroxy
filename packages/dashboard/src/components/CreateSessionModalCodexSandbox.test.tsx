/**
 * Tests for the codex-only sandbox selector on the Create Session modal (#6689).
 *
 * The control MUST:
 *   - render only when the active provider is `codex`
 *   - default to `workspace-write` on fresh open
 *   - forward the chosen mode as `codexSandbox` for a codex session
 *   - NOT forward `codexSandbox` for a non-codex provider
 *
 * The options + labels are single-sourced from `@chroxy/protocol`'s
 * `CODEX_SANDBOX_MODE_META`, so a drift there would surface here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

const CODEX_PROVIDER = {
  name: 'codex',
  capabilities: {},
  auth: { ready: true, source: 'static', detail: '' },
}
const SDK_PROVIDER = {
  name: 'claude-sdk',
  capabilities: {},
  auth: { ready: true, source: 'static', detail: '' },
}

function mockStore(defaultProvider: string, providers = [CODEX_PROVIDER, SDK_PROVIDER]) {
  vi.doMock('../store/connection', () => ({
    useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        defaultProvider,
        defaultModel: null,
        availableModels: [],
        availableModelsProvider: null,
        availableProviders: providers,
        availablePermissionModes: [],
        environments: [],
        requestDirectoryListing: () => {},
        setDirectoryListingCallback: () => {},
        defaultCwd: null,
      }),
  }))
}

afterEach(() => {
  cleanup()
  vi.resetModules()
  vi.doUnmock('../store/connection')
})

const baseProps = {
  open: true,
  onClose: vi.fn(),
  initialCwd: '/Users/me/projects',
  knownCwds: [] as string[],
  existingNames: [] as string[],
}

async function loadModal() {
  const mod = await import('./CreateSessionModal')
  return mod.CreateSessionModal
}

function openAdvanced() {
  fireEvent.click(screen.getByRole('button', { name: /advanced/i }))
}

describe('CreateSessionModal codex sandbox selector (#6689)', () => {
  it('renders the sandbox selector when the active provider is codex', async () => {
    mockStore('codex')
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} onCreate={vi.fn()} />)
    openAdvanced()
    expect(screen.getByTestId('codex-sandbox-field')).toBeInTheDocument()
    expect(screen.getByTestId('codex-sandbox-select')).toBeInTheDocument()
  })

  it('does NOT render the selector for a non-codex provider (claude-sdk)', async () => {
    mockStore('claude-sdk')
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} onCreate={vi.fn()} />)
    openAdvanced()
    expect(screen.queryByTestId('codex-sandbox-field')).not.toBeInTheDocument()
    expect(screen.queryByTestId('codex-sandbox-select')).not.toBeInTheDocument()
  })

  it('defaults to workspace-write on fresh open', async () => {
    mockStore('codex')
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} onCreate={vi.fn()} />)
    openAdvanced()
    const select = screen.getByTestId('codex-sandbox-select') as HTMLSelectElement
    expect(select.value).toBe('workspace-write')
  })

  it('offers all three sandbox modes', async () => {
    mockStore('codex')
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} onCreate={vi.fn()} />)
    openAdvanced()
    const select = screen.getByTestId('codex-sandbox-select') as HTMLSelectElement
    const values = Array.from(select.options).map((o) => o.value)
    expect(values).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })

  it('forwards codexSandbox: workspace-write by default for a codex session', async () => {
    mockStore('codex')
    const CreateSessionModal = await loadModal()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onCreate={onCreate} />)
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0]![0]).toMatchObject({
      provider: 'codex',
      codexSandbox: 'workspace-write',
    })
  })

  it('forwards the chosen sandbox mode when changed', async () => {
    mockStore('codex')
    const CreateSessionModal = await loadModal()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onCreate={onCreate} />)
    openAdvanced()
    const select = screen.getByTestId('codex-sandbox-select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'read-only' } })
    expect(select.value).toBe('read-only')
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0]![0]).toMatchObject({
      provider: 'codex',
      codexSandbox: 'read-only',
    })
  })

  it('does NOT forward codexSandbox for a non-codex provider', async () => {
    mockStore('claude-sdk')
    const CreateSessionModal = await loadModal()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onCreate={onCreate} />)
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0]![0].codexSandbox).toBeUndefined()
  })
})
