/**
 * ByokPoolSection (#6135, epic #5530) — renderer tests.
 *
 * Covers the surface against a mocked `byok_pool_status_snapshot`:
 *   - empty / loading / not-connected states before the first snapshot
 *   - a disabled-pool snapshot renders the note, no table/actions
 *   - enabled: stats + limits chips, per-shape bucket rows
 *   - Drain routes through the ConfirmDialog before calling onAction
 *   - Recycle (per-row) routes through the ConfirmDialog with the bucket key
 *   - Resize submits the typed caps; empty inputs submit nothing
 *   - pending shows "Working…"; a settled result shows the note / error
 *   - Refresh dispatches the request (and is disabled while loading)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ServerByokPoolStatusSnapshotMessage } from '@chroxy/protocol'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      byokPoolStatus: null,
      byokPoolStatusLoading: false,
      connectionPhase: 'connected',
      requestByokPoolStatus: () => false,
      byokPoolActioningIds: new Set<string>(),
      byokPoolActionResults: {},
      sendByokPoolAction: () => false,
    }),
}))
import { ByokPoolSection } from './ByokPoolSection'

afterEach(cleanup)

const BUCKET = 'node:22|/p|2g|2|chroxy'

function snapshot(over: Partial<ServerByokPoolStatusSnapshotMessage> = {}): ServerByokPoolStatusSnapshotMessage {
  return {
    type: 'byok_pool_status_snapshot',
    generatedAt: '2026-06-19T11:50:00.000Z',
    enabled: true,
    note: null,
    limits: { idleTimeoutMs: 300000, maxPerKey: 2, maxTotal: 8, maxAgeMs: 1800000 },
    stats: {
      hits: 7, misses: 3, releases: 5, shutdowns: 0, hitRate: 0.7, totalSize: 2,
      buckets: [{ key: BUCKET, size: 2, oldestIdleMs: 12000 }],
      evictionsByReason: { idle: 4, over_cap: 1 },
      recentEvictions: [],
    },
    ...over,
  } as ServerByokPoolStatusSnapshotMessage
}

describe('ByokPoolSection — empty / loading / not-connected', () => {
  it('renders the empty state with a Run-survey button when no snapshot', () => {
    render(<ByokPoolSection snapshot={null} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('byok-pool-empty')).toBeTruthy()
    expect(screen.getByTestId('byok-pool-empty-refresh')).toBeTruthy()
    expect(screen.queryByTestId('byok-pool-table')).toBeNull()
  })

  it('shows a loading message while the first survey is in flight', () => {
    render(<ByokPoolSection snapshot={null} loading={true} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('byok-pool-empty').textContent).toContain('Running the BYOK pool survey')
  })

  it('disables the run button and notes the disconnect when not connected', () => {
    render(<ByokPoolSection snapshot={null} loading={false} connected={false} onRefresh={() => {}} />)
    expect(screen.getByTestId('byok-pool-not-connected')).toBeTruthy()
    expect((screen.getByTestId('byok-pool-empty-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ByokPoolSection — disabled pool', () => {
  it('renders the disabled note and no table/actions', () => {
    render(
      <ByokPoolSection
        snapshot={snapshot({ enabled: false, note: 'BYOK container pool is disabled.', limits: null, stats: null })}
        loading={false}
        connected={true}
        onRefresh={() => {}}
      />,
    )
    expect(screen.getByTestId('byok-pool-disabled').textContent).toContain('disabled')
    expect(screen.queryByTestId('byok-pool-table')).toBeNull()
    expect(screen.queryByTestId('byok-pool-actions')).toBeNull()
  })
})

describe('ByokPoolSection — enabled', () => {
  it('renders stats + limits chips', () => {
    render(<ByokPoolSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId('byok-pool-chip-warm-count').textContent).toBe('2')
    expect(screen.getByTestId('byok-pool-chip-hits').textContent).toContain('7')
    expect(screen.getByTestId('byok-pool-chip-perkey').textContent).toContain('2')
    expect(screen.getByTestId('byok-pool-chip-total').textContent).toContain('8')
    expect(screen.getByTestId('byok-pool-evictions').textContent).toContain('idle 4')
  })

  it('renders one row per warm bucket', () => {
    render(<ByokPoolSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} />)
    expect(screen.getByTestId(`byok-bucket-row-${BUCKET}`)).toBeTruthy()
    expect(screen.getByTestId(`byok-bucket-size-${BUCKET}`).textContent).toBe('2')
  })

  it('Drain routes through the ConfirmDialog before calling onAction', () => {
    const onAction = vi.fn()
    render(<ByokPoolSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} onAction={onAction} />)
    fireEvent.click(screen.getByTestId('byok-pool-drain'))
    expect(onAction).not.toHaveBeenCalled() // dialog gates it
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    expect(onAction).toHaveBeenCalledWith('drain')
  })

  it('Recycle routes through the ConfirmDialog with the bucket key', () => {
    const onAction = vi.fn()
    render(<ByokPoolSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} onAction={onAction} />)
    fireEvent.click(screen.getByTestId(`byok-recycle-${BUCKET}`))
    expect(onAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    expect(onAction).toHaveBeenCalledWith('recycle', { key: BUCKET })
  })

  it('Resize submits the typed caps; nothing when both inputs are empty', () => {
    const onAction = vi.fn()
    render(<ByokPoolSection snapshot={snapshot()} loading={false} connected={true} onRefresh={() => {}} onAction={onAction} />)
    // Empty inputs → no-op.
    fireEvent.click(screen.getByTestId('byok-pool-resize-apply'))
    expect(onAction).not.toHaveBeenCalled()
    // Type a per-key cap and apply.
    fireEvent.change(screen.getByTestId('byok-pool-resize-perkey'), { target: { value: '1' } })
    fireEvent.click(screen.getByTestId('byok-pool-resize-apply'))
    expect(onAction).toHaveBeenCalledWith('resize', { maxPerKey: 1 })
  })

  it('shows Working… while a target is pending and a note when settled', () => {
    const { rerender } = render(
      <ByokPoolSection
        snapshot={snapshot()}
        loading={false}
        connected={true}
        onRefresh={() => {}}
        actioningIds={new Set(['drain'])}
        actionResults={{}}
      />,
    )
    expect(screen.getByTestId('byok-action-pending-drain')).toBeTruthy()
    rerender(
      <ByokPoolSection
        snapshot={snapshot()}
        loading={false}
        connected={true}
        onRefresh={() => {}}
        actioningIds={new Set<string>()}
        actionResults={{ drain: { action: 'drain', note: 'Drained — evicted 3', error: null, at: 1 } }}
      />,
    )
    expect(screen.getByTestId('byok-action-ok-drain').textContent).toContain('evicted 3')
  })

  it('Refresh dispatches the request and is disabled while loading', () => {
    const onRefresh = vi.fn()
    const { rerender } = render(
      <ByokPoolSection snapshot={snapshot()} loading={false} connected={true} onRefresh={onRefresh} />,
    )
    fireEvent.click(screen.getByTestId('byok-pool-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    rerender(<ByokPoolSection snapshot={snapshot()} loading={true} connected={true} onRefresh={onRefresh} />)
    expect((screen.getByTestId('byok-pool-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})
