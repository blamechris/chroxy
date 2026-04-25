/**
 * WelcomeScreen component tests (#1106)
 *
 * Shows when no sessions are active. Provides quick-start actions:
 * new session, recent sessions resume, keyboard shortcut hints.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { WelcomeScreen, type WelcomeScreenProps } from './WelcomeScreen'

const ORIGINAL_NAVIGATOR = globalThis.navigator

afterEach(() => {
  cleanup()
  Object.defineProperty(globalThis, 'navigator', {
    value: ORIGINAL_NAVIGATOR,
    configurable: true,
    writable: true,
  })
  vi.restoreAllMocks()
})

function setUserAgent(ua: string) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua },
    configurable: true,
    writable: true,
  })
}

const noop = () => {}

function renderWelcome(props: Partial<WelcomeScreenProps> = {}) {
  const defaultProps: WelcomeScreenProps = {
    onNewSession: noop,
    recentSessions: [],
    onResumeSession: noop,
  }
  return render(<WelcomeScreen {...defaultProps} {...props} />)
}

describe('WelcomeScreen', () => {
  it('renders the logo and tagline', () => {
    renderWelcome()
    expect(screen.getByTestId('welcome-screen')).toBeInTheDocument()
    expect(screen.getByText('Chroxy')).toBeInTheDocument()
    expect(screen.getByText(/CLI Agent IDE/i)).toBeInTheDocument()
  })

  it('renders new session card', () => {
    renderWelcome()
    const btn = screen.getByTestId('welcome-new-session')
    expect(btn).toBeInTheDocument()
    expect(btn.textContent).toMatch(/New Session/i)
  })

  it('fires onNewSession when new session card is clicked', () => {
    const onNewSession = vi.fn()
    renderWelcome({ onNewSession })
    fireEvent.click(screen.getByTestId('welcome-new-session'))
    expect(onNewSession).toHaveBeenCalledOnce()
  })

  it('shows Cmd+K shortcut hint on Mac', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    renderWelcome()
    expect(screen.getByText(/Cmd\+K/)).toBeInTheDocument()
  })

  it('shows Ctrl+K shortcut hint on non-Mac', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    renderWelcome()
    expect(screen.getByText(/Ctrl\+K/)).toBeInTheDocument()
  })

  it('renders nothing when no recent sessions', () => {
    renderWelcome({ recentSessions: [] })
    expect(screen.queryByTestId('welcome-recent-list')).not.toBeInTheDocument()
  })

  it('renders recent sessions list', () => {
    const recent = [
      { conversationId: 'c1', preview: 'Fix auth bug', cwd: '/projects/api', updatedAt: Date.now() - 3600000 },
      { conversationId: 'c2', preview: 'Add tests', cwd: '/projects/web', updatedAt: Date.now() - 7200000 },
    ]
    renderWelcome({ recentSessions: recent })
    const list = screen.getByTestId('welcome-recent-list')
    expect(list).toBeInTheDocument()
    expect(screen.getByText('Fix auth bug')).toBeInTheDocument()
    expect(screen.getByText('Add tests')).toBeInTheDocument()
  })

  it('fires onResumeSession with conversationId when recent session clicked', () => {
    const onResumeSession = vi.fn()
    const recent = [
      { conversationId: 'c1', preview: 'Fix auth bug', cwd: '/projects/api', updatedAt: Date.now() },
    ]
    renderWelcome({ recentSessions: recent, onResumeSession })
    fireEvent.click(screen.getByText('Fix auth bug'))
    expect(onResumeSession).toHaveBeenCalledWith('c1', '/projects/api')
  })

  it('shows relative timestamps for recent sessions', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-02T12:00:00Z'))
    const recent = [
      { conversationId: 'c1', preview: 'Recent task', cwd: '/home', updatedAt: new Date('2026-03-02T11:59:00Z').getTime() },
    ]
    renderWelcome({ recentSessions: recent })
    expect(screen.getByText(/1 min/i)).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('truncates long cwd paths', () => {
    const recent = [
      { conversationId: 'c1', preview: 'Task', cwd: '/home/user/very/deep/nested/project/directory', updatedAt: Date.now() },
    ]
    renderWelcome({ recentSessions: recent })
    // Should show abbreviated path, not the full thing
    const cwdEl = screen.getByTestId('welcome-recent-cwd-c1')
    expect(cwdEl.textContent!.length).toBeLessThan('/home/user/very/deep/nested/project/directory'.length)
  })

  it('limits recent sessions to 5', () => {
    const recent = Array.from({ length: 8 }, (_, i) => ({
      conversationId: `c${i}`,
      preview: `Task ${i}`,
      cwd: `/projects/p${i}`,
      updatedAt: Date.now() - i * 3600000,
    }))
    renderWelcome({ recentSessions: recent })
    const items = screen.getAllByTestId(/^welcome-recent-item-/)
    expect(items).toHaveLength(5)
  })

  it('applies className to container', () => {
    renderWelcome({ className: 'custom-welcome' })
    expect(screen.getByTestId('welcome-screen')).toHaveClass('custom-welcome')
  })
})
