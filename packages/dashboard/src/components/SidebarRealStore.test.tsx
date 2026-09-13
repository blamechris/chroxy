/**
 * Sidebar rendered against the REAL zustand store (#7797 review).
 *
 * Every other Sidebar suite in this package (`Sidebar.test.tsx:19`,
 * `SidebarCostBadge.test.tsx`, `SidebarKeyboard.test.tsx`,
 * `SidebarReorder.test.tsx`, `SidebarResize.test.tsx`, `App.test.tsx`) mocks
 * `useConnectionStore` as a bare `(selector) => selector(store)`. That mock
 * never goes through `useSyncExternalStore`, which is where zustand 5 enforces
 * snapshot stability — so the whole defect class
 *
 *     "a Sidebar selector returns a FRESH object on every call
 *      -> React's store-consistency check re-renders forever
 *      -> `Maximum update depth exceeded` / minified React #185 on mount"
 *
 * is structurally unobservable to them: "renders correctly" and "throws on
 * mount in the browser" are the same observable. That is this repo's dominant
 * defect class (docs/false-safety-guards.md), and it shipped once already —
 * #7793's first fix used a plain (unwrapped) `useConnectionStore((s) => {...})`
 * building a fresh `Record` per call, and all 6000+ dashboard tests stayed
 * green while the real dashboard's root ErrorBoundary swallowed the app.
 *
 * This file therefore deliberately does NOT `vi.mock('../store/connection')`.
 * It renders `<Sidebar/>` against the real store so the loop is observable,
 * and fails on the React console errors a loop emits — those are the only
 * signal for the NODE_ENV=production shape of the same bug.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Sidebar, type SidebarProps, type RepoNode } from './Sidebar'
import { useConnectionStore } from '../store/connection'
import { createEmptySessionState } from '../store/utils'
import type { CumulativeUsage, SessionInfo } from '@chroxy/store-core'

const LIVE_USAGE: CumulativeUsage = {
  inputTokens: 15153,
  outputTokens: 17,
  cacheReadTokens: 1408,
  cacheCreationTokens: 0,
  costUsd: 0,
  turnsBilled: 1,
}

const ZERO_USAGE: CumulativeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  turnsBilled: 0,
}

// The React console errors an unstable-snapshot render loop emits. The dev
// build prints the getSnapshot warning ahead of the throw, then "Maximum
// update depth exceeded"; a production build prints the minified #185.
// Matching any of them is what makes this guard build-independent.
const LOOP_ERROR = /getSnapshot should be cached|Maximum update depth exceeded|Minified React error #185|error #185/

function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 's1',
    name: 's1',
    cwd: '/tmp',
    type: 'cli',
    hasTerminal: false,
    model: null,
    permissionMode: null,
    isBusy: false,
    createdAt: 0,
    conversationId: null,
    provider: 'codex',
    cumulativeUsage: undefined,
    ...overrides,
  }
}

const REPOS: RepoNode[] = [
  {
    path: '/tmp',
    name: 'tmp',
    source: 'auto',
    exists: true,
    activeSessions: [{ sessionId: 's1', name: 's1', isBusy: false }],
    resumableSessions: [],
  },
]

const noop = vi.fn()

function renderSidebar(props: Partial<SidebarProps> = {}) {
  const defaultProps: SidebarProps = {
    repos: REPOS,
    activeSessionId: 's1',
    isOpen: true,
    width: 240,
    filter: '',
    serverStatus: 'connected',
    tunnelUrl: null,
    connectedClients: [],
    activePrimaryClientId: null,
    onFilterChange: noop,
    onSessionClick: noop,
    onResumeSession: noop,
    onNewSession: noop,
    onToggle: noop,
    onContextMenu: noop,
  }
  return render(<Sidebar {...defaultProps} {...props} />)
}

let errorSpy: ReturnType<typeof vi.spyOn>
let storeSnapshot: unknown

beforeEach(() => {
  storeSnapshot = useConnectionStore.getState()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  errorSpy.mockRestore()
  useConnectionStore.setState(storeSnapshot as never, true)
})

/** Every console.error argument flattened into one searchable string. */
function consoleErrorText(): string {
  return (errorSpy.mock.calls as unknown[][])
    .map((call) => call.map((a) => String(a)).join(' '))
    .join('\n')
}

describe('Sidebar against the real zustand store (#7797 review)', () => {
  it('mounts without a useSyncExternalStore render loop', () => {
    useConnectionStore.setState({
      sessionStates: {
        s1: { ...createEmptySessionState(), cumulativeUsage: LIVE_USAGE },
      },
    } as never)

    expect(() =>
      renderSidebar({ sessions: [makeSessionInfo({ cumulativeUsage: ZERO_USAGE })] }),
    ).not.toThrow()

    const text = consoleErrorText()
    expect(
      LOOP_ERROR.test(text),
      'Sidebar mount emitted a React render-loop error. A selector is returning a fresh ' +
        'reference on every call; wrap it in useShallow (see App.tsx sidebarCumulativeUsage, ' +
        `#4120). console.error output:\n${text}`,
    ).toBe(false)
  })

  it('mounts without a render loop when sessionStates is EMPTY (fresh page load)', () => {
    // The worst case for an unstable selector: no session has reported usage
    // yet, so the projected map is `{}` — a brand-new empty object on every
    // call, never reference-equal to the last one. This is the state the
    // dashboard is in for the first moments after load, i.e. the shape that
    // takes the whole app down via main.tsx's root ErrorBoundary.
    useConnectionStore.setState({ sessionStates: {} } as never)

    expect(() => renderSidebar({ sessions: [makeSessionInfo()] })).not.toThrow()
    const text = consoleErrorText()
    expect(LOOP_ERROR.test(text), `console.error output:\n${text}`).toBe(false)
  })

  it('shows the live sessionStates total through the real store, not the zero snapshot', () => {
    useConnectionStore.setState({
      sessionStates: {
        s1: { ...createEmptySessionState(), cumulativeUsage: LIVE_USAGE },
      },
    } as never)

    renderSidebar({ sessions: [makeSessionInfo({ cumulativeUsage: ZERO_USAGE })] })
    expect(screen.getByTestId('sidebar-token-view-today-total')).toHaveTextContent('15.2K tokens')
  })
})
