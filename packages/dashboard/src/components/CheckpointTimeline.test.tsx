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
    }
    return selector(store)
  },
}))

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

  it('calls restoreCheckpoint when Restore is clicked', () => {
    storeState.checkpoints = [CHECKPOINTS[0]!]
    render(<CheckpointTimeline />)

    fireEvent.click(screen.getByText('Restore'))
    expect(mockRestoreCheckpoint).toHaveBeenCalledWith('cp-1')
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
})
