/**
 * AgentMonitorPanel — tests for agent monitoring display.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { AgentMonitorPanel } from './AgentMonitorPanel'

let storeState: Record<string, unknown> = {}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: any) => {
    const sessionStates: Record<string, any> = storeState.sessionStates ?? {}
    const store = {
      activeSessionId: storeState.activeSessionId ?? 'sess-1',
      sessionStates,
    }
    return selector(store)
  },
}))

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
  storeState = {
    activeSessionId: 'sess-1',
    sessionStates: {
      'sess-1': {
        activeAgents: [],
      },
    },
  }
})

const AGENTS = [
  {
    toolUseId: 'toolu_abc123def456',
    description: 'Searching codebase for patterns',
    startedAt: Date.now() - 45_000,
  },
  {
    toolUseId: 'toolu_xyz789ghi012',
    description: 'Running test suite',
    startedAt: Date.now() - 180_000,
  },
]

describe('AgentMonitorPanel', () => {
  it('shows empty state when no agents running', () => {
    render(<AgentMonitorPanel />)
    expect(screen.getByTestId('agent-empty')).toBeTruthy()
    expect(screen.getByText('No agents currently running.')).toBeTruthy()
  })

  it('renders agent cards when agents are active', () => {
    ;(storeState.sessionStates as any)['sess-1'].activeAgents = AGENTS
    render(<AgentMonitorPanel />)

    const cards = screen.getAllByTestId('agent-card')
    expect(cards).toHaveLength(2)
  })

  it('shows agent descriptions', () => {
    ;(storeState.sessionStates as any)['sess-1'].activeAgents = AGENTS
    render(<AgentMonitorPanel />)

    expect(screen.getByText('Searching codebase for patterns')).toBeTruthy()
    expect(screen.getByText('Running test suite')).toBeTruthy()
  })

  it('shows truncated tool use IDs', () => {
    ;(storeState.sessionStates as any)['sess-1'].activeAgents = [AGENTS[0]!]
    render(<AgentMonitorPanel />)

    expect(screen.getByText('toolu_abc123')).toBeTruthy()
  })

  it('shows agent count badge', () => {
    ;(storeState.sessionStates as any)['sess-1'].activeAgents = AGENTS
    render(<AgentMonitorPanel />)

    expect(screen.getByText('2')).toBeTruthy()
  })

  it('shows elapsed time', () => {
    ;(storeState.sessionStates as any)['sess-1'].activeAgents = [AGENTS[0]!]
    render(<AgentMonitorPanel />)

    // 45 seconds ago → should show "45s"
    expect(screen.getByText('45s')).toBeTruthy()
  })

  it('shows elapsed time in minutes format', () => {
    ;(storeState.sessionStates as any)['sess-1'].activeAgents = [AGENTS[1]!]
    render(<AgentMonitorPanel />)

    // 180 seconds ago → should show "3m 0s"
    expect(screen.getByText('3m 0s')).toBeTruthy()
  })

  it('handles missing session state gracefully', () => {
    storeState = {
      activeSessionId: 'nonexistent',
      sessionStates: {},
    }
    render(<AgentMonitorPanel />)

    expect(screen.getByTestId('agent-empty')).toBeTruthy()
  })
})
