/**
 * NotificationBanners — cross-session notification banners with quick-approve (#1369)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { NotificationBanners } from './NotificationBanners'
import type { SessionNotification } from '../store/types'
import fs from 'node:fs'
import path from 'node:path'

afterEach(cleanup)

function makeNotification(overrides: Partial<SessionNotification> = {}): SessionNotification {
  return {
    id: 'n-1',
    sessionId: 'sess-1',
    sessionName: 'My Session',
    eventType: 'permission',
    message: 'Write to /tmp/test.txt',
    timestamp: Date.now(),
    requestId: 'req-abc',
    ...overrides,
  }
}

describe('NotificationBanners', () => {
  it('renders nothing when notifications array is empty', () => {
    const { container } = render(
      <NotificationBanners
        notifications={[]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
      />
    )
    expect(container.querySelector('.notification-banners')).not.toBeInTheDocument()
  })

  it('renders a permission banner with session name and tool description', () => {
    render(
      <NotificationBanners
        notifications={[makeNotification()]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
      />
    )
    expect(screen.getByText('My Session')).toBeInTheDocument()
    expect(screen.getByText(/Write to \/tmp\/test\.txt/)).toBeInTheDocument()
  })

  it('shows approve/deny buttons for permission notifications', () => {
    render(
      <NotificationBanners
        notifications={[makeNotification()]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /allow/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument()
  })

  it('calls onApprove with requestId when Allow clicked', () => {
    const onApprove = vi.fn()
    render(
      <NotificationBanners
        notifications={[makeNotification()]}
        onApprove={onApprove}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /allow/i }))
    expect(onApprove).toHaveBeenCalledWith('req-abc', 'n-1')
  })

  it('calls onDeny with requestId when Deny clicked', () => {
    const onDeny = vi.fn()
    render(
      <NotificationBanners
        notifications={[makeNotification()]}
        onApprove={vi.fn()}
        onDeny={onDeny}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /deny/i }))
    expect(onDeny).toHaveBeenCalledWith('req-abc', 'n-1')
  })

  it('does not show approve/deny buttons for non-permission notifications', () => {
    render(
      <NotificationBanners
        notifications={[makeNotification({ eventType: 'completed', requestId: undefined })]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: /allow/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /deny/i })).not.toBeInTheDocument()
  })

  it('calls onDismiss when dismiss button clicked', () => {
    const onDismiss = vi.fn()
    render(
      <NotificationBanners
        notifications={[makeNotification({ eventType: 'completed', requestId: undefined })]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={onDismiss}
        onSwitchSession={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledWith('n-1')
  })

  it('calls onSwitchSession when session name clicked', () => {
    const onSwitch = vi.fn()
    render(
      <NotificationBanners
        notifications={[makeNotification()]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={onSwitch}
      />
    )
    fireEvent.click(screen.getByText('My Session'))
    expect(onSwitch).toHaveBeenCalledWith('sess-1')
  })

  it('shows max 3 banners with overflow count', () => {
    const notifications = [
      makeNotification({ id: 'n-1', sessionId: 'sess-1', sessionName: 'Session 1' }),
      makeNotification({ id: 'n-2', sessionId: 'sess-2', sessionName: 'Session 2' }),
      makeNotification({ id: 'n-3', sessionId: 'sess-3', sessionName: 'Session 3' }),
      makeNotification({ id: 'n-4', sessionId: 'sess-4', sessionName: 'Session 4' }),
      makeNotification({ id: 'n-5', sessionId: 'sess-5', sessionName: 'Session 5' }),
    ]
    render(
      <NotificationBanners
        notifications={notifications}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
      />
    )
    // Should show 3 banners + overflow indicator
    expect(screen.getByText('Session 1')).toBeInTheDocument()
    expect(screen.getByText('Session 2')).toBeInTheDocument()
    expect(screen.getByText('Session 3')).toBeInTheDocument()
    expect(screen.queryByText('Session 4')).not.toBeInTheDocument()
    expect(screen.getByText(/\+2 more/)).toBeInTheDocument()
  })

  it('shows event type icon/label for different notification types', () => {
    render(
      <NotificationBanners
        notifications={[makeNotification({ eventType: 'error', requestId: undefined, message: 'Session crashed' })]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
      />
    )
    expect(screen.getByText(/Session crashed/)).toBeInTheDocument()
  })

  it('has accessible role for banner region', () => {
    render(
      <NotificationBanners
        notifications={[makeNotification()]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={vi.fn()}
        onSwitchSession={vi.fn()}
      />
    )
    expect(screen.getByRole('log')).toBeInTheDocument()
  })
})

describe('NotificationBanners source analysis', () => {
  const typesSource = fs.readFileSync(
    path.resolve(__dirname, '../store/types.ts'),
    'utf-8',
  )

  it('SessionNotification type includes requestId field', () => {
    expect(typesSource).toMatch(/requestId\??\s*:\s*string/)
  })
})
