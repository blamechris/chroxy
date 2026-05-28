/**
 * Tests for the TUI-only "Skip permission prompts" checkbox on the Create
 * Session modal (#4208).
 *
 * The checkbox MUST:
 *   - render only when the active provider is `claude-tui`
 *   - default to unchecked on fresh modal open
 *   - forward `skipPermissions: true` on onCreate when checked
 *   - omit `skipPermissions` entirely when unchecked (so the server-side
 *     `defaultSkipPermissions` from #4209 still wins on a server launched
 *     with --dangerously-skip-permissions)
 *   - NOT forward the flag even when checked if the user switches provider
 *     to something other than claude-tui before submit (belt + braces; the
 *     checkbox hides on provider change, but the underlying state could
 *     theoretically persist mid-render — the submit guard catches it)
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

describe('CreateSessionModal skip-permissions checkbox (#4208)', () => {
  it('renders the checkbox when active provider is claude-tui', async () => {
    mockStore('claude-tui')
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} onCreate={vi.fn()} />)
    openAdvanced()
    const cb = screen.getByTestId('skip-permissions-checkbox') as HTMLInputElement
    expect(cb).toBeInTheDocument()
    expect(cb.checked).toBe(false)
  })

  it('does NOT render the checkbox for non-TUI providers (claude-sdk)', async () => {
    mockStore('claude-sdk')
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} onCreate={vi.fn()} />)
    openAdvanced()
    expect(screen.queryByTestId('skip-permissions-checkbox')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skip-permissions-field')).not.toBeInTheDocument()
  })

  it('warning copy calls out the danger explicitly', async () => {
    mockStore('claude-tui')
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} onCreate={vi.fn()} />)
    openAdvanced()
    const hint = screen.getByText(/disables chroxy/i)
    expect(hint).toBeInTheDocument()
    expect(hint.textContent).toMatch(/dangerously-skip-permissions/i)
  })

  it('forwards skipPermissions: true on onCreate when checked', async () => {
    mockStore('claude-tui')
    const CreateSessionModal = await loadModal()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onCreate={onCreate} />)
    openAdvanced()
    const cb = screen.getByTestId('skip-permissions-checkbox') as HTMLInputElement
    fireEvent.click(cb)
    expect(cb.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0]![0]).toMatchObject({
      provider: 'claude-tui',
      skipPermissions: true,
    })
  })

  it('omits skipPermissions on onCreate when checkbox stays unchecked', async () => {
    mockStore('claude-tui')
    const CreateSessionModal = await loadModal()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onCreate={onCreate} />)
    // Don't open Advanced; just submit. The field must be undefined so the
    // server-side default (set via `chroxy start --dangerously-skip-permissions`
    // per #4209) is still the source of truth.
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0]![0].skipPermissions).toBeUndefined()
  })

  it('omits skipPermissions when provider is NOT claude-tui (defence in depth)', async () => {
    // Reload with the SDK provider as default and no TUI in the list so
    // the checkbox can't even be rendered, then submit. The submit guard
    // (`provider === 'claude-tui' && skipPermissions`) must keep
    // skipPermissions undefined.
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
