/**
 * Tests for CreateSessionModal fresh-open guard (#2679).
 *
 * Verifies that:
 * 1. Store updates to existingNames/availableProviders while the modal is
 *    already open do NOT wipe user-edited form fields.
 * 2. Provider is corrected if availableProviders changes and current selection
 *    is no longer valid (even while modal is open).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

let storeState: Record<string, unknown> = {}

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(storeState),
}))

import { CreateSessionModal } from './CreateSessionModal'

function setStoreState(overrides: Record<string, unknown> = {}) {
  storeState = {
    defaultProvider: 'claude-sdk',
    defaultModel: null,
    availableModels: [],
    availableModelsProvider: null,
    availableProviders: [],
    requestDirectoryListing: () => {},
    setDirectoryListingCallback: () => {},
    defaultCwd: null,
    environments: [],
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  setStoreState()
})

describe('CreateSessionModal fresh-open guard (#2679)', () => {
  it('preserves user-edited name when existingNames changes while open', () => {
    setStoreState()
    const { rerender } = render(
      <CreateSessionModal
        open={true}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        initialCwd="/home/user"
        knownCwds={[]}
        existingNames={['foo']}
      />,
    )

    // User types a custom name
    const nameInput = screen.getByLabelText(/session name/i)
    fireEvent.change(nameInput, { target: { value: 'my-custom-name' } })
    expect(nameInput).toHaveValue('my-custom-name')

    // Rerender with new existingNames (simulating store update while modal is open)
    rerender(
      <CreateSessionModal
        open={true}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        initialCwd="/home/user"
        knownCwds={[]}
        existingNames={['foo', 'bar']}
      />,
    )

    // Name should NOT be wiped
    expect(screen.getByLabelText(/session name/i)).toHaveValue('my-custom-name')
  })

  it('resets form when modal transitions from closed to open', () => {
    setStoreState()
    const props = {
      onClose: vi.fn(),
      onCreate: vi.fn(),
      initialCwd: '/home/user',
      knownCwds: [] as string[],
      existingNames: [] as string[],
    }
    const { rerender } = render(<CreateSessionModal {...props} open={false} />)

    // Open the modal
    rerender(<CreateSessionModal {...props} open={true} />)

    // User types a custom name
    const nameInput = screen.getByLabelText(/session name/i)
    fireEvent.change(nameInput, { target: { value: 'custom' } })
    expect(nameInput).toHaveValue('custom')

    // Close and reopen — form should reset
    rerender(<CreateSessionModal {...props} open={false} />)
    rerender(<CreateSessionModal {...props} open={true} />)

    // Name should be reset to auto-generated default, not 'custom'
    expect(screen.getByLabelText(/session name/i)).not.toHaveValue('custom')
  })

  it('corrects provider when availableProviders changes and current selection is invalid', () => {
    setStoreState({
      availableProviders: [
        { name: 'claude-sdk', capabilities: {} },
        { name: 'gemini', capabilities: {} },
      ],
    })
    const { rerender } = render(
      <CreateSessionModal
        open={true}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        initialCwd="/home/user"
        knownCwds={[]}
        existingNames={[]}
      />,
    )

    // Provider select should show claude-sdk
    const select = screen.getByLabelText(/select provider/i)
    expect(select).toHaveValue('claude-sdk')

    // User switches to gemini
    fireEvent.change(select, { target: { value: 'gemini' } })
    expect(select).toHaveValue('gemini')

    // Now availableProviders changes and gemini is removed
    setStoreState({
      availableProviders: [
        { name: 'claude-sdk', capabilities: {} },
      ],
    })
    rerender(
      <CreateSessionModal
        open={true}
        onClose={vi.fn()}
        onCreate={vi.fn()}
        initialCwd="/home/user"
        knownCwds={[]}
        existingNames={[]}
      />,
    )

    // Provider should fall back to first available
    expect(screen.getByLabelText(/select provider/i)).toHaveValue('claude-sdk')
  })

  it('does not pass the persisted Claude default model when creating a Codex session', () => {
    setStoreState({
      defaultProvider: 'codex',
      defaultModel: 'opus-4-6',
      availableProviders: [
        { name: 'claude-sdk', capabilities: {} },
        { name: 'codex', capabilities: {} },
      ],
    })
    const onCreate = vi.fn()
    render(
      <CreateSessionModal
        open={true}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    )

    fireEvent.change(screen.getByLabelText(/session name/i), { target: { value: 'Codex Test' } })
    fireEvent.click(screen.getByText('Create'))

    expect(onCreate).toHaveBeenCalledWith({
      name: 'Codex Test',
      cwd: '',
      provider: 'codex',
      model: undefined,
      permissionMode: undefined,
      worktree: undefined,
      environmentId: undefined,
    })
  })

  it('does not pass a stale persisted default model when creating a Claude-family session', () => {
    setStoreState({
      defaultProvider: 'claude-sdk',
      defaultModel: 'opus-4-6',
      availableModelsProvider: 'claude-sdk',
      availableModels: [
        { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6' },
        { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-7' },
      ],
      availableProviders: [
        { name: 'claude-sdk', capabilities: {} },
        { name: 'codex', capabilities: {} },
      ],
    })
    const onCreate = vi.fn()
    render(
      <CreateSessionModal
        open={true}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    )

    fireEvent.change(screen.getByLabelText(/session name/i), { target: { value: 'Claude Test' } })
    fireEvent.click(screen.getByText('Create'))

    expect(onCreate).toHaveBeenCalledWith({
      name: 'Claude Test',
      cwd: '',
      provider: 'claude-sdk',
      model: undefined,
      permissionMode: undefined,
      worktree: undefined,
      environmentId: undefined,
    })
  })

  it('passes the persisted default model only when it matches the selected provider catalog', () => {
    setStoreState({
      defaultProvider: 'claude-sdk',
      defaultModel: 'opus',
      availableModelsProvider: 'claude-sdk',
      availableModels: [
        { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6' },
        { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-7' },
      ],
      availableProviders: [
        { name: 'claude-sdk', capabilities: {} },
        { name: 'codex', capabilities: {} },
      ],
    })
    const onCreate = vi.fn()
    render(
      <CreateSessionModal
        open={true}
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    )

    fireEvent.change(screen.getByLabelText(/session name/i), { target: { value: 'Claude Test' } })
    fireEvent.click(screen.getByText('Create'))

    expect(onCreate).toHaveBeenCalledWith({
      name: 'Claude Test',
      cwd: '',
      provider: 'claude-sdk',
      model: 'opus',
      permissionMode: undefined,
      worktree: undefined,
      environmentId: undefined,
    })
  })
})
