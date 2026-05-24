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
})
