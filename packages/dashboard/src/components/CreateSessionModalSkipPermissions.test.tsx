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

  // #4245: the skipPermissions state must reset when the user switches
  // provider. Before the fix, ticking the box for claude-tui, switching to
  // claude-sdk, then switching back to claude-tui would leave the checkbox
  // pre-checked with no fresh warning — a security-UX wart. The submit
  // guard caught the cross-provider case at submit time, but the user
  // wouldn't be re-prompted to confirm the dangerous flag.
  describe('provider-switch reset (#4245)', () => {
    it('resets skipPermissions to false when switching from claude-tui to claude-sdk and back', async () => {
      mockStore('claude-tui')
      const CreateSessionModal = await loadModal()
      const onCreate = vi.fn()
      render(<CreateSessionModal {...baseProps} onCreate={onCreate} />)
      openAdvanced()
      // Tick the checkbox under claude-tui
      const cb = screen.getByTestId('skip-permissions-checkbox') as HTMLInputElement
      fireEvent.click(cb)
      expect(cb.checked).toBe(true)
      // Switch to claude-sdk — checkbox hides
      const select = screen.getByLabelText(/select provider/i) as HTMLSelectElement
      fireEvent.change(select, { target: { value: 'claude-sdk' } })
      expect(screen.queryByTestId('skip-permissions-checkbox')).not.toBeInTheDocument()
      // Switch back to claude-tui — checkbox renders again, must be unchecked
      fireEvent.change(select, { target: { value: 'claude-tui' } })
      const cb2 = screen.getByTestId('skip-permissions-checkbox') as HTMLInputElement
      expect(cb2.checked).toBe(false)
    })

    it('resets skipPermissions when switching away from claude-tui even without coming back', async () => {
      mockStore('claude-tui')
      const CreateSessionModal = await loadModal()
      const onCreate = vi.fn()
      render(<CreateSessionModal {...baseProps} onCreate={onCreate} />)
      openAdvanced()
      const cb = screen.getByTestId('skip-permissions-checkbox') as HTMLInputElement
      fireEvent.click(cb)
      expect(cb.checked).toBe(true)
      // Switch to claude-sdk and submit — the submit guard already strips
      // the flag on non-TUI providers, but the underlying state should
      // also be reset so the UX is consistent.
      const select = screen.getByLabelText(/select provider/i) as HTMLSelectElement
      fireEvent.change(select, { target: { value: 'claude-sdk' } })
      fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
      expect(onCreate).toHaveBeenCalledTimes(1)
      expect(onCreate.mock.calls[0]![0]).toMatchObject({
        provider: 'claude-sdk',
      })
      expect(onCreate.mock.calls[0]![0].skipPermissions).toBeUndefined()
    })

    it('does NOT reset skipPermissions when the provider stays the same (state survives unrelated re-renders)', async () => {
      mockStore('claude-tui')
      const CreateSessionModal = await loadModal()
      const onCreate = vi.fn()
      render(<CreateSessionModal {...baseProps} onCreate={onCreate} />)
      openAdvanced()
      const cb = screen.getByTestId('skip-permissions-checkbox') as HTMLInputElement
      fireEvent.click(cb)
      expect(cb.checked).toBe(true)
      // An unrelated state change (typing in the session name) must not
      // reset the checkbox — only provider changes do.
      const nameInput = screen.getByLabelText(/session name/i) as HTMLInputElement
      fireEvent.change(nameInput, { target: { value: 'my-session' } })
      const cbAfter = screen.getByTestId('skip-permissions-checkbox') as HTMLInputElement
      expect(cbAfter.checked).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
      expect(onCreate).toHaveBeenCalledTimes(1)
      expect(onCreate.mock.calls[0]![0]).toMatchObject({
        provider: 'claude-tui',
        skipPermissions: true,
      })
    })
  })
})
