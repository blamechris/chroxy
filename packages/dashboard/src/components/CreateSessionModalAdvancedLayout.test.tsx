/**
 * Advanced-section layout structure (#6509).
 *
 * The worktree checkbox and skip-permissions radios once collapsed to a
 * one-word-per-line column that overflowed the modal — root cause: the modal's
 * `input { width:100% }` bled onto the toggle inputs and the label text was a
 * bare (box-less) text node. The structural half of the fix wraps each label
 * text in a `<span class="label-text">` so the grid's text track is addressable.
 *
 * These guard the MARKUP the CSS fix depends on (jsdom has no layout, so the
 * pixel guarantee lives in the Playwright/smoke check); a revert of the span
 * wrap fails here, and a revert of the CSS fails AdvancedSectionCss.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

const TUI_PROVIDER = { name: 'claude-tui', capabilities: {}, auth: { ready: true, source: 'static', detail: '' } }

function mockStore(environments: unknown[] = []) {
  vi.doMock('../store/connection', () => ({
    useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        defaultProvider: 'claude-tui',
        defaultModel: null,
        availableModels: [],
        availableModelsProvider: null,
        availableProviders: [TUI_PROVIDER],
        availablePermissionModes: [],
        environments,
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
  onCreate: vi.fn(),
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

describe('CreateSessionModal Advanced-section layout (#6509)', () => {
  it('wraps the worktree label text in a .label-text span inside the .checkbox-label', async () => {
    mockStore()
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} />)
    openAdvanced()
    const text = screen.getByText('Isolate filesystem (worktree)')
    expect(text.tagName).toBe('SPAN')
    expect(text.classList.contains('label-text')).toBe(true)
    const label = text.closest('label.checkbox-label')
    expect(label).not.toBeNull()
    // Structural association preserved: the input lives in the same <label>.
    expect(label!.querySelector('#worktree-checkbox')).not.toBeNull()
    expect(label!.querySelector('#worktree-checkbox')!.getAttribute('aria-describedby')).toBe('worktree-hint')
  })

  it('wraps each permission-prompt radio label in a .label-text span inside its .radio-label', async () => {
    mockStore()
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} />)
    openAdvanced()
    for (const [testid, copy] of [
      ['skip-permissions-radio-inherit', 'Use server default'],
      ['skip-permissions-radio-off', 'Require permission prompts (override server default)'],
      ['skip-permissions-radio-on', 'Skip permission prompts (dangerous)'],
    ] as const) {
      const text = screen.getByText(copy)
      expect(text.tagName).toBe('SPAN')
      expect(text.classList.contains('label-text')).toBe(true)
      const label = text.closest('label.radio-label')
      expect(label).not.toBeNull()
      expect(label!.querySelector(`[data-testid="${testid}"]`)).not.toBeNull()
    }
  })

  it('keeps the radiogroup a11y wiring intact (unchanged by the layout fix)', async () => {
    mockStore()
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} />)
    openAdvanced()
    const group = screen.getByTestId('skip-permissions-field')
    expect(group.getAttribute('role')).toBe('radiogroup')
    expect(group.getAttribute('aria-labelledby')).toBe('skip-permissions-legend')
    expect(group.getAttribute('aria-describedby')).toBe('skip-permissions-hint')
  })

  it('#6512: links the Environment select to its hint via aria-describedby', async () => {
    mockStore([{ id: 'env-1', name: 'dev', image: 'node:22', status: 'running' }])
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} />)
    openAdvanced()
    const select = document.getElementById('env-select')
    expect(select).not.toBeNull()
    expect(select!.getAttribute('aria-describedby')).toBe('env-hint')
    // The hint carries the matching id so the association resolves.
    expect(document.getElementById('env-hint')?.classList.contains('form-hint')).toBe(true)
  })
})
