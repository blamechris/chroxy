/**
 * ActivityIndicator in-flight tool naming (#4308).
 *
 * Pre-fix the indicator could only say "Working… last activity Ns ago" — it
 * never named the running tool, so a long-running Bash command looked the
 * same as a stalled turn. This test locks in the derive-from-messages
 * approach: the indicator walks the active session's `messages[]` backwards
 * to find the most-recent `tool_use` with no result, and surfaces that
 * tool's name + elapsed time. When every tool has resolved (waiting on
 * assistant text between tool runs), the indicator falls back to the
 * original "Working… last activity" label.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ActivityIndicator } from './ActivityIndicator'

let storeState: Record<string, unknown> = {}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) => {
    const sessionStates: Record<string, unknown> = (storeState.sessionStates as Record<string, unknown>) ?? {}
    const store = {
      activeSessionId: storeState.activeSessionId ?? 'sess-1',
      sessionStates,
      serverResultTimeoutMs: storeState.serverResultTimeoutMs ?? 30 * 60 * 1000,
    }
    return selector(store)
  },
}))

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
})

function setStore(messages: Array<Record<string, unknown>>) {
  storeState = {
    activeSessionId: 'sess-1',
    serverResultTimeoutMs: 30 * 60 * 1000,
    sessionStates: {
      'sess-1': {
        isIdle: false,
        lastClientActivityAt: Date.now() - 3_000, // 3s ago → green
        messages,
        inactivityWarning: null,
      },
    },
  }
}

describe('ActivityIndicator — in-flight tool naming (#4308)', () => {
  it('names the most-recent tool_use without a result and shows elapsed time', () => {
    const now = Date.now()
    setStore([
      // Earlier resolved tool — should NOT be picked.
      { id: 'm1', type: 'tool_use', tool: 'Read', timestamp: now - 60_000, toolResult: 'contents', content: '', toolUseId: 'tu-1' },
      // Most-recent unresolved tool — this is what the indicator names.
      { id: 'm2', type: 'tool_use', tool: 'Bash', timestamp: now - 5_000, content: '', toolUseId: 'tu-2' },
    ])
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).toMatch(/Running\s+Bash/)
    // Elapsed should round to something near 5s — accept 3–7 to absorb test timing jitter.
    expect(label.textContent).toMatch(/[3-7]s$/)
  })

  it('falls back to the original "Working… last activity" label when no tool is in flight', () => {
    const now = Date.now()
    setStore([
      { id: 'm1', type: 'tool_use', tool: 'Bash', timestamp: now - 20_000, toolResult: 'done', content: '', toolUseId: 'tu-1' },
    ])
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).toMatch(/Working… last activity/)
    expect(label.textContent).not.toMatch(/Running/)
  })

  it('treats an empty-string toolResult as resolved (no in-flight indicator)', () => {
    // A tool that finished with no output (toolResult === '') must NOT
    // be picked as in-flight. Same predicate the ToolBubble pulse uses.
    const now = Date.now()
    setStore([
      { id: 'm1', type: 'tool_use', tool: 'Bash', timestamp: now - 5_000, toolResult: '', content: '', toolUseId: 'tu-1' },
    ])
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).not.toMatch(/Running/)
  })

  it('treats toolResultImages-only resolution as resolved (no in-flight indicator)', () => {
    // Some tools resolve with images and no toolResult string. Match the
    // ToolGroup hasResult predicate (#3794) so these aren't shown as in-flight.
    const now = Date.now()
    setStore([
      {
        id: 'm1',
        type: 'tool_use',
        tool: 'Bash',
        timestamp: now - 5_000,
        content: '',
        toolUseId: 'tu-1',
        toolResultImages: [{ data: 'x', mediaType: 'image/png' }],
      },
    ])
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).not.toMatch(/Running/)
  })

  it('renders nothing when the session is idle', () => {
    storeState = {
      activeSessionId: 'sess-1',
      serverResultTimeoutMs: 30 * 60 * 1000,
      sessionStates: {
        'sess-1': {
          isIdle: true,
          lastClientActivityAt: Date.now() - 1_000,
          messages: [{ id: 'm1', type: 'tool_use', tool: 'Bash', timestamp: Date.now() - 1_000, content: '', toolUseId: 'tu-1' }],
          inactivityWarning: null,
        },
      },
    }
    const { container } = render(<ActivityIndicator />)
    expect(container.firstChild).toBeNull()
  })

  it('formats MCP-style tool names via the shared formatter', () => {
    const now = Date.now()
    setStore([
      { id: 'm1', type: 'tool_use', tool: 'mcp__github__list_repos', timestamp: now - 5_000, content: '', toolUseId: 'tu-1' },
    ])
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    // formatToolName converts `mcp__github__list_repos` → `Github: List Repos`.
    expect(label.textContent).toMatch(/Running\s+Github: List Repos/)
  })
})
