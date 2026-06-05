/**
 * ActivityTree tests (#5176, epic #5170).
 *
 * The reusable per-session activity tree extracted from the retired Control
 * Room v1 sidebar panel. Covers the read-only live tree rendering:
 * hierarchy/indentation, status badges, live + frozen elapsed timers, the
 * blocked-state highlight, expand-to-output, and the session-scoped expansion
 * reset (id collision guard). The store wiring is covered separately in
 * dispatch-control-room-activity.test.ts; the drill-down integration into the
 * Control Room section is covered in ControlRoomSection.test.tsx.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import {
  applyActivitySnapshot,
  createEmptyActivityState,
  type ActivityEntry,
  type ActivityState,
} from '@chroxy/store-core'
import { ActivityTree, formatElapsed } from './ActivityTree'

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

describe('ActivityTree (#5176)', () => {
  it('renders the empty state when there is no session', () => {
    render(<ActivityTree activity={createEmptyActivityState()} sessionId={null} />)
    expect(screen.getByTestId('control-room-empty')).toHaveTextContent('No active session')
  })

  it('renders the empty state when the session has no activity', () => {
    render(<ActivityTree activity={createEmptyActivityState()} sessionId={SESSION_ID} />)
    expect(screen.getByTestId('control-room-empty')).toHaveTextContent('No activity in flight')
  })

  it('renders the tree with labels and status badges', () => {
    const activity = buildActivity([
      entry('a', { status: 'running', label: 'Run a search' }),
      entry('b', { status: 'done', endedAt: 2000, label: 'Done thing' }),
      entry('c', { status: 'failed', endedAt: 3000, label: 'Failed thing' }),
    ])
    render(<ActivityTree activity={activity} sessionId={SESSION_ID} now={() => 1000} />)

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
    render(<ActivityTree activity={activity} sessionId={SESSION_ID} now={() => 1000} />)

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
    render(<ActivityTree activity={activity} sessionId={SESSION_ID} now={() => 10_000} />)
    // Live entry: 10s elapsed against the injected clock.
    expect(screen.getByTestId('control-room-elapsed-live')).toHaveTextContent('10s')
    // Terminal entry: frozen at endedAt - startedAt = 5s, ignoring the clock.
    expect(screen.getByTestId('control-room-elapsed-done')).toHaveTextContent('5s')
  })

  it('live-ticks the elapsed timer for running entries', () => {
    vi.useFakeTimers()
    let clock = 1000
    const activity = buildActivity([entry('live', { status: 'running', startedAt: 1000 })])
    render(<ActivityTree activity={activity} sessionId={SESSION_ID} now={() => clock} />)
    expect(screen.getByTestId('control-room-elapsed-live')).toHaveTextContent('0s')

    act(() => {
      clock = 4000
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByTestId('control-room-elapsed-live')).toHaveTextContent('3s')
  })

  it('highlights blocked entries with the blocked class', () => {
    const activity = buildActivity([entry('blk', { status: 'blocked', label: 'Waiting on you' })])
    render(<ActivityTree activity={activity} sessionId={SESSION_ID} now={() => 1000} />)
    const toggle = screen.getByTestId('control-room-entry-toggle-blk')
    expect(toggle.className).toContain('control-room-entry-blocked')
    expect(toggle).toHaveAttribute('data-status', 'blocked')
  })

  it('expands an entry to show its output ref', () => {
    const activity = buildActivity([
      entry('a', { outputRef: { kind: 'tool_use', id: 'tool-42' } }),
    ])
    render(<ActivityTree activity={activity} sessionId={SESSION_ID} now={() => 1000} />)
    expect(screen.queryByTestId('control-room-output-a')).toBeNull()

    fireEvent.click(screen.getByTestId('control-room-entry-toggle-a'))
    expect(screen.getByTestId('control-room-output-a')).toBeInTheDocument()
    expect(screen.getByTestId('control-room-output-ref-a')).toHaveTextContent('tool_use: tool-42')

    // Toggling again collapses it.
    fireEvent.click(screen.getByTestId('control-room-entry-toggle-a'))
    expect(screen.queryByTestId('control-room-output-a')).toBeNull()
  })

  it('resets expansion state when the session changes (id collision guard)', () => {
    // Two sessions each have an entry with the SAME id 'a' (ids are only
    // unique within a session). Expanding it in session 1 must NOT carry over
    // and auto-expand the colliding id when switching to session 2.
    const s1 = buildActivity([entry('a', { outputRef: { kind: 'tool_use', id: 't1' } })], 's1')
    const s2 = buildActivity([entry('a', { outputRef: { kind: 'tool_use', id: 't2' } })], 's2')
    const { rerender } = render(
      <ActivityTree activity={s1} sessionId="s1" now={() => 1000} />,
    )
    fireEvent.click(screen.getByTestId('control-room-entry-toggle-a'))
    expect(screen.getByTestId('control-room-output-a')).toBeInTheDocument()

    rerender(<ActivityTree activity={s2} sessionId="s2" now={() => 1000} />)
    expect(screen.queryByTestId('control-room-output-a')).toBeNull()
  })

  it('shows a "no linked output" message when an entry has no outputRef', () => {
    const activity = buildActivity([entry('a')])
    render(<ActivityTree activity={activity} sessionId={SESSION_ID} now={() => 1000} />)
    fireEvent.click(screen.getByTestId('control-room-entry-toggle-a'))
    expect(screen.getByTestId('control-room-output-empty-a')).toHaveTextContent('No linked output yet')
  })

  it('does not start an interval when nothing is live (terminal-only tree)', () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    const activity = buildActivity([entry('done', { status: 'done', endedAt: 2000 })])
    render(<ActivityTree activity={activity} sessionId={SESSION_ID} now={() => 5000} />)
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
