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
    sendInterrupt: vi.fn(),
    sendPermissionResponse: vi.fn(),
    sendUserQuestionResponse: vi.fn(),
    markPromptAnswered: vi.fn(),
    switchSession: vi.fn(),
    destroySession: vi.fn(),
    renameSession: vi.fn(),
    createSession: vi.fn(),
    setViewMode: vi.fn(),
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    dismissServerError: vi.fn(),
    // #4629 — surfaced when the clipboard write fails so the user sees a
    // visible error instead of a silent no-op. Backed by the top-level
    // `addServerErrorMock` so tests can assert on the call args directly.
    addServerError: addServerErrorMock,
    dismissSessionNotification: vi.fn(),
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
    serverRegistry: [],
    activeServerId: null,
    addServer: vi.fn(),
    removeServer: vi.fn(),
    switchServer: vi.fn(),
    connectToServer: vi.fn(),
    updateServer: vi.fn(),
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
  return { useConnectionStore }
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

    it('calls setModel with model id when a specific model is selected', () => {
      const setModelFn = vi.fn()
      stateOverrides = { ...modelsState, setModel: setModelFn }
      render(<App />)
      const select = screen.getByTestId('chat-settings-trigger')
      fireEvent.change(select, { target: { value: 'claude-opus' } })
      expect(setModelFn).toHaveBeenCalledWith('claude-opus')
    })

    it('calls setModel with first model id when Default is selected', () => {
      const setModelFn = vi.fn()
      stateOverrides = {
        ...modelsState,
        setModel: setModelFn,
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
      const select = screen.getByTestId('chat-settings-trigger')
      fireEvent.change(select, { target: { value: '' } })
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

      // Confirm dialog returns true so handleCloseSession proceeds.
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
      try {
        // Click the close (×) button on s1's tab. SessionBar hides the close
        // button when only one session remains, so we need ≥2 sessions for
        // this to render at all.
        const s1Tab = screen.getByTestId('session-tab-s1')
        const closeBtn = within(s1Tab).getByTestId('tab-close')
        fireEvent.click(closeBtn)
      } finally {
        confirmSpy.mockRestore()
      }
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

    it('does NOT flash the check mark when the clipboard helper returns false', async () => {
      clipboardWriteTextMock.mockResolvedValue(false)
      stateOverrides = connectedWithMessages
      render(<App />)

      const btn = screen.getByTestId('btn-copy-transcript')
      // Title before click reflects the not-copied state (no "Copied!").
      expect(btn.getAttribute('title')).not.toContain('Copied!')

      fireEvent.click(btn)
      await waitFor(() => {
        expect(clipboardWriteTextMock).toHaveBeenCalledTimes(1)
      })

      // Indicator must NOT flip — the OS clipboard was never written.
      expect(btn.textContent).not.toContain('✓')
      expect(btn.getAttribute('title')).not.toContain('Copied!')
    })

    it('DOES flash the check mark when the clipboard helper returns true', async () => {
      clipboardWriteTextMock.mockResolvedValue(true)
      stateOverrides = connectedWithMessages
      render(<App />)

      const btn = screen.getByTestId('btn-copy-transcript')
      fireEvent.click(btn)

      await waitFor(() => {
        expect(btn.textContent).toContain('✓')
      })
      expect(clipboardWriteTextMock).toHaveBeenCalledTimes(1)
      expect(btn.getAttribute('title')).toContain('Copied!')
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

      const btn = screen.getByTestId('btn-copy-transcript')
      fireEvent.click(btn)

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
      // axis is caught).
      expect(btn.textContent).not.toContain('✓')
    })

    it('does NOT surface a server-error toast on a successful copy (#4629)', async () => {
      clipboardWriteTextMock.mockResolvedValue(true)
      stateOverrides = connectedWithMessages
      render(<App />)

      const btn = screen.getByTestId('btn-copy-transcript')
      fireEvent.click(btn)

      await waitFor(() => {
        expect(btn.textContent).toContain('✓')
      })
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

    it('Skills toggle exposes both title and aria-label', () => {
      stateOverrides = connectedWithSession
      render(<App />)
      const btn = screen.getByTestId('btn-toggle-skills-panel')
      expect(btn.getAttribute('title')).toBeTruthy()
      expect(btn.getAttribute('aria-label')).toBeTruthy()
    })

    it('Settings gear button exposes both title and aria-label', () => {
      stateOverrides = connectedWithSession
      render(<App />)
      const btn = screen.getByLabelText('Settings')
      expect(btn.getAttribute('title')).toMatch(/Settings/)
      expect(btn.getAttribute('aria-label')).toBe('Settings')
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
})
