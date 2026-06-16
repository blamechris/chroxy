/**
 * MailboxPanel (#5914 follow-up) — renderer tests.
 *
 * Covers the surface against a mocked `mailbox_status_snapshot`:
 *   - empty / loading / not-connected states before the first snapshot
 *   - summary chips render the registration + delivery counts
 *   - one registrations row per agentCommId (with busy/idle + tui/notify-only)
 *   - one deliveries row per event, outcome tag accent mapping
 *   - null unreadCount renders as "—"
 *   - the FORBIDDEN error annotation renders
 *   - Refresh dispatches the request (and is disabled while loading)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ServerMailboxStatusSnapshotMessage } from '@chroxy/protocol'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      mailboxStatus: null,
      mailboxStatusLoading: false,
      connectionPhase: 'connected',
      requestMailboxStatus: () => false,
    }),
}))
import { MailboxPanel } from './MailboxPanel'

afterEach(cleanup)

function snapshot(over: Partial<ServerMailboxStatusSnapshotMessage> = {}): ServerMailboxStatusSnapshotMessage {
  return {
    type: 'mailbox_status_snapshot',
    requestId: null,
    generatedAt: '2026-06-16T07:00:00.000Z',
    registrations: [
      { agentCommId: 'coder', sessionId: 'sid-1', sessionName: 'Coder', isBusy: false, isTui: true },
      { agentCommId: 'builder', sessionId: 'sid-2', sessionName: 'Builder', isBusy: true, isTui: true },
      { agentCommId: 'sdk', sessionId: 'sid-3', sessionName: null, isBusy: false, isTui: false },
    ],
    recentEvents: [
      { at: 1718521200000, to: 'coder', from: 'alice', unreadCount: 3, outcome: 'injected' },
      { at: 1718521100000, to: 'builder', from: 'unknown', unreadCount: null, outcome: 'busy' },
      { at: 1718521000000, to: 'ghost', from: 'bob', unreadCount: 1, outcome: 'no-session' },
    ],
    ...over,
  }
}

const NOW = () => Date.parse('2026-06-16T07:05:00.000Z')

describe('MailboxPanel', () => {
  it('shows the empty state with a Load snapshot button before the first snapshot', () => {
    render(<MailboxPanel snapshot={null} loading={false} connected onRefresh={() => {}} now={NOW} />)
    expect(screen.getByTestId('mailbox-empty')).toBeTruthy()
    expect(screen.getByTestId('mailbox-empty-refresh')).toBeTruthy()
  })

  it('shows a loading message while the first survey runs', () => {
    render(<MailboxPanel snapshot={null} loading connected onRefresh={() => {}} now={NOW} />)
    expect(screen.getByTestId('mailbox-empty').textContent).toContain('Loading the mailbox snapshot')
  })

  it('shows a not-connected hint when offline with no snapshot', () => {
    render(<MailboxPanel snapshot={null} loading={false} connected={false} onRefresh={() => {}} now={NOW} />)
    expect(screen.getByTestId('mailbox-not-connected')).toBeTruthy()
  })

  it('renders the summary chips with registration + delivery counts', () => {
    render(<MailboxPanel snapshot={snapshot()} connected onRefresh={() => {}} now={NOW} />)
    expect(screen.getByTestId('mailbox-chip-count-registrations').textContent).toBe('3')
    expect(screen.getByTestId('mailbox-chip-count-deliveries').textContent).toBe('3')
  })

  it('renders one registrations row per agentCommId with state + delivery columns', () => {
    render(<MailboxPanel snapshot={snapshot()} connected onRefresh={() => {}} now={NOW} />)
    expect(screen.getByTestId('mailbox-reg-coder')).toBeTruthy()
    expect(screen.getByTestId('mailbox-reg-state-coder').textContent).toBe('Idle')
    expect(screen.getByTestId('mailbox-reg-state-builder').textContent).toBe('Busy')
    expect(screen.getByTestId('mailbox-reg-pty-coder').textContent).toBe('claude-tui')
    expect(screen.getByTestId('mailbox-reg-pty-sdk').textContent).toBe('notify-only')
    // Unnamed session falls back to "(unnamed)".
    expect(screen.getByTestId('mailbox-reg-session-sdk').textContent).toBe('(unnamed)')
  })

  it('renders one deliveries row per event, with the outcome tag and null unread as a dash', () => {
    render(<MailboxPanel snapshot={snapshot()} connected onRefresh={() => {}} now={NOW} />)
    expect(screen.getByTestId('mailbox-event-0')).toBeTruthy()
    expect(screen.getByTestId('mailbox-event-2')).toBeTruthy()
    // null unreadCount → "—"
    expect(screen.getByTestId('mailbox-event-unread-1').textContent).toBe('—')
    // outcome tags + accents
    expect(screen.getByTestId('mailbox-outcome-injected').getAttribute('data-accent')).toBe('ok')
    expect(screen.getByTestId('mailbox-outcome-busy').getAttribute('data-accent')).toBe('warn')
    expect(screen.getByTestId('mailbox-outcome-no-session').getAttribute('data-accent')).toBe('bad')
  })

  it('renders the empty-table rows when there are no registrations / deliveries', () => {
    render(<MailboxPanel snapshot={snapshot({ registrations: [], recentEvents: [] })} connected onRefresh={() => {}} now={NOW} />)
    expect(screen.getByTestId('mailbox-no-registrations')).toBeTruthy()
    expect(screen.getByTestId('mailbox-no-deliveries')).toBeTruthy()
  })

  it('renders the error annotation when the snapshot carries one', () => {
    render(
      <MailboxPanel
        snapshot={snapshot({ error: { code: 'FORBIDDEN', message: 'requires host-level authority' } })}
        connected
        onRefresh={() => {}}
        now={NOW}
      />,
    )
    expect(screen.getByTestId('mailbox-error').textContent).toContain('host-level authority')
  })

  it('dispatches Refresh and disables it while loading', () => {
    const onRefresh = vi.fn()
    const { rerender } = render(<MailboxPanel snapshot={snapshot()} loading={false} connected onRefresh={onRefresh} now={NOW} />)
    fireEvent.click(screen.getByTestId('mailbox-refresh'))
    expect(onRefresh).toHaveBeenCalledTimes(1)

    rerender(<MailboxPanel snapshot={snapshot()} loading connected onRefresh={onRefresh} now={NOW} />)
    expect((screen.getByTestId('mailbox-refresh') as HTMLButtonElement).disabled).toBe(true)
  })
})
