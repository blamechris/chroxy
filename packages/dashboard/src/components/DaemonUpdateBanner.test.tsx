/**
 * DaemonUpdateBanner tests (#8331): the banner's three states, the confirm
 * dialog, and the once-per-commit notice (including the rollback notice).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react'
import { StrictMode } from 'react'
import type { ServerDaemonUpdateStatusMessage } from '@chroxy/protocol'
import { DaemonUpdateBanner, deriveNotice, formatClock, REQUEST_SLOW_MS, type DaemonUpdateBannerProps } from './DaemonUpdateBanner'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const NOW = Date.parse('2026-10-07T12:00:00.000Z')

const status = (over: Partial<ServerDaemonUpdateStatusMessage> = {}): ServerDaemonUpdateStatusMessage => ({
  type: 'daemon_update_status',
  running: A,
  pending: { target: B, from: A, subject: 'feat: faster tabs', commitsAhead: 1, queuedAt: '2026-10-07T11:00:00.000Z', reason: 'busy' },
  lastDeploy: null,
  postponedUntil: null,
  requestPending: false,
  applying: false,
  ...over,
})
const deployed = (result: string, over: Record<string, unknown> = {}) => ({ from: A, to: B, at: '2026-10-07T11:59:00.000Z', result, subject: 'feat: faster tabs', ...over })

function setup(over: Partial<DaemonUpdateBannerProps> = {}) {
  const props: DaemonUpdateBannerProps = {
    status: status(), busy: false, confirm: null, error: null,
    onRestartNow: vi.fn(), onPostpone: vi.fn(), onConfirmRestart: vi.fn(), onCancelConfirm: vi.fn(), onDismissError: vi.fn(),
    now: () => NOW,
    ...over,
  }
  const view = render(<DaemonUpdateBanner {...props} />)
  return { props, ...view }
}

beforeEach(() => { localStorage.clear() })
afterEach(cleanup)

describe('banner states', () => {
  it('pending, not postponed: "Update ready (<sha7>) — restarts when idle" with the subject and both buttons', () => {
    const { props } = setup()
    expect(screen.getByTestId('daemon-update-message').textContent).toBe(`Update ready (${B.slice(0, 7)}) — restarts when idle`)
    expect(screen.getByTestId('daemon-update-subject').textContent).toBe('feat: faster tabs')
    fireEvent.click(screen.getByTestId('daemon-update-restart-now'))
    expect(props.onRestartNow).toHaveBeenCalledWith(B)
    fireEvent.click(screen.getByTestId('daemon-update-postpone'))
    expect(props.onPostpone).toHaveBeenCalledWith(B)
    expect(screen.getByTestId('daemon-update-postpone').textContent).toBe('Postpone 1h')
  })

  it('shows how many commits are waiting', () => {
    setup({ status: status({ pending: { target: B, from: A, subject: 'feat: x', commitsAhead: 4, queuedAt: '2026-10-07T11:00:00.000Z', reason: 'busy' } }) })
    expect(screen.getByTestId('daemon-update-subject').textContent).toBe('feat: x (+3 more)')
  })

  it('postponed: "postponed until HH:MM" and only Restart now', () => {
    const until = '2026-10-07T13:05:00.000Z'
    setup({ status: status({ postponedUntil: until }) })
    expect(screen.getByTestId('daemon-update-message').textContent).toBe(`Update ${B.slice(0, 7)} postponed until ${formatClock(until)}`)
    expect(screen.getByTestId('daemon-update-restart-now')).toBeInTheDocument()
    expect(screen.queryByTestId('daemon-update-postpone')).not.toBeInTheDocument()
  })

  it('request pending: "Restarting to apply <sha7>…" and no buttons', () => {
    setup({ status: status({ requestPending: true, postponedUntil: '2026-10-07T13:05:00.000Z' }) })
    expect(screen.getByTestId('daemon-update-message').textContent).toBe(`Restarting to apply ${B.slice(0, 7)}…`)
    expect(screen.queryByTestId('daemon-update-restart-now')).not.toBeInTheDocument()
    expect(screen.queryByTestId('daemon-update-postpone')).not.toBeInTheDocument()
  })

  it('applying: "Restarting to apply <sha7>…" with NO buttons, whatever else the status says', () => {
    setup({ status: status({ applying: true, pending: { target: B, from: A, subject: 'feat: x', commitsAhead: 1, queuedAt: '2026-10-07T11:00:00.000Z', reason: 'applying' } }) })
    expect(screen.getByTestId('daemon-update-message').textContent).toBe(`Restarting to apply ${B.slice(0, 7)}…`)
    expect(screen.queryByTestId('daemon-update-restart-now')).not.toBeInTheDocument()
    expect(screen.queryByTestId('daemon-update-postpone')).not.toBeInTheDocument()
    cleanup()
    // Even a stale "postponed" or request flag cannot bring the buttons back while applying.
    setup({ status: status({ applying: true, postponedUntil: '2026-10-07T13:05:00.000Z', pending: { target: B, from: A, subject: 's', commitsAhead: 1, queuedAt: '2026-10-07T11:00:00.000Z', reason: 'applying' } }) })
    expect(screen.queryByTestId('daemon-update-restart-now')).not.toBeInTheDocument()
  })

  it('a restart request still unclaimed after 30 s says it applies at the next scheduled check', () => {
    vi.useFakeTimers()
    try {
      setup({ status: status({ requestPending: true }) })
      expect(screen.getByTestId('daemon-update-message').textContent).toBe(`Restarting to apply ${B.slice(0, 7)}…`)
      act(() => { vi.advanceTimersByTime(REQUEST_SLOW_MS - 1) })
      expect(screen.getByTestId('daemon-update-message').textContent).toContain('Restarting to apply')
      act(() => { vi.advanceTimersByTime(2) })
      expect(screen.getByTestId('daemon-update-message').textContent).toBe('Restart requested — applies at the next scheduled check')
      expect(screen.queryByTestId('daemon-update-restart-now')).not.toBeInTheDocument()
    } finally { vi.useRealTimers() }
  })

  it('the 30 s clock restarts when the pending target changes (no stale "applies at the next scheduled check" for a new update)', () => {
    vi.useFakeTimers()
    try {
      const props = {
        busy: false, confirm: null, error: null, onRestartNow: vi.fn(), onPostpone: vi.fn(), onConfirmRestart: vi.fn(), onCancelConfirm: vi.fn(), onDismissError: vi.fn(), now: () => NOW,
      }
      const pend = (target: string) => ({ target, from: A, subject: 's', commitsAhead: 1, queuedAt: '2026-10-07T11:00:00.000Z', reason: 'busy' as const })
      const { rerender } = render(<DaemonUpdateBanner {...props} status={status({ requestPending: true })} />)
      act(() => { vi.advanceTimersByTime(REQUEST_SLOW_MS + 1) })
      expect(screen.getByTestId('daemon-update-message').textContent).toContain('applies at the next scheduled check')
      rerender(<DaemonUpdateBanner {...props} status={status({ requestPending: true, pending: pend(C) })} />)
      expect(screen.getByTestId('daemon-update-message').textContent).toBe(`Restarting to apply ${C.slice(0, 7)}…`)
      act(() => { vi.advanceTimersByTime(REQUEST_SLOW_MS - 1) })
      expect(screen.getByTestId('daemon-update-message').textContent).toContain('Restarting to apply')
    } finally { vi.useRealTimers() }
  })

  it('unknown idle: "can\'t confirm the daemon is idle", Restart now is NOT offered, Postpone still is', () => {
    const { props } = setup({ status: status({ pending: { target: B, from: A, subject: 'feat: x', commitsAhead: 1, queuedAt: '2026-10-07T11:00:00.000Z', reason: 'unknown' } }) })
    expect(screen.getByTestId('daemon-update-message').textContent).toBe(`Update ready (${B.slice(0, 7)}) — can't confirm the daemon is idle`)
    expect(screen.queryByTestId('daemon-update-restart-now')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('daemon-update-postpone'))
    expect(props.onPostpone).toHaveBeenCalledWith(B)
  })

  it('an action in flight disables the buttons', () => {
    setup({ busy: true })
    expect(screen.getByTestId('daemon-update-restart-now')).toBeDisabled()
    expect(screen.getByTestId('daemon-update-postpone')).toBeDisabled()
  })

  it('renders nothing with no status, or with nothing pending and nothing to say', () => {
    setup({ status: null })
    expect(screen.queryByTestId('daemon-update-region')).not.toBeInTheDocument()
    cleanup()
    setup({ status: status({ pending: null }) })
    expect(screen.queryByTestId('daemon-update-region')).not.toBeInTheDocument()
  })

  it('is a polite status region, and shows a failed action\'s message', () => {
    const { props } = setup({ error: 'The daemon could not record the request. Try again.' })
    expect(screen.getByTestId('daemon-update-banner')).toHaveAttribute('role', 'status')
    expect(screen.getByTestId('daemon-update-error').textContent).toContain('could not record')
    fireEvent.click(screen.getByTestId('daemon-update-error-dismiss'))
    expect(props.onDismissError).toHaveBeenCalled()
  })

  it('every control is a 44px tap target (the stylesheet says so)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const css = readFileSync(resolve(__dirname, '../theme/components.css'), 'utf8')
    const rule = css.match(/\.daemon-update-btn\s*\{([^}]+)\}/)
    expect(rule, 'the button rule exists').toBeTruthy()
    expect(rule![1]).toMatch(/min-height:\s*44px/)
    expect(rule![1]).toMatch(/min-width:\s*44px/)
  })

  it('the region has its own grid row above the header, and the rows below were renumbered', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const css = readFileSync(resolve(__dirname, '../theme/components.css'), 'utf8')
    const row = (sel: string) => css.match(new RegExp(`#app\\.with-sidebar\\s*>\\s*${sel}\\s*\\{([^}]+)\\}`))?.[1]?.match(/grid-row:\s*(\d+)/)?.[1]
    // #8268 added the stale-bundle row (4) above this one, so everything from here down moved by one.
    expect(row('\\.stale-bundle-banner')).toBe('4')
    expect(row('\\.daemon-update-region')).toBe('5')
    expect(row('header')).toBe('6')
    expect(row('\\.sidebar')).toBe('7')
    expect(row('\\.main-wrapper')).toBe('7')
    expect(row('\\.footer-bar')).toBe('8')
    expect(css.match(/grid-template-rows:\s*auto auto auto auto auto auto 1fr auto;/)).toBeTruthy()
  })
})

describe('confirm dialog', () => {
  const confirm = { type: 'daemon_update_confirm_required' as const, requestId: 'r', target: B, reasons: ['session "api" busy: turn', 'session "web" has 1 pending permission(s)'], sessions: [] }

  it('lists the busy reasons and offers Restart anyway / Cancel', () => {
    const { props } = setup({ confirm })
    const list = screen.getByTestId('daemon-update-confirm-reasons')
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(confirm.reasons)
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    expect(props.onConfirmRestart).toHaveBeenCalledWith(B)
    expect(screen.getByTestId('confirm-dialog-confirm').textContent).toBe('Restart anyway')
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'))
    expect(props.onCancelConfirm).toHaveBeenCalled()
  })

  it('falls back to session names, then to an honest "could not confirm"', () => {
    setup({ confirm: { ...confirm, reasons: [], sessions: [{ sessionId: 's1', name: 'api', busyReason: 'turn' }] } })
    expect(screen.getByTestId('daemon-update-confirm-reasons').textContent).toBe('api')
    cleanup()
    setup({ confirm: { ...confirm, reasons: [], sessions: [] } })
    expect(screen.getByTestId('daemon-update-confirm-unknown')).toBeInTheDocument()
  })

  it('is closed when there is nothing to confirm', () => {
    setup()
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
  })
})

describe('the post-deploy notice', () => {
  it('"Updated to <sha7> — <subject>" for a successful deploy, once per commit', () => {
    const lastDeploy = deployed('ok')
    const { unmount } = setup({ status: status({ pending: null, running: B, lastDeploy }) })
    expect(screen.getByTestId('daemon-update-notice-message').textContent).toBe(`Updated to ${B.slice(0, 7)} — feat: faster tabs`)
    unmount()
    // A reload of the page: the same commit is not announced again.
    setup({ status: status({ pending: null, running: B, lastDeploy }) })
    expect(screen.queryByTestId('daemon-update-notice')).not.toBeInTheDocument()
    cleanup()
    // A different commit is news again.
    setup({ status: status({ pending: null, running: C, lastDeploy: deployed('ok', { to: C }) }) })
    expect(screen.getByTestId('daemon-update-notice-message').textContent).toContain(C.slice(0, 7))
  })

  it('survives StrictMode double effects (shows once, does not vanish)', () => {
    render(
      <StrictMode>
        <DaemonUpdateBanner status={status({ pending: null, running: B, lastDeploy: deployed('ok') })} busy={false} confirm={null} error={null}
          onRestartNow={vi.fn()} onPostpone={vi.fn()} onConfirmRestart={vi.fn()} onCancelConfirm={vi.fn()} onDismissError={vi.fn()} now={() => NOW} />
      </StrictMode>,
    )
    expect(screen.getByTestId('daemon-update-notice')).toBeInTheDocument()
  })

  it('is dismissible and stays dismissed across status updates', () => {
    const lastDeploy = deployed('ok')
    const props = {
      busy: false, confirm: null, error: null, onRestartNow: vi.fn(), onPostpone: vi.fn(), onConfirmRestart: vi.fn(), onCancelConfirm: vi.fn(), onDismissError: vi.fn(), now: () => NOW,
    }
    const { rerender } = render(<DaemonUpdateBanner {...props} status={status({ pending: null, running: B, lastDeploy })} />)
    fireEvent.click(screen.getByTestId('daemon-update-notice-dismiss'))
    expect(screen.queryByTestId('daemon-update-notice')).not.toBeInTheDocument()
    rerender(<DaemonUpdateBanner {...props} status={status({ pending: null, running: B, lastDeploy, requestPending: false })} />)
    expect(screen.queryByTestId('daemon-update-notice')).not.toBeInTheDocument()
  })

  it('a rolled-back target says "Update <sha7> failed and was rolled back"', () => {
    setup({ status: status({ pending: null, running: A, lastDeploy: deployed('rolled-back-build') }) })
    expect(screen.getByTestId('daemon-update-notice-message').textContent).toBe(`Update ${B.slice(0, 7)} failed and was rolled back`)
    expect(screen.getByTestId('daemon-update-notice')).toHaveAttribute('data-kind', 'rolled-back')
  })

  it('storage that throws never breaks rendering (the notice just may repeat)', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      setup({ status: status({ pending: null, running: B, lastDeploy: deployed('ok') }) })
      expect(screen.getByTestId('daemon-update-notice')).toBeInTheDocument()
    } finally { get.mockRestore(); set.mockRestore() }
  })
})

describe('deriveNotice', () => {
  const s = (lastDeploy: ServerDaemonUpdateStatusMessage['lastDeploy'], running: string | null = B) => status({ pending: null, running, lastDeploy })

  it('maps every result string the deploy script writes', () => {
    expect(deriveNotice(s(deployed('ok')), NOW)).toMatchObject({ kind: 'updated', sha: B })
    expect(deriveNotice(s(deployed('ok (tunnel not checked: --no-tunnel-check)')), NOW)).toMatchObject({ kind: 'updated', sha: B })
    expect(deriveNotice(s(deployed('deployed-tunnel-unverified')), NOW)).toMatchObject({ kind: 'updated', note: expect.stringContaining('tunnel') })
    expect(deriveNotice(s(deployed('rolled-back-build'), A), NOW)).toMatchObject({ kind: 'rolled-back', sha: B })
    expect(deriveNotice(s(deployed('rolled-back-restart'), A), NOW)).toMatchObject({ kind: 'rolled-back', sha: B })
    expect(deriveNotice(s(deployed('rollback-failed'), A), NOW)).toMatchObject({ kind: 'rollback-failed', sha: B })
    expect(deriveNotice(s(deployed('rollback-manual-restart'), A), NOW)).toBeNull()
    expect(deriveNotice(s(deployed('something-new'), A), NOW)).toBeNull()
  })

  it('a health-failure rollback is recorded bad -> good, so the FAILED commit is `from`', () => {
    // scripts/deploy-daemon.mjs: recordResult(fwdTarget, want, 'rolled-back') — `to` is the good commit.
    const n = deriveNotice(s(deployed('rolled-back', { from: B, to: A }), A), NOW)
    expect(n).toMatchObject({ kind: 'rolled-back', sha: B })
  })

  it('only a deploy within the last 7 days is news', () => {
    expect(deriveNotice(s(deployed('ok', { at: new Date(NOW - 6.9 * 864e5).toISOString() })), NOW)).not.toBeNull()
    expect(deriveNotice(s(deployed('ok', { at: new Date(NOW - 7.1 * 864e5).toISOString() })), NOW)).toBeNull()
  })

  it('"Updated to X" needs the daemon to be KNOWN to run X', () => {
    expect(deriveNotice(s(deployed('ok'), C), NOW)).toBeNull()
    expect(deriveNotice(s(deployed('ok'), B), NOW)).not.toBeNull()
    // No evidence, no claim: a daemon that cannot report its commit gets no "Updated to".
    expect(deriveNotice(s(deployed('ok'), null), NOW)).toBeNull()
    expect(deriveNotice(s(deployed('deployed-tunnel-unverified'), null), NOW)).toBeNull()
  })
})
