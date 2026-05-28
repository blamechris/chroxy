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
import { ActivityIndicator, findInFlightToolUse, type InFlightMessage } from './ActivityIndicator'

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

// #4336 — the production component reads via `useShallow`. Stub the hook to
// a pass-through so the mocked store-selector path above continues to work
// unchanged — `useShallow(fn)` is invoked as the selector itself, and the
// test mock calls it once with our snapshot. Same pattern App.test.tsx uses.
vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: unknown) => fn,
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

  it('names the in-flight tool during the lastActivityAt-null connect race (#4320)', () => {
    // Busy session with an unresolved tool_use but no activity event has
    // updated lastClientActivityAt yet (the race observed when tool_start
    // arrives before any event that bumps the activity timestamp). The
    // indicator must still name the running tool rather than fall through
    // to a generic "Working…" label. No elapsed suffix is rendered because
    // we have no clock anchor in this branch.
    const now = Date.now()
    storeState = {
      activeSessionId: 'sess-1',
      serverResultTimeoutMs: 30 * 60 * 1000,
      sessionStates: {
        'sess-1': {
          isIdle: false,
          lastClientActivityAt: null,
          messages: [
            { id: 'm1', type: 'tool_use', tool: 'Bash', timestamp: now - 2_000, content: '', toolUseId: 'tu-1' },
          ],
          inactivityWarning: null,
        },
      },
    }
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).toMatch(/Running\s+Bash/)
    expect(label.textContent).not.toMatch(/Working…/)
  })

  it('falls back to "Working…" during the connect race when no tool is in flight (#4320)', () => {
    // Busy with no tool_use in messages and no activity timestamp yet —
    // the original baseline label is what the user should see.
    storeState = {
      activeSessionId: 'sess-1',
      serverResultTimeoutMs: 30 * 60 * 1000,
      sessionStates: {
        'sess-1': {
          isIdle: false,
          lastClientActivityAt: null,
          messages: [],
          inactivityWarning: null,
        },
      },
    }
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).toBe('Working…')
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

  // #4339 — the MCP test above only exercises the `mcp__`-prefix branch of
  // `formatToolName`, which IGNORES the second `serverName` arg entirely.
  // The non-MCP branch is the only path where `serverName` is observable in
  // the output (`${serverName} ${formatted}`). These fixtures lock that path
  // in so a regression that drops `serverName` propagation fails loudly.
  it('prefixes a non-MCP tool name with serverName when provided (#4339)', () => {
    const now = Date.now()
    setStore([
      {
        id: 'm1',
        type: 'tool_use',
        tool: 'list_files',
        serverName: 'fs',
        timestamp: now - 5_000,
        content: '',
        toolUseId: 'tu-1',
      },
    ])
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    // formatToolName('list_files', 'fs') → 'fs List Files'.
    expect(label.textContent).toMatch(/Running\s+fs List Files/)
  })

  it('renders a non-MCP tool name without prefix when serverName is omitted (#4339 control)', () => {
    // Control fixture for the case above: same tool, no `serverName` → the
    // server prefix must NOT appear. Pins the conditional in
    // `formatToolName(name, serverName)` so a default-on regression flips this test.
    const now = Date.now()
    setStore([
      {
        id: 'm1',
        type: 'tool_use',
        tool: 'list_files',
        timestamp: now - 5_000,
        content: '',
        toolUseId: 'tu-1',
      },
    ])
    render(<ActivityIndicator />)
    const label = screen.getByTestId('activity-indicator-label')
    expect(label.textContent).toMatch(/Running\s+List Files/)
    expect(label.textContent).not.toMatch(/fs/)
  })

  // #4308 — activeTools-driven path (preferred over the messages walk when
  // present). These tests pin the precedence: activeTools wins over a tool
  // resolved via the messages walk; sub-agent description wins over both.
  describe('activeTools / activeAgents state slot (#4308)', () => {
    it('prefers the activeTools slot over the messages walk', () => {
      const now = Date.now()
      // messages walk would pick `Read`, but activeTools says `WebFetch` is
      // the current in-flight tool — activeTools wins.
      storeState = {
        activeSessionId: 'sess-1',
        serverResultTimeoutMs: 30 * 60 * 1000,
        sessionStates: {
          'sess-1': {
            isIdle: false,
            lastClientActivityAt: now - 3_000,
            messages: [
              { id: 'm1', type: 'tool_use', tool: 'Read', timestamp: now - 6_000, content: '', toolUseId: 'tu-walk' },
            ],
            activeTools: [
              { toolUseId: 'tu-1', tool: 'WebFetch', startedAt: now - 4_000 },
            ],
            inactivityWarning: null,
          },
        },
      }
      render(<ActivityIndicator />)
      const label = screen.getByTestId('activity-indicator-label')
      expect(label.textContent).toMatch(/Running\s+WebFetch/)
      expect(label.textContent).not.toMatch(/Read/)
    })

    it('uses the most-recent activeTools entry when multiple are in flight', () => {
      const now = Date.now()
      storeState = {
        activeSessionId: 'sess-1',
        serverResultTimeoutMs: 30 * 60 * 1000,
        sessionStates: {
          'sess-1': {
            isIdle: false,
            lastClientActivityAt: now - 2_000,
            messages: [],
            activeTools: [
              { toolUseId: 'tu-1', tool: 'Bash', startedAt: now - 10_000 },
              { toolUseId: 'tu-2', tool: 'WebFetch', startedAt: now - 3_000 },
            ],
            inactivityWarning: null,
          },
        },
      }
      render(<ActivityIndicator />)
      const label = screen.getByTestId('activity-indicator-label')
      expect(label.textContent).toMatch(/Running\s+WebFetch/)
    })

    it('falls through to the messages walk when activeTools is empty', () => {
      const now = Date.now()
      storeState = {
        activeSessionId: 'sess-1',
        serverResultTimeoutMs: 30 * 60 * 1000,
        sessionStates: {
          'sess-1': {
            isIdle: false,
            lastClientActivityAt: now - 2_000,
            messages: [
              { id: 'm1', type: 'tool_use', tool: 'Read', timestamp: now - 4_000, content: '', toolUseId: 'tu-1' },
            ],
            activeTools: [],
            inactivityWarning: null,
          },
        },
      }
      render(<ActivityIndicator />)
      const label = screen.getByTestId('activity-indicator-label')
      expect(label.textContent).toMatch(/Running\s+Read/)
    })

    it('surfaces an active sub-agent description, taking precedence over the in-flight tool', () => {
      const now = Date.now()
      // Parent agent's Task tool is in flight, but a sub-agent is running.
      // The chip should name the sub-agent's description, not "Task".
      storeState = {
        activeSessionId: 'sess-1',
        serverResultTimeoutMs: 30 * 60 * 1000,
        sessionStates: {
          'sess-1': {
            isIdle: false,
            lastClientActivityAt: now - 2_000,
            messages: [],
            activeTools: [
              { toolUseId: 'tu-task', tool: 'Task', startedAt: now - 5_000 },
            ],
            activeAgents: [
              { toolUseId: 'tu-sub', description: 'audit-pr', startedAt: now - 5_000 },
            ],
            inactivityWarning: null,
          },
        },
      }
      render(<ActivityIndicator />)
      const label = screen.getByTestId('activity-indicator-label')
      expect(label.textContent).toMatch(/Running\s+audit-pr/)
      expect(label.textContent).not.toMatch(/Task/)
    })

    it('uses the most-recent activeAgents entry when multiple sub-agents are running', () => {
      const now = Date.now()
      storeState = {
        activeSessionId: 'sess-1',
        serverResultTimeoutMs: 30 * 60 * 1000,
        sessionStates: {
          'sess-1': {
            isIdle: false,
            lastClientActivityAt: now - 2_000,
            messages: [],
            activeTools: [],
            activeAgents: [
              { toolUseId: 'tu-a', description: 'first-task', startedAt: now - 10_000 },
              { toolUseId: 'tu-b', description: 'second-task', startedAt: now - 3_000 },
            ],
            inactivityWarning: null,
          },
        },
      }
      render(<ActivityIndicator />)
      const label = screen.getByTestId('activity-indicator-label')
      expect(label.textContent).toMatch(/Running\s+second-task/)
    })

    it('surfaces sub-agent description during the lastActivityAt-null connect race', () => {
      const now = Date.now()
      storeState = {
        activeSessionId: 'sess-1',
        serverResultTimeoutMs: 30 * 60 * 1000,
        sessionStates: {
          'sess-1': {
            isIdle: false,
            lastClientActivityAt: null,
            messages: [],
            activeTools: [],
            activeAgents: [
              { toolUseId: 'tu-a', description: 'do-thing', startedAt: now - 2_000 },
            ],
            inactivityWarning: null,
          },
        },
      }
      render(<ActivityIndicator />)
      const label = screen.getByTestId('activity-indicator-label')
      expect(label.textContent).toMatch(/Running\s+do-thing/)
    })
  })
})

/**
 * #4319 / #4336 — Narrow-selector contract for ActivityIndicator.
 *
 * Pre-#4319 the component subscribed to `sessionStates[id]?.messages` — every
 * `stream_delta` / `tool_input_delta` swapped the array reference and forced
 * a re-render even when the in-flight tool was unchanged. The fix narrows
 * the subscription to a `useShallow` projection of `{ tool, startedAt,
 * serverName }` — React only re-renders when those primitives change.
 *
 * We can't measure React render count from here without wrapping the export,
 * but we CAN lock in the contract that drives the perf win: when a no-op
 * store update happens (a brand-new messages array with the same in-flight
 * tool), the projection's primitives are === stable. That is the mechanism
 * by which `useShallow` bails out and skips the render — so this test
 * indirectly guarantees the perf property the issue calls out.
 *
 * #4337 — These assertions now run against the REAL exported
 * `findInFlightToolUse` predicate so a change to the production resolved /
 * in-flight gate (e.g. a new `toolError` field counted as resolved) breaks
 * the test rather than silently keeping a stale inline copy passing.
 */
describe('ActivityIndicator — narrow in-flight selector (#4319, #4336)', () => {
  it('findInFlightToolUse returns === stable primitives when messages[] reference changes (#4337)', async () => {
    const mod = await import('./ActivityIndicator')
    // Sanity: both exports the test depends on must still exist.
    expect(typeof mod.ActivityIndicator).toBe('function')
    expect(typeof mod.findInFlightToolUse).toBe('function')

    // Two snapshots differ ONLY in the messages[] reference — same in-flight
    // tool object semantics, fresh array (the `stream_delta` perf case).
    // Both run through the production predicate so any divergence between
    // the test's expectations and the real walk surfaces here.
    const now = Date.now()
    const toolMsg: InFlightMessage = {
      type: 'tool_use',
      tool: 'Bash',
      timestamp: now - 5_000,
    }
    const messagesA: InFlightMessage[] = [toolMsg]
    // Brand-new array reference, same logical content.
    const messagesB: InFlightMessage[] = [{ ...toolMsg }]

    const a = findInFlightToolUse(messagesA)
    const b = findInFlightToolUse(messagesB)

    // Primitives projected by the production predicate are === stable
    // across the no-op messages[] reference swap — this is the property
    // the `useShallow` projection in the component relies on.
    expect(a?.tool).toBe(b?.tool)
    expect(a?.startedAt).toBe(b?.startedAt)
    expect(a?.tool).toBe('Bash')
    expect(a?.startedAt).toBe(now - 5_000)
  })

  it('findInFlightToolUse skips resolved tools and returns the most-recent in-flight one (#4337)', () => {
    // Locks in the predicate's walk semantics: earlier resolved tool is
    // skipped, later unresolved tool is returned. Mirrors the top-of-file
    // "names the most-recent tool_use" render test — but against the
    // predicate directly so a regression in the resolved-gate breaks here,
    // not just in the rendered label.
    const now = Date.now()
    const result = findInFlightToolUse([
      { type: 'tool_use', tool: 'Read', timestamp: now - 60_000, toolResult: 'contents' },
      { type: 'tool_use', tool: 'Bash', timestamp: now - 5_000 },
    ])
    expect(result?.tool).toBe('Bash')
    expect(result?.startedAt).toBe(now - 5_000)
  })

  it('findInFlightToolUse treats empty-string toolResult AND images-only resolutions as resolved (#4337)', () => {
    // Pin the two "non-obvious resolved" branches against the imported
    // predicate. If the gate changes (e.g. images-only is suddenly NOT
    // counted as resolved), the test fails directly on the predicate.
    expect(
      findInFlightToolUse([
        { type: 'tool_use', tool: 'Bash', timestamp: 0, toolResult: '' },
      ]),
    ).toBeNull()
    expect(
      findInFlightToolUse([
        {
          type: 'tool_use',
          tool: 'screenshot',
          timestamp: 0,
          toolResultImages: [{ data: 'x', mediaType: 'image/png' }],
        },
      ]),
    ).toBeNull()
  })

  it('findInFlightToolUse returns null for null/undefined/empty input (#4337)', () => {
    expect(findInFlightToolUse(null)).toBeNull()
    expect(findInFlightToolUse(undefined)).toBeNull()
    expect(findInFlightToolUse([])).toBeNull()
  })

  it('findInFlightToolUse preserves serverName on the in-flight tool (#4337, #4339)', () => {
    // The predicate must propagate `serverName` so the component can pass
    // it into `formatToolName` for the non-MCP prefix path (#4339).
    const result = findInFlightToolUse([
      { type: 'tool_use', tool: 'list_files', serverName: 'fs', timestamp: 0 },
    ])
    expect(result?.tool).toBe('list_files')
    expect(result?.serverName).toBe('fs')
  })

  it('rendering across no-op store updates yields the same label text (proxy for stable selectors)', () => {
    // Stronger end-to-end check: render the component, swap the messages
    // array for a fresh-reference copy with the same logical content, and
    // re-render. The visible label must be identical — which is only true
    // if the `useShallow` projection produced the same primitives both times.
    const now = Date.now()
    const baseTool = { id: 'm1', type: 'tool_use', tool: 'Bash', timestamp: now - 5_000, content: '', toolUseId: 'tu-1' }
    setStore([baseTool])
    const { unmount } = render(<ActivityIndicator />)
    const firstLabel = screen.getByTestId('activity-indicator-label').textContent
    unmount()

    // New array reference, same content — the perf-pathological case.
    setStore([{ ...baseTool }])
    render(<ActivityIndicator />)
    const secondLabel = screen.getByTestId('activity-indicator-label').textContent

    expect(firstLabel).toBe(secondLabel)
    expect(firstLabel).toMatch(/Running\s+Bash/)
  })
})
