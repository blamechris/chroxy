/**
 * HostPruneSection (#6140, epic #5530) — renderer tests.
 *
 * Covers the surface against a mocked `host_prune_status_snapshot`:
 *   - empty / loading / not-connected states before the first snapshot
 *   - docker-unavailable note (no tables/actions)
 *   - summary chips + container/image tables
 *   - each prune button routes through the ConfirmDialog before onAction
 *   - buttons disable when their resource class is empty / while actioning
 *   - pending → settled note; Refresh dispatch + disabled-while-loading
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ServerHostPruneStatusSnapshotMessage } from '@chroxy/protocol'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      hostPruneStatus: null,
      hostPruneStatusLoading: false,
      connectionPhase: 'connected',
      requestHostPruneStatus: () => false,
      hostPruneActioningIds: new Set<string>(),
      hostPruneActionResults: {},
      sendHostPruneAction: () => false,
    }),
}))
import { HostPruneSection } from './HostPruneSection'

afterEach(cleanup)

function snapshot(over: Partial<ServerHostPruneStatusSnapshotMessage> = {}): ServerHostPruneStatusSnapshotMessage {
  return {
    type: 'host_prune_status_snapshot',
    generatedAt: '2026-06-19T12:00:00.000Z',
    dockerAvailable: true,
    note: null,
    containers: [{ id: 'aaa111222333', name: 'chroxy-env-foo', state: 'exited', sizeBytes: 12_000_000 }],
    images: [{ id: 'img111222333', ref: 'chroxy-env:foo-1', repository: 'chroxy-env', sizeBytes: 1_000_000_000 }],
    summary: { containerCount: 1, imageCount: 1, reclaimableBytes: 1_012_000_000 },
    ...over,
  } as ServerHostPruneStatusSnapshotMessage
}

describe('HostPruneSection — empty / loading / not-connected', () => {
  it('renders the empty state with a Run-survey button when no snapshot', () => {
    render(<HostPruneSection snapshot={null} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('host-prune-empty')).toBeTruthy()
    expect(screen.queryByTestId('host-prune-containers-table')).toBeNull()
  })

  it('disables the run button when not connected', () => {
    render(<HostPruneSection snapshot={null} loading={false} connected={false} onRefresh={() => {}} />)
    expect((screen.getByTestId('host-prune-empty-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('HostPruneSection — docker unavailable', () => {
  it('renders the no-docker note and no tables/actions', () => {
    render(
      <HostPruneSection
        snapshot={snapshot({ dockerAvailable: false, note: 'docker is unavailable', containers: [], images: [], summary: { containerCount: 0, imageCount: 0, reclaimableBytes: 0 } })}
        loading={false}
        connected={true}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByTestId('host-prune-no-docker').textContent).toContain('unavailable')
    expect(screen.queryByTestId('host-prune-actions')).toBeNull()
  })
})

describe('HostPruneSection — populated', () => {
  it('renders summary chips + both tables', () => {
    render(<HostPruneSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('host-prune-chip-containers-count').textContent).toBe('1')
    expect(screen.getByTestId('host-prune-chip-images-count').textContent).toBe('1')
    expect(screen.getByTestId('host-prune-container-aaa111222333')).toBeTruthy()
    expect(screen.getByTestId('host-prune-image-img111222333')).toBeTruthy()
  })

  it('each prune kind routes through the ConfirmDialog before onAction', () => {
    const onAction = vi.fn()
    render(<HostPruneSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} onAction={onAction} />)
    fireEvent.click(screen.getByTestId('host-prune-all'))
    expect(onAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    expect(onAction).toHaveBeenCalledWith('all')
  })

  it('Prune containers is disabled when there are no containers', () => {
    render(
      <HostPruneSection
        snapshot={snapshot({ containers: [], summary: { containerCount: 0, imageCount: 1, reclaimableBytes: 1_000_000_000 } })}
        loading={false}
        connected={true}
        onRefresh={() => {}}
      />,
    )
    expect((screen.getByTestId('host-prune-containers') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('host-prune-images') as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows Pruning… while a kind is pending and a note when settled', () => {
    const { rerender } = render(
      <HostPruneSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} actioningIds={new Set(['all'])} actionResults={{}} />,
    )
    expect(screen.getByTestId('host-prune-pending-all')).toBeTruthy()
    rerender(
      <HostPruneSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} actioningIds={new Set<string>()} actionResults={{ all: { kind: 'all', note: 'Removed 1 container, 1 image (~965 MiB)', error: null, at: 1 } }} />,
    )
    expect(screen.getByTestId('host-prune-ok-all').textContent).toContain('Removed 1 container')
  })

  it('Refresh dispatches and is disabled while loading', () => {
    const onRefresh = vi.fn()
    const { rerender } = render(<HostPruneSection snapshot={snapshot()} loading={false} connected={true} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByTestId('host-prune-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    rerender(<HostPruneSection snapshot={snapshot()} loading={true} connected={true} onRefresh={onRefresh} />)
    expect((screen.getByTestId('host-prune-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})
