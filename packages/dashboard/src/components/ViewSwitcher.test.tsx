/**
 * ViewSwitcher tab-visibility tests.
 *
 * Pins the provider-aware tab gates:
 *   - #5835: the "Output" tab appears only for providers with a real PTY
 *     (claude-tui, and user-shell since #5986) via `showTerminalTab`.
 *   - #5986: the "Chat" tab is hidden for terminal-only providers
 *     (user-shell — a raw $SHELL has no parsed chat surface) via
 *     `showChatTab`. Both default to shown so the common chat-provider
 *     path is unaffected.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ViewSwitcher } from './ViewSwitcher'

afterEach(cleanup)

function renderSwitcher(overrides: Partial<Parameters<typeof ViewSwitcher>[0]> = {}) {
  return render(
    <ViewSwitcher
      viewMode="terminal"
      setViewMode={vi.fn()}
      splitMode={null}
      setSplitMode={vi.fn()}
      persistSplitMode={vi.fn()}
      showConsoleTab={false}
      unreadSystemCount={0}
      checkpointsOpen={false}
      setCheckpointsOpen={vi.fn()}
      {...overrides}
    />,
  )
}

describe('ViewSwitcher tab gates', () => {
  it('shows both Chat and Terminal by default (chat provider path unaffected)', () => {
    renderSwitcher({ showTerminalTab: true })
    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument()
  })

  it('hides the Terminal tab for providers without a PTY (showTerminalTab=false)', () => {
    renderSwitcher({ showTerminalTab: false })
    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Terminal' })).not.toBeInTheDocument()
  })

  it('hides the Chat tab for terminal-only providers (#5986 user-shell)', () => {
    renderSwitcher({ showChatTab: false, showTerminalTab: true })
    expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument()
    // The Output terminal stays — that's the only surface a user-shell has.
    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument()
  })

  // #5998 — dedicated Split + showChatTab=false case: a terminal-only provider
  // (user-shell) has no chat surface, so the Split tab — which renders a
  // ChatView alongside a terminal pane — must be hidden even though the Output
  // terminal is present.
  it('hides the Split tab when showChatTab=false (terminal-only provider) (#5998)', () => {
    renderSwitcher({ showChatTab: false, showTerminalTab: true })
    expect(screen.queryByRole('button', { name: 'Split' })).not.toBeInTheDocument()
    // The Output terminal stays — the only surface a user-shell has.
    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument()
  })

  it('shows Split only when BOTH chat and terminal surfaces exist (#5997)', () => {
    // Split renders a ChatView + a terminal pane, so it needs both — present
    // only when showChatTab AND showTerminalTab (claude-tui today).
    renderSwitcher({ showChatTab: true, showTerminalTab: true })
    expect(screen.getByRole('button', { name: 'Split' })).toBeInTheDocument()

    // Terminal-only provider (user-shell): no chat surface → hidden.
    cleanup()
    renderSwitcher({ showChatTab: false, showTerminalTab: true })
    expect(screen.queryByRole('button', { name: 'Split' })).not.toBeInTheDocument()

    // Chat-only provider (no PTY/Output): no terminal surface → hidden too,
    // otherwise the terminal half would render empty (Copilot review).
    cleanup()
    renderSwitcher({ showChatTab: true, showTerminalTab: false })
    expect(screen.queryByRole('button', { name: 'Split' })).not.toBeInTheDocument()
  })
})

// #6799 — global compact chat filter toggle (hide tool calls + thinking, mobile
// parity). The control only renders while a chat surface is on screen and only
// when a handler is wired.
describe('ViewSwitcher compact chat filter toggle (#6799)', () => {
  const TOGGLE = 'compact-chat-filter-toggle'

  it('renders the toggle on the chat view when a handler is supplied', () => {
    renderSwitcher({ viewMode: 'chat', onToggleCompactChatFilter: vi.fn() })
    expect(screen.getByTestId(TOGGLE)).toBeInTheDocument()
  })

  it('renders the toggle in split view too (split always shows a ChatView)', () => {
    renderSwitcher({ viewMode: 'terminal', splitMode: 'horizontal', showTerminalTab: true, onToggleCompactChatFilter: vi.fn() })
    expect(screen.getByTestId(TOGGLE)).toBeInTheDocument()
  })

  it('hides the toggle on non-chat views (e.g. the terminal tab)', () => {
    renderSwitcher({ viewMode: 'terminal', showTerminalTab: true, onToggleCompactChatFilter: vi.fn() })
    expect(screen.queryByTestId(TOGGLE)).not.toBeInTheDocument()
  })

  it('hides the toggle for terminal-only providers (no chat surface)', () => {
    renderSwitcher({ viewMode: 'chat', showChatTab: false, showTerminalTab: true, onToggleCompactChatFilter: vi.fn() })
    expect(screen.queryByTestId(TOGGLE)).not.toBeInTheDocument()
  })

  it('hides the toggle entirely when no handler is wired', () => {
    renderSwitcher({ viewMode: 'chat' })
    expect(screen.queryByTestId(TOGGLE)).not.toBeInTheDocument()
  })

  it('reflects the current filter state via aria-pressed', () => {
    renderSwitcher({ viewMode: 'chat', compactChatFilter: true, onToggleCompactChatFilter: vi.fn() })
    expect(screen.getByTestId(TOGGLE)).toHaveAttribute('aria-pressed', 'true')

    cleanup()
    renderSwitcher({ viewMode: 'chat', compactChatFilter: false, onToggleCompactChatFilter: vi.fn() })
    expect(screen.getByTestId(TOGGLE)).toHaveAttribute('aria-pressed', 'false')
  })

  it('invokes the handler with the negated state on click', () => {
    const onToggle = vi.fn()
    renderSwitcher({ viewMode: 'chat', compactChatFilter: false, onToggleCompactChatFilter: onToggle })
    fireEvent.click(screen.getByTestId(TOGGLE))
    expect(onToggle).toHaveBeenCalledWith(true)
  })
})
