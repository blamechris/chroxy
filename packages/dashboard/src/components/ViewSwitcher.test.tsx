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
import { render, screen, cleanup } from '@testing-library/react'
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
  it('shows both Chat and Output by default (chat provider path unaffected)', () => {
    renderSwitcher({ showTerminalTab: true })
    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Output' })).toBeInTheDocument()
  })

  it('hides the Output tab for providers without a PTY (showTerminalTab=false)', () => {
    renderSwitcher({ showTerminalTab: false })
    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Output' })).not.toBeInTheDocument()
  })

  it('hides the Chat tab for terminal-only providers (#5986 user-shell)', () => {
    renderSwitcher({ showChatTab: false, showTerminalTab: true })
    expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument()
    // The Output terminal stays — that's the only surface a user-shell has.
    expect(screen.getByRole('button', { name: 'Output' })).toBeInTheDocument()
  })

  // #5998 — dedicated Split + showChatTab=false case: a terminal-only provider
  // (user-shell) has no chat surface, so the Split tab — which renders a
  // ChatView alongside a terminal pane — must be hidden even though the Output
  // terminal is present.
  it('hides the Split tab when showChatTab=false (terminal-only provider) (#5998)', () => {
    renderSwitcher({ showChatTab: false, showTerminalTab: true })
    expect(screen.queryByRole('button', { name: 'Split' })).not.toBeInTheDocument()
    // The Output terminal stays — the only surface a user-shell has.
    expect(screen.getByRole('button', { name: 'Output' })).toBeInTheDocument()
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
