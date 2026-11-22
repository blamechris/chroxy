/**
 * #9145: while Advanced is collapsed, the toggle names EVERY non-default
 * Advanced choice Create will submit. One test per control checks the
 * disclosure and the submitted payload together.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

const READY = { ready: true, source: 'static', detail: '' }
const mockStoreState: Record<string, unknown> = {}
vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockStoreState),
}))

import { CreateSessionModal } from './CreateSessionModal'

beforeEach(() => {
  for (const k of Object.keys(mockStoreState)) delete mockStoreState[k]
  Object.assign(mockStoreState, {
    defaultProvider: 'claude-tui',
    defaultModel: null,
    modelsByProvider: {},
    availableProviders: [
      { name: 'claude-tui', capabilities: {}, auth: READY },
      { name: 'codex', capabilities: {}, auth: READY },
    ],
    permissionModesByProvider: {},
    environments: [{ id: 'env-1', name: 'dev-box', image: 'node:22', status: 'running' }],
    requestDirectoryListing: () => {},
    setDirectoryListingCallback: () => {},
    defaultCwd: null,
  })
})
afterEach(cleanup)

function setup() {
  const onCreate = vi.fn()
  render(<CreateSessionModal open initialCwd="/repo" onCreate={onCreate} onClose={vi.fn()} />)
  return onCreate
}
const toggle = () => document.querySelector('.advanced-toggle-btn') as HTMLButtonElement
const summary = () => screen.queryByTestId('advanced-summary')
const openAdv = () => fireEvent.click(toggle())
const create = () => fireEvent.click(screen.getByRole('button', { name: 'Create' }))

function expectDisclosed(text: RegExp) {
  expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  expect(summary()).toHaveTextContent(text)
  expect(toggle()).toHaveAttribute('aria-describedby', 'advanced-summary')
}

describe('CreateSessionModal collapsed Advanced disclosure (#9145)', () => {
  it('discloses nothing for all defaults and submits no Advanced choice', () => {
    const onCreate = setup()
    expect(summary()).toBeNull()
    expect(toggle()).not.toHaveAttribute('aria-describedby')
    create()
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: undefined, environmentId: undefined, skipPermissions: undefined, codexSandbox: undefined, worktree: undefined }))
  })

  it('permission mode', () => {
    const onCreate = setup()
    openAdv()
    fireEvent.change(screen.getByLabelText('Permission mode'), { target: { value: 'acceptEdits' } })
    openAdv()
    expectDisclosed(/permission mode Accept Edits selected/)
    create()
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'acceptEdits' }))
    // the disclosure names the same mode that was submitted, and collapsing kept it
    openAdv()
    expect((screen.getByLabelText('Permission mode') as HTMLSelectElement).value).toBe('acceptEdits')
  })

  it('codex sandbox', () => {
    const onCreate = setup()
    fireEvent.change(screen.getByLabelText('Select provider'), { target: { value: 'codex' } })
    openAdv()
    fireEvent.change(screen.getByTestId('codex-sandbox-select'), { target: { value: 'read-only' } })
    openAdv()
    expectDisclosed(/Codex sandbox .*selected/)
    create()
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex', codexSandbox: 'read-only' }))
  })

  it.each([['on', true, /skip permission prompts selected/], ['off', false, /require permission prompts selected/]] as const)(
    'skip permissions %s', (radio, sent, text) => {
      const onCreate = setup()
      openAdv()
      fireEvent.click(screen.getByTestId(`skip-permissions-radio-${radio}`))
      openAdv()
      expectDisclosed(text)
      create()
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ skipPermissions: sent }))
    })

  it('environment', () => {
    const onCreate = setup()
    openAdv()
    fireEvent.change(document.getElementById('env-select') as HTMLSelectElement, { target: { value: 'env-1' } })
    openAdv()
    expectDisclosed(/environment dev-box selected/)
    create()
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ environmentId: 'env-1' }))
  })

  it('does not disclose a skip choice the submit path drops after a provider switch', () => {
    const onCreate = setup()
    openAdv()
    fireEvent.click(screen.getByTestId('skip-permissions-radio-on'))
    openAdv()
    fireEvent.change(screen.getByLabelText('Select provider'), { target: { value: 'codex' } })
    expect(summary()).toBeNull()
    create()
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ skipPermissions: undefined }))
  })

  it('does not disclose a codex sandbox the submit path drops after a provider switch', () => {
    const onCreate = setup()
    fireEvent.change(screen.getByLabelText('Select provider'), { target: { value: 'codex' } })
    openAdv()
    fireEvent.change(screen.getByTestId('codex-sandbox-select'), { target: { value: 'read-only' } })
    openAdv()
    expectDisclosed(/Codex sandbox/)
    fireEvent.change(screen.getByLabelText('Select provider'), { target: { value: 'claude-tui' } })
    expect(summary()).toBeNull()
    create()
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude-tui', codexSandbox: undefined }))
  })

  it('names every non-default choice at once and hides the summary when expanded', () => {
    setup()
    openAdv()
    fireEvent.change(screen.getByLabelText('Permission mode'), { target: { value: 'plan' } })
    fireEvent.click(screen.getByTestId('skip-permissions-radio-on'))
    fireEvent.change(document.getElementById('env-select') as HTMLSelectElement, { target: { value: 'env-1' } })
    expect(summary()).toBeNull()
    openAdv()
    expectDisclosed(/permission mode.*skip permission prompts.*environment dev-box/)
  })
})
