/**
 * Tests for the TUI-only skip-permissions control on the Create Session modal
 * (#4208, #4244).
 *
 * The control is a tri-state radio group (#4244):
 *   - 'inherit' (default) — emits `skipPermissions: undefined`, server applies
 *     its `defaultSkipPermissions` (#4209)
 *   - 'on' — emits `skipPermissions: true`, session spawns with
 *     `--dangerously-skip-permissions` regardless of server default
 *   - 'off' — emits `skipPermissions: false`, explicitly blocks the flag even
 *     when the server was launched with `chroxy start
 *     --dangerously-skip-permissions`. This is the case the pre-#4244 checkbox
 *     could not represent.
 *
 * The control MUST:
 *   - render only when the active provider is `claude-tui`
 *   - default to 'inherit' on fresh modal open
 *   - forward the correct `skipPermissions` value (undefined / true / false)
 *     for each state
 *   - NOT forward the flag even when 'on' is selected if the user switches
 *     provider to something other than claude-tui before submit (belt +
 *     braces; the group hides on provider change, but the underlying state
 *     could theoretically persist mid-render — the submit guard catches it)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

const TUI_PROVIDER = {
  name: 'claude-tui',
  capabilities: {},
  auth: { ready: true, source: 'static', detail: '' },
}
const SDK_PROVIDER = {
  name: 'claude-sdk',
  capabilities: {},
  auth: { ready: true, source: 'static', detail: '' },
}

function mockStore(defaultProvider: string, providers = [TUI_PROVIDER, SDK_PROVIDER]) {
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
  // Dynamic import after vi.doMock so the mocked connection store is
  // picked up by CreateSessionModal at module-eval time.
  const mod = await import('./CreateSessionModal')
  return mod.CreateSessionModal
}

function openAdvanced() {
  fireEvent.click(screen.getByRole('button', { name: /advanced/i }))
}

describe('CreateSessionModal skip-permissions tri-state (#4208, #4244)', () => {
  it('renders the tri-state radio group when active provider is claude-tui', async () => {
    mockStore('claude-tui')
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} onCreate={vi.fn()} />)
    openAdvanced()
    expect(screen.getByTestId('skip-permissions-field')).toBeInTheDocument()
    expect(screen.getByTestId('skip-permissions-radio-inherit')).toBeInTheDocument()
    expect(screen.getByTestId('skip-permissions-radio-on')).toBeInTheDocument()
    expect(screen.getByTestId('skip-permissions-radio-off')).toBeInTheDocument()
  })

  it('defaults to "inherit" on fresh open', async () => {
    mockStore('claude-tui')
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} onCreate={vi.fn()} />)
    openAdvanced()
    const inherit = screen.getByTestId('skip-permissions-radio-inherit') as HTMLInputElement
    const on = screen.getByTestId('skip-permissions-radio-on') as HTMLInputElement
    const off = screen.getByTestId('skip-permissions-radio-off') as HTMLInputElement
    expect(inherit.checked).toBe(true)
    expect(on.checked).toBe(false)
    expect(off.checked).toBe(false)
  })

  it('does NOT render the radio group for non-TUI providers (claude-sdk)', async () => {
    mockStore('claude-sdk')
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} onCreate={vi.fn()} />)
    openAdvanced()
    expect(screen.queryByTestId('skip-permissions-field')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skip-permissions-radio-inherit')).not.toBeInTheDocument()
  })

  it('warning copy on the "on" option calls out the danger explicitly', async () => {
    mockStore('claude-tui')
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} onCreate={vi.fn()} />)
    openAdvanced()
    const hint = screen.getByText(/disables chroxy/i)
    expect(hint).toBeInTheDocument()
    expect(hint.textContent).toMatch(/dangerously-skip-permissions/i)
  })

  it('emits skipPermissions: undefined when "inherit" is selected (default)', async () => {
    mockStore('claude-tui')
    const CreateSessionModal = await loadModal()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onCreate={onCreate} />)
    // Don't open Advanced; the default state is 'inherit'. Submit straight away.
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0]![0].skipPermissions).toBeUndefined()
  })

  it('emits skipPermissions: true when "on" is selected', async () => {
    mockStore('claude-tui')
    const CreateSessionModal = await loadModal()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onCreate={onCreate} />)
    openAdvanced()
    const on = screen.getByTestId('skip-permissions-radio-on') as HTMLInputElement
    fireEvent.click(on)
    expect(on.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0]![0]).toMatchObject({
      provider: 'claude-tui',
      skipPermissions: true,
    })
  })

  it('emits skipPermissions: false when "off" is selected (#4244 — overrides server default)', async () => {
    mockStore('claude-tui')
    const CreateSessionModal = await loadModal()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onCreate={onCreate} />)
    openAdvanced()
    const off = screen.getByTestId('skip-permissions-radio-off') as HTMLInputElement
    fireEvent.click(off)
    expect(off.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    // CRITICAL: must be literal `false`, not `undefined`. Server-side
    // defaultSkipPermissions: true would be honoured if we emitted undefined.
    expect(onCreate.mock.calls[0]![0]).toMatchObject({
      provider: 'claude-tui',
      skipPermissions: false,
    })
    expect(onCreate.mock.calls[0]![0].skipPermissions).toBe(false)
  })

  it('user can flip across all three states; final selection wins', async () => {
    mockStore('claude-tui')
    const CreateSessionModal = await loadModal()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onCreate={onCreate} />)
    openAdvanced()
    const on = screen.getByTestId('skip-permissions-radio-on') as HTMLInputElement
    const off = screen.getByTestId('skip-permissions-radio-off') as HTMLInputElement
    const inherit = screen.getByTestId('skip-permissions-radio-inherit') as HTMLInputElement
    fireEvent.click(on)
    expect(on.checked).toBe(true)
    fireEvent.click(off)
    expect(off.checked).toBe(true)
    expect(on.checked).toBe(false)
    fireEvent.click(inherit)
    expect(inherit.checked).toBe(true)
    expect(off.checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(onCreate.mock.calls[0]![0].skipPermissions).toBeUndefined()
  })

  it('omits skipPermissions when provider is NOT claude-tui (defence in depth)', async () => {
    // Reload with the SDK provider as default and no TUI in the list so
    // the group can't even be rendered, then submit. The submit guard
    // (`provider === 'claude-tui' ? ... : undefined`) must keep
    // skipPermissions undefined regardless of the underlying state.
    mockStore('claude-sdk', [SDK_PROVIDER])
    const CreateSessionModal = await loadModal()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onCreate={onCreate} />)
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0]![0].skipPermissions).toBeUndefined()
  })
})
