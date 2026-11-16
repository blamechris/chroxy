import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { SessionBar } from './SessionBar'
import { Sidebar } from './Sidebar'

// Keep the real badge consumers and canonical metadata, but never initialize
// the connection store or a native bridge for a provider-description test.
vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    serverRegistry: [],
    activeServerId: null,
    activeSessionId: null,
    connectionPhase: 'disconnected',
    sessionStates: {},
  }),
}))
vi.mock('../utils/tauri-bridge', () => ({ getTauriInvoke: () => null }))

afterEach(cleanup)

const SDK_TOOLTIP = 'Claude Agent SDK, headless'
const BYOK_TOOLTIP = 'Direct Anthropic API via @anthropic-ai/sdk — per-token billing with your own ANTHROPIC_API_KEY. No claude binary required.'
const neighbors = [
  ['claude-byok', 'BYOK', BYOK_TOOLTIP, 'sdk'],
  ['docker-sdk', 'Docker SDK', 'Docker-isolated SDK — billed per token via ANTHROPIC_API_KEY', 'sdk'],
  ['docker-cli', 'Docker CLI', 'Docker-isolated CLI — forwards your ANTHROPIC_API_KEY into the container (per-token billing, no OAuth fallback)', 'cli'],
  ['docker-byok', 'Docker BYOK', 'BYOK agent loop on the host, tool execution (Read/Write/Edit/Bash/Glob/Grep) inside an isolated Docker container. Per-token billing with your own ANTHROPIC_API_KEY.', 'sdk'],
  ['docker', 'Docker CLI', 'Docker-isolated CLI — forwards your ANTHROPIC_API_KEY into the container (alias for docker-cli)', 'cli'],
  ['custom-sdk', 'SDK', 'SDK provider — billed per token', 'sdk'],
] as const

function consumer(surface: 'SessionBar' | 'Sidebar', provider?: string) {
  const session = { sessionId: 'badge-session', name: 'Badge session', isBusy: false, provider }
  const noop = () => {}
  if (surface === 'SessionBar') {
    return <SessionBar sessions={[{ ...session, isActive: true }]} onSwitch={noop} onClose={noop} onRename={noop} onNewSession={noop} />
  }
  return <Sidebar
    repos={[{ path: '/test/badge-project', name: 'badge-project', source: 'manual', exists: true, activeSessions: [session], resumableSessions: [] }]}
    activeSessionId="badge-session" isOpen width={240} filter="" serverStatus="disconnected" tunnelUrl={null}
    connectedClients={[]} activePrimaryClientId={null} onFilterChange={noop} onSessionClick={noop}
    onResumeSession={noop} onNewSession={noop} onToggle={noop} onContextMenu={noop}
  />
}

function row(surface: 'SessionBar' | 'Sidebar') {
  return screen.getByTestId(surface === 'SessionBar' ? 'session-tab-badge-session' : 'session-item-badge-session')
}

for (const surface of ['SessionBar', 'Sidebar'] as const) {
  describe(`${surface} provider badges (#8228)`, () => {
    it('uses billing-neutral Claude Agent SDK hover text', () => {
      render(consumer(surface, 'claude-sdk'))
      const badge = within(row(surface)).getByText('SDK')
      expect(badge).toHaveAttribute('title', SDK_TOOLTIP)
      expect(badge).toHaveAttribute('data-provider', 'sdk')
    })

    it('uses billing-neutral Claude Agent SDK accessibility text', () => {
      render(consumer(surface, 'claude-sdk'))
      const badge = within(row(surface)).getByLabelText(SDK_TOOLTIP)
      expect(badge).toHaveTextContent(/^SDK$/)
      expect(badge).toHaveAttribute('aria-label', SDK_TOOLTIP)
    })

    it.each(neighbors)('preserves %s metadata', (provider, short, tooltip, type) => {
      render(consumer(surface, provider))
      const badge = within(row(surface)).getByLabelText(tooltip)
      expect(badge).toHaveTextContent(short)
      expect(badge).toHaveAttribute('title', tooltip)
      expect(badge).toHaveAttribute('aria-label', tooltip)
      expect(badge).toHaveAttribute('data-provider', type)
    })

    it('updates the same session badge when provider metadata changes', () => {
      const view = render(consumer(surface, 'claude-sdk'))
      expect(within(row(surface)).getByLabelText(SDK_TOOLTIP)).toHaveAttribute('title', SDK_TOOLTIP)
      view.rerender(consumer(surface, 'claude-byok'))
      expect(within(row(surface)).getByLabelText(BYOK_TOOLTIP)).toHaveAttribute('title', BYOK_TOOLTIP)
      expect(within(row(surface)).queryByLabelText(SDK_TOOLTIP)).not.toBeInTheDocument()
      view.rerender(consumer(surface, 'claude-sdk'))
      expect(within(row(surface)).getByLabelText(SDK_TOOLTIP)).toHaveTextContent(/^SDK$/)
    })

    it('does not invent provider metadata when the provider is absent', () => {
      render(consumer(surface))
      expect(row(surface).querySelector('[data-provider]')).toBeNull()
    })
  })
}
