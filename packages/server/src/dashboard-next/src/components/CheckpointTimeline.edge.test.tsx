/**
 * CheckpointTimeline edge case tests (#1726)
 *
 * Extends the base tests with edge cases:
 * - Single checkpoint marked as latest
 * - Unnamed checkpoint shows truncated ID
 * - Connection state gating (only lists when connected)
 * - Cancel button on create form
 * - Whitespace-only name treated as unnamed
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

describe('CheckpointTimeline — edge cases', () => {
  // -- empty and single --

  it('single checkpoint is marked cp-latest', () => {
    storeState.checkpoints = [{
      id: 'cp-solo', name: 'Only', description: '', messageCount: 5,
      createdAt: Date.now(), hasGitSnapshot: false,
    }]
    render(<CheckpointTimeline />)
    const node = screen.getByTestId('checkpoint-node')
    expect(node.className).toContain('cp-latest')
  })

  it('second checkpoint (older) is not cp-latest', () => {
    storeState.checkpoints = [
      { id: 'cp-a', name: 'Newest', description: '', messageCount: 2, createdAt: Date.now(), hasGitSnapshot: false },
      { id: 'cp-b', name: 'Older', description: '', messageCount: 1, createdAt: Date.now() - 10000, hasGitSnapshot: false },
    ]
    render(<CheckpointTimeline />)
    const nodes = screen.getAllByTestId('checkpoint-node')
    // Sorted newest first — first node is latest
    expect(nodes[0]!.className).toContain('cp-latest')
    expect(nodes[1]!.className).not.toContain('cp-latest')
  })

  it('unnamed checkpoint shows truncated ID', () => {
    storeState.checkpoints = [{
      id: 'abc12345-def6-7890', name: '', description: '', messageCount: 3,
      createdAt: Date.now(), hasGitSnapshot: false,
    }]
    render(<CheckpointTimeline />)
    // Shows "Checkpoint " + first 8 chars of ID
    expect(screen.getByText('Checkpoint abc12345')).toBeTruthy()
  })

  it('description is shown when present', () => {
    storeState.checkpoints = [{
      id: 'cp-1', name: 'N', description: 'My description', messageCount: 1,
      createdAt: Date.now(), hasGitSnapshot: false,
    }]
    render(<CheckpointTimeline />)
    expect(screen.getByText('My description')).toBeTruthy()
  })

  it('description is absent from DOM when empty', () => {
    storeState.checkpoints = [{
      id: 'cp-1', name: 'N', description: '', messageCount: 1,
      createdAt: Date.now(), hasGitSnapshot: false,
    }]
    render(<CheckpointTimeline />)
    // No .cp-desc element should be present in the DOM
    const container = document.querySelector('.cp-desc')
    expect(container).toBeNull()
  })

  // -- connection state gating --

  it('does not call listCheckpoints when not connected', () => {
    storeState.connectionPhase = 'disconnected'
    render(<CheckpointTimeline />)
    expect(mockListCheckpoints).not.toHaveBeenCalled()
  })

  it('does not call listCheckpoints when connecting', () => {
    storeState.connectionPhase = 'connecting'
    render(<CheckpointTimeline />)
    expect(mockListCheckpoints).not.toHaveBeenCalled()
  })

  // -- create form --

  it('cancel button on create form dismisses it', () => {
    render(<CheckpointTimeline />)
    fireEvent.click(screen.getByText('+ New Checkpoint'))
    expect(screen.getByPlaceholderText('Checkpoint name (optional)')).toBeTruthy()

    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByPlaceholderText('Checkpoint name (optional)')).toBeNull()
    expect(screen.getByText('+ New Checkpoint')).toBeTruthy()
  })

  it('whitespace-only name creates unnamed checkpoint', () => {
    render(<CheckpointTimeline />)
    fireEvent.click(screen.getByText('+ New Checkpoint'))
    const input = screen.getByPlaceholderText('Checkpoint name (optional)')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByText('Create'))
    expect(mockCreateCheckpoint).toHaveBeenCalledWith(undefined)
  })
})
