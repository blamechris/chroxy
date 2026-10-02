/**
 * #7332: the disabled "Isolate filesystem (worktree)" checkbox must say WHY it
 * is disabled.
 *
 * The control is disabled purely because the Working directory field is empty
 * (and that field is labelled "optional", so nothing links the two). The hint
 * under the checkbox was keyed on the CHECKED state and described git, so the
 * user read "requires a git repo CWD" and concluded the feature was broken.
 *
 * The reason has to be rendered hint text that the checkbox's aria-describedby
 * points at. A `title` on a disabled <input> never renders — disabled inputs do
 * not fire pointer events — so that is explicitly not a fix and these tests do
 * not accept it.
 *
 * Related (#7332 review): a worktree tick made while a cwd is set must not
 * survive a cleared cwd, either in the checkbox or in the submitted payload.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

const DISABLED_REASON = 'Choose a working directory first — worktree isolation needs a git repo'

const TUI_PROVIDER = { name: 'claude-tui', capabilities: {}, auth: { ready: true, source: 'static', detail: '' } }

function mockStore() {
  vi.doMock('../store/connection', () => ({
    useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        defaultProvider: 'claude-tui',
        defaultModel: null,
        // No modelsByProvider on purpose: the component then falls back to its
        // stable EMPTY_MODELS_BY_PROVIDER, so the submit useCallback is NOT
        // rebuilt every render and a missing dependency (e.g. effectiveWorktree)
        // shows up as a stale-closure failure in the payload case. A fresh `{}`
        // here would rebuild the callback each render and hide that regression.
        availableProviders: [TUI_PROVIDER],
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
  onCreate: vi.fn(),
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

function worktreeCheckbox(): HTMLInputElement {
  return document.getElementById('worktree-checkbox') as HTMLInputElement
}

describe('CreateSessionModal worktree checkbox disabled reason (#7332)', () => {
  it('with no working directory, the checkbox is disabled and the reason is visible text that names the working directory', async () => {
    mockStore()
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} initialCwd="" />)
    openAdvanced()

    const checkbox = worktreeCheckbox()
    expect(checkbox).not.toBeNull()
    expect(checkbox.disabled).toBe(true)

    // The reason must be rendered text inside the worktree field — not a
    // title attribute on the disabled input, which never shows.
    const field = checkbox.closest('.form-field')!
    expect(field).not.toBeNull()
    expect(field.textContent).toMatch(/working directory/i)
    expect(field.textContent).toMatch(/first/i)
    // The accessible description the checkbox points at carries the reason too.
    const hintId = checkbox.getAttribute('aria-describedby')!
    expect(hintId).toBeTruthy()
    expect(document.getElementById(hintId)!.textContent).toBe(DISABLED_REASON)
    // Visible text, not a `title` on the disabled input (which never renders).
    expect(checkbox.hasAttribute('title')).toBe(false)
  })

  it('with a working directory, the checkbox is enabled and the reason is gone', async () => {
    mockStore()
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} initialCwd="/Users/me/projects" />)
    openAdvanced()

    const checkbox = worktreeCheckbox()
    expect(checkbox.disabled).toBe(false)
    const field = checkbox.closest('.form-field')!
    expect(field.textContent).not.toMatch(/choose a working directory/i)
    // The enabled state falls back to the existing git-repo hint.
    expect(document.getElementById('worktree-hint')!.textContent).toMatch(/git/i)
  })

  it('typing a working directory enables the checkbox and clears the reason', async () => {
    mockStore()
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} initialCwd="" />)
    openAdvanced()
    expect(worktreeCheckbox().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/Users/me/projects' } })

    const checkbox = worktreeCheckbox()
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.closest('.form-field')!.textContent).not.toMatch(/choose a working directory/i)
    expect(document.getElementById('worktree-hint')!.textContent).toMatch(/git/i)
  })

  // Guards the `.trim()` on the cwd: without it a whitespace-only cwd would
  // enable the checkbox and the daemon would reject the resulting create.
  it('a whitespace-only working directory counts as empty: checkbox disabled and the reason is shown', async () => {
    mockStore()
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} initialCwd="   " />)
    openAdvanced()

    const checkbox = worktreeCheckbox()
    expect(checkbox.disabled).toBe(true)
    expect(document.getElementById('worktree-hint')!.textContent).toBe(DISABLED_REASON)
  })

  it('clearing the working directory after ticking the checkbox unticks it and shows the reason; re-entering the cwd restores the tick', async () => {
    mockStore()
    const CreateSessionModal = await loadModal()
    render(<CreateSessionModal {...baseProps} initialCwd="/Users/me/projects" />)
    openAdvanced()

    fireEvent.click(worktreeCheckbox())
    expect(worktreeCheckbox().checked).toBe(true)

    const cwdInput = screen.getByLabelText('Working directory')
    fireEvent.change(cwdInput, { target: { value: '' } })

    // The box must not stay "checked + disabled" with the tick still counting.
    expect(worktreeCheckbox().disabled).toBe(true)
    expect(worktreeCheckbox().checked).toBe(false)
    expect(document.getElementById('worktree-hint')!.textContent).toBe(DISABLED_REASON)

    // The user's choice is preserved: typing the cwd back brings the tick back.
    fireEvent.change(cwdInput, { target: { value: '/Users/me/projects' } })
    expect(worktreeCheckbox().disabled).toBe(false)
    expect(worktreeCheckbox().checked).toBe(true)
  })

  // Proves the payload, not just the UI. Against the pre-fix code this fails:
  // the stale `worktree` state was submitted as `worktree: true` alongside an
  // empty cwd, which the daemon rejects ("Worktree requires an explicit CWD").
  it('submitting after clearing a ticked worktree checkbox sends worktree: undefined with the empty cwd', async () => {
    mockStore()
    const CreateSessionModal = await loadModal()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onCreate={onCreate} initialCwd="/Users/me/projects" />)
    openAdvanced()

    fireEvent.click(worktreeCheckbox())
    expect(worktreeCheckbox().checked).toBe(true)
    fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '' } })

    fireEvent.click(screen.getByRole('button', { name: /create/i }))

    expect(onCreate).toHaveBeenCalledTimes(1)
    const payload = onCreate.mock.calls[0]?.[0] as { cwd: string; worktree?: boolean } | undefined
    expect(payload?.cwd).toBe('')
    expect(payload?.worktree).toBeUndefined()
  })

  it('submitting with a cwd and a ticked worktree checkbox still sends worktree: true', async () => {
    mockStore()
    const CreateSessionModal = await loadModal()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onCreate={onCreate} initialCwd="/Users/me/projects" />)
    openAdvanced()

    fireEvent.click(worktreeCheckbox())
    fireEvent.click(screen.getByRole('button', { name: /create/i }))

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/Users/me/projects', worktree: true }))
  })
})
