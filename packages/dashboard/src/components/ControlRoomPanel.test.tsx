/**
 * ControlRoomPanel tests (#5163, epic #5159).
 *
 * Covers the read-only live tree rendering: hierarchy/indentation, status
 * badges, live + frozen elapsed timers, the blocked-state highlight, and
 * expand-to-output. The store wiring is covered separately in
 * dispatch-control-room-activity.test.ts.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import {
  applyActivitySnapshot,
  createEmptyActivityState,
  type ActivityEntry,
  type ActivityState,
} from '@chroxy/store-core'
import { ControlRoomPanel, controlRoomCollapsedMetric, formatElapsed } from './ControlRoomPanel'

const SESSION_ID = 'sess-1'

function buildActivity(entries: ActivityEntry[], sessionId = SESSION_ID): ActivityState {
  return applyActivitySnapshot(createEmptyActivityState(), {
    type: 'activity_snapshot',
    sessionId,
    schemaVersion: 1,
    entries,
  })
}

function entry(id: string, over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id,
    kind: 'agent',
    label: `Label ${id}`,
    status: 'running',
    startedAt: 1000,
    ...over,
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ControlRoomPanel (#5163)', () => {
  it('renders the empty state when there is no active session', () => {
    render(<ControlRoomPanel activity={createEmptyActivityState()} activeSessionId={null} />)
    expect(screen.getByTestId('control-room-empty')).toHaveTextContent('No active session')
  })

  it('renders the empty state when the active session has no activity', () => {
    render(<ControlRoomPanel activity={createEmptyActivityState()} activeSessionId={SESSION_ID} />)
    expect(screen.getByTestId('control-room-empty')).toHaveTextContent('No activity in flight')
  })

  it('renders the tree with labels and status badges', () => {
    const activity = buildActivity([
      entry('a', { status: 'running', label: 'Run a search' }),
      entry('b', { status: 'done', endedAt: 2000, label: 'Done thing' }),
      entry('c', { status: 'failed', endedAt: 3000, label: 'Failed thing' }),
    ])
    render(<ControlRoomPanel activity={activity} activeSessionId={SESSION_ID} now={() => 1000} />)

    expect(screen.getByTestId('control-room-entry-label-a')).toHaveTextContent('Run a search')
    expect(screen.getByTestId('control-room-status-a')).toHaveTextContent('Running')
    expect(screen.getByTestId('control-room-status-b')).toHaveTextContent('Done')
    expect(screen.getByTestId('control-room-status-c')).toHaveTextContent('Failed')
    // Accessible status label, not just colour.
    expect(screen.getByTestId('control-room-status-a')).toHaveAttribute('aria-label', 'Status: Running')
  })

  it('indents children below their parent', () => {
    const activity = buildActivity([
      entry('parent', { kind: 'agent' }),
      entry('child', { kind: 'tool', parentId: 'parent' }),
    ])
    render(<ControlRoomPanel activity={activity} activeSessionId={SESSION_ID} now={() => 1000} />)

    const parentToggle = screen.getByTestId('control-room-entry-toggle-parent')
    const childToggle = screen.getByTestId('control-room-entry-toggle-child')
    const parentPad = Number.parseInt(parentToggle.style.paddingLeft || '0', 10)
    const childPad = Number.parseInt(childToggle.style.paddingLeft || '0', 10)
    expect(childPad).toBeGreaterThan(parentPad)
  })

  it('freezes elapsed for terminal entries at endedAt and ticks for live ones', () => {
    const activity = buildActivity([
      entry('live', { status: 'running', startedAt: 0 }),
      entry('done', { status: 'done', startedAt: 0, endedAt: 5000 }),
    ])
    render(<ControlRoomPanel activity={activity} activeSessionId={SESSION_ID} now={() => 10_000} />)
    // Live entry: 10s elapsed against the injected clock.
    expect(screen.getByTestId('control-room-elapsed-live')).toHaveTextContent('10s')
    // Terminal entry: frozen at endedAt - startedAt = 5s, ignoring the clock.
    expect(screen.getByTestId('control-room-elapsed-done')).toHaveTextContent('5s')
  })

  it('live-ticks the elapsed timer for running entries', () => {
    vi.useFakeTimers()
    let clock = 1000
    const activity = buildActivity([entry('live', { status: 'running', startedAt: 1000 })])
    render(<ControlRoomPanel activity={activity} activeSessionId={SESSION_ID} now={() => clock} />)
    expect(screen.getByTestId('control-room-elapsed-live')).toHaveTextContent('0s')

    act(() => {
      clock = 4000
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByTestId('control-room-elapsed-live')).toHaveTextContent('3s')
  })

  it('highlights blocked entries with the blocked class', () => {
    const activity = buildActivity([entry('blk', { status: 'blocked', label: 'Waiting on you' })])
    render(<ControlRoomPanel activity={activity} activeSessionId={SESSION_ID} now={() => 1000} />)
    const toggle = screen.getByTestId('control-room-entry-toggle-blk')
    expect(toggle.className).toContain('control-room-entry-blocked')
    expect(toggle).toHaveAttribute('data-status', 'blocked')
  })

  it('expands an entry to show its output ref', () => {
    const activity = buildActivity([
      entry('a', { outputRef: { kind: 'tool_use', id: 'tool-42' } }),
    ])
    render(<ControlRoomPanel activity={activity} activeSessionId={SESSION_ID} now={() => 1000} />)
    expect(screen.queryByTestId('control-room-output-a')).toBeNull()

    fireEvent.click(screen.getByTestId('control-room-entry-toggle-a'))
    expect(screen.getByTestId('control-room-output-a')).toBeInTheDocument()
    expect(screen.getByTestId('control-room-output-ref-a')).toHaveTextContent('tool_use: tool-42')

    // Toggling again collapses it.
    fireEvent.click(screen.getByTestId('control-room-entry-toggle-a'))
    expect(screen.queryByTestId('control-room-output-a')).toBeNull()
  })

  it('resets expansion state when the active session changes (id collision guard)', () => {
    // Two sessions each have an entry with the SAME id 'a' (ids are only
    // unique within a session). Expanding it in session 1 must NOT carry over
    // and auto-expand the colliding id when switching to session 2.
    const s1 = buildActivity([entry('a', { outputRef: { kind: 'tool_use', id: 't1' } })], 's1')
    const s2 = buildActivity([entry('a', { outputRef: { kind: 'tool_use', id: 't2' } })], 's2')
    const { rerender } = render(
      <ControlRoomPanel activity={s1} activeSessionId="s1" now={() => 1000} />,
    )
    fireEvent.click(screen.getByTestId('control-room-entry-toggle-a'))
    expect(screen.getByTestId('control-room-output-a')).toBeInTheDocument()

    rerender(<ControlRoomPanel activity={s2} activeSessionId="s2" now={() => 1000} />)
    expect(screen.queryByTestId('control-room-output-a')).toBeNull()
  })

  it('shows a "no linked output" message when an entry has no outputRef', () => {
    const activity = buildActivity([entry('a')])
    render(<ControlRoomPanel activity={activity} activeSessionId={SESSION_ID} now={() => 1000} />)
    fireEvent.click(screen.getByTestId('control-room-entry-toggle-a'))
    expect(screen.getByTestId('control-room-output-empty-a')).toHaveTextContent('No linked output yet')
  })

  it('does not start an interval when nothing is live (terminal-only tree)', () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    const activity = buildActivity([entry('done', { status: 'done', endedAt: 2000 })])
    render(<ControlRoomPanel activity={activity} activeSessionId={SESSION_ID} now={() => 5000} />)
    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
  })
})

describe('formatElapsed', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(5000)).toBe('5s')
    expect(formatElapsed(65_000)).toBe('1:05')
    expect(formatElapsed(3_661_000)).toBe('1:01:01')
  })

  it('clamps negative input to 0', () => {
    expect(formatElapsed(-1000)).toBe('0s')
  })
})

describe('controlRoomCollapsedMetric', () => {
  it('returns null when no active session', () => {
    expect(controlRoomCollapsedMetric(createEmptyActivityState(), null)).toBeNull()
  })

  it('returns null when nothing is live', () => {
    const activity = buildActivity([entry('done', { status: 'done', endedAt: 2000 })])
    expect(controlRoomCollapsedMetric(activity, SESSION_ID)).toBeNull()
  })

  it('counts live entries and blocked entries', () => {
    const activity = buildActivity([
      entry('a', { status: 'running' }),
      entry('b', { status: 'blocked' }),
      entry('c', { status: 'done', endedAt: 2000 }),
    ])
    expect(controlRoomCollapsedMetric(activity, SESSION_ID)).toBe('2 live · 1 blocked')
  })

  it('omits the blocked suffix when nothing is blocked', () => {
    const activity = buildActivity([entry('a', { status: 'running' })])
    expect(controlRoomCollapsedMetric(activity, SESSION_ID)).toBe('1 live')
  })
})
