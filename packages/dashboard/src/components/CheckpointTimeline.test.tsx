/**
 * CheckpointTimeline — tests for timeline visualization and actions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { CheckpointTimeline } from './CheckpointTimeline'

const mockListCheckpoints = vi.fn()
const mockCreateCheckpoint = vi.fn()
const mockRestoreCheckpoint = vi.fn()
const mockDeleteCheckpoint = vi.fn()

let storeState: Record<string, unknown> = {}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: any) => {
    const store = {
      checkpoints: storeState.checkpoints ?? [],
      listCheckpoints: mockListCheckpoints,
      createCheckpoint: mockCreateCheckpoint,
      restoreCheckpoint: mockRestoreCheckpoint,
      deleteCheckpoint: mockDeleteCheckpoint,
      connectionPhase: storeState.connectionPhase ?? 'connected',
      // #6767: restore-mode picker capability lookup.
      activeSessionId: storeState.activeSessionId ?? null,
      sessions: storeState.sessions ?? [],
      availableProviders: storeState.availableProviders ?? [],
    }
    return selector(store)
  },
}))

// #6767: an active session whose provider CAN branch the conversation.
const FORK_CAPABLE = {
  activeSessionId: 's1',
  sessions: [{ sessionId: 's1', provider: 'claude-sdk' }],
  availableProviders: [{ name: 'claude-sdk', capabilities: { conversationFork: true } }],
}
// A provider that CANNOT fork (the default when nothing is set, made explicit).
const NON_FORK = {
  activeSessionId: 's1',
  sessions: [{ sessionId: 's1', provider: 'claude-tui' }],
  availableProviders: [{ name: 'claude-tui', capabilities: {} }],
}

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
  storeState = { connectionPhase: 'connected' }
})

const CHECKPOINTS = [
  {
    id: 'cp-1',
    name: 'Before refactor',
    description: 'Save point before major refactor',
    messageCount: 42,
    createdAt: Date.now() - 3600_000,
    hasGitSnapshot: true,
  },
  {
    id: 'cp-2',
    name: 'After tests pass',
    description: '',
    messageCount: 85,
    createdAt: Date.now() - 60_000,
    hasGitSnapshot: false,
  },
]

describe('CheckpointTimeline', () => {
  it('requests checkpoint list on mount', () => {
    render(<CheckpointTimeline />)
    expect(mockListCheckpoints).toHaveBeenCalledOnce()
  })

  it('shows empty state when no checkpoints', () => {
    render(<CheckpointTimeline />)
    expect(screen.getByText(/No checkpoints yet/)).toBeTruthy()
  })

  it('renders checkpoint nodes sorted newest first', () => {
    storeState.checkpoints = CHECKPOINTS
    render(<CheckpointTimeline />)

    const nodes = screen.getAllByTestId('checkpoint-node')
    expect(nodes).toHaveLength(2)

    // Newest (cp-2) should be first
    expect(nodes[0]!.textContent).toContain('After tests pass')
    expect(nodes[1]!.textContent).toContain('Before refactor')
  })

  it('shows git badge when hasGitSnapshot is true', () => {
    storeState.checkpoints = CHECKPOINTS
    render(<CheckpointTimeline />)
    expect(screen.getByText('git')).toBeTruthy()
  })

  it('shows message count', () => {
    storeState.checkpoints = CHECKPOINTS
    render(<CheckpointTimeline />)
    expect(screen.getByText('42 msgs')).toBeTruthy()
    expect(screen.getByText('85 msgs')).toBeTruthy()
  })

  it('calls restoreCheckpoint with the default mode (both) when Restore is clicked', () => {
    storeState.checkpoints = [CHECKPOINTS[0]!]
    render(<CheckpointTimeline />)

    fireEvent.click(screen.getByText('Restore'))
    // #6767: default restore mode is 'both'.
    expect(mockRestoreCheckpoint).toHaveBeenCalledWith('cp-1', 'both')
  })

  // #6767 — selective restore-mode picker.
  describe('restore-mode picker (#6767)', () => {
    it('renders the three restore modes with Both selected by default', () => {
      storeState.checkpoints = [CHECKPOINTS[0]!]
      render(<CheckpointTimeline />)
      expect(screen.getByTestId('checkpoint-mode-both').getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByTestId('checkpoint-mode-files').getAttribute('aria-pressed')).toBe('false')
      expect(screen.getByTestId('checkpoint-mode-conversation').getAttribute('aria-pressed')).toBe('false')
    })

    it('restores with the chosen mode (files) — keeps the current session', () => {
      storeState.checkpoints = [CHECKPOINTS[0]!]
      render(<CheckpointTimeline />)
      fireEvent.click(screen.getByTestId('checkpoint-mode-files'))
      fireEvent.click(screen.getByText('Restore'))
      expect(mockRestoreCheckpoint).toHaveBeenCalledWith('cp-1', 'files')
    })

    it('disables Conversation when the active session provider cannot fork', () => {
      Object.assign(storeState, NON_FORK, { checkpoints: [CHECKPOINTS[0]!] })
      render(<CheckpointTimeline />)
      const conv = screen.getByTestId('checkpoint-mode-conversation') as HTMLButtonElement
      expect(conv.disabled).toBe(true)
    })

    it('enables Conversation and restores with it when the provider can fork', () => {
      Object.assign(storeState, FORK_CAPABLE, { checkpoints: [CHECKPOINTS[0]!] })
      render(<CheckpointTimeline />)
      const conv = screen.getByTestId('checkpoint-mode-conversation') as HTMLButtonElement
      expect(conv.disabled).toBe(false)
      fireEvent.click(conv)
      fireEvent.click(screen.getByText('Restore'))
      expect(mockRestoreCheckpoint).toHaveBeenCalledWith('cp-1', 'conversation')
    })
  })

  it('shows delete confirmation on Delete click', () => {
    storeState.checkpoints = [CHECKPOINTS[0]!]
    render(<CheckpointTimeline />)

    fireEvent.click(screen.getByText('Delete'))
    expect(screen.getByText('Confirm')).toBeTruthy()
    expect(screen.getByText('Cancel')).toBeTruthy()
  })

  it('deletes checkpoint on Confirm', () => {
    storeState.checkpoints = [CHECKPOINTS[0]!]
    render(<CheckpointTimeline />)

    fireEvent.click(screen.getByText('Delete'))
    fireEvent.click(screen.getByText('Confirm'))
    expect(mockDeleteCheckpoint).toHaveBeenCalledWith('cp-1')
  })

  it('cancels delete on Cancel', () => {
    storeState.checkpoints = [CHECKPOINTS[0]!]
    render(<CheckpointTimeline />)

    fireEvent.click(screen.getByText('Delete'))
    fireEvent.click(screen.getByText('Cancel'))
    // Should be back to showing Delete button
    expect(screen.getByText('Delete')).toBeTruthy()
    expect(mockDeleteCheckpoint).not.toHaveBeenCalled()
  })

  it('shows create form and creates checkpoint', () => {
    render(<CheckpointTimeline />)

    fireEvent.click(screen.getByText('+ New Checkpoint'))
    const input = screen.getByPlaceholderText('Checkpoint name (optional)')
    expect(input).toBeTruthy()

    fireEvent.change(input, { target: { value: 'My save' } })
    fireEvent.click(screen.getByText('Create'))
    expect(mockCreateCheckpoint).toHaveBeenCalledWith('My save')
  })

  it('creates checkpoint without name when empty', () => {
    render(<CheckpointTimeline />)

    fireEvent.click(screen.getByText('+ New Checkpoint'))
    fireEvent.click(screen.getByText('Create'))
    expect(mockCreateCheckpoint).toHaveBeenCalledWith(undefined)
  })

  it('creates checkpoint on Enter key', () => {
    render(<CheckpointTimeline />)

    fireEvent.click(screen.getByText('+ New Checkpoint'))
    const input = screen.getByPlaceholderText('Checkpoint name (optional)')
    fireEvent.change(input, { target: { value: 'Quick save' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mockCreateCheckpoint).toHaveBeenCalledWith('Quick save')
  })

  it('cancels create form on Escape key', () => {
    render(<CheckpointTimeline />)

    fireEvent.click(screen.getByText('+ New Checkpoint'))
    const input = screen.getByPlaceholderText('Checkpoint name (optional)')
    fireEvent.keyDown(input, { key: 'Escape' })
    // Form should be hidden, "New Checkpoint" button should be back
    expect(screen.getByText('+ New Checkpoint')).toBeTruthy()
  })

  // #3484: trim guard on checkpoint name fallback. The header label uses
  // `checkpoint.name || fallback`, but a whitespace-only name (e.g. '   ')
  // is truthy and would render as a visually-empty `<span class="cp-name">`.
  // Mirrors the description guard from #3461 and the SkillsPanel guards
  // from #3441 / #3458 — the trim is used only as a boolean predicate;
  // the displayed fallback is the truncated-ID label.
  describe('name trim guard (#3484)', () => {
    it('renders whitespace-only name as truncated-ID fallback (spaces)', () => {
      storeState.checkpoints = [{
        id: 'abc12345-def6-7890', name: '   ', description: '', messageCount: 1,
        createdAt: Date.now(), hasGitSnapshot: false,
      }]
      render(<CheckpointTimeline />)
      expect(screen.getByText('Checkpoint abc12345')).toBeTruthy()
    })

    it('renders whitespace-only name as truncated-ID fallback (mixed)', () => {
      storeState.checkpoints = [{
        id: 'abc12345-def6-7890', name: '\t\n  ', description: '', messageCount: 1,
        createdAt: Date.now(), hasGitSnapshot: false,
      }]
      render(<CheckpointTimeline />)
      expect(screen.getByText('Checkpoint abc12345')).toBeTruthy()
    })

    it('uses checkpoint.id as title when name is whitespace-only', () => {
      storeState.checkpoints = [{
        id: 'abc12345-def6-7890', name: '   ', description: '', messageCount: 1,
        createdAt: Date.now(), hasGitSnapshot: false,
      }]
      render(<CheckpointTimeline />)
      const nameEl = document.querySelector('.cp-name')
      expect(nameEl).not.toBeNull()
      expect(nameEl?.getAttribute('title')).toBe('abc12345-def6-7890')
    })

    it('renders the name verbatim when present (untrimmed)', () => {
      storeState.checkpoints = [{
        id: 'cp-1', name: '  Save point  ', description: '', messageCount: 1,
        createdAt: Date.now(), hasGitSnapshot: false,
      }]
      render(<CheckpointTimeline />)
      const nameEl = document.querySelector('.cp-name')
      expect(nameEl?.textContent).toBe('  Save point  ')
    })
  })
})
