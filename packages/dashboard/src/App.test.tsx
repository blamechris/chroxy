/**
 * App smoke test (#1192)
 *
 * Verifies App renders without crashing by mocking the Zustand store.
 * Pattern: mock useConnectionStore to return default state + no-op actions,
 * avoiding real WebSocket connections.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react'

vi.mock('./hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

// #4796 — capture the options the App passes into useVoiceInput so we can
// assert the store's `inputSettings.voiceInputMode` is threaded through.
// This closes audit Tester #2 (the wiring chain had zero test coverage —
// a store-selector typo or stale-closure bug would have silently broken
// the user-facing setting with green CI).
const voiceInputModeSpy = vi.fn<(opts: { mode?: 'continuous' | 'auto-pause' } | undefined) => void>()
vi.mock('./hooks/useVoiceInput', () => ({
  useVoiceInput: (opts?: { mode?: 'continuous' | 'auto-pause' }) => {
    voiceInputModeSpy(opts)
    return {
      isRecording: false,
      transcript: '',
      error: null,
      isAvailable: false,
      engine: 'none' as const,
      start: vi.fn(),
      stop: vi.fn(),
    }
  },
}))

// #4673 — control the clipboard helper per-test so we can assert that the
// "Copied!" check mark only fires when the helper actually wrote. Default
// to a successful write so the unrelated render-smoke tests stay green.
// #4629 — also expose an `addServerErrorMock` so the failure-path test
// can assert the dashboard surfaces a visible toast when the clipboard
// write fails (the original bug was a silent no-op + misleading
// "Copied!" tooltip). Both are declared via `vi.hoisted()` because
// `vi.mock()` factories are hoisted to the top of the file before any
// top-level `const`, so a plain const would hit a TDZ ReferenceError.
const { clipboardWriteTextMock, addServerErrorMock } = vi.hoisted(() => ({
  clipboardWriteTextMock: vi.fn<(text: string) => Promise<boolean>>(() => Promise.resolve(true)),
  addServerErrorMock: vi.fn<(message: string, action?: unknown, severity?: unknown) => void>(),
}))
vi.mock('./utils/clipboard', () => ({
  writeText: (text: string) => clipboardWriteTextMock(text),
}))

// #3608: capture the `onRestart` prop the App passes into StdinDisabledBanner
// so the no-op-guard test can invoke `handleRestartSession` directly with a
// missing id (the real banner short-circuits its own render when the active
// id has no matching session, hiding the button — but we still want to
// exercise the handler-level `if (!session) return` guard).
let capturedOnRestart: ((sessionId: string) => void) | null = null

// #4305 — Chat and Output are now ALWAYS mounted (display:none toggle
// instead of conditional render) so user-set expand state on tool
// groups + chat scroll position survive a tab switch. That means
// `MultiTerminalView` mounts even in tests where `viewMode === 'chat'`,
// which previously hid it behind a conditional. xterm.js's real
// `Terminal.open()` (via `TerminalView`) calls `matchMedia` and other
// JSDOM-incompatible browser APIs and would throw on every test. A
// shallow stub keeps the App tests focused on App behaviour while
// MultiTerminalView's own tests cover its production wiring.
vi.mock('./components/MultiTerminalView', () => ({
  MultiTerminalView: (props: { className?: string }) => (
    <div data-testid="multi-terminal-view-mock" className={props.className} />
  ),
}))

// #4685 — PermissionPrompt reads `availableProviders` and calls
// `isRuleEligibleProvider`, both of which need a richer store mock than the
// App smoke harness provides. The #4685 gate tests below mount a permission
// message (requestId + expiresAt + !answered) which would otherwise drive
// the real PermissionPrompt to crash on the missing helper. Stub it here so
// the gate tests stay focused on App-level derivation; PermissionPrompt has
// its own dedicated suite in PermissionPrompt.test.tsx.
vi.mock('./components/PermissionPrompt', () => ({
  PermissionPrompt: (props: { requestId: string; tool: string }) => (
    <div data-testid={`permission-prompt-mock-${props.requestId}`} data-tool={props.tool} />
  ),
}))

// #4695 / #5062 — CreateSessionModal pulls multiple store-callback selectors
// (setDirectoryListingCallback / requestDirectoryListing / …) that the
// App-test store mock doesn't enumerate. Stubbing the modal lets the
// New Session overflow-menu click assertion verify the `open` prop transition
// without dragging in directory-browser store wiring. Production
// behaviour is exercised by the CreateSessionModal*.test.tsx suites.
vi.mock('./components/CreateSessionModal', () => ({
  // #5218 — expose an `onCreate` seam so create-flow tests can drive the
  // confirm path (App.handleCreateSession) without dragging in the real
  // modal's directory-browser / store wiring. Existing tests only assert the
  // `open` transition via `create-session-modal-mock`, so the extra confirm
  // button is inert for them.
  CreateSessionModal: (props: {
    open: boolean
    onCreate?: (data: { name: string; cwd: string }) => void
    // #6301 — surface the create spinner + retryable error so the
    // #6285 App-layer branches (create-confirm effect / not-sent
    // else-branch) are directly assertable from the modal's DOM.
    isCreating?: boolean
    serverError?: string
  }) =>
    props.open ? (
      <div data-testid="create-session-modal-mock">
        <button
          type="button"
          data-testid="create-session-modal-confirm"
          onClick={() => props.onCreate?.({ name: 'New Session', cwd: '/tmp/new' })}
        />
        {props.isCreating ? <div data-testid="create-session-modal-creating" /> : null}
        {props.serverError ? (
          <div data-testid="create-session-modal-error">{props.serverError}</div>
        ) : null}
      </div>
    ) : null,
}))

vi.mock('./components/StdinDisabledBanner', () => ({
  StdinDisabledBanner: (props: {
    visible: boolean
    sessionId: string | null
    onRestart: (sessionId: string) => void
  }) => {
    capturedOnRestart = props.onRestart
    if (!props.visible || !props.sessionId) return null
    // Mirror the real component's DOM contract so existing tests that click
    // the restart button still work (data-testid + onClick behaviour).
    return (
      <div data-testid="stdin-disabled-banner" role="status" aria-live="polite">
        <button
          data-testid="stdin-disabled-restart-button"
          onClick={() => props.onRestart(props.sessionId!)}
          type="button"
        >
          Restart Session
        </button>
      </div>
    )
  },
}))

import { App } from './App'
import { createShortcutRegistry } from './shortcuts/registry'
import { DEFAULT_SHORTCUTS } from './shortcuts/defaults'
import { __setSharedRegistryForTesting } from './shortcuts/useShortcutRegistry'

// Mutable state override — tests can change this before rendering
let stateOverrides: Record<string, unknown> = {}

// Mock the store module — return default state merged with overrides
vi.mock('./store/connection', () => {
  const baseState = {
    connectionPhase: 'disconnected',
    sessions: [],
    activeSessionId: null,
    sessionStates: {} as Record<string, unknown>,
    messages: [] as unknown[],
    viewMode: 'chat',
    availableProviders: [],
    availableModels: [],
    availablePermissionModes: [],
    serverErrors: [],
    connectionRetryCount: 0,
    terminalRawBuffer: '',
    // #5206 — mirror the real default (session-close confirmation on).
    confirmSessionClose: true,
    getActiveSessionState: () => ({
      messages: [],
      streamingMessageId: null,
      activeModel: null,
      permissionMode: null,
      contextUsage: null,
      sessionCost: null,
      isIdle: true,
      activeAgents: [],
      isPlanPending: false,
    }),
    connect: vi.fn(),
    sendInput: vi.fn(),
    // #6295 — queued-send notice path. App.handleSend surfaces a transient
    // info notification when sendInput falls through to the offline queue.
    addInfoNotification: vi.fn(),
    sendInterrupt: vi.fn(),
    sendPermissionResponse: vi.fn(),
    sendUserQuestionResponse: vi.fn(),
    markPromptAnswered: vi.fn(),
    switchSession: vi.fn(),
    destroySession: vi.fn(),
    renameSession: vi.fn(),
    createSession: vi.fn(() => true),
    setViewMode: vi.fn(),
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    dismissServerError: vi.fn(),
    // #4629 — surfaced when the clipboard write fails so the user sees a
    // visible error instead of a silent no-op. Backed by the top-level
    // `addServerErrorMock` so tests can assert on the call args directly.
    addServerError: addServerErrorMock,
    dismissSessionNotification: vi.fn(),
    // #4890 — Slack-style intervention notifications widget read/unread
    // actions wired through the store. The widget consumes these
    // selectors at render time so the mock state needs them present.
    markSessionNotificationRead: vi.fn(),
    markAllSessionNotificationsRead: vi.fn(),
    markPromptAnsweredByRequestId: vi.fn(),
    sessionNotifications: [],
    setTerminalWriteCallback: vi.fn(),
    filePickerFiles: null,
    slashCommands: [],
    fetchFileList: vi.fn(),
    fetchSlashCommands: vi.fn(),
    defaultProvider: 'claude-sdk',
    inputSettings: { chatEnterToSend: true, terminalEnterToSend: false, voiceInputMode: 'continuous' },
    updateInputSettings: vi.fn(),
    conversationHistory: [],
    fetchConversationHistory: vi.fn(),
    resumeConversation: vi.fn(),
    connectedClients: [],
    // #5510 — pairing-approval primitive: host-level pending pair-request banner
    // slice + actions. Mirror the real store defaults so App renders the
    // (empty) PendingPairRequests banner without crashing on `.length`.
    pendingPairRequests: [],
    approvePairRequest: vi.fn(),
    denyPairRequest: vi.fn(),
    serverRegistry: [],
    activeServerId: null,
    addServer: vi.fn(),
    removeServer: vi.fn(),
    switchServer: vi.fn(),
    connectToServer: vi.fn(),
    updateServer: vi.fn(),
    // #5543 — Control Room auto-fetch: ControlRoomView's mount effect reads the
    // three snapshot/loading slices and calls the matching request action when
    // the active tab is stale and the WS is connected. Mirror the real store so
    // the effect doesn't crash on a missing action when CR tests run connected.
    hostStatus: null,
    runnerStatus: null,
    integrationStatus: null,
    hostStatusLoading: false,
    runnerStatusLoading: false,
    integrationStatusLoading: false,
    requestHostStatus: vi.fn(),
    requestRunnerStatus: vi.fn(),
    requestIntegrationStatus: vi.fn(),
    // #5998 — the App-level view-mode effect opts a PTY-backed session into the
    // live terminal mirror and forces the view-mode for terminal-only / non-PTY
    // providers. The base mock exposes the two mirror actions + the
    // serverCapabilities slice the effect (and the "New Shell" gate) read, so the
    // effect's selectors don't crash on a missing action when these tests run.
    subscribeTerminalMirror: vi.fn(),
    unsubscribeTerminalMirror: vi.fn(),
    serverCapabilities: null,
  }
  const useConnectionStore = (
    selector?: (s: typeof baseState) => unknown,
  ) => {
    // Merge overrides at call time so tests can set them before render
    const state = { ...baseState, ...stateOverrides }
    if (typeof selector === 'function') {
      return selector(state as typeof baseState)
    }
    return state
  }
  useConnectionStore.getState = () => ({ ...baseState, ...stateOverrides })
  // #6287 — useChatKeyboard (mounted by App) calls these rule-eligibility helpers
  // at render to decide whether the permission shortcut offers allow-for-session.
  // Stub them false in the smoke harness (real coverage lives in
  // useChatKeyboard.test.tsx + PermissionPrompt.test.tsx).
  return {
    useConnectionStore,
    isRuleEligibleTool: () => false,
    isRuleEligibleProvider: () => false,
  }
})

// Mock zustand/react/shallow — just pass through the selector
vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: unknown) => fn,
}))

beforeEach(() => {
  stateOverrides = {}
  capturedOnRestart = null
  // #4673 — reset the clipboard mock between tests so per-case rejection
  // overrides don't bleed through.
  clipboardWriteTextMock.mockReset()
  clipboardWriteTextMock.mockResolvedValue(true)
  // #4629 — reset between cases so the failure-path test only sees the
  // calls it triggered.
  addServerErrorMock.mockReset()
  // #4432 — reset the shared shortcut registry so per-test rebinds
  // don't bleed between cases. The registry persists overrides to
  // localStorage; clearing the key keeps loadOverrides() returning {}.
  try { localStorage.removeItem('chroxy_persist_shortcut_overrides_v1') } catch { /* jsdom always provides localStorage */ }
  __setSharedRegistryForTesting(createShortcutRegistry(DEFAULT_SHORTCUTS))
  // #4796 — reset between cases so per-test mode assertions only see the
  // current render's invocations.
  voiceInputModeSpy.mockReset()
})

afterEach(cleanup)

describe('App', () => {
  it('renders without crashing in disconnected state', () => {
    const { container } = render(<App />)
    expect(container.querySelector('#app')).toBeInTheDocument()
  })

  it('renders the input bar when disconnected', () => {
    render(<App />)
    expect(screen.getByTestId('input-bar')).toBeInTheDocument()
  })

  it('does not show reconnect banner when disconnected (not reconnecting)', () => {
    render(<App />)
    expect(screen.queryByTestId('reconnect-banner')).not.toBeInTheDocument()
  })

  it('shows welcome screen when connected with no sessions', () => {
    stateOverrides = { connectionPhase: 'connected', sessions: [] }
    render(<App />)
    expect(screen.getByTestId('welcome-screen')).toBeInTheDocument()
    expect(screen.queryByTestId('input-bar')).not.toBeInTheDocument()
  })

  it('hides welcome screen when sessions exist', () => {
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }
    render(<App />)
    expect(screen.queryByTestId('welcome-screen')).not.toBeInTheDocument()
    expect(screen.getByTestId('input-bar')).toBeInTheDocument()
  })

  it('opens shortcut help when ? is pressed', () => {
    render(<App />)
    expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: '?' })
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument()
  })

  it('lists the permission shortcuts in the help modal with platform-aware modifier (#2872, #2883)', () => {
    // jsdom's default userAgent does not match Mac — the modal should render
    // Ctrl+Y / Ctrl+Shift+Y instead of Cmd+...
    render(<App />)
    fireEvent.keyDown(window, { key: '?' })

    expect(screen.getByText('Ctrl+Y')).toBeInTheDocument()
    expect(screen.getByText('Allow current permission prompt')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+Shift+Y')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Allow current permission prompt for this session (rule-eligible tools)',
      ),
    ).toBeInTheDocument()
    // No `Cmd+...` label should remain on non-Mac platforms.
    expect(screen.queryByText('Cmd+Y')).not.toBeInTheDocument()
    expect(screen.queryByText('Cmd+Shift+Y')).not.toBeInTheDocument()
  })

  it('swaps Cmd for Ctrl across all shortcut rows on non-Mac platforms (#2883)', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: '?' })

    // Spot-check entries that previously rendered as Cmd+... so a regression
    // which only rewrites Cmd+Y would still fail here.
    expect(screen.getByText('Ctrl+K')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+N')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+Enter')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+Shift+D')).toBeInTheDocument()
    expect(screen.queryByText('Cmd+K')).not.toBeInTheDocument()
    expect(screen.queryByText('Cmd+Enter')).not.toBeInTheDocument()
  })

  // #4941 — the sidebar drag-to-reorder shortcut was previously invisible
  // anywhere outside the source code. After landing the discoverability
  // follow-up, opening the `?` cheat sheet shows the two reorder entries
  // alongside their descriptions and a dedicated "Sidebar" section
  // heading, so users can find them.
  it('lists the sidebar reorder shortcuts in the cheat sheet under a Sidebar section (#4941)', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: '?' })

    expect(screen.getByText('Alt+ArrowUp')).toBeInTheDocument()
    expect(screen.getByText('Alt+ArrowDown')).toBeInTheDocument()
    expect(screen.getByText('Move sidebar row up (when focused)')).toBeInTheDocument()
    expect(screen.getByText('Move sidebar row down (when focused)')).toBeInTheDocument()
    // Confirm the entries render under the new "Sidebar" group (h3),
    // not folded into another section.
    expect(screen.getByRole('heading', { level: 3, name: 'Sidebar' })).toBeInTheDocument()
  })

  // #4432 — the cheat sheet's tab-switch row used to be derived from
  // session.switch.1's binding alone, then string-replaced "1$" with
  // "1-9". When the other eight bindings still pointed at their
  // defaults, a rebind of just session.switch.1 to "Cmd+Q" produced a
  // misleading "Ctrl+Q-9" / "Cmd+Q-9" row that didn't describe any
  // real binding. The fix detects divergence and falls back to nine
  // individual rows when the bindings aren't aligned.
  describe('cheat sheet tab-switch divergence (#4432)', () => {
    it('renders a single collapsed Ctrl+1-9 row when all nine bindings are at their defaults', () => {
      render(<App />)
      fireEvent.keyDown(window, { key: '?' })

      // Default case: single collapsed row, no per-digit rows.
      expect(screen.getByText('Ctrl+1-9')).toBeInTheDocument()
      expect(screen.getByText('Switch to tab by number')).toBeInTheDocument()
      // None of the individual per-digit labels or descriptions
      // should appear — they're folded into the collapsed row.
      expect(screen.queryByText('Ctrl+1')).not.toBeInTheDocument()
      expect(screen.queryByText('Ctrl+2')).not.toBeInTheDocument()
      expect(screen.queryByText('Ctrl+9')).not.toBeInTheDocument()
      expect(screen.queryByText('Switch to tab 1')).not.toBeInTheDocument()
      expect(screen.queryByText('Switch to tab 9')).not.toBeInTheDocument()
    })

    it('splits into nine individual rows when only session.switch.1 is rebound to Cmd+Q', () => {
      // Install a fresh registry, then rebind session.switch.1 to
      // something that diverges from the digit pattern. The other
      // eight entries stay at their cmd+N defaults, so the cheat
      // sheet must NOT collapse into a single misleading row.
      const registry = createShortcutRegistry(DEFAULT_SHORTCUTS)
      registry.setBinding('session.switch.1', 'cmd+q')
      __setSharedRegistryForTesting(registry)

      render(<App />)
      fireEvent.keyDown(window, { key: '?' })

      // No collapsed row — the misleading "Ctrl+Q-9" label must NOT
      // appear, and neither should "Switch to tab by number".
      expect(screen.queryByText('Ctrl+Q-9')).not.toBeInTheDocument()
      expect(screen.queryByText('Switch to tab by number')).not.toBeInTheDocument()
      // Also guard against the original buggy "Ctrl+1-9" label
      // appearing alongside a rebound entry 1.
      expect(screen.queryByText('Ctrl+1-9')).not.toBeInTheDocument()

      // The nine entries each render with their own keys and
      // description. Entry 1 reflects the rebind; 2..9 reflect the
      // defaults.
      expect(screen.getByText('Ctrl+Q')).toBeInTheDocument()
      expect(screen.getByText('Switch to tab 1')).toBeInTheDocument()
      for (let n = 2; n <= 9; n += 1) {
        expect(screen.getByText(`Ctrl+${n}`)).toBeInTheDocument()
        expect(screen.getByText(`Switch to tab ${n}`)).toBeInTheDocument()
      }
    })
  })

  it('does not open shortcut help when ? is typed in an input', () => {
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }
    render(<App />)
    const textarea = screen.getByRole('textbox', { name: /message input/i })

    fireEvent.keyDown(textarea, { key: '?' })
    expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument()
  })

  it('does not open shortcut help when another modal overlay is open', () => {
    render(<App />)
    // Simulate another modal overlay being open
    const overlay = document.createElement('div')
    overlay.setAttribute('data-modal-overlay', '')
    overlay.classList.add('other-modal')
    document.body.appendChild(overlay)

    try {
      fireEvent.keyDown(window, { key: '?' })
      expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument()
    } finally {
      overlay.remove()
    }
  })

  it('prevents Backspace from navigating when target is not an input', () => {
    render(<App />)
    const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    const spy = vi.spyOn(event, 'preventDefault')
    window.dispatchEvent(event)
    expect(spy).toHaveBeenCalled()
  })

  it('allows Backspace inside a textarea', () => {
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }
    render(<App />)
    const textarea = screen.getByRole('textbox', { name: /message input/i })
    const event = fireEvent.keyDown(textarea, { key: 'Backspace' })
    // fireEvent returns false if preventDefault was called; true means it was not prevented
    expect(event).toBe(true)
  })

  // ── #4412: migrated shortcuts fire through the registry-driven
  // dispatch table. Each test pins one branch end-to-end: a real
  // keydown event reaches the App handler, the registry matches it
  // to the id, the dispatch arm calls the right store action /
  // setter. We assert on the observable side-effect (store action
  // spy, modal text, or rendered state) rather than poking React
  // internals.
  describe('registry-driven shortcut dispatch (#4412)', () => {
    const oneSession = [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }]
    const twoSessions = [
      { sessionId: 's1', name: 'One', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null },
      { sessionId: 's2', name: 'Two', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null },
    ]

    it('Cmd+. dispatches session.interrupt', () => {
      const sendInterrupt = vi.fn()
      stateOverrides = { connectionPhase: 'connected', sessions: oneSession, activeSessionId: 's1', sendInterrupt }
      render(<App />)
      fireEvent.keyDown(window, { key: '.', metaKey: true })
      expect(sendInterrupt).toHaveBeenCalled()
    })

    it('Cmd+Shift+D toggles between chat and terminal view', () => {
      const setViewMode = vi.fn()
      stateOverrides = { connectionPhase: 'connected', sessions: oneSession, activeSessionId: 's1', setViewMode, viewMode: 'chat' }
      render(<App />)
      fireEvent.keyDown(window, { key: 'd', metaKey: true, shiftKey: true })
      expect(setViewMode).toHaveBeenCalledWith('terminal')
    })

    it('Cmd+2 switches to the second session', () => {
      const switchSession = vi.fn()
      stateOverrides = { connectionPhase: 'connected', sessions: twoSessions, activeSessionId: 's1', switchSession }
      render(<App />)
      fireEvent.keyDown(window, { key: '2', metaKey: true })
      expect(switchSession).toHaveBeenCalledWith('s2')
    })

    it('Cmd+1 with no sessions does NOT call switchSession (no preventDefault, OS gets the key)', () => {
      const switchSession = vi.fn()
      stateOverrides = { connectionPhase: 'connected', sessions: [], activeSessionId: null, switchSession }
      render(<App />)
      fireEvent.keyDown(window, { key: '1', metaKey: true })
      expect(switchSession).not.toHaveBeenCalled()
    })

    it('Cmd+Shift+] (next tab) wraps from last back to first', () => {
      const switchSession = vi.fn()
      stateOverrides = { connectionPhase: 'connected', sessions: twoSessions, activeSessionId: 's2', switchSession }
      render(<App />)
      fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true })
      expect(switchSession).toHaveBeenCalledWith('s1')
    })

    it('Cmd+Shift+[ (prev tab) wraps from first back to last', () => {
      const switchSession = vi.fn()
      stateOverrides = { connectionPhase: 'connected', sessions: twoSessions, activeSessionId: 's1', switchSession }
      render(<App />)
      fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true })
      expect(switchSession).toHaveBeenCalledWith('s2')
    })

    it('Shift+Tab toggles plan mode when focus is OUTSIDE a text input', () => {
      const setPermissionMode = vi.fn()
      stateOverrides = { connectionPhase: 'connected', sessions: oneSession, activeSessionId: 's1', setPermissionMode, permissionMode: 'approve' }
      render(<App />)
      fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
      expect(setPermissionMode).toHaveBeenCalledWith('plan')
    })

    it('Shift+Tab does NOT toggle plan mode while focus is in the textarea (allows native reverse-tab)', () => {
      const setPermissionMode = vi.fn()
      stateOverrides = { connectionPhase: 'connected', sessions: oneSession, activeSessionId: 's1', setPermissionMode, permissionMode: 'approve' }
      render(<App />)
      const textarea = screen.getByRole('textbox', { name: /message input/i })
      fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true })
      expect(setPermissionMode).not.toHaveBeenCalled()
    })

    it('Cmd+Shift+P (VSCode palette alias) opens the command palette', () => {
      stateOverrides = { connectionPhase: 'connected', sessions: oneSession, activeSessionId: 's1' }
      render(<App />)
      expect(screen.queryByTestId('command-palette')).not.toBeInTheDocument()
      fireEvent.keyDown(window, { key: 'p', metaKey: true, shiftKey: true })
      expect(screen.getByTestId('command-palette')).toBeInTheDocument()
    })

    it('Cmd+W does NOT close the only tab (lets the desktop window-close path take over)', () => {
      const destroySession = vi.fn()
      stateOverrides = { connectionPhase: 'connected', sessions: oneSession, activeSessionId: 's1', destroySession }
      render(<App />)
      fireEvent.keyDown(window, { key: 'w', metaKey: true })
      expect(destroySession).not.toHaveBeenCalled()
    })

    describe('#5206 session-close confirmation', () => {
      it('clicking a tab × opens the confirm dialog instead of destroying immediately (default on)', () => {
        const destroySession = vi.fn()
        stateOverrides = { connectionPhase: 'connected', sessions: twoSessions, activeSessionId: 's1', destroySession, confirmSessionClose: true }
        render(<App />)
        const tab = screen.getByTestId('session-tab-s2')
        fireEvent.click(within(tab).getByTestId('tab-close'))
        expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument()
        expect(destroySession).not.toHaveBeenCalled()
      })

      it('confirming the dialog destroys the targeted session', () => {
        const destroySession = vi.fn()
        stateOverrides = { connectionPhase: 'connected', sessions: twoSessions, activeSessionId: 's1', destroySession, confirmSessionClose: true }
        render(<App />)
        fireEvent.click(within(screen.getByTestId('session-tab-s2')).getByTestId('tab-close'))
        fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
        expect(destroySession).toHaveBeenCalledWith('s2')
        expect(screen.queryByTestId('confirm-dialog')).toBeNull()
      })

      it('cancelling the dialog keeps the session', () => {
        const destroySession = vi.fn()
        stateOverrides = { connectionPhase: 'connected', sessions: twoSessions, activeSessionId: 's1', destroySession, confirmSessionClose: true }
        render(<App />)
        fireEvent.click(within(screen.getByTestId('session-tab-s2')).getByTestId('tab-close'))
        fireEvent.click(screen.getByTestId('confirm-dialog-cancel'))
        expect(destroySession).not.toHaveBeenCalled()
        expect(screen.queryByTestId('confirm-dialog')).toBeNull()
      })

      it('closes immediately without a dialog when the setting is off', () => {
        const destroySession = vi.fn()
        stateOverrides = { connectionPhase: 'connected', sessions: twoSessions, activeSessionId: 's1', destroySession, confirmSessionClose: false }
        render(<App />)
        fireEvent.click(within(screen.getByTestId('session-tab-s2')).getByTestId('tab-close'))
        expect(screen.queryByTestId('confirm-dialog')).toBeNull()
        expect(destroySession).toHaveBeenCalledWith('s2')
      })
    })
  })

  it('shows session loading skeleton when connecting', () => {
    stateOverrides = { connectionPhase: 'connecting' }
    render(<App />)
    expect(screen.getByTestId('session-loading-skeleton')).toBeInTheDocument()
  })

  it('hides session loading skeleton when connected with sessions', () => {
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }
    render(<App />)
    expect(screen.queryByTestId('session-loading-skeleton')).not.toBeInTheDocument()
  })

  it('shows session loading skeleton briefly when switching sessions', async () => {
    const switchSessionFn = vi.fn()
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [
        { sessionId: 's1', name: 'Session 1', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null },
        { sessionId: 's2', name: 'Session 2', cwd: '/tmp', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null },
      ],
      activeSessionId: 's1',
      switchSession: switchSessionFn,
    }
    const { rerender } = render(<App />)
    // Skeleton not shown before switch
    expect(screen.queryByTestId('session-loading-skeleton')).not.toBeInTheDocument()
    // Simulate clicking the s2 tab — triggers handleSwitchSession which sets isSwitchingSession=true
    // The mock switchSession does NOT update activeSessionId, so the skeleton stays visible
    fireEvent.click(screen.getByTestId('session-tab-s2'))
    expect(screen.getByTestId('session-loading-skeleton')).toBeInTheDocument()
    // Simulate activeSessionId changing (store confirms the switch)
    stateOverrides = { ...stateOverrides, activeSessionId: 's2' }
    rerender(<App />)
    // Skeleton cleared once activeSessionId changes
    expect(screen.queryByTestId('session-loading-skeleton')).not.toBeInTheDocument()
  })

  // #4029: FooterBar cwd was static — set once at auth_ok and never updated
  // on tab switch. This regression test renders two sessions with different
  // cwds, asserts the footer tracks the active session's cwd, then flips
  // the active id and asserts the footer updates.
  it('FooterBar cwd updates when activeSessionId changes (#4029)', () => {
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [
        { sessionId: 's1', name: 'Alpha', cwd: '/home/me/repo-alpha', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null },
        { sessionId: 's2', name: 'Beta', cwd: '/var/www/repo-beta', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null },
      ],
      activeSessionId: 's1',
      sessionCwd: '/initial/auth_ok/cwd',
    }
    const { rerender } = render(<App />)
    // The footer span has the full cwd in its `title` attribute; the visible
    // text is abbreviated to the last two segments. Assert via title so the
    // assertion isn't coupled to the abbreviation rules.
    const footerBar = screen.getByTestId('footer-bar')
    expect(within(footerBar).getByTitle('/home/me/repo-alpha')).toBeInTheDocument()
    // Flip active id — same sessions list, just a different selection.
    stateOverrides = { ...stateOverrides, activeSessionId: 's2' }
    rerender(<App />)
    const footerBarAfter = screen.getByTestId('footer-bar')
    expect(within(footerBarAfter).getByTitle('/var/www/repo-beta')).toBeInTheDocument()
    // Pre-#4029 the initial sessionCwd would have leaked through after the
    // switch — assert it's gone so a future revert can't pass this test.
    expect(within(footerBarAfter).queryByTitle('/initial/auth_ok/cwd')).not.toBeInTheDocument()
  })

  describe('Model selector onChange', () => {
    const modelsState = {
      connectionPhase: 'connected' as const,
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli' as const, hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
      availableModels: [
        { id: 'claude-sonnet', label: 'Sonnet' },
        { id: 'claude-opus', label: 'Opus' },
      ],
    }

    // #6220 — the model picker is now a button that opens a modal; selecting a
    // model in the modal calls setModel with that model's id.
    it('calls setModel with the model id when a model is picked from the modal', () => {
      const setModelFn = vi.fn()
      stateOverrides = { ...modelsState, setModel: setModelFn }
      render(<App />)
      fireEvent.click(screen.getByTestId('chat-settings-trigger'))
      fireEvent.click(screen.getByTestId('model-picker-item-claude-opus'))
      expect(setModelFn).toHaveBeenCalledWith('claude-opus')
    })

    it('calls setModel with the default model id when the default-marked model is picked', () => {
      const setModelFn = vi.fn()
      stateOverrides = {
        ...modelsState,
        setModel: setModelFn,
        defaultModelId: 'claude-sonnet',
        getActiveSessionState: () => ({
          messages: [],
          streamingMessageId: null,
          activeModel: 'claude-opus',
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
      }
      render(<App />)
      fireEvent.click(screen.getByTestId('chat-settings-trigger'))
      // The default model is rendered with a "(default)" marker; picking it
      // switches to it explicitly.
      fireEvent.click(screen.getByTestId('model-picker-item-claude-sonnet'))
      expect(setModelFn).toHaveBeenCalledWith('claude-sonnet')
    })
  })

  describe('System events tab', () => {
    const connectedState = {
      connectionPhase: 'connected' as const,
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli' as const, hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }

    it('renders System tab button in view switcher', () => {
      stateOverrides = connectedState
      render(<App />)
      expect(screen.getByRole('button', { name: /system/i })).toBeInTheDocument()
    })

    it('clicking System tab sets viewMode to system', () => {
      const setViewModeFn = vi.fn()
      stateOverrides = { ...connectedState, setViewMode: setViewModeFn }
      render(<App />)
      fireEvent.click(screen.getByRole('button', { name: /system/i }))
      expect(setViewModeFn).toHaveBeenCalledWith('system')
    })

    it('filters system messages out of chat view', () => {
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: [
            { id: 'msg-1', type: 'response', content: 'Hello from Claude', timestamp: 1 },
            { id: 'sys-1', type: 'system', content: 'iPhone connected', timestamp: 2 },
            { id: 'msg-2', type: 'user_input', content: 'Hi', timestamp: 3 },
          ],
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        viewMode: 'chat',
      }
      render(<App />)
      // #4397 — the system-pane is now kept mounted (hidden) alongside the
      // chat-pane, so 'iPhone connected' renders into the hidden system
      // ChatView. Scope the assertion to the visible chat-pane so we still
      // pin the filtering contract for the chat tab specifically.
      const chatPane = screen.getByTestId('chat-pane')
      expect(within(chatPane).queryByText('iPhone connected')).not.toBeInTheDocument()
      expect(within(chatPane).getByText('Hello from Claude')).toBeInTheDocument()
    })

    it('shows system messages in system view', () => {
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: [
            { id: 'msg-1', type: 'response', content: 'Hello from Claude', timestamp: 1 },
            { id: 'sys-1', type: 'system', content: 'iPhone connected', timestamp: 2 },
          ],
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        viewMode: 'system',
      }
      render(<App />)
      expect(screen.getByText('iPhone connected')).toBeInTheDocument()
    })

    it('shows unread badge when system events arrive while on another tab', () => {
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: [
            { id: 'sys-1', type: 'system', content: 'iPhone connected', timestamp: 1 },
          ],
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        viewMode: 'chat',
      }
      render(<App />)
      const systemTab = screen.getByRole('button', { name: /system/i })
      expect(systemTab.querySelector('.system-badge')).toBeInTheDocument()
    })
  })

  // #4305 — switching between Chat and Output (terminal) tabs must not
  // unmount the ChatView. Pre-fix, the panes were rendered with
  // `{viewMode === 'chat' && <ChatView .../>}` / `{viewMode === 'terminal'
  // && <MultiTerminalView .../>}`, so a tab switch unmounted the inactive
  // pane and reset every ToolGroup/ToolBubble's local `expanded` state
  // (and the scroll position). The fix keeps both panes mounted at all
  // times and toggles visibility with display:none on a wrapper div, so
  // React's reconciler keeps the same component instances and their
  // hooks-local state survives the switch.
  describe('chat/output tab switch preserves mount (#4305)', () => {
    const connectedState = {
      connectionPhase: 'connected' as const,
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli' as const, hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }

    it('keeps both chat-pane and terminal-pane mounted regardless of viewMode', () => {
      stateOverrides = { ...connectedState, viewMode: 'chat' }
      const { rerender } = render(<App />)
      expect(screen.getByTestId('chat-pane')).toBeInTheDocument()
      expect(screen.getByTestId('terminal-pane')).toBeInTheDocument()

      // Switch to terminal — both panes still mounted, just hidden/shown.
      stateOverrides = { ...connectedState, viewMode: 'terminal' }
      rerender(<App />)
      expect(screen.getByTestId('chat-pane')).toBeInTheDocument()
      expect(screen.getByTestId('terminal-pane')).toBeInTheDocument()
    })

    it('hides the inactive pane with display:none and shows the active one', () => {
      stateOverrides = { ...connectedState, viewMode: 'chat' }
      const { rerender } = render(<App />)
      const chatPane = screen.getByTestId('chat-pane')
      const terminalPane = screen.getByTestId('terminal-pane')
      // Active pane uses `display: contents` so its child participates
      // in the parent flex/grid layout exactly as the original
      // conditional render did; inactive pane is `display: none`.
      expect(chatPane.style.display).toBe('contents')
      expect(terminalPane.style.display).toBe('none')

      stateOverrides = { ...connectedState, viewMode: 'terminal' }
      rerender(<App />)
      // Same node references — proves React did NOT unmount/remount.
      expect(screen.getByTestId('chat-pane')).toBe(chatPane)
      expect(screen.getByTestId('terminal-pane')).toBe(terminalPane)
      expect(chatPane.style.display).toBe('none')
      expect(terminalPane.style.display).toBe('contents')
    })

    it('ChatView DOM persists across tab switch (no unmount/remount jump)', () => {
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: [
            { id: 'msg-1', type: 'response', content: 'Hello from Claude', timestamp: 1 },
          ],
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        viewMode: 'chat',
      }
      const { rerender } = render(<App />)
      // #4397 — system-pane is now also kept mounted, so `chat-view` is a
      // multi-match testid. Scope to the chat-pane wrapper to assert on
      // the chat tab's ChatView specifically.
      const chatPane = screen.getByTestId('chat-pane')
      const chatViewBefore = within(chatPane).getByTestId('chat-view')

      // Flip to terminal then back to chat.
      stateOverrides = { ...stateOverrides, viewMode: 'terminal' }
      rerender(<App />)
      // chat-view is still in the DOM (just hidden via the wrapper) —
      // pre-fix it was unmounted and so would be missing.
      expect(within(screen.getByTestId('chat-pane')).getByTestId('chat-view')).toBe(chatViewBefore)

      stateOverrides = { ...stateOverrides, viewMode: 'chat' }
      rerender(<App />)
      // And still the same node reference after coming back — no
      // remount happened across the round-trip.
      expect(within(screen.getByTestId('chat-pane')).getByTestId('chat-view')).toBe(chatViewBefore)
    })
  })

  // #4397 — same display:none kept-alive treatment for the System tab.
  // Pre-fix the system tab was a plain conditional render
  // (`{viewMode === 'system' && <ChatView .../>}`), so switching
  // chat → system → chat unmounted the system ChatView and dropped its
  // scroll position + any expand state on system-side tool groups.
  describe('system tab preserves mount (#4397)', () => {
    const connectedState = {
      connectionPhase: 'connected' as const,
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli' as const, hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }

    it('keeps system-pane mounted whenever the connection is ready, regardless of viewMode', () => {
      stateOverrides = { ...connectedState, viewMode: 'chat' }
      const { rerender } = render(<App />)
      expect(screen.getByTestId('system-pane')).toBeInTheDocument()

      stateOverrides = { ...connectedState, viewMode: 'system' }
      rerender(<App />)
      expect(screen.getByTestId('system-pane')).toBeInTheDocument()

      stateOverrides = { ...connectedState, viewMode: 'terminal' }
      rerender(<App />)
      expect(screen.getByTestId('system-pane')).toBeInTheDocument()
    })

    it('hides system-pane with display:none unless viewMode === "system"', () => {
      stateOverrides = { ...connectedState, viewMode: 'chat' }
      const { rerender } = render(<App />)
      expect(screen.getByTestId('system-pane').style.display).toBe('none')

      stateOverrides = { ...connectedState, viewMode: 'system' }
      rerender(<App />)
      expect(screen.getByTestId('system-pane').style.display).toBe('contents')

      stateOverrides = { ...connectedState, viewMode: 'terminal' }
      rerender(<App />)
      expect(screen.getByTestId('system-pane').style.display).toBe('none')
    })

    it('system ChatView DOM node survives a chat → system → chat round-trip', () => {
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: [
            { id: 'sys-1', type: 'system', content: 'iPhone connected', timestamp: 1 },
          ],
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        viewMode: 'system',
      }
      const { rerender } = render(<App />)
      const systemPane = screen.getByTestId('system-pane')
      const systemViewBefore = within(systemPane).getByTestId('chat-view')

      // Switch to chat — system-pane stays mounted (hidden).
      stateOverrides = { ...stateOverrides, viewMode: 'chat' }
      rerender(<App />)
      expect(within(screen.getByTestId('system-pane')).getByTestId('chat-view')).toBe(systemViewBefore)

      // Switch back to system — same node, no remount.
      stateOverrides = { ...stateOverrides, viewMode: 'system' }
      rerender(<App />)
      expect(within(screen.getByTestId('system-pane')).getByTestId('chat-view')).toBe(systemViewBefore)
    })

    it('does not mount system-pane while connecting (no flicker before connection settles)', () => {
      stateOverrides = { connectionPhase: 'connecting' }
      render(<App />)
      expect(screen.queryByTestId('system-pane')).not.toBeInTheDocument()
    })
  })

  describe('tunnel warming banner (#2836)', () => {
    it('shows the banner when serverPhase is tunnel_warming', () => {
      stateOverrides = {
        connectionPhase: 'connected',
        serverPhase: 'tunnel_warming',
        tunnelProgress: { attempt: 3, maxAttempts: 20 },
      }
      render(<App />)
      const banner = screen.getByTestId('tunnel-warming-banner')
      expect(banner).toBeInTheDocument()
      expect(banner).not.toHaveClass('tunnel-warming-banner--hidden')
      expect(banner.getAttribute('aria-hidden')).toBeNull()
      expect(banner.textContent).toMatch(/warming/i)
      expect(banner.textContent).toMatch(/3\/20/)
      expect(banner.textContent).toMatch(/QR will appear shortly/i)
    })

    it('shows the banner (no progress) when phase is set without attempt count', () => {
      stateOverrides = {
        connectionPhase: 'connected',
        serverPhase: 'tunnel_warming',
        tunnelProgress: null,
      }
      render(<App />)
      const banner = screen.getByTestId('tunnel-warming-banner')
      expect(banner).toBeInTheDocument()
      expect(banner).not.toHaveClass('tunnel-warming-banner--hidden')
      expect(banner.textContent).toMatch(/warming/i)
      expect(banner.textContent).toMatch(/QR will appear shortly/i)
    })

    it('also shows the banner for the legacy tunnel_verifying phase', () => {
      stateOverrides = {
        connectionPhase: 'connected',
        serverPhase: 'tunnel_verifying',
        tunnelProgress: { attempt: 1, maxAttempts: 20 },
      }
      render(<App />)
      const banner = screen.getByTestId('tunnel-warming-banner')
      expect(banner).toBeInTheDocument()
      expect(banner).not.toHaveClass('tunnel-warming-banner--hidden')
    })

    it('keeps the banner slot rendered but hidden when serverPhase is ready (#2915)', () => {
      stateOverrides = {
        connectionPhase: 'connected',
        serverPhase: 'ready',
      }
      render(<App />)
      // Reserved slot is always rendered to prevent layout shift — the banner
      // becomes visually hidden rather than unmounted so surrounding content
      // does not reflow when the tunnel finishes warming.
      const banner = screen.getByTestId('tunnel-warming-banner')
      expect(banner).toBeInTheDocument()
      expect(banner).toHaveClass('tunnel-warming-banner--hidden')
      expect(banner.getAttribute('aria-hidden')).toBe('true')
      expect(banner.textContent).toBe('')
    })

    it('keeps the banner slot rendered but hidden when serverPhase is null (#2915)', () => {
      stateOverrides = {
        connectionPhase: 'connected',
        serverPhase: null,
      }
      render(<App />)
      const banner = screen.getByTestId('tunnel-warming-banner')
      expect(banner).toBeInTheDocument()
      expect(banner).toHaveClass('tunnel-warming-banner--hidden')
      expect(banner.getAttribute('aria-hidden')).toBe('true')
      expect(banner.textContent).toBe('')
    })

    // Regression: when with-sidebar grid layout is active, the banner had
    // no explicit grid placement and was auto-placed into row 4 col 1 (under
    // the sidebar only), creating an asymmetric strip. The fix adds explicit
    // grid-row/grid-column rules so the banner spans full width above the
    // header in both flex (no sidebar) and grid (with sidebar) modes.
    it('keeps #app.with-sidebar > .tunnel-warming-banner full-width above the header (no asymmetric strip)', async () => {
      stateOverrides = {
        connectionPhase: 'connected',
        serverPhase: 'tunnel_warming',
        tunnelProgress: { attempt: 1, maxAttempts: 20 },
        // Populate sessions with cwd so sidebarRepos > 0 → with-sidebar class
        sessions: [{ sessionId: 's1', name: 'S1', cwd: '/tmp/repo', isBusy: false, provider: 'claude-sdk' }],
      }
      const { container } = render(<App />)
      const app = container.querySelector('#app')
      expect(app).not.toBeNull()
      expect(app).toHaveClass('with-sidebar')

      // Banner must be a direct child of #app (so the > selector matches).
      const banner = screen.getByTestId('tunnel-warming-banner')
      expect(banner.parentElement).toBe(app)

      // The CSS rule that prevents the asymmetric strip must exist. jsdom
      // doesn't compute grid layout, so verify the rule is present in the
      // theme stylesheet (load directly from disk to avoid relying on jsdom's
      // CSS-loading behaviour). Both grid-row and grid-column matter — without
      // grid-row: 2 the banner could pass the column assertion but still land
      // in the wrong row. Extract the rule body and assert both properties.
      const fs = await import('node:fs')
      const path = await import('node:path')
      const cssPath = path.resolve(__dirname, 'theme/components.css')
      const css = fs.readFileSync(cssPath, 'utf8')
      const ruleMatch = css.match(
        /#app\.with-sidebar\s*>\s*\.tunnel-warming-banner\s*\{([^}]+)\}/,
      )
      expect(ruleMatch).not.toBeNull()
      const ruleBody = ruleMatch![1]
      expect(ruleBody).toMatch(/grid-row:\s*2\b/)
      expect(ruleBody).toMatch(/grid-column:\s*1\s*\/\s*-1/)
    })

    it('preserves identical banner slot geometry across warming ↔ connected transitions (#2915)', () => {
      // Warming state
      stateOverrides = {
        connectionPhase: 'connected',
        serverPhase: 'tunnel_warming',
        tunnelProgress: { attempt: 3, maxAttempts: 20 },
      }
      const { rerender } = render(<App />)
      const warmingBanner = screen.getByTestId('tunnel-warming-banner')
      const warmingClasses = new Set(warmingBanner.classList)

      // Transition to connected/ready state
      stateOverrides = {
        connectionPhase: 'connected',
        serverPhase: 'ready',
      }
      rerender(<App />)
      const readyBanner = screen.getByTestId('tunnel-warming-banner')
      const readyClasses = new Set(readyBanner.classList)

      // DOM node identity: React must reuse the exact same element across the
      // transition (not unmount/remount). A replaced node — even one with the
      // same tagName and class — could still cause layout shift via CSS
      // transitions or micro reflow.
      expect(readyBanner).toBe(warmingBanner)
      expect(readyBanner.isSameNode(warmingBanner)).toBe(true)

      // Exact classList delta: only the --hidden modifier toggles. No other
      // classes appear or disappear, which would indicate extra styling churn.
      const added = [...readyClasses].filter((c) => !warmingClasses.has(c))
      const removed = [...warmingClasses].filter((c) => !readyClasses.has(c))
      expect(added).toEqual(['tunnel-warming-banner--hidden'])
      expect(removed).toEqual([])
      expect(readyBanner).toHaveClass('tunnel-warming-banner')
    })
  })

  describe('StdinDisabledBanner restart ordering (#3602)', () => {
    // The server rejects `destroy_session` when it would destroy the last
    // remaining session ("Cannot destroy the last session" — see
    // `packages/server/src/handlers/session-handlers.js`). Destroying the
    // broken session first would therefore fail in the common single-session
    // case. The handler must create the replacement first, then destroy.
    it('calls createSession BEFORE destroySession when the banner restart is clicked', () => {
      const callOrder: string[] = []
      const createSessionFn = vi.fn(() => {
        callOrder.push('create')
      })
      const destroySessionFn = vi.fn(() => {
        callOrder.push('destroy')
      })
      stateOverrides = {
        connectionPhase: 'connected',
        sessions: [
          {
            sessionId: 's1',
            name: 'Wedged',
            cwd: '/tmp/repo',
            type: 'cli',
            hasTerminal: true,
            model: null,
            permissionMode: null,
            isBusy: false,
            createdAt: Date.now(),
            conversationId: null,
            provider: 'claude-sdk',
            worktree: false,
            stdinForwardingDisabled: true,
          },
        ],
        activeSessionId: 's1',
        createSession: createSessionFn,
        destroySession: destroySessionFn,
      }
      render(<App />)

      // Banner must be rendered for the wedged session.
      expect(screen.getByTestId('stdin-disabled-banner')).toBeInTheDocument()
      fireEvent.click(screen.getByTestId('stdin-disabled-restart-button'))

      // Both must have been invoked.
      expect(createSessionFn).toHaveBeenCalledTimes(1)
      expect(destroySessionFn).toHaveBeenCalledTimes(1)

      // Strict ordering: create then destroy. Destroy-first would fail when
      // the wedged session is the only one open.
      expect(callOrder).toEqual(['create', 'destroy'])

      // createSession must receive the original session's spawn options so
      // the user lands back in the same cwd / provider / etc.
      expect(createSessionFn).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Wedged',
          cwd: '/tmp/repo',
          provider: 'claude-sdk',
          worktree: false,
        }),
      )

      // destroySession must target the wedged session id.
      expect(destroySessionFn).toHaveBeenCalledWith('s1')
    })

    // #3608: regression net for the `if (!session) return` guard in
    // `handleRestartSession`. The guard has been in place since #3567 / #3593
    // but had no dedicated test — a future refactor that drops it would
    // silently start dispatching `createSession({ name: undefined, ... })` and
    // `destroySession(undefined)` against the WS layer when the active session
    // id no longer corresponds to any entry in `sessions` (e.g. a stale id
    // referenced after the session was removed). Two layers protect against
    // this: the banner's visibility check at the render site, and the
    // handler's own guard. This test exercises both.
    it('is a no-op when activeSessionId does not match any session in sessions', () => {
      const createSessionFn = vi.fn()
      const destroySessionFn = vi.fn()
      stateOverrides = {
        connectionPhase: 'connected',
        // The wedged session exists but its id does NOT match activeSessionId,
        // so `sessions.find(s => s.sessionId === activeSessionId)` returns
        // undefined inside the handler — the exact branch the guard protects.
        sessions: [
          {
            sessionId: 's1',
            name: 'Wedged',
            cwd: '/tmp/repo',
            type: 'cli',
            hasTerminal: true,
            model: null,
            permissionMode: null,
            isBusy: false,
            createdAt: Date.now(),
            conversationId: null,
            provider: 'claude-sdk',
            worktree: false,
            stdinForwardingDisabled: true,
          },
        ],
        activeSessionId: 'missing-id',
        createSession: createSessionFn,
        destroySession: destroySessionFn,
      }
      render(<App />)

      // Visibility-layer assertion: banner must not appear since the active
      // id doesn't resolve to any session — the user has no button to click.
      expect(screen.queryByTestId('stdin-disabled-banner')).not.toBeInTheDocument()
      expect(screen.queryByTestId('stdin-disabled-restart-button')).not.toBeInTheDocument()

      // Handler-layer assertion: even if the banner *had* rendered (e.g. a
      // future refactor surfaces it via a different code path), the handler's
      // `if (!session) return` guard must short-circuit before either WS call.
      // `capturedOnRestart` was wired into App via the StdinDisabledBanner
      // mock at module top.
      expect(capturedOnRestart).toBeTypeOf('function')
      capturedOnRestart!('missing-id')

      expect(createSessionFn).not.toHaveBeenCalled()
      expect(destroySessionFn).not.toHaveBeenCalled()
    })
  })

  describe('Per-session composer state cleanup (#3800)', () => {
    // #3797 introduced per-session paste-collapse storage in three refs on
    // App: `inputDraftsRef`, `pastedTextBlocksRef`, `pastedTextNextIdRef`.
    // `handleSend` clears the entry for the active session, but
    // `handleCloseSession` / `handleRestartSession` only invoked the store's
    // `destroySession` and left the ref entries behind. For a long-running
    // dashboard with frequent session churn the maps would grow unbounded
    // (each holding the full pasted-text content) — see #3800. The fix wires
    // a per-session eviction into both handlers. These tests assert observable
    // proof of cleanup: a session whose composer had a paste chip, once
    // closed, must not "remember" it when its sessionId is later re-presented
    // to the dashboard.
    function bigText(lines: number, charsPerLine = 100): string {
      const line = 'x'.repeat(charsPerLine)
      return Array(lines).fill(line).join('\n')
    }

    const twoSessions = [
      {
        sessionId: 's1', name: 'One', cwd: '/tmp', type: 'cli' as const,
        hasTerminal: true, model: null, permissionMode: null, isBusy: false,
        createdAt: 1, conversationId: null, provider: 'claude-sdk', worktree: false,
      },
      {
        sessionId: 's2', name: 'Two', cwd: '/tmp', type: 'cli' as const,
        hasTerminal: true, model: null, permissionMode: null, isBusy: false,
        createdAt: 2, conversationId: null, provider: 'claude-sdk', worktree: false,
      },
    ]

    it('evicts paste blocks for the closed session so re-presenting the id starts clean', () => {
      const destroySessionFn = vi.fn()
      stateOverrides = {
        connectionPhase: 'connected',
        sessions: twoSessions,
        activeSessionId: 's1',
        destroySession: destroySessionFn,
      }
      const { rerender } = render(<App />)

      // Paste oversized text into the composer of session s1 — this calls
      // App.handleLargePaste which stashes a PastedTextBlock in
      // `pastedTextBlocksRef.current` under key 's1' and renders a chip.
      const textarea = screen.getByRole('textbox', { name: /message input/i })
      fireEvent.paste(textarea, {
        clipboardData: {
          files: [],
          items: [],
          getData: (type: string) => (type === 'text/plain' ? bigText(30) : ''),
        },
      })
      expect(screen.getByTestId('pasted-text-chips')).toBeInTheDocument()

      // Click the close (×) button on s1's tab. SessionBar hides the close
      // button when only one session remains, so we need ≥2 sessions for
      // this to render at all. #5206 — closing now opens the ConfirmDialog;
      // confirm it to proceed with the teardown.
      const s1Tab = screen.getByTestId('session-tab-s1')
      fireEvent.click(within(s1Tab).getByTestId('tab-close'))
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
      expect(destroySessionFn).toHaveBeenCalledWith('s1')

      // Simulate the store completing destruction: s1 is gone, s2 is active.
      stateOverrides = {
        ...stateOverrides,
        sessions: twoSessions.filter(s => s.sessionId !== 's1'),
        activeSessionId: 's2',
      }
      rerender(<App />)
      // Sanity: no chips for s2 (it never had a paste).
      expect(screen.queryByTestId('pasted-text-chips')).not.toBeInTheDocument()

      // Now re-present a session with id 's1' (proxy for the dashboard
      // rehydrating, or a new session that happened to receive the same
      // id). If handleCloseSession had not cleaned up `pastedTextBlocksRef`,
      // the stale block would re-appear here — exactly the memory-leak
      // failure mode #3800 describes.
      stateOverrides = {
        ...stateOverrides,
        sessions: twoSessions,
        activeSessionId: 's1',
      }
      rerender(<App />)
      expect(screen.queryByTestId('pasted-text-chips')).not.toBeInTheDocument()
    })

    it('evicts paste blocks for the restarted session (handleRestartSession)', () => {
      const destroySessionFn = vi.fn()
      const createSessionFn = vi.fn()
      // Single session with stdinForwardingDisabled so the StdinDisabledBanner
      // renders and we can drive `handleRestartSession` via its restart button.
      const wedged = [{
        sessionId: 's1', name: 'Wedged', cwd: '/tmp', type: 'cli' as const,
        hasTerminal: true, model: null, permissionMode: null, isBusy: false,
        createdAt: 1, conversationId: null, provider: 'claude-sdk',
        worktree: false, stdinForwardingDisabled: true,
      }]
      stateOverrides = {
        connectionPhase: 'connected',
        sessions: wedged,
        activeSessionId: 's1',
        destroySession: destroySessionFn,
        createSession: createSessionFn,
      }
      const { rerender } = render(<App />)

      // Stage a collapsed paste in s1's composer.
      const textarea = screen.getByRole('textbox', { name: /message input/i })
      fireEvent.paste(textarea, {
        clipboardData: {
          files: [],
          items: [],
          getData: (type: string) => (type === 'text/plain' ? bigText(30) : ''),
        },
      })
      expect(screen.getByTestId('pasted-text-chips')).toBeInTheDocument()

      // Trigger restart via the banner's mocked button (captures handler at
      // module top). handleRestartSession creates a replacement first then
      // destroys the wedged one — both must run, but the relevant assertion
      // here is the cleanup pass on the OLD sessionId.
      fireEvent.click(screen.getByTestId('stdin-disabled-restart-button'))
      expect(createSessionFn).toHaveBeenCalledTimes(1)
      expect(destroySessionFn).toHaveBeenCalledWith('s1')

      // Simulate the store completing the swap: old 's1' replaced by a fresh
      // session 's1-restart', which becomes the new active. Switch away first
      // so the activeSessionId-keyed useEffect that hydrates composer state
      // fires when we come back to 's1', re-reading from refs.
      stateOverrides = {
        ...stateOverrides,
        sessions: [{ ...wedged[0]!, sessionId: 's1-restart', name: 'Restarted', stdinForwardingDisabled: false }],
        activeSessionId: 's1-restart',
      }
      rerender(<App />)
      expect(screen.queryByTestId('pasted-text-chips')).not.toBeInTheDocument()

      // Now re-present a session whose id is the wedged-original 's1' — same
      // failure-mode probe as the close test. If handleRestartSession had not
      // evicted the per-session refs, this rehydration would resurrect the
      // stale paste chip from `pastedTextBlocksRef`.
      stateOverrides = {
        ...stateOverrides,
        sessions: [{ ...wedged[0]!, stdinForwardingDisabled: false }],
        activeSessionId: 's1',
      }
      rerender(<App />)
      expect(screen.queryByTestId('pasted-text-chips')).not.toBeInTheDocument()
    })
  })

  describe('Composer ref reconciliation against session_list (#3977)', () => {
    // #3977: the server can remove a session from `sessions[]` without the
    // dashboard having called `handleCloseSession` locally — another client
    // closes the session, the supervisor culls it, the server cold-restarts
    // and rebuilds session_list from disk without the dead entries, or the
    // user switches servers. In every one of those paths the per-session
    // composer refs (`inputDraftsRef`, `pastedTextBlocksRef`,
    // `pastedTextNextIdRef`) would leak the dead sessionId's entries for the
    // lifetime of <App />. The fix subscribes to `sessions[]` and reconciles
    // the refs whenever an entry disappears from the list. These tests prove
    // the eviction is observable: a session whose composer had a paste chip,
    // once removed from `sessions[]` by anything other than the local close
    // handler, must not "remember" it when its sessionId reappears.
    function bigText(lines: number, charsPerLine = 100): string {
      const line = 'x'.repeat(charsPerLine)
      return Array(lines).fill(line).join('\n')
    }

    const twoSessions = [
      {
        sessionId: 's1', name: 'One', cwd: '/tmp', type: 'cli' as const,
        hasTerminal: true, model: null, permissionMode: null, isBusy: false,
        createdAt: 1, conversationId: null, provider: 'claude-sdk', worktree: false,
      },
      {
        sessionId: 's2', name: 'Two', cwd: '/tmp', type: 'cli' as const,
        hasTerminal: true, model: null, permissionMode: null, isBusy: false,
        createdAt: 2, conversationId: null, provider: 'claude-sdk', worktree: false,
      },
    ]

    it('evicts paste blocks when a session vanishes from session_list (server-driven removal)', () => {
      stateOverrides = {
        connectionPhase: 'connected',
        sessions: twoSessions,
        activeSessionId: 's1',
      }
      const { rerender } = render(<App />)

      // Stage a collapsed paste on s1.
      const textarea = screen.getByRole('textbox', { name: /message input/i })
      fireEvent.paste(textarea, {
        clipboardData: {
          files: [],
          items: [],
          getData: (type: string) => (type === 'text/plain' ? bigText(30) : ''),
        },
      })
      expect(screen.getByTestId('pasted-text-chips')).toBeInTheDocument()

      // Simulate a server-driven `session_list` broadcast that drops s1 —
      // NOT the local close handler. Active id moves to s2.
      stateOverrides = {
        ...stateOverrides,
        sessions: twoSessions.filter(s => s.sessionId !== 's1'),
        activeSessionId: 's2',
      }
      rerender(<App />)
      expect(screen.queryByTestId('pasted-text-chips')).not.toBeInTheDocument()

      // Re-present a session with id s1 (the dashboard rebinds to the same
      // id, or a new session happens to reuse it). If the ref entry leaked,
      // the stale paste chip would resurrect here — the failure mode #3977
      // describes for the broadcast-driven removal path.
      stateOverrides = {
        ...stateOverrides,
        sessions: twoSessions,
        activeSessionId: 's1',
      }
      rerender(<App />)
      expect(screen.queryByTestId('pasted-text-chips')).not.toBeInTheDocument()
    })

    it('evicts the typed draft when a session vanishes from session_list', () => {
      stateOverrides = {
        connectionPhase: 'connected',
        sessions: twoSessions,
        activeSessionId: 's1',
      }
      const { rerender } = render(<App />)

      // Type a draft into s1.
      const textarea = screen.getByRole('textbox', { name: /message input/i })
      fireEvent.change(textarea, { target: { value: 'draft for s1' } })
      expect((textarea as HTMLTextAreaElement).value).toBe('draft for s1')

      // Server-driven removal of s1 (broadcast, not local close).
      stateOverrides = {
        ...stateOverrides,
        sessions: twoSessions.filter(s => s.sessionId !== 's1'),
        activeSessionId: 's2',
      }
      rerender(<App />)

      // Re-present s1 — the draft must not resurrect from `inputDraftsRef`.
      stateOverrides = {
        ...stateOverrides,
        sessions: twoSessions,
        activeSessionId: 's1',
      }
      rerender(<App />)
      const restored = screen.getByRole('textbox', { name: /message input/i }) as HTMLTextAreaElement
      expect(restored.value).toBe('')
    })

    it('preserves composer state for sessions that remain in session_list', () => {
      stateOverrides = {
        connectionPhase: 'connected',
        sessions: twoSessions,
        activeSessionId: 's1',
      }
      const { rerender } = render(<App />)

      // Paste in s1.
      const textarea = screen.getByRole('textbox', { name: /message input/i })
      fireEvent.paste(textarea, {
        clipboardData: {
          files: [],
          items: [],
          getData: (type: string) => (type === 'text/plain' ? bigText(30) : ''),
        },
      })
      expect(screen.getByTestId('pasted-text-chips')).toBeInTheDocument()

      // Server-driven removal of s2 — s1 stays in the list, so its paste
      // chip must survive the reconciliation pass.
      stateOverrides = {
        ...stateOverrides,
        sessions: twoSessions.filter(s => s.sessionId !== 's2'),
        activeSessionId: 's1',
      }
      rerender(<App />)
      expect(screen.getByTestId('pasted-text-chips')).toBeInTheDocument()
    })
  })

  // #4372 — a11y: handleSidebarContextMenu must move focus to the row before
  // opening the SessionContextMenu. PR #4369 added focus restoration on
  // menu unmount that returns focus to whatever was document.activeElement
  // at open time; a right-click does not move focus by default, so without
  // this the captured "trigger" is whatever was last clicked (often the
  // composer textarea) and Esc lands focus there, not on the row.
  describe('right-click focuses the sidebar row before opening the menu (#4372)', () => {
    const connectedState = {
      connectionPhase: 'connected' as const,
      sessions: [
        { sessionId: 's1', name: 'Alpha', cwd: '/tmp/repo', type: 'cli' as const, hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null },
      ],
      activeSessionId: 's1',
    }

    it('calls focus() on the right-clicked row before opening the menu', () => {
      // We can't assert `document.activeElement === row` after the contextMenu
      // event finishes — SessionContextMenu's mount effect focuses its first
      // item, so by the time the assertion runs the menu has stolen focus.
      // What we *can* pin down is that the handler invokes `focus()` on the
      // row element itself (so SessionContextMenu's mount-effect capture of
      // `document.activeElement` lands on the row). Spy on the row's focus.
      stateOverrides = connectedState
      render(<App />)
      const row = screen.getByTestId('session-item-s1')
      const focusSpy = vi.spyOn(row, 'focus')
      fireEvent.contextMenu(row)
      expect(focusSpy).toHaveBeenCalled()
    })

    it('returns focus to the row when the menu is dismissed (Esc)', () => {
      // End-to-end: the user right-clicks the row from the composer textarea,
      // navigates the menu, then dismisses with Esc. PR #4369 added the
      // focus-restoration cleanup; #4372 ensures the *captured* trigger is
      // the row (not the composer) by focusing it first in the handler. We
      // assert both halves: the menu opens, then Esc lands focus on the row.
      stateOverrides = connectedState
      render(<App />)
      const textarea = screen.getByRole('textbox', { name: /message input/i }) as HTMLTextAreaElement
      textarea.focus()
      expect(document.activeElement).toBe(textarea)

      const row = screen.getByTestId('session-item-s1')
      fireEvent.contextMenu(row)
      // Sanity: the menu is open and its first item should be focused.
      const menu = screen.getByRole('menu')
      expect(menu).toBeInTheDocument()

      // Esc dismisses the menu. SessionContextMenu listens at document scope
      // for keydown today; firing on the menu element (rather than directly
      // on `document`) lets the event bubble through the standard user-facing
      // path, so this test stays green if the listener is later scoped to
      // the menu itself.
      fireEvent.keyDown(menu, { key: 'Escape' })

      // The menu should be gone, and focus restored to the row (NOT the
      // textarea, which would indicate the pre-#4372 bug).
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(document.activeElement).toBe(row)
    })

    // Parallel to the session-row case above, but for repo headers — the
    // case the first pass of #4372 missed because the onContextMenu listener
    // used to be on the inner `.sidebar-repo-header` (no tabIndex, no role)
    // instead of the outer `.sidebar-repo` treeitem. Without the Sidebar
    // structural fix, this test would fail: focus would stay on the textarea
    // (because focus() on the unfocusable header is a no-op) and Esc would
    // land focus on document.body or the textarea, not the treeitem.
    it('returns focus to the repo treeitem when the menu is dismissed (Esc)', () => {
      stateOverrides = connectedState
      render(<App />)
      const textarea = screen.getByRole('textbox', { name: /message input/i }) as HTMLTextAreaElement
      textarea.focus()
      expect(document.activeElement).toBe(textarea)

      // App derives repos from sessions; our s1 session cwd is /tmp/repo,
      // which produces a `repo-header-/tmp/repo` testid on the header.
      const header = screen.getByTestId('repo-header-/tmp/repo')
      const treeitem = header.closest('[role="treeitem"]') as HTMLElement | null
      expect(treeitem).not.toBeNull()

      // Right-click on the inner header. The listener now lives on the
      // outer treeitem, so the contextmenu event bubbles up and the
      // handler's event.currentTarget is the focusable treeitem.
      fireEvent.contextMenu(header)
      const menu = screen.getByRole('menu')
      expect(menu).toBeInTheDocument()

      fireEvent.keyDown(menu, { key: 'Escape' })

      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(document.activeElement).toBe(treeitem)
    })
  })

  // #4673 — Tauri WKWebView's `navigator.clipboard.writeText` silently
  // resolves without writing to the OS clipboard, which made the "Copied!"
  // check mark flash on a transcript that was never actually copied. The
  // copy callback now routes through the `writeText` helper and only marks
  // the button as copied when the helper reports success.
  describe('handleCopyTranscript copy indicator (#4673)', () => {
    const connectedWithMessages = {
      connectionPhase: 'connected' as const,
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli' as const, hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
      getActiveSessionState: () => ({
        messages: [
          { id: 'msg-1', type: 'user_input', content: 'hello', timestamp: 1 },
          { id: 'msg-2', type: 'response', content: 'hi back', timestamp: 2 },
        ],
        streamingMessageId: null,
        activeModel: null,
        permissionMode: null,
        contextUsage: null,
        sessionCost: null,
        isIdle: true,
        activeAgents: [],
        isPlanPending: false,
      }),
    }

    // #4974 — Copy transcript moved into the header overflow menu. The
    // helper opens the menu and returns the "Copy transcript" item so
    // each test reads as: open → click → assert. We re-query the item
    // after the click because the App rerenders the menu when
    // `transcriptCopied` flips, which can rebind the DOM node.
    const openOverflowAndGetCopyItem = () => {
      fireEvent.click(screen.getByTestId('header-overflow-trigger'))
      return screen.getByTestId('header-overflow-item-copy-transcript')
    }

    it('does NOT flash the check mark when the clipboard helper returns false', async () => {
      clipboardWriteTextMock.mockResolvedValue(false)
      stateOverrides = connectedWithMessages
      render(<App />)

      const item = openOverflowAndGetCopyItem()
      // Title before click reflects the not-copied state (no "Copied!").
      expect(item.getAttribute('title')).not.toContain('Copied!')

      fireEvent.click(item)
      await waitFor(() => {
        expect(clipboardWriteTextMock).toHaveBeenCalledTimes(1)
      })

      // Indicator must NOT flip — the OS clipboard was never written.
      // The menu closes after a click; re-open and re-read the item.
      const after = openOverflowAndGetCopyItem()
      expect(after.textContent).not.toContain('✓')
      expect(after.getAttribute('title')).not.toContain('Copied!')
    })

    it('DOES flash the check mark when the clipboard helper returns true', async () => {
      clipboardWriteTextMock.mockResolvedValue(true)
      stateOverrides = connectedWithMessages
      render(<App />)

      const item = openOverflowAndGetCopyItem()
      fireEvent.click(item)

      await waitFor(() => {
        expect(clipboardWriteTextMock).toHaveBeenCalledTimes(1)
      })
      // Re-open the menu — `transcriptCopied` flipped to true so the
      // item now renders the check glyph + "Copied!" title.
      const after = openOverflowAndGetCopyItem()
      await waitFor(() => {
        expect(after.textContent).toContain('✓')
      })
      expect(after.getAttribute('title')).toContain('Copied!')
    })

    // #4629 — the original bug was that a failed clipboard write would
    // silently swallow the failure and the "Copied!" tooltip flashed
    // anyway. PR #4676 (for #4673) fixed the misleading flash but the
    // user still got zero feedback when the write fell through. The third
    // acceptance criterion on #4629 explicitly calls this out: "If
    // clipboard write fails, user sees an error (not a misleading
    // 'Copied!' tooltip)". Surface a server-error toast so the user knows
    // the OS clipboard wasn't actually written.
    it('surfaces a server-error toast when the clipboard helper returns false (#4629)', async () => {
      clipboardWriteTextMock.mockResolvedValue(false)
      stateOverrides = connectedWithMessages
      render(<App />)

      const item = openOverflowAndGetCopyItem()
      fireEvent.click(item)

      await waitFor(() => {
        expect(addServerErrorMock).toHaveBeenCalledTimes(1)
      })
      const firstCall = addServerErrorMock.mock.calls[0]
      expect(firstCall).toBeDefined()
      const [message, action, severity] = firstCall!
      expect(message).toMatch(/clipboard/i)
      // #4870 — a failed clipboard write is non-destructive (the user just
      // needs to retry). Match the #4148 convention by tagging the toast
      // as a 'warning' so it renders yellow rather than the red 'error'
      // reserved for STREAM_ERROR / ABORT. The recovery `action` slot
      // stays undefined because we have nothing meaningful to wire a
      // one-click retry to from this call site.
      expect(action).toBeUndefined()
      expect(severity).toBe('warning')
      // Must NOT also flash the success indicator (that was the #4673 bug;
      // this test pins the negative too so a future regression on either
      // axis is caught). Re-open the menu to read the current row state.
      const after = openOverflowAndGetCopyItem()
      expect(after.textContent).not.toContain('✓')
    })

    it('does NOT surface a server-error toast on a successful copy (#4629)', async () => {
      clipboardWriteTextMock.mockResolvedValue(true)
      stateOverrides = connectedWithMessages
      render(<App />)

      const item = openOverflowAndGetCopyItem()
      fireEvent.click(item)

      // Wait for the clipboard write to resolve (state-only assertion —
      // keeps the waitFor callback side-effect-free per RTL guidance;
      // re-opening the menu inside the retry loop would toggle it open
      // and closed on each tick and make the test non-deterministic).
      await waitFor(() => {
        expect(clipboardWriteTextMock).toHaveBeenCalledTimes(1)
      })
      // `transcriptCopied` flipped to true — re-open the menu and read
      // the row's current glyph.
      const after = openOverflowAndGetCopyItem()
      expect(after.textContent).toContain('✓')
      expect(addServerErrorMock).not.toHaveBeenCalled()
    })
  })

  // #4871 — the sidebar context-menu's copyToClipboard callback (used for
  // "Copy path" on session/repo rows and "Copy Conversation ID" on
  // resumable rows) routed through `clipboardWriteText` but explicitly
  // "fell through quietly" on failure — the same Tauri-WKWebView /
  // non-secure-context failure modes that motivated #4629 left the user
  // with zero feedback and a stale paste. PR #4857 fixed the
  // handleCopyTranscript path; this is the sibling fix. The callback now
  // surfaces a 'warning'-severity toast (per #4870 — a failed clipboard
  // write is non-destructive, not red-error-worthy).
  describe('sidebar copyToClipboard callback failure feedback (#4871)', () => {
    const connectedWithRepoSession = {
      connectionPhase: 'connected' as const,
      sessions: [{
        sessionId: 's1',
        name: 'Alpha',
        cwd: '/tmp/repo',
        type: 'cli' as const,
        hasTerminal: true,
        model: null,
        permissionMode: null,
        isBusy: false,
        createdAt: Date.now(),
        conversationId: null,
      }],
      activeSessionId: 's1',
    }

    it('surfaces a warning-severity toast when the clipboard helper returns false', async () => {
      clipboardWriteTextMock.mockResolvedValue(false)
      stateOverrides = connectedWithRepoSession
      render(<App />)

      // Right-click the session row to open the sidebar context menu, then
      // click "Copy path" — the same callback that wires "Copy Conversation
      // ID" on resumable rows. The session-row path is easier to bootstrap
      // (no conversationHistory fixture required).
      const row = screen.getByTestId('session-item-s1')
      fireEvent.contextMenu(row)
      const menu = screen.getByRole('menu')
      expect(menu).toBeInTheDocument()

      const copyPath = within(menu).getByRole('menuitem', { name: /copy path/i })
      fireEvent.click(copyPath)

      await waitFor(() => {
        expect(clipboardWriteTextMock).toHaveBeenCalledWith('/tmp/repo')
      })
      await waitFor(() => {
        expect(addServerErrorMock).toHaveBeenCalledTimes(1)
      })
      const firstCall = addServerErrorMock.mock.calls[0]
      expect(firstCall).toBeDefined()
      const [message, action, severity] = firstCall!
      expect(message).toMatch(/clipboard/i)
      // Severity arg pinned to 'warning' (#4870 convention).
      expect(action).toBeUndefined()
      expect(severity).toBe('warning')
    })

    it('does NOT surface a toast on a successful copy (no green confirmation by design)', async () => {
      clipboardWriteTextMock.mockResolvedValue(true)
      stateOverrides = connectedWithRepoSession
      render(<App />)

      const row = screen.getByTestId('session-item-s1')
      fireEvent.contextMenu(row)
      const menu = screen.getByRole('menu')
      const copyPath = within(menu).getByRole('menuitem', { name: /copy path/i })
      fireEvent.click(copyPath)

      await waitFor(() => {
        expect(clipboardWriteTextMock).toHaveBeenCalledWith('/tmp/repo')
      })
      // Resolve the microtask so the .then() handler runs.
      await Promise.resolve()
      expect(addServerErrorMock).not.toHaveBeenCalled()
    })
  })

  // #4796 — wiring guard for `useVoiceInput({ mode })`. Audit Tester #2
  // flagged that the chain `SettingsPanel.tsx -> updateInputSettings ->
  // inputSettings.voiceInputMode -> App.tsx selector -> useVoiceInput({ mode })`
  // had zero test coverage. A store-selector typo (e.g. `inputSettings.mode`)
  // or stale closure in `modeRef` would silently break the user-facing
  // setting without any test failing — the bug would only show up in
  // manual QA, which is what happened in #4796. These tests pin the
  // store-to-hook contract.
  describe('voice input mode wiring (#4796)', () => {
    it('passes the store inputSettings.voiceInputMode through to useVoiceInput as the mode option', () => {
      stateOverrides = {
        inputSettings: { chatEnterToSend: true, terminalEnterToSend: false, voiceInputMode: 'auto-pause' as const },
      }
      render(<App />)
      // The hook must be invoked with the exact mode persisted in the store.
      // Use `mock.calls` rather than `toHaveBeenCalledWith` so we can spot
      // any extra "mode" call from a strict-mode double render.
      const modes = voiceInputModeSpy.mock.calls.map(c => c[0]?.mode)
      expect(modes).toContain('auto-pause')
    })

    it('passes "continuous" when the store has the default voiceInputMode', () => {
      stateOverrides = {
        inputSettings: { chatEnterToSend: true, terminalEnterToSend: false, voiceInputMode: 'continuous' as const },
      }
      render(<App />)
      const modes = voiceInputModeSpy.mock.calls.map(c => c[0]?.mode)
      expect(modes).toContain('continuous')
    })
  })

  // #4685 — App-level integration tests for the AskUserQuestion content
  // gate. The component-level tests in QuestionPrompt.test.tsx prove the
  // placeholder branch given a prop; these prove App.tsx ACTUALLY computes
  // `pendingPermission=true` when the active session has both an unresolved
  // `AskUserQuestion` permission_request AND a `user_question`-derived
  // prompt message, and that the gate flips OFF on allow / STAYS ON on
  // deny. A future change that renames `m.tool` or moves `requestId`
  // placement on the permission ChatMessage would silently regress the
  // fix — these tests pin the App-side derivation. Mirrors Copilot review
  // comment #2 on #4860.
  describe('AskUserQuestion content gate — App-level derivation (#4685)', () => {
    const connectedState = {
      connectionPhase: 'connected' as const,
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli' as const, hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }

    // Two messages mirror the TUI race in the wild: the permission hook's
    // HTTP /permission broadcast creates a `permission_request` ChatMessage
    // (tool='AskUserQuestion', requestId set), and the in-process
    // user_question event creates a separate `prompt` ChatMessage carrying
    // the model-supplied question text + options (no requestId).
    const askUserQuestionMessages = [
      {
        id: 'perm-1',
        type: 'prompt',
        content: 'AskUserQuestion: pick your fighter',
        tool: 'AskUserQuestion',
        requestId: 'req-aq-1',
        options: [
          { label: 'Allow', value: 'allow' },
          { label: 'Deny', value: 'deny' },
        ],
        expiresAt: Date.now() + 300_000,
        timestamp: 1,
      },
      {
        id: 'q-1',
        type: 'prompt',
        content: 'Pick your fighter',
        options: [
          { label: 'Ryu', value: 'ryu' },
          { label: 'Ken', value: 'ken' },
        ],
        questions: [
          { question: 'Pick your fighter', options: [{ label: 'Ryu', value: 'ryu' }, { label: 'Ken', value: 'ken' }] },
        ],
        timestamp: 2,
      },
    ]

    it('renders the placeholder (and hides question content) when the AskUserQuestion permission_request is unresolved', () => {
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: askUserQuestionMessages,
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        resolvedPermissions: {},
        viewMode: 'chat',
      }
      render(<App />)
      const chatPane = screen.getByTestId('chat-pane')
      // Placeholder renders…
      expect(within(chatPane).getByTestId('question-prompt-pending-permission')).toBeInTheDocument()
      // …and the model-supplied question + option labels are NOT in the
      // chat pane (gate works end-to-end through App's derivation).
      expect(within(chatPane).queryByText('Pick your fighter')).not.toBeInTheDocument()
      expect(within(chatPane).queryByText('Ryu')).not.toBeInTheDocument()
      expect(within(chatPane).queryByText('Ken')).not.toBeInTheDocument()
    })

    it('flips OFF the gate (reveals content) when the permission resolves to `allow`', () => {
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: askUserQuestionMessages,
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        resolvedPermissions: { 'req-aq-1': 'allow' },
        viewMode: 'chat',
      }
      render(<App />)
      const chatPane = screen.getByTestId('chat-pane')
      // Placeholder is gone…
      expect(within(chatPane).queryByTestId('question-prompt-pending-permission')).not.toBeInTheDocument()
      // …and the actual question + options are visible.
      expect(within(chatPane).getByText('Pick your fighter')).toBeInTheDocument()
      expect(within(chatPane).getByText('Ryu')).toBeInTheDocument()
      expect(within(chatPane).getByText('Ken')).toBeInTheDocument()
    })

    it('flips OFF the gate when the permission resolves to `allowSession`', () => {
      // Same behaviour as `allow` — both are "user explicitly approved
      // seeing the question content."
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: askUserQuestionMessages,
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        resolvedPermissions: { 'req-aq-1': 'allowSession' },
        viewMode: 'chat',
      }
      render(<App />)
      const chatPane = screen.getByTestId('chat-pane')
      expect(within(chatPane).queryByTestId('question-prompt-pending-permission')).not.toBeInTheDocument()
      expect(within(chatPane).getByText('Pick your fighter')).toBeInTheDocument()
    })

    it('KEEPS the gate ON when the permission resolves to `deny` (#4685 Copilot review)', () => {
      // Issue #4685 expected behavior: "(b) Question bubble renders only
      // after the permission flow completes (and shows the redacted/denied
      // state if user clicks Deny)". Pre-Copilot-review the gate flipped
      // off on ANY resolved entry, surfacing the model-supplied question
      // text + options after a denial — exactly defeating the gate. This
      // test pins the deny-keeps-gate-on rule end-to-end through App's
      // derivation.
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: askUserQuestionMessages,
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        resolvedPermissions: { 'req-aq-1': 'deny' },
        viewMode: 'chat',
      }
      render(<App />)
      const chatPane = screen.getByTestId('chat-pane')
      // Placeholder STILL renders — deny does not un-gate.
      expect(within(chatPane).getByTestId('question-prompt-pending-permission')).toBeInTheDocument()
      // Question content stays hidden.
      expect(within(chatPane).queryByText('Pick your fighter')).not.toBeInTheDocument()
      expect(within(chatPane).queryByText('Ryu')).not.toBeInTheDocument()
    })

    it('KEEPS the gate ON when the cross-client permission_resolved set `m.answered = "deny"` on the permission message', () => {
      // The cross-client path lives on the per-message `answered` field
      // rather than the store's `resolvedPermissions` map (see
      // message-handler.ts:1705 — handlePermissionResolved sets answered
      // for the cross-client view, NOT resolvedPermissions). Mirror the
      // resolvedPermissions deny test for the per-message branch.
      const denyAnsweredMessages = [
        { ...askUserQuestionMessages[0], answered: 'deny' as const, answeredAt: Date.now() },
        askUserQuestionMessages[1],
      ]
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: denyAnsweredMessages,
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        resolvedPermissions: {},
        viewMode: 'chat',
      }
      render(<App />)
      const chatPane = screen.getByTestId('chat-pane')
      expect(within(chatPane).getByTestId('question-prompt-pending-permission')).toBeInTheDocument()
      expect(within(chatPane).queryByText('Pick your fighter')).not.toBeInTheDocument()
    })

    it('does NOT activate the gate when there is no AskUserQuestion permission_request in the session', () => {
      // Defensive: a `user_question` without a paired permission_request
      // (e.g. SDK / CLI / BYOK / Codex / Gemini providers, which short-
      // circuit AskUserQuestion in PermissionManager — no permission_request
      // is ever broadcast) MUST render the QuestionPrompt content
      // immediately. The gate is TUI-specific by construction and a no-op
      // elsewhere; pin that here so a future change can't accidentally
      // gate every provider's AskUserQuestion.
      stateOverrides = {
        ...connectedState,
        getActiveSessionState: () => ({
          messages: [askUserQuestionMessages[1]], // user_question only, no permission_request
          streamingMessageId: null,
          activeModel: null,
          permissionMode: null,
          contextUsage: null,
          sessionCost: null,
          isIdle: true,
          activeAgents: [],
          isPlanPending: false,
        }),
        resolvedPermissions: {},
        viewMode: 'chat',
      }
      render(<App />)
      const chatPane = screen.getByTestId('chat-pane')
      expect(within(chatPane).queryByTestId('question-prompt-pending-permission')).not.toBeInTheDocument()
      expect(within(chatPane).getByText('Pick your fighter')).toBeInTheDocument()
    })
  })

  describe('header tooltips (#4630)', () => {
    const connectedWithSession = {
      connectionPhase: 'connected' as const,
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli' as const, hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }

    // #4974 — Skills + Settings moved into the header overflow menu.
    // The trigger itself stays in the chrome with title + aria-label;
    // the underlying actions sit one click away inside the popover.
    it('Skills row inside the overflow menu carries a title', () => {
      stateOverrides = connectedWithSession
      render(<App />)
      fireEvent.click(screen.getByTestId('header-overflow-trigger'))
      const item = screen.getByTestId('header-overflow-item-skills')
      expect(item.getAttribute('title')).toBe('Skills')
      expect(item.textContent).toMatch(/Skills/)
    })

    it('Settings row inside the overflow menu carries a Settings title', () => {
      stateOverrides = connectedWithSession
      render(<App />)
      fireEvent.click(screen.getByTestId('header-overflow-trigger'))
      const item = screen.getByTestId('header-overflow-item-settings')
      expect(item.getAttribute('title')).toMatch(/Settings/)
      expect(item.textContent).toMatch(/Settings/)
    })

    it('header overflow trigger itself exposes title + aria-label (chrome affordance)', () => {
      stateOverrides = connectedWithSession
      render(<App />)
      const trigger = screen.getByTestId('header-overflow-trigger')
      expect(trigger.getAttribute('title')).toBeTruthy()
      expect(trigger.getAttribute('aria-label')).toBeTruthy()
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    })

    it('header status dot exposes both title and aria-label so it is discoverable', () => {
      stateOverrides = connectedWithSession
      const { container } = render(<App />)
      // The header's status-dot is rendered inside #header, distinct from
      // the per-tab status-dot inside SessionBar.
      const header = container.querySelector('#header')
      const dot = header!.querySelector('.status-dot')
      expect(dot, 'header status-dot must exist').toBeTruthy()
      expect(dot!.getAttribute('title'), 'status-dot needs title for browser hover').toBeTruthy()
      expect(dot!.getAttribute('aria-label'), 'status-dot needs aria-label for SR').toBeTruthy()
    })

    // #4873 — header status dot must NOT carry role="status" / aria-live.
    // The per-element live region announced every reconnect intermediate
    // (connecting → reconnecting → connected → reconnecting…), spamming
    // SR users. The page-level ConnectionAnnouncer (mounted in App)
    // handles settled-state announcements instead.
    it('header status dot does NOT carry role="status" (#4873)', () => {
      stateOverrides = connectedWithSession
      const { container } = render(<App />)
      const header = container.querySelector('#header')
      const dot = header!.querySelector('.status-dot')
      expect(dot, 'header status-dot must exist').toBeTruthy()
      expect(dot!.getAttribute('role'), 'status-dot must NOT be role=status').not.toBe('status')
      expect(dot!.getAttribute('aria-live'), 'status-dot must not be a live region').toBeNull()
    })

    // #4873 — the page-level live region IS rendered, so SR users still
    // get a settled-state announcement after the debounce window.
    it('renders a page-level ConnectionAnnouncer live region (#4873)', () => {
      stateOverrides = connectedWithSession
      const { container } = render(<App />)
      const announcer = container.querySelector('[data-testid="connection-announcer"]')
      expect(announcer, 'page-level connection announcer must exist').toBeTruthy()
      expect(announcer!.getAttribute('role')).toBe('status')
      expect(announcer!.getAttribute('aria-live')).toBe('polite')
    })

    it('version badge exposes both title and aria-label', () => {
      stateOverrides = connectedWithSession
      const { container } = render(<App />)
      const badge = container.querySelector('.version-badge')
      expect(badge, 'version-badge must exist').toBeTruthy()
      expect(badge!.getAttribute('title'), 'version-badge needs title').toBeTruthy()
      expect(badge!.getAttribute('aria-label'), 'version-badge needs aria-label').toBeTruthy()
    })
  })

  // #5182 (D1) — the top-bar status dot must track the CONNECTED state
  // (the app's WS/tunnel connection), not a daemon "running" state. It is
  // driven by `connectionPhase`: green `.connected` only when
  // connectionPhase === 'connected', and a non-connected class otherwise.
  // The separate "Running" indicator lives on the sidebar/explorer header
  // (#5192) and is deliberately not wired into this dot.
  describe('top status dot reflects Connected state (#5182)', () => {
    const oneSession = [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli' as const, hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }]

    it('is .connected (green) when connectionPhase is connected', () => {
      stateOverrides = { connectionPhase: 'connected', sessions: oneSession, activeSessionId: 's1' }
      const { container } = render(<App />)
      const dot = container.querySelector('#header .status-dot')
      expect(dot, 'header status-dot must exist').toBeTruthy()
      expect(dot!.classList.contains('connected'), 'dot must be .connected when connected').toBe(true)
      expect(dot!.getAttribute('aria-label')).toMatch(/connected/i)
    })

    it('is NOT .connected when disconnected', () => {
      stateOverrides = { connectionPhase: 'disconnected', sessions: [], activeSessionId: null }
      const { container } = render(<App />)
      const dot = container.querySelector('#header .status-dot')
      expect(dot, 'header status-dot must exist').toBeTruthy()
      expect(dot!.classList.contains('connected'), 'dot must NOT be .connected when disconnected').toBe(false)
      expect(dot!.classList.contains('disconnected')).toBe(true)
    })

    it('shows the connecting state (not connected) while reconnecting', () => {
      stateOverrides = { connectionPhase: 'reconnecting', sessions: oneSession, activeSessionId: 's1' }
      const { container } = render(<App />)
      const dot = container.querySelector('#header .status-dot')
      expect(dot!.classList.contains('connected')).toBe(false)
      expect(dot!.classList.contains('reconnecting')).toBe(true)
    })
  })

  // #5180 (C2) — every control in the top bar must be present (and thus
  // not occluded into nonexistence) when connected: the model dropdown,
  // the permission (Approve) select, the notification bell, the ⋯
  // overflow trigger, the cost badge, and the token/status cluster. This
  // is the render-level guard that pairs with the CSS layout fix (the
  // right cluster is content-pinned and its children never shrink to
  // overlap one another).
  describe('top-bar controls all render without occlusion (#5180)', () => {
    const connectedModelState = {
      connectionPhase: 'connected' as const,
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli' as const, hasTerminal: true, model: 'sonnet', permissionMode: 'approve', isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
      availableModels: [
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6', contextWindow: 200000 },
        { id: 'opus', label: 'Opus 4.7', fullId: 'claude-opus-4-7', contextWindow: 200000 },
      ],
      availablePermissionModes: [
        { id: 'approve', label: 'Approve' },
        { id: 'auto', label: 'Auto Approve' },
      ],
    }

    it('renders the model dropdown, permission select, bell, overflow, and cost slot together', () => {
      stateOverrides = connectedModelState
      const { container } = render(<App />)
      const header = container.querySelector('#header')
      expect(header, '#header must render').toBeTruthy()
      // Model dropdown (header-center)
      expect(within(header as HTMLElement).getByTestId('chat-settings-trigger')).toBeInTheDocument()
      // Permission-mode (Approve) select
      expect(header!.querySelector('select[data-kind="permission"]'), 'permission select must render').toBeTruthy()
      // Notification bell trigger
      expect(within(header as HTMLElement).getByTestId('notifications-widget-trigger')).toBeInTheDocument()
      // Overflow (⋯) trigger
      expect(within(header as HTMLElement).getByTestId('header-overflow-trigger')).toBeInTheDocument()
      // Cost slot (legacy .status-cost or configurable badge — at least one)
      const costSlot = header!.querySelector('.status-cost, [data-testid="sidebar-cost-badge"]')
      expect(costSlot, 'cost slot must render').toBeTruthy()
      // Status bar cluster (tokens live here)
      expect(within(header as HTMLElement).getByTestId('status-bar')).toBeInTheDocument()
    })
  })

  // #4695 / #5062 — discoverable chrome-level "New Session" entry point.
  //
  // The per-project sidebar button (`sidebar-new-session-<path>`) and the
  // command palette (`new-session` id) were the only two entry points
  // before #4695 — neither discoverable to a first-time user scanning
  // the dashboard chrome. #4695 added a standalone button in the
  // `header-right` zone; #5062 then folded that button INTO the header
  // overflow (⋯) menu so the right zone stops crowding the model
  // selector. The discoverable entry now lives as the first row of the
  // overflow menu, reusing the existing `handleNewSession` path
  // (setShowCreateSession → CreateSessionModal). The tests pin:
  //   1. The entry renders inside #header (always-visible chrome),
  //      reached by opening the overflow (⋯) menu.
  //   2. It has a visible "New Session" label and a title with the
  //      Cmd+N shortcut hint.
  //   3. Clicking it opens the Create Session modal (the modal renders
  //      its overlay only when open=true, mirrored on Modal.tsx's
  //      `if (!open) return null` guard).
  //   4. The standalone `chrome-new-session` button no longer renders —
  //      the affordance lives only inside the overflow menu now.
  describe('New Session in header overflow menu (#5062)', () => {
    const baseHeaderState = {
      connectionPhase: 'connected' as const,
      sessions: [{ sessionId: 's1', name: 'Test', cwd: '/tmp', type: 'cli' as const, hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null }],
      activeSessionId: 's1',
    }

    it('no longer renders the standalone chrome-new-session button (#5062)', () => {
      stateOverrides = baseHeaderState
      render(<App />)
      expect(screen.queryByTestId('chrome-new-session')).not.toBeInTheDocument()
    })

    it('renders the New Session entry inside the header overflow menu', () => {
      stateOverrides = baseHeaderState
      const { container } = render(<App />)
      const header = container.querySelector('#header')
      expect(header, '#header must render').toBeTruthy()
      const trigger = within(header as HTMLElement).getByTestId('header-overflow-trigger')
      fireEvent.click(trigger)
      const item = screen.getByTestId('header-overflow-item-new-session')
      expect(item).toBeInTheDocument()
      expect(item.textContent).toMatch(/New Session/)
    })

    it('exposes a title attribute containing the Cmd+N shortcut hint', () => {
      stateOverrides = baseHeaderState
      render(<App />)
      fireEvent.click(screen.getByTestId('header-overflow-trigger'))
      const item = screen.getByTestId('header-overflow-item-new-session')
      // The HeaderOverflowMenu copies `item.title` straight onto the
      // <li>'s `title` attribute — assert the shortcut hint survives.
      // formatShortcutKeys() emits `Cmd+N` on macOS and `Ctrl+N`
      // elsewhere, so match either modifier joined to `N` by a `+`. The
      // earlier `/N/` was too loose — it would still pass if the
      // modifier disappeared and the title read just "New session (N)".
      expect(item.getAttribute('title')).toMatch(/New session/)
      expect(item.getAttribute('title')).toMatch(/(Cmd|Ctrl)\+N/)
    })

    it('opens the Create Session modal on click', () => {
      stateOverrides = baseHeaderState
      render(<App />)
      // Modal mock renders the testID node only when `open=true`.
      expect(screen.queryByTestId('create-session-modal-mock')).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId('header-overflow-trigger'))
      fireEvent.click(screen.getByTestId('header-overflow-item-new-session'))
      expect(screen.getByTestId('create-session-modal-mock')).toBeInTheDocument()
    })
  })

  describe('#5211 Control Room view vs disconnected/startup screens', () => {
    const sessionWithCwd = [
      { sessionId: 's1', name: 'One', cwd: '/tmp/a', type: 'cli', hasTerminal: true, model: null, permissionMode: null, isBusy: false, createdAt: Date.now(), conversationId: null },
    ]

    it('keeps the CR view and suppresses the disconnected screen when the connection drops while CR is active', () => {
      stateOverrides = { connectionPhase: 'connected', sessions: sessionWithCwd, activeSessionId: 's1' }
      const { rerender } = render(<App />)
      // Open the Control Room via the sidebar launcher (sessions-with-cwd
      // render the sidebar, which hosts the launcher).
      fireEvent.click(screen.getByTestId('sidebar-panel-slot-launcher-control-room'))
      expect(screen.getByTestId('control-room-main')).toBeInTheDocument()

      // Connection drops with no sessions left — the disconnected screen would
      // normally render. controlRoomActive is local state and survives the
      // rerender, so the CR is still active.
      stateOverrides = { connectionPhase: 'disconnected', sessions: [], activeSessionId: null }
      rerender(<App />)

      // #5211 — the CR owns the main area; the disconnected screen does NOT
      // also render (mutually exclusive).
      expect(screen.getByTestId('control-room-main')).toBeInTheDocument()
      expect(screen.queryByTestId('disconnected-screen')).not.toBeInTheDocument()
    })
  })

  // #5218 / #5214 — a stashed Investigate seed must not leak into a session
  // created by a *plain* opener. handleInvestigate stashes the repo's note as
  // the pending seed (openCreateSession({ seed })); every plain opener routes
  // through openCreateSession() with no seed, which clears the ref (#5215 /
  // #5217). If a clear regresses, the stale reason would seed an unrelated
  // session's composer. These tests lock that in: a positive control proves
  // the seed path is observable, then each plain opener must leave the
  // composer empty after create. The assertions are timing-agnostic — they
  // read the active session's composer after the create-confirm effect runs,
  // regardless of which session the effect targets.
  describe('#5218 Investigate seed does not leak into plain create-session openers', () => {
    const REASON = 'Investigate: 172 worktrees — likely a leak/runaway.'

    const oneSessionWithCwd = [{
      sessionId: 's1', name: 'One', cwd: '/tmp/work', type: 'cli' as const,
      hasTerminal: true, model: null, permissionMode: null, isBusy: false,
      createdAt: 1, conversationId: null, provider: 'claude-sdk', worktree: false,
    }]

    // host_status snapshot whose single repo carries an actionable
    // `investigate` verdict + a note (the reason that would be seeded).
    function snapshotWithInvestigate() {
      return {
        type: 'host_status_snapshot' as const,
        generatedAt: '2026-06-06T11:50:00.000Z',
        root: '/tmp',
        summary: { live: 0, onboarded: 0, abandoned: 0, investigate: 1, recent: 0 },
        repos: [{
          name: 'alpha', path: '/tmp/alpha', branch: 'main',
          verdict: 'investigate' as const, live: false,
          tree: { state: 'dirty' as const, untracked: 2, modified: 0, staged: 0 },
          worktrees: 172, ahead: null, behind: null, openPRs: null, prChecks: null,
          prsUrl: null, attribution: null, onboarding: 'skipped — dirty tree',
          lastTouched: '2026-06-01T00:00:00.000Z', note: REASON,
        }],
      }
    }

    function connectedState() {
      return {
        connectionPhase: 'connected' as const,
        sessions: oneSessionWithCwd,
        activeSessionId: 's1',
        hostStatus: snapshotWithInvestigate(),
        createSession: vi.fn(() => true),
      }
    }

    // Open the Control Room and click the repo's dedicated Investigate row
    // action (#5608 — moved off the verdict badge onto an explicit button) —
    // this stashes the repo's note as the pending seed and opens the
    // create-session modal.
    function stashSeedViaInvestigate() {
      fireEvent.click(screen.getByTestId('sidebar-panel-slot-launcher-control-room'))
      fireEvent.click(screen.getByTestId('cr-action-investigate-alpha'))
      // Modal opened (mock renders its node only when open=true).
      expect(screen.getByTestId('create-session-modal-mock')).toBeInTheDocument()
    }

    // Drive the mocked modal's onCreate seam → App.handleCreateSession, which
    // flips isCreatingSession and lets the create-confirm effect run.
    function confirmCreate() {
      fireEvent.click(screen.getByTestId('create-session-modal-confirm'))
    }

    // After create, make sure we're viewing the session (not the Control Room)
    // so the composer renders. When a seed fires the effect deactivates the CR
    // for us; when it doesn't, we close the CR tab explicitly. Either way we
    // end up on the session view.
    function viewSessionComposer(): HTMLTextAreaElement {
      const crClose = screen.queryByTestId('control-room-tab-close')
      if (crClose) fireEvent.click(crClose)
      return screen.getByRole('textbox', { name: /message input/i }) as HTMLTextAreaElement
    }

    it('positive control: Investigate → create seeds the composer with the reason', () => {
      stateOverrides = connectedState()
      render(<App />)
      stashSeedViaInvestigate()
      confirmCreate()
      // Seed landed in the active session's composer — proves the seed path is
      // observable, so the empty-composer assertions below are meaningful.
      expect(viewSessionComposer().value).toBe(REASON)
    })

    it.each([
      ['header overflow "New Session"', () => {
        fireEvent.click(screen.getByTestId('header-overflow-trigger'))
        fireEvent.click(screen.getByTestId('header-overflow-item-new-session'))
      }],
      ['command palette "New Session"', () => {
        // Cmd+Shift+P opens the palette (VSCode alias); click the command.
        fireEvent.keyDown(window, { key: 'p', metaKey: true, shiftKey: true })
        fireEvent.click(screen.getByRole('option', { name: /new session/i }))
      }],
    ])('does not leak the seed when a plain session is opened via %s', (_label, openPlainSession) => {
      stateOverrides = connectedState()
      render(<App />)
      stashSeedViaInvestigate()   // seed stashed
      openPlainSession()          // plain opener must CLEAR the seed ref
      confirmCreate()             // create — must NOT seed
      expect(viewSessionComposer().value).toBe('')
    })
  })
})

// #6301 — App-layer coverage for the #6285 create-spinner reset. #6285 made
// createSession return a boolean and added two App.tsx branches that the
// store-level tests only cover transitively:
//   (a) the create-confirm-window guard (#6285 effect): if the socket drops
//       mid-create (connectionPhase leaves 'connected' while isCreatingSession),
//       the stranded "Creating…" spinner is cleared and a retryable error is
//       surfaced — otherwise no session_created/session_error reply ever clears
//       it and the spinner wedges forever.
//   (b) the not-sent else-branch in handleCreateSession: clicking Create while
//       the socket is closed (createSession returns false) surfaces the
//       'Connection lost' error WITHOUT latching the spinner.
// The modal mock surfaces `isCreating` / `serverError` as testID nodes so both
// branches are directly assertable.
describe('#6301 create-session spinner reset (#6285 App-layer branches)', () => {
  // Fresh-session create: connected, no sessions yet, no active session. The
  // WelcomeScreen renders its New Session button, and crucially activeSessionId
  // stays null so the create-confirm effect (which closes the modal once the
  // server adopts a session) does NOT fire — leaving the spinner observable.
  const freshConnectedState = (createSession: () => boolean) => ({
    connectionPhase: 'connected' as const,
    sessions: [],
    activeSessionId: null,
    createSession: vi.fn(createSession),
  })

  function openCreateViaWelcome() {
    fireEvent.click(screen.getByTestId('welcome-new-session'))
    expect(screen.getByTestId('create-session-modal-mock')).toBeInTheDocument()
  }

  it('(a) clears the spinner and surfaces a retryable error when the socket drops mid-create', () => {
    stateOverrides = freshConnectedState(() => true)
    const { rerender } = render(<App />)
    openCreateViaWelcome()

    // Confirm — createSession returned true, so the spinner latches and no
    // error shows yet (the server reply is still pending).
    fireEvent.click(screen.getByTestId('create-session-modal-confirm'))
    expect(screen.getByTestId('create-session-modal-creating')).toBeInTheDocument()
    expect(screen.queryByTestId('create-session-modal-error')).not.toBeInTheDocument()

    // Socket drops before the server replies: connectionPhase leaves 'connected'
    // while isCreatingSession is still true. The #6285 effect must clear the
    // spinner and surface the retryable 'Connection lost' error.
    stateOverrides = { ...freshConnectedState(() => true), connectionPhase: 'reconnecting' as const }
    rerender(<App />)

    expect(screen.queryByTestId('create-session-modal-creating')).not.toBeInTheDocument()
    expect(screen.getByTestId('create-session-modal-error').textContent).toMatch(/Connection lost/i)
  })

  it('(b) shows the Connection lost error and does NOT latch the spinner when Create is clicked on a closed socket', () => {
    // createSession returns false (closed-socket no-op). The modal is still
    // open (it was opened while connected), but the confirm hits the not-sent
    // else-branch: surface the error, never latch the spinner.
    stateOverrides = freshConnectedState(() => false)
    render(<App />)
    openCreateViaWelcome()

    fireEvent.click(screen.getByTestId('create-session-modal-confirm'))

    expect(screen.queryByTestId('create-session-modal-creating')).not.toBeInTheDocument()
    expect(screen.getByTestId('create-session-modal-error').textContent).toMatch(/Connection lost/i)
  })
})

// #5424 — clients must not assume a 200k context window when a model's
// contextWindow is unknown. Ollama deliberately reports none (the effective
// window is the local model file's num_ctx), so the header meter must fall
// back to the raw token-count chip instead of rendering a fabricated
// "% of 200k". Claude-backed providers keep the 200k default — it's real.
describe('context meter — occupancy snapshot semantics (#5424 / #6769)', () => {
  function sessionState(activeModel: string, overrides: Record<string, unknown> = {}) {
    return {
      messages: [],
      streamingMessageId: null,
      activeModel,
      permissionMode: null,
      contextUsage: null,
      contextOccupancy: null,
      sessionCost: null,
      isIdle: true,
      activeAgents: [],
      isPlanPending: false,
      ...overrides,
    }
  }

  function session(provider: string) {
    return {
      sessionId: 's1',
      name: 'Test',
      cwd: '/tmp',
      type: 'cli' as const,
      hasTerminal: true,
      model: null,
      permissionMode: null,
      isBusy: false,
      createdAt: Date.now(),
      conversationId: null,
      provider,
    }
  }

  /** byok-style final-round snapshot (no window/threshold on the snapshot). */
  const byokSnapshot = (totalTokens: number) => ({
    totalTokens,
    maxTokens: null,
    autoCompactThreshold: null,
    isAutoCompactEnabled: null,
    source: 'final-round-prompt' as const,
  })

  it('shows the raw occupancy count (no percent) when the window is unknown (#5424)', () => {
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [session('ollama')],
      activeSessionId: 's1',
      availableModels: [
        // Ollama models ship contextWindow: null on the wire; store-core
        // drops it, so the entry simply has no contextWindow here.
        { id: 'llama3:8b', label: 'llama3:8b', fullId: 'llama3:8b' },
      ],
      getActiveSessionState: () =>
        sessionState('llama3:8b', { contextOccupancy: byokSnapshot(12_500) }),
    }
    const { container } = render(<App />)
    // No used/total meter — there is no known total to meter against.
    expect(screen.queryByTestId('status-context-meter')).not.toBeInTheDocument()
    // The chip falls back to the raw occupancy count, no percent.
    const chip = container.querySelector('#header .status-context')
    expect(chip).toBeTruthy()
    expect(chip!.textContent).toContain('12.5k tokens')
  })

  it('meters a byok snapshot against the 200k claude default when the model entry lacks contextWindow', () => {
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [session('claude-byok')],
      activeSessionId: 's1',
      availableModels: [
        // Legacy servers can omit contextWindow on claude models — the
        // 200k default is genuine there.
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6' },
      ],
      getActiveSessionState: () =>
        sessionState('sonnet', { contextOccupancy: byokSnapshot(12_500) }),
    }
    render(<App />)
    const label = screen.getByTestId('status-context-label')
    expect(label.textContent).toContain('12.5k')
    expect(label.textContent).toContain('200.0k')
  })

  // #6769 core: an SDK snapshot meters at the SDK's own numbers — and the
  // BILLING aggregate sitting on the same session state must not leak in.
  it('meters the SDK snapshot against its real autoCompactThreshold, ignoring billing usage (#6769)', () => {
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [session('claude-sdk')],
      activeSessionId: 's1',
      availableModels: [
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6', contextWindow: 200_000 },
      ],
      getActiveSessionState: () =>
        sessionState('sonnet', {
          // The billing aggregate of an 8-round turn — ≈816k of cache_read.
          // Reading THIS as occupancy was the pre-review bug: the meter
          // pinned 100% red on every real multi-tool turn.
          contextUsage: {
            inputTokens: 3_200,
            outputTokens: 7_200,
            cacheRead: 800_000,
            cacheCreation: 6_000,
          },
          // The SDK's occupancy snapshot after the same turn.
          contextOccupancy: {
            totalTokens: 110_000,
            maxTokens: 200_000,
            autoCompactThreshold: 167_000,
            isAutoCompactEnabled: true,
            source: 'context-usage-api' as const,
          },
        }),
    }
    render(<App />)
    const label = screen.getByTestId('status-context-label')
    // Label reads the snapshot (110k / 200k), not the ≈816k aggregate.
    expect(label.textContent).toContain('110.0k')
    expect(label.textContent).toContain('200.0k')
    // Percent = 110k / 167k threshold ≈ 66% — sane, NOT clamped at 100%.
    const bars = screen.getAllByRole('progressbar', { name: /context window usage/i })
    expect(bars.length).toBeGreaterThan(0)
    for (const bar of bars) {
      const now = Number(bar.getAttribute('aria-valuenow'))
      expect(now).toBeGreaterThanOrEqual(65)
      expect(now).toBeLessThanOrEqual(67)
    }
  })

  // #6769: no occupancy snapshot → NO meter and NO chip, even when billing
  // usage exists (claude-cli / codex / gemini / claude-tui — the honest dash).
  it('renders the dash state when a session has billing usage but no occupancy snapshot (#6769)', () => {
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [session('claude-cli')],
      activeSessionId: 's1',
      availableModels: [
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6', contextWindow: 200_000 },
      ],
      getActiveSessionState: () =>
        sessionState('sonnet', {
          contextUsage: {
            inputTokens: 3_200,
            outputTokens: 7_200,
            cacheRead: 800_000,
            cacheCreation: 6_000,
          },
          contextOccupancy: null,
        }),
    }
    const { container } = render(<App />)
    expect(screen.queryByTestId('status-context-meter')).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar', { name: /context window usage/i })).not.toBeInTheDocument()
    // The header chip stays the empty placeholder — no fabricated number.
    const chip = container.querySelector('#header .status-context')
    expect(chip?.textContent ?? '').not.toMatch(/tokens/)
  })

  it('prefers the snapshot maxTokens over the registry window for the meter label (#6769)', () => {
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [session('claude-sdk')],
      activeSessionId: 's1',
      availableModels: [
        // Registry thinks 200k; the SDK snapshot says the window is 1M.
        { id: 'sonnet', label: 'Sonnet 4.6', fullId: 'claude-sonnet-4-6', contextWindow: 200_000 },
      ],
      getActiveSessionState: () =>
        sessionState('sonnet', {
          contextOccupancy: {
            totalTokens: 110_000,
            maxTokens: 1_000_000,
            autoCompactThreshold: 900_000,
            isAutoCompactEnabled: true,
            source: 'context-usage-api' as const,
          },
        }),
    }
    render(<App />)
    const label = screen.getByTestId('status-context-label')
    expect(label.textContent).toContain('110.0k')
    expect(label.textContent).toContain('1M')
  })
})

// #5998 — App-level view-mode effect (App.tsx). The effect:
//   1. forces a user-shell (terminal-only) session's view to 'terminal'
//      when it's sitting on the now-hidden Chat tab;
//   2. forces a non-PTY (chat) provider back to 'chat' if it's stranded on
//      the Output tab — but ONLY once the provider is known (not null), the
//      #5838 null-provider guard, so a persisted Output view for a claude-tui
//      session isn't kicked away during the load/reconnect window;
//   3. opts a PTY-backed session (BOTH claude-tui AND user-shell) into the
//      live terminal mirror when on the Output tab + connected, re-subscribing
//      after a reconnect (connectionPhase flips back to 'connected').
describe('App-level view-mode effect (#5998)', () => {
  function session(provider: string) {
    return {
      sessionId: 's1',
      name: 'Test',
      cwd: '/tmp',
      type: 'cli' as const,
      hasTerminal: true,
      model: null,
      permissionMode: null,
      isBusy: false,
      createdAt: Date.now(),
      conversationId: null,
      provider,
    }
  }

  // AC1 — switching to a user-shell session forces viewMode to 'terminal'
  // (the Chat tab is hidden for a terminal-only provider, so a session sitting
  // on the persisted 'chat' default must snap to the Output terminal).
  it('forces viewMode to terminal for a user-shell session sitting on chat (AC1)', () => {
    const setViewMode = vi.fn()
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [session('user-shell')],
      activeSessionId: 's1',
      viewMode: 'chat',
      serverCapabilities: { userShell: true },
      setViewMode,
    }
    render(<App />)
    expect(setViewMode).toHaveBeenCalledWith('terminal')
  })

  it('does NOT force a user-shell session away from a non-chat tab (System stays put) (AC1)', () => {
    // The effect only redirects from the now-hidden Chat tab — Files/System are
    // useful for a shell's cwd and must not be snapped back (#5997).
    const setViewMode = vi.fn()
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [session('user-shell')],
      activeSessionId: 's1',
      viewMode: 'system',
      serverCapabilities: { userShell: true },
      setViewMode,
    }
    render(<App />)
    expect(setViewMode).not.toHaveBeenCalled()
  })

  // AC2 — a non-PTY (chat) provider stranded on the Output tab is forced back
  // to chat once the provider is known.
  it('forces viewMode to chat when a non-PTY provider is stranded on the Output tab (AC2)', () => {
    const setViewMode = vi.fn()
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [session('claude-sdk')],
      activeSessionId: 's1',
      viewMode: 'terminal',
      setViewMode,
    }
    render(<App />)
    expect(setViewMode).toHaveBeenCalledWith('chat')
  })

  // AC2 — the #5838 null-provider guard: during the initial-load / reconnect
  // window the active session's provider is still null/unknown. Force-switching
  // then would kick the operator out of a persisted Output view for a
  // claude-tui session, so the effect must NOT force away from 'terminal'.
  it('does NOT force-switch from terminal while the provider is still null (#5838 guard) (AC2)', () => {
    const setViewMode = vi.fn()
    stateOverrides = {
      connectionPhase: 'connected',
      // No matching session for activeSessionId → activeSessionProvider is null
      // (the load/reconnect window before session_list resolves the provider).
      sessions: [],
      activeSessionId: 's1',
      viewMode: 'terminal',
      setViewMode,
    }
    render(<App />)
    expect(setViewMode).not.toHaveBeenCalled()
  })

  // AC3 — a PTY provider on the Output tab + connected subscribes to the mirror.
  // BOTH claude-tui and user-shell are PTY-backed (isPtyProvider = isTui ||
  // isUserShell), so both subscribe.
  it('subscribes to the terminal mirror for a claude-tui session on Output + connected (AC3)', () => {
    const subscribeTerminalMirror = vi.fn()
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [session('claude-tui')],
      activeSessionId: 's1',
      viewMode: 'terminal',
      subscribeTerminalMirror,
    }
    render(<App />)
    expect(subscribeTerminalMirror).toHaveBeenCalledWith('s1')
  })

  it('subscribes to the terminal mirror for a user-shell session on Output + connected (AC3)', () => {
    const subscribeTerminalMirror = vi.fn()
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [session('user-shell')],
      activeSessionId: 's1',
      viewMode: 'terminal',
      serverCapabilities: { userShell: true },
      subscribeTerminalMirror,
    }
    render(<App />)
    expect(subscribeTerminalMirror).toHaveBeenCalledWith('s1')
  })

  it('does NOT subscribe for a non-PTY (chat) provider even on the Output tab (AC3)', () => {
    // A claude-sdk session has no PTY mirror; it's force-switched to chat
    // (AC2) and never subscribes.
    const subscribeTerminalMirror = vi.fn()
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [session('claude-sdk')],
      activeSessionId: 's1',
      viewMode: 'terminal',
      subscribeTerminalMirror,
    }
    render(<App />)
    expect(subscribeTerminalMirror).not.toHaveBeenCalled()
  })

  it('does NOT subscribe while disconnected, then subscribes when the socket connects (AC3)', () => {
    // The opt-in is gated on a live socket (connectionPhase === 'connected').
    const subscribeTerminalMirror = vi.fn()
    stateOverrides = {
      connectionPhase: 'connecting',
      sessions: [session('claude-tui')],
      activeSessionId: 's1',
      viewMode: 'terminal',
      subscribeTerminalMirror,
    }
    const { rerender } = render(<App />)
    expect(subscribeTerminalMirror).not.toHaveBeenCalled()

    stateOverrides = { ...stateOverrides, connectionPhase: 'connected' }
    rerender(<App />)
    expect(subscribeTerminalMirror).toHaveBeenCalledWith('s1')
  })

  it('re-subscribes to the terminal mirror after a reconnect (AC3)', () => {
    // A reconnect clears the server-side terminalSessionIds set, so the effect
    // must re-run on the connectionPhase change and re-subscribe — otherwise
    // the mirror silently stops updating (#5838).
    const subscribeTerminalMirror = vi.fn()
    const unsubscribeTerminalMirror = vi.fn()
    stateOverrides = {
      connectionPhase: 'connected',
      sessions: [session('claude-tui')],
      activeSessionId: 's1',
      viewMode: 'terminal',
      subscribeTerminalMirror,
      unsubscribeTerminalMirror,
    }
    const { rerender } = render(<App />)
    expect(subscribeTerminalMirror).toHaveBeenCalledTimes(1)

    // Drop the connection (cleanup runs → unsubscribe), then reconnect.
    stateOverrides = { ...stateOverrides, connectionPhase: 'reconnecting' }
    rerender(<App />)
    expect(unsubscribeTerminalMirror).toHaveBeenCalledWith('s1')

    stateOverrides = { ...stateOverrides, connectionPhase: 'connected' }
    rerender(<App />)
    expect(subscribeTerminalMirror).toHaveBeenCalledTimes(2)
    expect(subscribeTerminalMirror).toHaveBeenLastCalledWith('s1')
  })
})
