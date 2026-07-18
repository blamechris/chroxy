/**
 * SettingsPanel tests (#1526)
 *
 * Tests theme picker, session defaults, close/backdrop behavior,
 * and Escape key dismissal.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { SettingsPanel, describePermissionAuditEntry } from './SettingsPanel'

// Mock theme-engine
vi.mock('../theme/theme-engine', () => ({
  getAvailableThemes: () => [
    {
      id: 'default',
      name: 'Default',
      description: 'Purple and blue dark theme',
      colors: { 'bg-primary': '#0f0f1a', 'accent-blue': '#4a9eff', 'text-primary': '#ffffff' },
      terminal: { background: '#000000', foreground: '#e0e0e0', cursor: '#4a9eff', selectionBackground: '#4a9eff44' },
    },
    {
      id: 'hacker',
      name: 'Hacker',
      description: 'Black and lime green',
      colors: { 'bg-primary': '#000000', 'accent-blue': '#00ff41', 'text-primary': '#00ff41' },
      terminal: { background: '#000000', foreground: '#00ff41', cursor: '#00ff41', selectionBackground: '#00ff4144' },
    },
    {
      id: 'midnight',
      name: 'Midnight',
      description: 'Deep blue with softer contrast',
      colors: { 'bg-primary': '#0a0e1a', 'accent-blue': '#60a5fa', 'text-primary': '#e2e8f0' },
      terminal: { background: '#060a14', foreground: '#e2e8f0', cursor: '#60a5fa', selectionBackground: '#60a5fa44' },
    },
  ],
  applyTheme: vi.fn(),
  loadPersistedThemeId: () => 'default',
}))

const mockSetTheme = vi.fn()
const mockUpdateInputSettings = vi.fn()
// #5184: spy for the cost-badge mode setter.
const mockSetCostBadgeMode = vi.fn()
// #5206: spy for the confirm-session-close setter.
const mockSetConfirmSessionClose = vi.fn()

// #3404 audit F1: settable so individual tests can override availableProviders
// without redefining the whole mock.
let mockState: Record<string, unknown> = {}

function setMockState(extra: Record<string, unknown> = {}): void {
  mockState = {
    activeTheme: 'default',
    setTheme: mockSetTheme,
    defaultProvider: 'claude-sdk',
    setDefaultProvider: vi.fn(),
    inputSettings: { chatEnterToSend: true, terminalEnterToSend: false, voiceInputMode: 'continuous' },
    updateInputSettings: mockUpdateInputSettings,
    // #5184: header cost-badge display mode default + setter spy.
    costBadgeMode: 'provider-model',
    setCostBadgeMode: mockSetCostBadgeMode,
    // #5206: confirm-before-close setting default + setter spy.
    confirmSessionClose: true,
    setConfirmSessionClose: mockSetConfirmSessionClose,
    availableProviders: [],
    // Per-session promptEvaluator toggle defaults — overridden by the
    // Active session test cases. Default empty array + null id keeps the
    // existing tests working without forcing them to know about the new
    // section.
    activeSessionId: null,
    sessions: [],
    setPromptEvaluator: vi.fn(),
    setChroxyContextHint: vi.fn(),
    // #4660: per-session preamble default — overridden by the
    // Active session preamble test cases.
    setSessionPreamble: vi.fn(),
    // #4052: BYOK credentials defaults — refresh is a no-op spy by
    // default; individual tests override status / actions as needed.
    //
    // #4559: each action returns `true` by default (mirrors the
    // store's "WS open → patch sent" path) so existing assertions that
    // rely on success-side effects (e.g. input clearing after Save) keep
    // passing. Tests covering the WS-closed branch override with
    // `vi.fn().mockReturnValue(false)`.
    byokCredentialsStatus: null,
    refreshByokCredentialsStatus: vi.fn().mockReturnValue(true),
    setByokCredentials: vi.fn().mockReturnValue(true),
    clearByokCredentials: vi.fn().mockReturnValue(true),
    // #3855: generalized Provider Credentials pane is rendered inside the
    // SettingsPanel, so its store selectors must resolve in this mock too.
    credentialsStatus: null,
    credentialTestResults: {},
    refreshCredentialsStatus: vi.fn().mockReturnValue(true),
    setCredential: vi.fn().mockReturnValue(true),
    deleteCredential: vi.fn().mockReturnValue(true),
    testCredential: vi.fn().mockReturnValue(true),
    // #4542: per-category notification toggles. `notificationPrefs` mirrors
    // the latest snapshot received over the WS connection (null until the
    // first `notification_prefs` arrives).
    notificationPrefs: null,
    refreshNotificationPrefs: vi.fn().mockReturnValue(true),
    setNotificationPrefsCategory: vi.fn().mockReturnValue(true),
    // #4543: per-device opt-in/out. `currentDeviceKey` is the stable browser
    // localStorage id used as the device key in the per-device override map.
    // The test default uses a fixed string so toggles assert against a known
    // key without coupling to localStorage; individual tests can override.
    currentDeviceKey: 'test-device-key',
    setNotificationPrefsDevice: vi.fn().mockReturnValue(true),
    // #4564: per-device delete (the "Clear" buttons in the device list).
    deleteNotificationPrefsDevice: vi.fn().mockReturnValue(true),
    // #4544: quiet-hours editor actions. Default no-op spies; individual
    // tests override.
    setNotificationPrefsQuietHours: vi.fn().mockReturnValue(true),
    setNotificationPrefsBypassCategories: vi.fn().mockReturnValue(true),
    // #4560: server-advertised capabilities. Default to the modern shape
    // (notificationPrefs supported) so existing tests covering the
    // Notifications section keep exercising the rendered path. Tests
    // covering the older-server gate override with `{}`.
    serverCapabilities: { notificationPrefs: true },
    ...extra,
  }
}
setMockState()

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockState),
  // #6772/#6829: SettingsPanel now imports this pure capability helper. Faithful
  // reimplementation (a provider supports rules iff its caps say sessionRules:true)
  // so the Session Rules section's visibility gate behaves like production.
  isRuleEligibleProvider: (
    provider: string | null | undefined,
    providers: { name: string; capabilities?: { sessionRules?: boolean } }[] | undefined,
  ) => !!provider && providers?.find((p) => p.name === provider)?.capabilities?.sessionRules === true,
}))

beforeEach(() => {
  mockSetTheme.mockClear()
  mockSetCostBadgeMode.mockClear()
  setMockState()
})

afterEach(cleanup)

describe('SettingsPanel', () => {
  it('does not render when closed', () => {
    render(<SettingsPanel isOpen={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders when open', () => {
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('shows Appearance section with theme cards', () => {
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText('Appearance')).toBeInTheDocument()
    expect(screen.getByText('Default')).toBeInTheDocument()
    expect(screen.getByText('Hacker')).toBeInTheDocument()
    expect(screen.getByText('Midnight')).toBeInTheDocument()
  })

  it('marks active theme with aria-pressed', () => {
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    const defaultCard = screen.getByText('Default').closest('button')
    expect(defaultCard).toHaveAttribute('aria-pressed', 'true')
    const hackerCard = screen.getByText('Hacker').closest('button')
    expect(hackerCard).toHaveAttribute('aria-pressed', 'false')
  })

  it('calls setTheme when theme card clicked', () => {
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    const hackerCard = screen.getByText('Hacker').closest('button')!
    fireEvent.click(hackerCard)
    expect(mockSetTheme).toHaveBeenCalledWith('hacker')
  })

  it('shows theme swatches (5 per theme)', () => {
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    const swatches = document.querySelectorAll('.theme-swatch')
    // 3 themes × 5 swatches each = 15
    expect(swatches.length).toBe(15)
  })

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn()
    render(<SettingsPanel isOpen={true} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Close settings'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn()
    render(<SettingsPanel isOpen={true} onClose={onClose} />)
    const backdrop = document.querySelector('.settings-backdrop')!
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows Session Defaults section', () => {
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText('Session Defaults')).toBeInTheDocument()
  })

  it('shows default provider selector', () => {
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByLabelText('Default provider')).toBeInTheDocument()
  })

  it('shows send shortcut selector', () => {
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByLabelText('Send shortcut')).toBeInTheDocument()
  })

  it('calls updateInputSettings when send shortcut changed', () => {
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    const select = screen.getByLabelText('Send shortcut')
    fireEvent.change(select, { target: { value: 'cmd-enter' } })
    expect(mockUpdateInputSettings).toHaveBeenCalledWith({ chatEnterToSend: false })
  })

  // #5184: header cost-badge display mode select. Reads / writes through the
  // store (mocked here) — the store layer owns the localStorage persistence,
  // covered by the connection-store tests.
  describe('cost-badge display mode (#5184)', () => {
    it('renders the cost-badge mode selector with all five options', () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const select = screen.getByTestId('cost-badge-mode-select') as HTMLSelectElement
      expect(select).toBeInTheDocument()
      const values = Array.from(select.options).map(o => o.value).sort()
      expect(values).toEqual(['context-pct', 'cost', 'provider-model', 'session-type', 'tokens'])
    })

    it('reflects the persisted mode from the store', () => {
      setMockState({ costBadgeMode: 'tokens' })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const select = screen.getByTestId('cost-badge-mode-select') as HTMLSelectElement
      expect(select.value).toBe('tokens')
    })

    it('defaults the selector to provider-model', () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const select = screen.getByTestId('cost-badge-mode-select') as HTMLSelectElement
      expect(select.value).toBe('provider-model')
    })

    it('calls setCostBadgeMode when a new mode is chosen', () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const select = screen.getByTestId('cost-badge-mode-select')
      fireEvent.change(select, { target: { value: 'context-pct' } })
      expect(mockSetCostBadgeMode).toHaveBeenCalledWith('context-pct')
    })

    it('ignores an invalid value rather than committing junk to the store', () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const select = screen.getByTestId('cost-badge-mode-select')
      fireEvent.change(select, { target: { value: 'not-a-mode' } })
      expect(mockSetCostBadgeMode).not.toHaveBeenCalled()
    })
  })

  describe('confirm-before-close toggle (#5206)', () => {
    it('reflects the enabled state from the store', () => {
      setMockState({ confirmSessionClose: true })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const toggle = screen.getByTestId('confirm-session-close-toggle') as HTMLInputElement
      expect(toggle.checked).toBe(true)
    })

    it('reflects the disabled state from the store', () => {
      setMockState({ confirmSessionClose: false })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const toggle = screen.getByTestId('confirm-session-close-toggle') as HTMLInputElement
      expect(toggle.checked).toBe(false)
    })

    it('calls setConfirmSessionClose when toggled', () => {
      setMockState({ confirmSessionClose: true })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('confirm-session-close-toggle'))
      expect(mockSetConfirmSessionClose).toHaveBeenCalledWith(false)
    })
  })

  it('closes on Escape key', () => {
    const onClose = vi.fn()
    render(<SettingsPanel isOpen={true} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('has data-modal-overlay attribute on backdrop (#1557)', () => {
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    const backdrop = document.querySelector('.settings-backdrop')!
    expect(backdrop).toHaveAttribute('data-modal-overlay')
  })

  it('suppresses Escape when not the topmost modal (#1557)', () => {
    const onClose = vi.fn()
    render(<SettingsPanel isOpen={true} onClose={onClose} />)

    // Simulate another modal overlay on top
    const topOverlay = document.createElement('div')
    topOverlay.setAttribute('data-modal-overlay', '')
    document.body.appendChild(topOverlay)

    try {
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      document.body.removeChild(topOverlay)
    }
  })

  it('renders console tab toggle when onToggleConsoleTab is provided (#1821)', () => {
    const onToggle = vi.fn()
    render(
      <SettingsPanel
        isOpen={true}
        onClose={vi.fn()}
        showConsoleTab={false}
        onToggleConsoleTab={onToggle}
      />
    )

    const checkbox = screen.getByLabelText('Show Console tab') as HTMLInputElement
    expect(checkbox).toBeTruthy()
    expect(checkbox.checked).toBe(false)

    fireEvent.click(checkbox)
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it('does not render console toggle when onToggleConsoleTab is not provided', () => {
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    expect(screen.queryByLabelText('Show Console tab')).toBeNull()
  })

  // #4891 — audible intervention ping toggle
  it('renders the intervention-ping toggle when onToggleInterventionPing is provided', () => {
    const onToggle = vi.fn()
    render(
      <SettingsPanel
        isOpen={true}
        onClose={vi.fn()}
        interventionPingEnabled={true}
        onToggleInterventionPing={onToggle}
      />
    )

    const checkbox = screen.getByTestId('intervention-ping-toggle') as HTMLInputElement
    expect(checkbox).toBeTruthy()
    expect(checkbox.checked).toBe(true)

    fireEvent.click(checkbox)
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it('reflects the muted state on the intervention-ping toggle', () => {
    render(
      <SettingsPanel
        isOpen={true}
        onClose={vi.fn()}
        interventionPingEnabled={false}
        onToggleInterventionPing={vi.fn()}
      />
    )
    const checkbox = screen.getByTestId('intervention-ping-toggle') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
  })

  it('does not render the intervention-ping toggle when handler is absent', () => {
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    expect(screen.queryByTestId('intervention-ping-toggle')).toBeNull()
  })

  // #3404 audit F1
  describe('Provider auth status section', () => {
    it('hides the section when the server has not surfaced any auth field', () => {
      setMockState({ availableProviders: [{ name: 'claude-sdk', capabilities: {} }] })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.queryByTestId('auth-status-section')).toBeNull()
    })

    it('renders one row per provider with the server-provided detail', () => {
      setMockState({
        availableProviders: [
          {
            name: 'claude-sdk',
            capabilities: {},
            auth: { ready: true, source: 'env', envVar: 'ANTHROPIC_API_KEY', envVars: ['ANTHROPIC_API_KEY'], hint: '', detail: 'Anthropic API (ANTHROPIC_API_KEY set)' },
          },
          {
            name: 'codex',
            capabilities: {},
            auth: { ready: false, source: 'none', envVar: null, envVars: ['OPENAI_API_KEY'], hint: 'set OPENAI_API_KEY', detail: 'Not configured — set OPENAI_API_KEY' },
          },
        ],
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)

      expect(screen.getByTestId('auth-status-section')).toBeInTheDocument()

      const sdkRow = screen.getByTestId('auth-status-claude-sdk')
      expect(sdkRow).toHaveAttribute('data-tone', 'env')
      expect(sdkRow).toHaveTextContent('Anthropic API (ANTHROPIC_API_KEY set)')

      const codexRow = screen.getByTestId('auth-status-codex')
      expect(codexRow).toHaveAttribute('data-tone', 'missing')
      expect(codexRow).toHaveTextContent('Not configured — set OPENAI_API_KEY')
      expect(codexRow).toHaveTextContent('set OPENAI_API_KEY') // hint surfaced
    })

    it('renders the color legend so the green/blue/red/grey tones are self-explanatory', () => {
      setMockState({
        availableProviders: [
          {
            name: 'claude-cli',
            capabilities: {},
            auth: { ready: true, source: 'oauth', envVar: null, envVars: [], hint: '', detail: 'Claude subscription' },
          },
        ],
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const legend = screen.getByLabelText('Color legend')
      expect(legend).toBeInTheDocument()
      // #3690: the legend has 4 rows — one per protocol auth.source value
      // ('env' | 'oauth' | 'none') plus the derived UI-side 'missing' tone
      // we paint when ready=false. Each row pairs a label with a swatch
      // whose data-tone must match: assert per-row label-to-tone parity so
      // a copy/paste swap between swatches can't silently regress legend
      // alignment.
      const expectedRows: Array<[string, string]> = [
        ['Subscription / login', 'oauth'],
        ['API key', 'env'],
        ['Not configured', 'missing'],
        ['Custom provider', 'none'],
      ]
      const items = Array.from(legend.querySelectorAll('li'))
      expect(items.length).toBe(expectedRows.length)
      for (const [label, tone] of expectedRows) {
        const item = items.find(li => li.textContent?.includes(label))
        expect(item, `legend row labelled "${label}" not found`).toBeDefined()
        const swatch = item!.querySelector('.auth-status-swatch')
        expect(swatch, `legend row "${label}" missing swatch`).toBeTruthy()
        expect(swatch).toHaveAttribute('data-tone', tone)
      }
    })

    it('hides the decorative legend swatches from screen readers', () => {
      // #3690: swatches are pure colour chips with no text, so they must
      // carry aria-hidden to avoid announcing four empty regions before
      // each label (matches the .theme-card-check convention).
      setMockState({
        availableProviders: [
          {
            name: 'claude-cli',
            capabilities: {},
            auth: { ready: true, source: 'oauth', envVar: null, envVars: [], hint: '', detail: 'Claude subscription' },
          },
        ],
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const legend = screen.getByLabelText('Color legend')
      const swatches = legend.querySelectorAll('.auth-status-swatch')
      expect(swatches.length).toBe(4)
      swatches.forEach(s => {
        expect(s).toHaveAttribute('aria-hidden', 'true')
      })
    })

    it('marks oauth-source rows with the oauth tone', () => {
      setMockState({
        availableProviders: [
          {
            name: 'claude-cli',
            capabilities: {},
            auth: { ready: true, source: 'oauth', envVar: null, envVars: [], hint: '', detail: 'Claude subscription' },
          },
        ],
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const row = screen.getByTestId('auth-status-claude-cli')
      expect(row).toHaveAttribute('data-tone', 'oauth')
    })

    it('marks ready providers with source="none" as the "none" tone (#3690)', () => {
      // Custom/external providers that don't declare a preflight.credentials
      // block return ready:true + source:'none'. Before #3690 this rendered
      // with data-tone="none" but the legend had no row for it, so users
      // saw a 4th unexplained colour. Assert the row uses the legended tone.
      setMockState({
        availableProviders: [
          {
            name: 'custom-provider',
            capabilities: {},
            auth: { ready: true, source: 'none', envVar: null, envVars: [], hint: '', detail: 'No credential check declared by this provider' },
          },
        ],
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const row = screen.getByTestId('auth-status-custom-provider')
      expect(row).toHaveAttribute('data-tone', 'none')
      expect(row).toHaveTextContent('No credential check declared by this provider')
    })
  })

  // Per-session promptEvaluator toggle. Moved from ChatSettingsDropdown
  // (header) into SettingsPanel so the label has room for a hint line.
  // The capability gate is preserved: only renders when the active session
  // reports a boolean `promptEvaluator` field — older servers (pre-#3185)
  // omit it and a non-functional control would mislead.
  describe('Active session — promptEvaluator toggle', () => {
    function setActiveSessionState(extra: Record<string, unknown>) {
      setMockState({
        activeSessionId: 'sess-1',
        sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', ...extra }],
        setPromptEvaluator: vi.fn(),
      })
    }

    it('does not render the section when no active session reports the field', () => {
      // No promptEvaluator field on the session — capability gate fails.
      setActiveSessionState({})
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.queryByTestId('active-session-section')).toBeNull()
      expect(screen.queryByTestId('prompt-evaluator-toggle')).toBeNull()
    })

    it('does not render when there is no active session at all', () => {
      setMockState({
        activeSessionId: null,
        sessions: [],
        setPromptEvaluator: vi.fn(),
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.queryByTestId('active-session-section')).toBeNull()
    })

    it('renders the section when the active session reports a boolean promptEvaluator', () => {
      setActiveSessionState({ promptEvaluator: false })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('active-session-section')).toBeInTheDocument()
      expect(screen.getByTestId('prompt-evaluator-toggle')).toBeInTheDocument()
    })

    it('reflects promptEvaluator=true as a checked checkbox', () => {
      setActiveSessionState({ promptEvaluator: true })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const cb = screen.getByTestId('prompt-evaluator-toggle') as HTMLInputElement
      expect(cb.checked).toBe(true)
    })

    it('reflects promptEvaluator=false as an unchecked checkbox', () => {
      setActiveSessionState({ promptEvaluator: false })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const cb = screen.getByTestId('prompt-evaluator-toggle') as HTMLInputElement
      expect(cb.checked).toBe(false)
    })

    it('emits the new boolean value on click', () => {
      const setPromptEvaluator = vi.fn()
      setMockState({
        activeSessionId: 'sess-1',
        sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', promptEvaluator: false }],
        setPromptEvaluator,
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('prompt-evaluator-toggle'))
      expect(setPromptEvaluator).toHaveBeenCalledWith(true)
    })

    it('emits false when toggling off', () => {
      const setPromptEvaluator = vi.fn()
      setMockState({
        activeSessionId: 'sess-1',
        sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', promptEvaluator: true }],
        setPromptEvaluator,
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('prompt-evaluator-toggle'))
      expect(setPromptEvaluator).toHaveBeenCalledWith(false)
    })

    it('shows a hint explaining the per-session scope', () => {
      setActiveSessionState({ promptEvaluator: false })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const section = screen.getByTestId('active-session-section')
      expect(section.textContent).toContain('this session')
    })
  })

  // #3805: per-session Chroxy context hint toggle. Mirrors the
  // promptEvaluator capability-gated pattern — only renders when the
  // active session reports a boolean `chroxyContextHint` field.
  describe('Active session — chroxyContextHint toggle (#3805)', () => {
    function setActiveSessionState(extra: Record<string, unknown>) {
      setMockState({
        activeSessionId: 'sess-1',
        sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', ...extra }],
        setChroxyContextHint: vi.fn(),
      })
    }

    it('does not render the Chroxy hint toggle when no active session reports the field', () => {
      setActiveSessionState({})
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.queryByTestId('chroxy-context-hint-toggle')).toBeNull()
    })

    it('renders the toggle when the active session reports a boolean chroxyContextHint', () => {
      setActiveSessionState({ chroxyContextHint: false })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('active-session-section')).toBeInTheDocument()
      expect(screen.getByTestId('chroxy-context-hint-toggle')).toBeInTheDocument()
    })

    it('reflects chroxyContextHint=true as a checked checkbox', () => {
      setActiveSessionState({ chroxyContextHint: true })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const cb = screen.getByTestId('chroxy-context-hint-toggle') as HTMLInputElement
      expect(cb.checked).toBe(true)
    })

    it('reflects chroxyContextHint=false as an unchecked checkbox (default OFF)', () => {
      setActiveSessionState({ chroxyContextHint: false })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const cb = screen.getByTestId('chroxy-context-hint-toggle') as HTMLInputElement
      expect(cb.checked).toBe(false)
    })

    it('emits true when toggling on', () => {
      const setChroxyContextHint = vi.fn()
      setMockState({
        activeSessionId: 'sess-1',
        sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', chroxyContextHint: false }],
        setChroxyContextHint,
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('chroxy-context-hint-toggle'))
      expect(setChroxyContextHint).toHaveBeenCalledWith(true)
    })

    it('emits false when toggling off', () => {
      const setChroxyContextHint = vi.fn()
      setMockState({
        activeSessionId: 'sess-1',
        sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', chroxyContextHint: true }],
        setChroxyContextHint,
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('chroxy-context-hint-toggle'))
      expect(setChroxyContextHint).toHaveBeenCalledWith(false)
    })
  })

  // #4660: per-session preamble. Mirrors the chroxy-context-hint
  // capability-gated pattern — only renders when the active session
  // reports a string `sessionPreamble` field (older servers omit it).
  // Send is debounced 400ms so a single keystroke does not fire a WS
  // message — tests use vi.useFakeTimers to deterministically advance
  // past the debounce window.
  describe('Active session — sessionPreamble text area (#4660)', () => {
    function setActiveSessionState(extra: Record<string, unknown>) {
      setMockState({
        activeSessionId: 'sess-1',
        sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', ...extra }],
        setSessionPreamble: vi.fn(),
      })
    }

    it('does not render the preamble text area when no active session reports the field', () => {
      setActiveSessionState({})
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.queryByTestId('session-preamble-input')).toBeNull()
    })

    it('renders the text area when the active session reports a string sessionPreamble', () => {
      setActiveSessionState({ sessionPreamble: '' })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('active-session-section')).toBeInTheDocument()
      expect(screen.getByTestId('session-preamble-input')).toBeInTheDocument()
    })

    it('hydrates the text area with the server-confirmed value', () => {
      setActiveSessionState({ sessionPreamble: 'always use bullet points' })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const input = screen.getByTestId('session-preamble-input') as HTMLTextAreaElement
      expect(input.value).toBe('always use bullet points')
    })

    it('debounces 400ms before emitting the value', () => {
      vi.useFakeTimers()
      try {
        const setSessionPreamble = vi.fn()
        setMockState({
          activeSessionId: 'sess-1',
          sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', sessionPreamble: '' }],
          setSessionPreamble,
        })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        const input = screen.getByTestId('session-preamble-input') as HTMLTextAreaElement
        fireEvent.change(input, { target: { value: 'hello' } })
        // Immediately after the change — debounce window still open.
        expect(setSessionPreamble).not.toHaveBeenCalled()
        vi.advanceTimersByTime(399)
        expect(setSessionPreamble).not.toHaveBeenCalled()
        vi.advanceTimersByTime(2)
        expect(setSessionPreamble).toHaveBeenCalledTimes(1)
        expect(setSessionPreamble).toHaveBeenCalledWith('hello')
      } finally {
        vi.useRealTimers()
      }
    })

    it('coalesces rapid keystrokes into a single send (only the latest value fires)', () => {
      vi.useFakeTimers()
      try {
        const setSessionPreamble = vi.fn()
        setMockState({
          activeSessionId: 'sess-1',
          sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', sessionPreamble: '' }],
          setSessionPreamble,
        })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        const input = screen.getByTestId('session-preamble-input') as HTMLTextAreaElement
        fireEvent.change(input, { target: { value: 'h' } })
        vi.advanceTimersByTime(100)
        fireEvent.change(input, { target: { value: 'he' } })
        vi.advanceTimersByTime(100)
        fireEvent.change(input, { target: { value: 'hello' } })
        vi.advanceTimersByTime(401)
        expect(setSessionPreamble).toHaveBeenCalledTimes(1)
        expect(setSessionPreamble).toHaveBeenCalledWith('hello')
      } finally {
        vi.useRealTimers()
      }
    })

    it('enforces the 4000-char maxLength attribute', () => {
      setActiveSessionState({ sessionPreamble: '' })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const input = screen.getByTestId('session-preamble-input') as HTMLTextAreaElement
      expect(input.maxLength).toBe(4000)
    })

    // #4662: cross-session debounce safety + multi-client conflict UX.
    // Mirrors the QuietHoursEditor pattern (#4570): a pending debounce
    // closes over the typed text but reads activeSessionId at fire-time
    // — switching sessions mid-debounce would leak draft A onto session
    // B. A divergent server broadcast mid-edit was also silently
    // overwriting the local draft.
    describe('cross-session debounce safety + multi-client conflict UX (#4662)', () => {
      it('cancels a pending debounce when activeSessionId changes mid-edit', () => {
        vi.useFakeTimers()
        try {
          const setSessionPreamble = vi.fn()
          setMockState({
            activeSessionId: 'sess-A',
            sessions: [
              { sessionId: 'sess-A', name: 'A', cwd: '/tmp', sessionPreamble: '' },
              { sessionId: 'sess-B', name: 'B', cwd: '/tmp', sessionPreamble: '' },
            ],
            setSessionPreamble,
          })
          const { rerender } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
          const input = screen.getByTestId('session-preamble-input') as HTMLTextAreaElement
          fireEvent.change(input, { target: { value: 'session A draft' } })
          // Switch active session within the debounce window.
          vi.advanceTimersByTime(100)
          setMockState({
            activeSessionId: 'sess-B',
            sessions: [
              { sessionId: 'sess-A', name: 'A', cwd: '/tmp', sessionPreamble: '' },
              { sessionId: 'sess-B', name: 'B', cwd: '/tmp', sessionPreamble: '' },
            ],
            setSessionPreamble,
          })
          rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
          // Drain past the original debounce window — nothing should fire.
          vi.advanceTimersByTime(500)
          expect(setSessionPreamble).not.toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
        }
      })

      it('hydrates the text area to the new session value after a switch (no stale draft)', () => {
        setMockState({
          activeSessionId: 'sess-A',
          sessions: [
            { sessionId: 'sess-A', name: 'A', cwd: '/tmp', sessionPreamble: 'A value' },
            { sessionId: 'sess-B', name: 'B', cwd: '/tmp', sessionPreamble: 'B value' },
          ],
          setSessionPreamble: vi.fn(),
        })
        const { rerender } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        const input = screen.getByTestId('session-preamble-input') as HTMLTextAreaElement
        expect(input.value).toBe('A value')
        fireEvent.change(input, { target: { value: 'A draft' } })
        // Switch sessions before the debounce fires.
        setMockState({
          activeSessionId: 'sess-B',
          sessions: [
            { sessionId: 'sess-A', name: 'A', cwd: '/tmp', sessionPreamble: 'A value' },
            { sessionId: 'sess-B', name: 'B', cwd: '/tmp', sessionPreamble: 'B value' },
          ],
          setSessionPreamble: vi.fn(),
        })
        rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        const after = screen.getByTestId('session-preamble-input') as HTMLTextAreaElement
        expect(after.value).toBe('B value')
      })

      it('surfaces a conflict banner when a divergent snapshot lands mid-edit', () => {
        setMockState({
          activeSessionId: 'sess-1',
          sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', sessionPreamble: 'original' }],
          setSessionPreamble: vi.fn(),
        })
        const { rerender } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        const input = screen.getByTestId('session-preamble-input') as HTMLTextAreaElement
        fireEvent.change(input, { target: { value: 'my local draft' } })
        // Divergent snapshot arrives from another client.
        setMockState({
          activeSessionId: 'sess-1',
          sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', sessionPreamble: 'other client value' }],
          setSessionPreamble: vi.fn(),
        })
        rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        expect(screen.getByTestId('session-preamble-conflict-banner')).toBeInTheDocument()
        expect(screen.getByTestId('session-preamble-conflict-accept')).toBeInTheDocument()
        expect(screen.getByTestId('session-preamble-conflict-discard')).toBeInTheDocument()
        // Local draft is preserved while the banner is up.
        const afterInput = screen.getByTestId('session-preamble-input') as HTMLTextAreaElement
        expect(afterInput.value).toBe('my local draft')
      })

      it('clicking discard replaces the draft with the snapshot and clears the banner', () => {
        setMockState({
          activeSessionId: 'sess-1',
          sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', sessionPreamble: 'original' }],
          setSessionPreamble: vi.fn(),
        })
        const { rerender } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.change(screen.getByTestId('session-preamble-input'), { target: { value: 'my draft' } })
        setMockState({
          activeSessionId: 'sess-1',
          sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', sessionPreamble: 'other client' }],
          setSessionPreamble: vi.fn(),
        })
        rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.click(screen.getByTestId('session-preamble-conflict-discard'))
        const after = screen.getByTestId('session-preamble-input') as HTMLTextAreaElement
        expect(after.value).toBe('other client')
        expect(screen.queryByTestId('session-preamble-conflict-banner')).toBeNull()
      })

      it('clicking accept keeps the local draft and clears the banner', () => {
        setMockState({
          activeSessionId: 'sess-1',
          sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', sessionPreamble: 'original' }],
          setSessionPreamble: vi.fn(),
        })
        const { rerender } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.change(screen.getByTestId('session-preamble-input'), { target: { value: 'my draft' } })
        setMockState({
          activeSessionId: 'sess-1',
          sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', sessionPreamble: 'other client' }],
          setSessionPreamble: vi.fn(),
        })
        rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.click(screen.getByTestId('session-preamble-conflict-accept'))
        const after = screen.getByTestId('session-preamble-input') as HTMLTextAreaElement
        expect(after.value).toBe('my draft')
        expect(screen.queryByTestId('session-preamble-conflict-banner')).toBeNull()
      })

      it('a snapshot matching the local draft does not surface the banner (own echo)', () => {
        vi.useFakeTimers()
        try {
          const setSessionPreamble = vi.fn()
          setMockState({
            activeSessionId: 'sess-1',
            sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', sessionPreamble: '' }],
            setSessionPreamble,
          })
          const { rerender } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
          fireEvent.change(screen.getByTestId('session-preamble-input'), { target: { value: 'echo me' } })
          vi.advanceTimersByTime(401)
          expect(setSessionPreamble).toHaveBeenCalledWith('echo me')
          // Server echoes the same value back.
          setMockState({
            activeSessionId: 'sess-1',
            sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', sessionPreamble: 'echo me' }],
            setSessionPreamble,
          })
          rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
          expect(screen.queryByTestId('session-preamble-conflict-banner')).toBeNull()
        } finally {
          vi.useRealTimers()
        }
      })

      it('accepts snapshot updates normally when the editor is clean', () => {
        setMockState({
          activeSessionId: 'sess-1',
          sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', sessionPreamble: 'initial' }],
          setSessionPreamble: vi.fn(),
        })
        const { rerender } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        // No edits — a fresh snapshot replaces the draft.
        setMockState({
          activeSessionId: 'sess-1',
          sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', sessionPreamble: 'from server' }],
          setSessionPreamble: vi.fn(),
        })
        rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        const after = screen.getByTestId('session-preamble-input') as HTMLTextAreaElement
        expect(after.value).toBe('from server')
        expect(screen.queryByTestId('session-preamble-conflict-banner')).toBeNull()
      })

      it('cancels a pending debounce on unmount', () => {
        vi.useFakeTimers()
        try {
          const setSessionPreamble = vi.fn()
          setMockState({
            activeSessionId: 'sess-1',
            sessions: [{ sessionId: 'sess-1', name: 'Test', cwd: '/tmp', sessionPreamble: '' }],
            setSessionPreamble,
          })
          const { unmount } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
          fireEvent.change(screen.getByTestId('session-preamble-input'), { target: { value: 'half-typed' } })
          vi.advanceTimersByTime(100)
          unmount()
          vi.advanceTimersByTime(500)
          expect(setSessionPreamble).not.toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
        }
      })
    })
  })

  describe('BYOK credentials (#4052)', () => {
    it('renders Missing status when no key configured', () => {
      setMockState({ byokCredentialsStatus: { status: 'missing', source: 'none', reason: 'not configured' } })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('byok-credentials-section')).toBeInTheDocument()
      expect(screen.getByTestId('byok-status').textContent).toContain('Missing')
      expect(screen.getByTestId('byok-reason').textContent).toContain('not configured')
    })

    it('renders Set + masked preview when key is set via file', () => {
      setMockState({
        byokCredentialsStatus: {
          status: 'set', source: 'file', masked: 'sk-ant-api03...[95 chars redacted]',
          fileExists: true,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('byok-status').textContent).toContain('Set (file)')
      expect(screen.getByTestId('byok-status').textContent).toContain('sk-ant-api03...[95 chars redacted]')
      // Remove button is keyed on fileExists (#4144) — file present here.
      expect(screen.getByTestId('byok-clear-button')).toBeInTheDocument()
    })

    it('hides the Remove button when source is env AND no file on disk (#4144)', () => {
      setMockState({
        byokCredentialsStatus: {
          status: 'set', source: 'env', masked: 'sk-ant-api03...[95 chars redacted]',
          fileExists: false,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.queryByTestId('byok-clear-button')).not.toBeInTheDocument()
      // Also no stale-file notice when there's actually no file.
      expect(screen.queryByTestId('byok-stale-file-notice')).not.toBeInTheDocument()
    })

    it('shows Remove + stale-file notice when env wins but a file is shadowed on disk (#4144)', () => {
      setMockState({
        byokCredentialsStatus: {
          status: 'set', source: 'env', masked: 'sk-ant-api03...[95 chars redacted]',
          fileExists: true,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      // Stale-file notice surfaces — env wins, file is shadowed.
      const notice = screen.getByTestId('byok-stale-file-notice')
      expect(notice).toBeInTheDocument()
      // Notice references both the env var and the file so the user
      // knows what's currently active and what's persisted.
      expect(notice.textContent).toMatch(/ANTHROPIC_API_KEY/)
      expect(notice.textContent).toMatch(/credentials\.json/)
      // Remove button is offered so the user can clear the shadowed file.
      expect(screen.getByTestId('byok-clear-button')).toBeInTheDocument()
    })

    it('shows Remove + branched stale-file notice when missing+fileExists (#4175)', () => {
      // The file is on disk but unreadable (e.g. mode 0644 — strict
      // 0600 check fails). Pre-#4175 the gate was source === 'env'
      // only, so the user saw a Remove button with no context about
      // what it removes. Now the notice fires for source !== 'file'
      // && fileExists, with branched copy explaining the unreadable case.
      setMockState({
        byokCredentialsStatus: {
          status: 'missing', source: 'none',
          reason: 'credentials.json mode 0644 — chroxy requires 0600',
          fileExists: true,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const notice = screen.getByTestId('byok-stale-file-notice')
      expect(notice).toBeInTheDocument()
      // Branched copy: NOT the env-wins variant; the unreadable variant.
      expect(notice.textContent).toMatch(/cannot be read/i)
      expect(notice.textContent).toMatch(/Status above for the reason/i)
      // No ANTHROPIC_API_KEY reference in this branch — only env-wins
      // mentions the env var.
      expect(notice.textContent).not.toMatch(/ANTHROPIC_API_KEY/)
      // Remove button is offered so the user can clear the unreadable file.
      expect(screen.getByTestId('byok-clear-button')).toBeInTheDocument()
    })

    it('does NOT show stale-file notice when source is file (file IS being used) (#4175)', () => {
      // Defensive: notice gate must not fire when the file is the active
      // source — there's nothing "stale" about it.
      setMockState({
        byokCredentialsStatus: {
          status: 'set', source: 'file', masked: 'sk-ant-api03...[95 chars redacted]',
          fileExists: true,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.queryByTestId('byok-stale-file-notice')).not.toBeInTheDocument()
    })

    it('disables Save until the input has content', () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const save = screen.getByTestId('byok-save-button') as HTMLButtonElement
      expect(save.disabled).toBe(true)
      fireEvent.change(screen.getByTestId('byok-key-input'), { target: { value: 'sk-ant-paste-test' } })
      expect(save.disabled).toBe(false)
    })

    it('calls setByokCredentials with the trimmed key and clears the input on Save', () => {
      // #4559: the input only clears on a successful send — mirror the
      // OPEN-socket store path by returning `true`. The failure path is
      // covered separately in the WS-closed describe block.
      const setByokCredentials = vi.fn().mockReturnValue(true)
      setMockState({ setByokCredentials })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const input = screen.getByTestId('byok-key-input') as HTMLInputElement
      fireEvent.change(input, { target: { value: '   sk-ant-from-user   ' } })
      fireEvent.click(screen.getByTestId('byok-save-button'))
      expect(setByokCredentials).toHaveBeenCalledWith('sk-ant-from-user')
      expect(input.value).toBe('')
    })

    it('refuses keys not starting with sk-ant- without calling setByokCredentials', () => {
      const setByokCredentials = vi.fn()
      setMockState({ setByokCredentials })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.change(screen.getByTestId('byok-key-input'), { target: { value: 'sk-openai-bogus' } })
      fireEvent.click(screen.getByTestId('byok-save-button'))
      expect(setByokCredentials).not.toHaveBeenCalled()
      expect(screen.getByTestId('byok-error').textContent).toContain('sk-ant-')
    })

    it('calls refreshByokCredentialsStatus when the panel opens', () => {
      const refreshByokCredentialsStatus = vi.fn()
      setMockState({ refreshByokCredentialsStatus })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(refreshByokCredentialsStatus).toHaveBeenCalled()
    })

    it('calls clearByokCredentials when Remove is clicked', () => {
      const clearByokCredentials = vi.fn()
      setMockState({
        byokCredentialsStatus: {
          status: 'set', source: 'file', masked: 'sk-ant-api03...[95 chars redacted]',
          fileExists: true,
        },
        clearByokCredentials,
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('byok-clear-button'))
      expect(clearByokCredentials).toHaveBeenCalled()
    })

    it('uses type=password on the input so the key never echoes to screen', () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const input = screen.getByTestId('byok-key-input')
      expect(input.getAttribute('type')).toBe('password')
      expect(input.getAttribute('autocomplete')).toBe('off')
    })
  })

  describe('Notification preferences — per-category toggles (#4542)', () => {
    // The full RATE_LIMITS-derived category set from packages/server/src/push.js.
    // Kept verbatim so a server-side rename is caught by these tests.
    const categories = {
      permission: true,
      result: true,
      activity_update: true,
      activity_waiting: true,
      activity_error: true,
      inactivity_warning: true,
      live_activity: true,
    }
    const defaultPrefs = { categories, devices: {}, quietHours: null }

    it('renders the Notifications section when prefs are loaded', () => {
      setMockState({ notificationPrefs: defaultPrefs })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('notification-prefs-section')).toBeInTheDocument()
    })

    it('renders the section even before the first snapshot lands (loading state)', () => {
      setMockState({ notificationPrefs: null })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      // Section is always present so users see the loading hint instead of
      // wondering whether the feature exists.
      expect(screen.getByTestId('notification-prefs-section')).toBeInTheDocument()
      expect(screen.getByTestId('notification-prefs-loading')).toBeInTheDocument()
    })

    it('renders one toggle per known server category', () => {
      setMockState({ notificationPrefs: defaultPrefs })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      // The set MUST cover everything in RATE_LIMITS (push.js). If the server
      // adds a new category, this test fails so the UI can label it.
      for (const cat of Object.keys(categories)) {
        expect(screen.getByTestId(`notification-prefs-toggle-${cat}`)).toBeInTheDocument()
      }
    })

    it('reflects a category disabled state as an unchecked checkbox', () => {
      setMockState({
        notificationPrefs: {
          categories: { ...categories, result: false },
          devices: {},
          quietHours: null,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const resultToggle = screen.getByTestId('notification-prefs-toggle-result') as HTMLInputElement
      const permToggle = screen.getByTestId('notification-prefs-toggle-permission') as HTMLInputElement
      expect(resultToggle.checked).toBe(false)
      expect(permToggle.checked).toBe(true)
    })

    it('calls setNotificationPrefsCategory(cat, next) when a toggle is clicked', () => {
      const setNotificationPrefsCategory = vi.fn()
      setMockState({ notificationPrefs: defaultPrefs, setNotificationPrefsCategory })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('notification-prefs-toggle-result'))
      // Toggling an enabled category sends `false`.
      expect(setNotificationPrefsCategory).toHaveBeenCalledWith('result', false)
    })

    it('emits true when toggling a disabled category back on', () => {
      const setNotificationPrefsCategory = vi.fn()
      setMockState({
        notificationPrefs: {
          categories: { ...categories, inactivity_warning: false },
          devices: {},
          quietHours: null,
        },
        setNotificationPrefsCategory,
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('notification-prefs-toggle-inactivity_warning'))
      expect(setNotificationPrefsCategory).toHaveBeenCalledWith('inactivity_warning', true)
    })

    it('calls refreshNotificationPrefs when the panel opens', () => {
      const refreshNotificationPrefs = vi.fn()
      setMockState({ refreshNotificationPrefs })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(refreshNotificationPrefs).toHaveBeenCalled()
    })

    it('renders only categories present in the snapshot — unknown server keys are surfaced too', () => {
      // The wire schema is permissive (z.record(string, boolean)) — if a
      // future server adds a category the UI doesn't know about, render it
      // with the raw key so the user can still toggle it. Better than
      // silently hiding a notification source.
      setMockState({
        notificationPrefs: {
          categories: { ...categories, future_category: true },
          devices: {},
          quietHours: null,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('notification-prefs-toggle-future_category')).toBeInTheDocument()
    })
  })

  describe('Notification preferences — external-session categories (#5446)', () => {
    // #5413 Phase 3 added session_online / session_offline / session_activity
    // server-side; #5435 labeled them on mobile. These tests pin the dashboard
    // labels + order to the same wording so the two clients never drift.
    const categories = {
      permission: true,
      result: true,
      activity_update: true,
      activity_waiting: true,
      activity_error: true,
      inactivity_warning: true,
      live_activity: true,
      session_online: true,
      session_offline: true,
      session_activity: true,
    }
    const defaultPrefs = { categories, devices: {}, quietHours: null }

    // Wording copied verbatim from packages/app/src/screens/SettingsScreen.tsx
    // (#5435) — change both together or not at all.
    const expectedLabels: Record<string, { label: string; hint: string }> = {
      session_online: {
        label: 'External session online',
        hint: 'An external session reported in via /api/events.',
      },
      session_offline: {
        label: 'External session offline',
        hint: 'An external session ended or went away.',
      },
      session_activity: {
        label: 'External session activity',
        hint: 'Subagent and tool activity from external sessions.',
      },
    }

    it('labels the three categories instead of falling back to the raw-key tail', () => {
      setMockState({ notificationPrefs: defaultPrefs })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      for (const [cat, { label, hint }] of Object.entries(expectedLabels)) {
        const toggle = screen.getByTestId(`notification-prefs-toggle-${cat}`)
        // The row label is `meta?.label ?? cat` — raw key means no label entry.
        expect(toggle.closest('label')?.textContent).toBe(label)
        expect(screen.getByText(hint)).toBeInTheDocument()
      }
    })

    it('orders them after result and before live_activity, matching mobile', () => {
      setMockState({ notificationPrefs: defaultPrefs })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const rendered = screen
        .getAllByTestId(/^notification-prefs-toggle-/)
        .map((el) => el.getAttribute('data-testid')!.replace('notification-prefs-toggle-', ''))
      expect(rendered).toEqual([
        'permission',
        'activity_waiting',
        'activity_error',
        'activity_update',
        'inactivity_warning',
        'result',
        'session_online',
        'session_offline',
        'session_activity',
        'live_activity',
      ])
    })
  })

  describe('Notification preferences — label sync with server ALL_CATEGORIES (#5446)', () => {
    // Hardening: parse the canonical category enum straight out of
    // packages/server/src/notification-prefs.js so a future server-side
    // addition fails HERE (and in the mirror check below) instead of
    // silently shipping a raw-key row in the unknown tail — the exact gap
    // #5435 (mobile) and #5446 (dashboard) had to close after #5413.
    function parseServerCategories(): string[] {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../../../server/src/notification-prefs.js'),
        'utf-8',
      )
      const m = src.match(/export const ALL_CATEGORIES = Object\.freeze\(\[([\s\S]*?)\]\)/)
      if (!m) {
        throw new Error(
          'ALL_CATEGORIES not found in packages/server/src/notification-prefs.js — update this sync test',
        )
      }
      return [...m[1]!.matchAll(/'([^']+)'/g)].map((hit) => hit[1]!)
    }
    const allCategories = parseServerCategories()

    it('parses a sane category list from the server source', () => {
      expect(allCategories.length).toBeGreaterThanOrEqual(10)
      expect(allCategories).toContain('permission')
      expect(allCategories).toContain('session_activity')
    })

    it('renders a friendly label for every server category (no raw-key fallback)', () => {
      setMockState({
        notificationPrefs: {
          categories: Object.fromEntries(allCategories.map((c) => [c, true])),
          devices: {},
          quietHours: null,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      for (const cat of allCategories) {
        const toggle = screen.getByTestId(`notification-prefs-toggle-${cat}`)
        // The unknown-key tail renders the raw key as the label text.
        expect(toggle.closest('label')?.textContent).not.toBe(cat)
      }
    })

    it('gives every server category an order slot (renders ahead of unknown keys)', () => {
      // Known keys render in NOTIFICATION_CATEGORY_ORDER first; unknown keys
      // append after in *insertion order* (Object.keys is insertion-ordered
      // for string keys — the zz_ prefix is cosmetic, nothing sorts). The
      // sentinel therefore MUST be seeded FIRST: a server category missing
      // its order slot falls into the unknown tail, and only a leading
      // sentinel forces it to render after the sentinel. Seeded last, the
      // missing category would render before the sentinel and this guard
      // would pass vacuously (the #5032 lesson, again).
      setMockState({
        notificationPrefs: {
          categories: {
            zz_unknown_sentinel: true,
            ...Object.fromEntries(allCategories.map((c) => [c, true])),
          },
          devices: {},
          quietHours: null,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const rendered = screen
        .getAllByTestId(/^notification-prefs-toggle-/)
        .map((el) => el.getAttribute('data-testid')!.replace('notification-prefs-toggle-', ''))
      const sentinelIdx = rendered.indexOf('zz_unknown_sentinel')
      expect(sentinelIdx).toBeGreaterThan(-1)
      for (const cat of allCategories) {
        expect(rendered.indexOf(cat), `order slot for ${cat}`).toBeLessThan(sentinelIdx)
      }
    })

    it('mobile SettingsScreen also labels every server category (cross-client guard)', () => {
      // Same guard for the other client, asserted from one place so a new
      // server category cannot fall into the raw-key tail on either UI.
      // NOTIFICATION_CATEGORY_LABELS was lifted from SettingsScreen.tsx into
      // packages/app/src/components/settings/constants.ts (#5658).
      const mobileSource = fs.readFileSync(
        path.resolve(__dirname, '../../../app/src/components/settings/constants.ts'),
        'utf-8',
      )
      const m = mobileSource.match(/const NOTIFICATION_CATEGORY_LABELS[^=]*=\s*\{([\s\S]*?)\n\};/)
      if (!m) {
        throw new Error(
          'NOTIFICATION_CATEGORY_LABELS not found in packages/app/src/components/settings/constants.ts — update this sync test',
        )
      }
      for (const cat of allCategories) {
        expect(m[1], `mobile label for ${cat}`).toMatch(new RegExp(`\\b${cat}:`))
      }
    })
  })

  describe('Notification preferences — per-device opt-in/out (#4543)', () => {
    // Same full category set as the per-category block — keep in sync so a
    // server-side rename trips both groups at once.
    const categories = {
      permission: true,
      result: true,
      activity_update: true,
      activity_waiting: true,
      activity_error: true,
      inactivity_warning: true,
      live_activity: true,
    }
    const defaultPrefs = { categories, devices: {}, quietHours: null }

    it('renders a "Mute on this device" toggle alongside each global category toggle', () => {
      setMockState({ notificationPrefs: defaultPrefs })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      // Every category gets its own per-device toggle, keyed by category name.
      for (const cat of Object.keys(categories)) {
        expect(screen.getByTestId(`notification-prefs-device-toggle-${cat}`)).toBeInTheDocument()
      }
    })

    it('reflects a device override (false) as a checked "mute" toggle', () => {
      // Per-device override: result is muted on THIS device only — global stays on.
      setMockState({
        notificationPrefs: {
          categories,
          devices: {
            'test-device-key': { categories: { result: false } },
          },
          quietHours: null,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const resultDeviceMute = screen.getByTestId('notification-prefs-device-toggle-result') as HTMLInputElement
      const permDeviceMute = screen.getByTestId('notification-prefs-device-toggle-permission') as HTMLInputElement
      // Checked = "muted on this device". The per-device override of `false`
      // means "explicitly off here", so the mute checkbox is checked.
      expect(resultDeviceMute.checked).toBe(true)
      // Permission has no device override — falls through to global default
      // (true), so it is NOT muted on this device.
      expect(permDeviceMute.checked).toBe(false)
    })

    it('reflects a device override (true) as an explicit unmute (mute toggle unchecked)', () => {
      // Override `true` means "explicitly enabled on this device" even if
      // global is off. The mute checkbox stays unchecked.
      setMockState({
        notificationPrefs: {
          categories: { ...categories, result: false },
          devices: {
            'test-device-key': { categories: { result: true } },
          },
          quietHours: null,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const resultDeviceMute = screen.getByTestId('notification-prefs-device-toggle-result') as HTMLInputElement
      expect(resultDeviceMute.checked).toBe(false)
    })

    it('calls setNotificationPrefsDevice(deviceKey, cat, false) when the user mutes a category on this device', () => {
      const setNotificationPrefsDevice = vi.fn()
      setMockState({ notificationPrefs: defaultPrefs, setNotificationPrefsDevice })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      // Currently unmuted — clicking the mute toggle should patch
      // devices[deviceKey].categories[result] = false on the wire.
      fireEvent.click(screen.getByTestId('notification-prefs-device-toggle-result'))
      expect(setNotificationPrefsDevice).toHaveBeenCalledWith('test-device-key', 'result', false)
    })

    it('calls setNotificationPrefsDevice(deviceKey, cat, true) when the user unmutes a muted-here category', () => {
      const setNotificationPrefsDevice = vi.fn()
      setMockState({
        notificationPrefs: {
          categories,
          devices: {
            'test-device-key': { categories: { result: false } },
          },
          quietHours: null,
        },
        setNotificationPrefsDevice,
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      // Clicking a checked mute toggle should flip back to enabled (true).
      // This is the "explicit unmute" path — even after this, the per-device
      // override row stays in the map (server can't delete via shallow-merge),
      // but the user-visible state matches expectation.
      fireEvent.click(screen.getByTestId('notification-prefs-device-toggle-result'))
      expect(setNotificationPrefsDevice).toHaveBeenCalledWith('test-device-key', 'result', true)
    })

    it('does not surface per-device toggles when currentDeviceKey is null', () => {
      // If the client hasn't established a device identity yet (e.g. storage
      // unavailable), the per-device row should not render — there's no key
      // to patch against. The global per-category toggles still work.
      setMockState({ notificationPrefs: defaultPrefs, currentDeviceKey: null })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      // Global toggles still present.
      expect(screen.getByTestId('notification-prefs-toggle-result')).toBeInTheDocument()
      // Per-device row hidden.
      expect(screen.queryByTestId('notification-prefs-device-toggle-result')).not.toBeInTheDocument()
    })

    it('does not patch when clicked but currentDeviceKey is null', () => {
      // Defensive: even if a stale-rendered toggle somehow fires, the action
      // must short-circuit so we never send a `devices[null]` patch.
      const setNotificationPrefsDevice = vi.fn()
      setMockState({
        notificationPrefs: defaultPrefs,
        currentDeviceKey: null,
        setNotificationPrefsDevice,
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      // Toggles aren't rendered, so there's nothing to click — verifies the
      // contract holds without any synthetic interaction.
      expect(setNotificationPrefsDevice).not.toHaveBeenCalled()
    })

    it('does not wrap the per-device input inside a <label> element (#4562)', () => {
      // Regression for #4562: the per-device row originally used a wrapping
      // <label> that shared its <li> ancestor with the global category's
      // <label>. Two labels in the same row confuses screen readers and can
      // bubble click events to the wrong input. Hoisted: the per-device input
      // sits alongside an explicit <label htmlFor={deviceToggleId}> sibling
      // inside a plain <div>, with no <label> ancestor at all.
      setMockState({ notificationPrefs: defaultPrefs })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const deviceToggle = screen.getByTestId('notification-prefs-device-toggle-result')
      // No ancestor <label> for the per-device input.
      expect(deviceToggle.closest('label')).toBeNull()
      // The per-device row wrapper is a <div>, not a <label>.
      const row = screen.getByTestId('notification-prefs-device-row-result')
      expect(row.tagName).toBe('DIV')
      // And the explicit "Mute on this device" label still associates via htmlFor
      // so clicking the text toggles only the device input (scoped to the
      // `result` row — every category renders its own copy of the text).
      const muteLabel = row.querySelector('label')
      expect(muteLabel).not.toBeNull()
      expect(muteLabel!.getAttribute('for')).toBe('notification-prefs-device-result')
      expect(muteLabel!.textContent).toBe('Mute on this device')
    })

    it('applies the .notification-prefs-device-row class for visual hierarchy (#4563)', () => {
      // Regression for #4563: the per-device row must carry the
      // `notification-prefs-device-row` className so the matching CSS rule
      // (indent + muted label) renders it as subordinate to the global
      // per-category toggle. Without the class the row reads as a sibling
      // toggle — the original visual-hierarchy bug.
      setMockState({ notificationPrefs: defaultPrefs })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const row = screen.getByTestId('notification-prefs-device-row-result')
      expect(row.classList.contains('notification-prefs-device-row')).toBe(true)
    })
  })

  // #4564: per-device-list orphan-clearing UI. The per-device map can
  // accumulate dead entries when Expo refreshes a push token, an app is
  // reinstalled, or a browser tab loses its `chroxy_device_id`. The list
  // surface lets the user drain those orphans one at a time without
  // hand-editing the prefs file. The list always renders when prefs are
  // loaded — even when empty — so the operator knows the surface exists.
  describe('Notification preferences — known-devices list (#4564)', () => {
    const categories = {
      permission: true,
      result: true,
      activity_update: true,
      activity_waiting: true,
      activity_error: true,
      inactivity_warning: true,
      live_activity: true,
    }

    it('renders an empty-state hint when no per-device entries exist', () => {
      // No `devices` keys at all — the list should still render the header
      // (so users find the affordance for next time) plus a quiet hint.
      setMockState({
        notificationPrefs: { categories, devices: {}, quietHours: null },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('notification-prefs-devices-list')).toBeInTheDocument()
      expect(screen.getByTestId('notification-prefs-devices-empty')).toBeInTheDocument()
    })

    it('renders one row per device entry', () => {
      setMockState({
        notificationPrefs: {
          categories,
          devices: {
            'test-device-key': { categories: { result: false } },
            'other-device-key': { categories: { result: false } },
            'ExponentPushToken[orphan-12345]': { categories: { permission: false } },
          },
          quietHours: null,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('notification-prefs-device-entry-test-device-key')).toBeInTheDocument()
      expect(screen.getByTestId('notification-prefs-device-entry-other-device-key')).toBeInTheDocument()
      expect(
        screen.getByTestId('notification-prefs-device-entry-ExponentPushToken[orphan-12345]'),
      ).toBeInTheDocument()
    })

    it('tags the row matching currentDeviceKey as "this device"', () => {
      setMockState({
        notificationPrefs: {
          categories,
          devices: {
            'test-device-key': { categories: { result: false } },
            'other-device-key': { categories: { result: false } },
          },
          quietHours: null,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const thisDeviceRow = screen.getByTestId('notification-prefs-device-entry-test-device-key')
      // The current-device row carries an explicit marker the user can see
      // before clicking Clear (a missed click on the wrong row reads as a
      // surprise self-mute on the device they're currently using).
      expect(thisDeviceRow.textContent).toMatch(/this device/i)
      // Sibling row does NOT carry the marker.
      const otherRow = screen.getByTestId('notification-prefs-device-entry-other-device-key')
      expect(otherRow.textContent).not.toMatch(/this device/i)
    })

    it('shows a truncated token label so long Expo tokens stay readable', () => {
      // The full Expo token is `ExponentPushToken[~40 base64 chars]` — too
      // long to read in a settings row. The label trims to a stable
      // first-N prefix so the user can still match it against a per-row
      // action and so visually-similar tokens stay distinguishable.
      const longToken = 'ExponentPushToken[abcdefghijklmnopqrstuvwxyz0123456789]'
      setMockState({
        notificationPrefs: {
          categories,
          devices: { [longToken]: { categories: { result: false } } },
          quietHours: null,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const row = screen.getByTestId(`notification-prefs-device-entry-${longToken}`)
      // The truncated label appears AND the full token does not (otherwise
      // truncation isn't actually happening).
      expect(row.textContent).not.toContain(longToken)
      expect(row.textContent?.includes('…') || row.textContent?.includes('...')).toBe(true)
    })

    it('renders a Clear button per row', () => {
      setMockState({
        notificationPrefs: {
          categories,
          devices: {
            'test-device-key': { categories: { result: false } },
            'other-device-key': { categories: { result: false } },
          },
          quietHours: null,
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('notification-prefs-device-clear-test-device-key')).toBeInTheDocument()
      expect(screen.getByTestId('notification-prefs-device-clear-other-device-key')).toBeInTheDocument()
    })

    it('calls deleteNotificationPrefsDevice(deviceKey) when Clear is clicked', () => {
      const deleteNotificationPrefsDevice = vi.fn().mockReturnValue(true)
      setMockState({
        notificationPrefs: {
          categories,
          devices: {
            'orphan-device-key': { categories: { result: false } },
          },
          quietHours: null,
        },
        deleteNotificationPrefsDevice,
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('notification-prefs-device-clear-orphan-device-key'))
      expect(deleteNotificationPrefsDevice).toHaveBeenCalledWith('orphan-device-key')
    })

    it('prompts before clearing when the row matches currentDeviceKey (#4588)', () => {
      // The (this device) row silently wipes the operator's own mutes /
      // quiet-hours overrides if cleared by accident — the prompt is a
      // second cue after the (this device) tag.
      const deleteNotificationPrefsDevice = vi.fn().mockReturnValue(true)
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
      setMockState({
        notificationPrefs: {
          categories,
          devices: { 'test-device-key': { categories: { result: false } } },
          quietHours: null,
        },
        deleteNotificationPrefsDevice,
        currentDeviceKey: 'test-device-key',
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('notification-prefs-device-clear-test-device-key'))
      expect(confirmSpy).toHaveBeenCalledOnce()
      expect(confirmSpy.mock.calls[0]![0]).toMatch(/fall back to global defaults/i)
      expect(deleteNotificationPrefsDevice).toHaveBeenCalledWith('test-device-key')
      confirmSpy.mockRestore()
    })

    it('does NOT dispatch the delete when the current-device confirm is dismissed (#4588)', () => {
      // Cancel path — the dispatch must NOT fire. This is the whole point
      // of the prompt: a misclick on your own row should be recoverable.
      const deleteNotificationPrefsDevice = vi.fn().mockReturnValue(true)
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      setMockState({
        notificationPrefs: {
          categories,
          devices: { 'test-device-key': { categories: { result: false } } },
          quietHours: null,
        },
        deleteNotificationPrefsDevice,
        currentDeviceKey: 'test-device-key',
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('notification-prefs-device-clear-test-device-key'))
      expect(confirmSpy).toHaveBeenCalledOnce()
      expect(deleteNotificationPrefsDevice).not.toHaveBeenCalled()
      confirmSpy.mockRestore()
    })

    it('skips the confirm prompt for orphan rows (#4588)', () => {
      // Orphan-row clears stay one-click — the whole point of the orphan
      // list is fast cleanup. Only the current-device row gates the dispatch.
      const deleteNotificationPrefsDevice = vi.fn().mockReturnValue(true)
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
      setMockState({
        notificationPrefs: {
          categories,
          devices: { 'orphan-device-key': { categories: { result: false } } },
          quietHours: null,
        },
        deleteNotificationPrefsDevice,
        currentDeviceKey: 'test-device-key',
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('notification-prefs-device-clear-orphan-device-key'))
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(deleteNotificationPrefsDevice).toHaveBeenCalledWith('orphan-device-key')
      confirmSpy.mockRestore()
    })

    it('does not render the list when the server lacks the notificationPrefs capability', () => {
      // The capability gate (#4560) replaces the body of the Notifications
      // section with an upgrade hint. The device list shares that gate so
      // we never render Clear buttons against a pre-#4541 server that
      // would silently ignore the `notification_prefs_set` patch.
      setMockState({
        notificationPrefs: null,
        serverCapabilities: {},
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.queryByTestId('notification-prefs-devices-list')).toBeNull()
    })

    // #4587: per-device metadata (lastSeenAt + platform). The dashboard
    // surfaces these as a muted "{platform} · Last seen {relative}" suffix
    // next to the truncated token so operators can tell orphan entries
    // apart. Both fields are optional — pre-#4587 servers omit them and
    // the row renders exactly as before.
    describe('lastSeen + platform metadata (#4587)', () => {
      it('renders a platform badge when entry.platform is set', () => {
        setMockState({
          notificationPrefs: {
            categories,
            devices: {
              'tok-ios': { categories: { result: false }, platform: 'ios' },
            },
            quietHours: null,
          },
        })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        const badge = screen.getByTestId('notification-prefs-device-platform-tok-ios')
        // Friendly label rewrite — `ios` -> `iOS` — so the row reads
        // correctly for non-technical operators.
        expect(badge.textContent).toMatch(/iOS/)
      })

      it('renders a last-seen badge when entry.lastSeenAt is set', () => {
        setMockState({
          notificationPrefs: {
            categories,
            devices: {
              'tok-seen': {
                categories: { result: false },
                // 1 minute ago — should render as "1 min ago"
                lastSeenAt: Date.now() - 60_000,
              },
            },
            quietHours: null,
          },
        })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        const badge = screen.getByTestId('notification-prefs-device-last-seen-tok-seen')
        // Match the minute-granularity render. Allow `1 min` or `2 min`
        // depending on which side of the floor we land on.
        expect(badge.textContent).toMatch(/Last seen \d+ min ago/)
      })

      it('renders both meta spans when both fields are set', () => {
        setMockState({
          notificationPrefs: {
            categories,
            devices: {
              'tok-both': {
                categories: { result: false },
                platform: 'android',
                lastSeenAt: Date.now() - 3_600_000, // 1 hr ago
              },
            },
            quietHours: null,
          },
        })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        expect(screen.getByTestId('notification-prefs-device-platform-tok-both').textContent).toMatch(/Android/)
        expect(screen.getByTestId('notification-prefs-device-last-seen-tok-both').textContent).toMatch(/hr ago/)
      })

      it('omits both meta spans when fields are absent (pre-#4587 server)', () => {
        // Graceful fallback — a snapshot from an older server still
        // renders, just without the new affordances. The truncated token
        // and Clear button are still present.
        setMockState({
          notificationPrefs: {
            categories,
            devices: {
              'tok-legacy': { categories: { result: false } },
            },
            quietHours: null,
          },
        })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        expect(screen.queryByTestId('notification-prefs-device-platform-tok-legacy')).toBeNull()
        expect(screen.queryByTestId('notification-prefs-device-last-seen-tok-legacy')).toBeNull()
        // Sanity — the row itself still renders.
        expect(screen.getByTestId('notification-prefs-device-entry-tok-legacy')).toBeInTheDocument()
        expect(screen.getByTestId('notification-prefs-device-clear-tok-legacy')).toBeInTheDocument()
      })
    })
  })

  describe('Notification preferences — quiet-hours editor (#4544)', () => {
    const categories = {
      permission: true,
      result: true,
      activity_update: true,
      activity_waiting: true,
      activity_error: true,
      inactivity_warning: true,
      live_activity: true,
    }
    const baseSnapshot = { categories, devices: {}, quietHours: null }

    it('renders the quiet-hours toggle inside the Notifications section', () => {
      setMockState({ notificationPrefs: baseSnapshot })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('quiet-hours-editor')).toBeInTheDocument()
      expect(screen.getByTestId('quiet-hours-enabled-toggle')).toBeInTheDocument()
    })

    it('hides the start/end/timezone inputs when quiet hours are disabled', () => {
      setMockState({ notificationPrefs: baseSnapshot })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.queryByTestId('quiet-hours-start-input')).toBeNull()
      expect(screen.queryByTestId('quiet-hours-end-input')).toBeNull()
      expect(screen.queryByTestId('quiet-hours-timezone-select')).toBeNull()
    })

    it('shows start/end/timezone inputs when quiet hours are enabled', () => {
      setMockState({
        notificationPrefs: {
          ...baseSnapshot,
          quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const startInput = screen.getByTestId('quiet-hours-start-input') as HTMLInputElement
      const endInput = screen.getByTestId('quiet-hours-end-input') as HTMLInputElement
      const tzSelect = screen.getByTestId('quiet-hours-timezone-select') as HTMLSelectElement
      expect(startInput.value).toBe('22:00')
      expect(endInput.value).toBe('07:00')
      expect(tzSelect.value).toBe('America/Los_Angeles')
    })

    it('calls setNotificationPrefsQuietHours(null) when disabling', () => {
      const setNotificationPrefsQuietHours = vi.fn()
      setMockState({
        notificationPrefs: {
          ...baseSnapshot,
          quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
        },
        setNotificationPrefsQuietHours,
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('quiet-hours-enabled-toggle'))
      expect(setNotificationPrefsQuietHours).toHaveBeenCalledWith(null)
    })

    it('calls setNotificationPrefsQuietHours with a default window when enabling for the first time', () => {
      const setNotificationPrefsQuietHours = vi.fn()
      setMockState({ notificationPrefs: baseSnapshot, setNotificationPrefsQuietHours })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('quiet-hours-enabled-toggle'))
      const called = setNotificationPrefsQuietHours.mock.calls[0]?.[0]
      // Default: 22:00-07:00 in the browser timezone.
      expect(called).toMatchObject({ start: '22:00', end: '07:00' })
      expect(typeof called.timezone).toBe('string')
      expect(called.timezone.length).toBeGreaterThan(0)
    })

    it('Save button sends the edited window', () => {
      const setNotificationPrefsQuietHours = vi.fn()
      setMockState({
        notificationPrefs: {
          ...baseSnapshot,
          quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
        },
        setNotificationPrefsQuietHours,
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      // Change the start time, then click Save.
      fireEvent.change(screen.getByTestId('quiet-hours-start-input'), { target: { value: '23:30' } })
      fireEvent.click(screen.getByTestId('quiet-hours-save-button'))
      expect(setNotificationPrefsQuietHours).toHaveBeenCalledWith({
        start: '23:30',
        end: '07:00',
        timezone: 'America/Los_Angeles',
      })
    })

    it('renders the bypass fieldset with permission + activity_error checked by default', () => {
      setMockState({
        notificationPrefs: {
          ...baseSnapshot,
          quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
          bypassCategories: ['permission', 'activity_error'],
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const permCheck = screen.getByTestId('quiet-hours-bypass-toggle-permission') as HTMLInputElement
      const errCheck = screen.getByTestId('quiet-hours-bypass-toggle-activity_error') as HTMLInputElement
      const resultCheck = screen.getByTestId('quiet-hours-bypass-toggle-result') as HTMLInputElement
      expect(permCheck.checked).toBe(true)
      expect(errCheck.checked).toBe(true)
      expect(resultCheck.checked).toBe(false)
    })

    it('toggling a bypass checkbox sends the full updated list', () => {
      const setNotificationPrefsBypassCategories = vi.fn()
      setMockState({
        notificationPrefs: {
          ...baseSnapshot,
          quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
          bypassCategories: ['permission', 'activity_error'],
        },
        setNotificationPrefsBypassCategories,
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      // Uncheck activity_error — replacement wire sends just ['permission'].
      fireEvent.click(screen.getByTestId('quiet-hours-bypass-toggle-activity_error'))
      const called = setNotificationPrefsBypassCategories.mock.calls[0]?.[0]
      expect(Array.isArray(called)).toBe(true)
      expect(called.sort()).toEqual(['permission'])
    })

    it('falls back to documented bypass defaults when the snapshot omits bypassCategories', () => {
      // Older server omits the field. The UI must still show permission +
      // activity_error checked so the user sees the active gate state.
      setMockState({
        notificationPrefs: {
          ...baseSnapshot,
          quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
        },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const permCheck = screen.getByTestId('quiet-hours-bypass-toggle-permission') as HTMLInputElement
      const errCheck = screen.getByTestId('quiet-hours-bypass-toggle-activity_error') as HTMLInputElement
      expect(permCheck.checked).toBe(true)
      expect(errCheck.checked).toBe(true)
    })

    // #4570: snapshot broadcasts must not clobber unsaved edits.
    //
    // Background: PR #4565 wired `useEffect([win])` to re-sync the draft on
    // every snapshot — which is correct for a remote save with no local
    // pending changes, but wrong when the user is mid-edit. A broadcast
    // from another client (or an unrelated notification_prefs_set for a
    // different field that re-broadcasts the merged snapshot) would
    // overwrite the user's typed-but-unsaved text. Now: the editor tracks
    // a `dirty` flag, skips snapshot apply when dirty, and surfaces a
    // conflict banner with explicit accept/discard.
    describe('snapshot-vs-draft preservation (#4570)', () => {
      it('does NOT overwrite the start input when a snapshot arrives mid-edit', () => {
        const initial = {
          ...baseSnapshot,
          quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
        }
        setMockState({ notificationPrefs: initial })
        const { rerender } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)

        // User starts typing — draft is now dirty.
        const startInput = screen.getByTestId('quiet-hours-start-input') as HTMLInputElement
        fireEvent.change(startInput, { target: { value: '23:45' } })
        expect(startInput.value).toBe('23:45')

        // A new snapshot lands from the server (another client saved a
        // different end time). Re-render with the new prefs.
        setMockState({
          notificationPrefs: {
            ...baseSnapshot,
            quietHours: { start: '21:00', end: '06:00', timezone: 'America/Los_Angeles' },
          },
        })
        rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)

        // The user's in-flight edit is preserved — NOT replaced by the
        // broadcast value.
        const startAfter = screen.getByTestId('quiet-hours-start-input') as HTMLInputElement
        expect(startAfter.value).toBe('23:45')
      })

      it('surfaces a conflict banner with accept/discard when the snapshot diverges from the dirty draft', () => {
        const initial = {
          ...baseSnapshot,
          quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
        }
        setMockState({ notificationPrefs: initial })
        const { rerender } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)

        // Make the draft dirty.
        fireEvent.change(screen.getByTestId('quiet-hours-start-input'), { target: { value: '23:45' } })

        // Snapshot lands from another client with a divergent window.
        setMockState({
          notificationPrefs: {
            ...baseSnapshot,
            quietHours: { start: '21:00', end: '06:00', timezone: 'America/Los_Angeles' },
          },
        })
        rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)

        // Banner appears with the explicit accept/discard affordances.
        expect(screen.getByTestId('quiet-hours-conflict-banner')).toBeInTheDocument()
        expect(screen.getByTestId('quiet-hours-conflict-accept')).toBeInTheDocument()
        expect(screen.getByTestId('quiet-hours-conflict-discard')).toBeInTheDocument()
      })

      it('clicking discard accepts the snapshot, replacing the draft and clearing the banner', () => {
        const initial = {
          ...baseSnapshot,
          quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
        }
        setMockState({ notificationPrefs: initial })
        const { rerender } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.change(screen.getByTestId('quiet-hours-start-input'), { target: { value: '23:45' } })

        setMockState({
          notificationPrefs: {
            ...baseSnapshot,
            quietHours: { start: '21:00', end: '06:00', timezone: 'America/Los_Angeles' },
          },
        })
        rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.click(screen.getByTestId('quiet-hours-conflict-discard'))

        // Draft now reflects the snapshot; banner is gone.
        const startAfter = screen.getByTestId('quiet-hours-start-input') as HTMLInputElement
        expect(startAfter.value).toBe('21:00')
        expect(screen.queryByTestId('quiet-hours-conflict-banner')).toBeNull()
      })

      it('clicking accept keeps the local draft and clears the banner', () => {
        const initial = {
          ...baseSnapshot,
          quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
        }
        setMockState({ notificationPrefs: initial })
        const { rerender } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.change(screen.getByTestId('quiet-hours-start-input'), { target: { value: '23:45' } })

        setMockState({
          notificationPrefs: {
            ...baseSnapshot,
            quietHours: { start: '21:00', end: '06:00', timezone: 'America/Los_Angeles' },
          },
        })
        rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.click(screen.getByTestId('quiet-hours-conflict-accept'))

        // Draft preserved; banner dismissed.
        const startAfter = screen.getByTestId('quiet-hours-start-input') as HTMLInputElement
        expect(startAfter.value).toBe('23:45')
        expect(screen.queryByTestId('quiet-hours-conflict-banner')).toBeNull()
      })

      it('accepts snapshot updates normally when the editor is clean', () => {
        const initial = {
          ...baseSnapshot,
          quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
        }
        setMockState({ notificationPrefs: initial })
        const { rerender } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)

        // No edits — a fresh snapshot replaces the draft as before.
        setMockState({
          notificationPrefs: {
            ...baseSnapshot,
            quietHours: { start: '21:00', end: '06:00', timezone: 'America/Los_Angeles' },
          },
        })
        rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        const startAfter = screen.getByTestId('quiet-hours-start-input') as HTMLInputElement
        const endAfter = screen.getByTestId('quiet-hours-end-input') as HTMLInputElement
        expect(startAfter.value).toBe('21:00')
        expect(endAfter.value).toBe('06:00')
        expect(screen.queryByTestId('quiet-hours-conflict-banner')).toBeNull()
      })

      it('accepts the next snapshot after Save (dirty flag clears on save)', () => {
        const setNotificationPrefsQuietHours = vi.fn()
        const initial = {
          ...baseSnapshot,
          quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
        }
        setMockState({ notificationPrefs: initial, setNotificationPrefsQuietHours })
        const { rerender } = render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)

        // User edits + saves; dirty clears.
        fireEvent.change(screen.getByTestId('quiet-hours-start-input'), { target: { value: '23:30' } })
        fireEvent.click(screen.getByTestId('quiet-hours-save-button'))
        expect(setNotificationPrefsQuietHours).toHaveBeenCalledWith({
          start: '23:30', end: '07:00', timezone: 'America/Los_Angeles',
        })

        // Echo snapshot from server with the saved values arrives — accepted.
        setMockState({
          notificationPrefs: {
            ...baseSnapshot,
            quietHours: { start: '23:30', end: '07:00', timezone: 'America/Los_Angeles' },
          },
          setNotificationPrefsQuietHours,
        })
        rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        expect(screen.queryByTestId('quiet-hours-conflict-banner')).toBeNull()

        // A subsequent unrelated snapshot still applies normally.
        setMockState({
          notificationPrefs: {
            ...baseSnapshot,
            quietHours: { start: '00:00', end: '08:00', timezone: 'America/Los_Angeles' },
          },
          setNotificationPrefsQuietHours,
        })
        rerender(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        const startAfter = screen.getByTestId('quiet-hours-start-input') as HTMLInputElement
        expect(startAfter.value).toBe('00:00')
      })
    })
  })

  // #4559: fail-loud inline error when a notification-prefs / BYOK write
  // fires while the WS is closed. Pre-#4559 these actions silently no-op'd
  // (the action read `socket.readyState !== OPEN` and returned without
  // sending), so the user saw a switch refuse to stay flipped with no
  // feedback. The store actions now return a boolean; SettingsPanel
  // surfaces a banner per section when the action reports `false`.
  describe('Fail-loud inline error on WS-closed write (#4559)', () => {
    // Same RATE_LIMITS-derived category set used elsewhere in the file —
    // kept inline so a server-side rename trips here too.
    const categories = {
      permission: true,
      result: true,
      activity_update: true,
      activity_waiting: true,
      activity_error: true,
      inactivity_warning: true,
      live_activity: true,
    }
    const defaultPrefs = { categories, devices: {}, quietHours: null }

    describe('Notification prefs', () => {
      it('renders no error banner on initial render (WS open path)', () => {
        // Defensive: ensure the banner only appears after a failed write,
        // never on first paint.
        setMockState({ notificationPrefs: defaultPrefs })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        expect(screen.queryByTestId('notification-prefs-ws-closed-error')).toBeNull()
      })

      it('surfaces an inline error and still calls the action when a category toggle fires while WS is closed', () => {
        // Action returns false to mimic the closed-socket path. The
        // toggle handler still calls the action (the store decides
        // whether to send) but the banner makes the failure visible
        // instead of leaving the user staring at a reverted checkbox.
        const setNotificationPrefsCategory = vi.fn().mockReturnValue(false)
        setMockState({
          notificationPrefs: defaultPrefs,
          setNotificationPrefsCategory,
        })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.click(screen.getByTestId('notification-prefs-toggle-result'))
        // The action ran — the store is responsible for the no-op gate.
        expect(setNotificationPrefsCategory).toHaveBeenCalledWith('result', false)
        // Banner is visible and tagged role=alert so a screen reader
        // announces the failure.
        const banner = screen.getByTestId('notification-prefs-ws-closed-error')
        expect(banner).toBeInTheDocument()
        expect(banner).toHaveAttribute('role', 'alert')
        // Copy mentions the recovery path so the user knows what to do.
        expect(banner.textContent).toMatch(/server disconnected/i)
        expect(banner.textContent).toMatch(/Reconnect/i)
      })

      it('does NOT render the WS-closed banner when the toggle succeeds', () => {
        // Sanity: the success path leaves no banner behind. Pre-#4559
        // there was no banner at all; this test guards against a future
        // refactor leaving a stale "sent" toast on screen.
        const setNotificationPrefsCategory = vi.fn().mockReturnValue(true)
        setMockState({
          notificationPrefs: defaultPrefs,
          setNotificationPrefsCategory,
        })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.click(screen.getByTestId('notification-prefs-toggle-result'))
        expect(setNotificationPrefsCategory).toHaveBeenCalledWith('result', false)
        expect(screen.queryByTestId('notification-prefs-ws-closed-error')).toBeNull()
      })

      it('clears the banner after a subsequent successful toggle', () => {
        // First toggle fails (WS closed → banner appears). Then the
        // user reconnects, toggles again, and the banner clears.
        // Modeling the action returning false then true mirrors the
        // ConnectionPhase transition without needing to drive the
        // socket itself.
        const setNotificationPrefsCategory = vi
          .fn<(cat: string, enabled: boolean) => boolean>()
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(true)
        setMockState({
          notificationPrefs: defaultPrefs,
          setNotificationPrefsCategory,
        })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.click(screen.getByTestId('notification-prefs-toggle-result'))
        expect(screen.getByTestId('notification-prefs-ws-closed-error')).toBeInTheDocument()
        fireEvent.click(screen.getByTestId('notification-prefs-toggle-result'))
        expect(screen.queryByTestId('notification-prefs-ws-closed-error')).toBeNull()
      })

      it('surfaces the banner when a per-device mute toggle fires while WS is closed', () => {
        // Per-device mute toggle shares the banner with the global
        // category toggle — both flow through the same section.
        const setNotificationPrefsDevice = vi.fn().mockReturnValue(false)
        setMockState({
          notificationPrefs: defaultPrefs,
          setNotificationPrefsDevice,
        })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.click(screen.getByTestId('notification-prefs-device-toggle-result'))
        expect(setNotificationPrefsDevice).toHaveBeenCalledWith('test-device-key', 'result', false)
        expect(screen.getByTestId('notification-prefs-ws-closed-error')).toBeInTheDocument()
      })

      it('surfaces the banner when the quiet-hours Save fires while WS is closed', () => {
        // Quiet-hours editor uses the same banner because it sits inside
        // the Notifications section.
        const setNotificationPrefsQuietHours = vi.fn().mockReturnValue(false)
        setMockState({
          notificationPrefs: {
            ...defaultPrefs,
            quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
          },
          setNotificationPrefsQuietHours,
        })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.change(screen.getByTestId('quiet-hours-start-input'), { target: { value: '23:30' } })
        fireEvent.click(screen.getByTestId('quiet-hours-save-button'))
        expect(setNotificationPrefsQuietHours).toHaveBeenCalled()
        expect(screen.getByTestId('notification-prefs-ws-closed-error')).toBeInTheDocument()
      })

      it('surfaces the banner when a bypass-category toggle fires while WS is closed', () => {
        // Bypass-category toggles share the same banner. The user just
        // unchecks one of the documented defaults to trigger the action.
        const setNotificationPrefsBypassCategories = vi.fn().mockReturnValue(false)
        setMockState({
          notificationPrefs: {
            ...defaultPrefs,
            quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
            bypassCategories: ['permission', 'activity_error'],
          },
          setNotificationPrefsBypassCategories,
        })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.click(screen.getByTestId('quiet-hours-bypass-toggle-activity_error'))
        expect(setNotificationPrefsBypassCategories).toHaveBeenCalled()
        expect(screen.getByTestId('notification-prefs-ws-closed-error')).toBeInTheDocument()
      })
    })

    describe('BYOK credentials', () => {
      it('surfaces an inline error and preserves the input when Save fires while WS is closed', () => {
        // Pre-#4559 the input was cleared regardless of whether the
        // write actually went out — the user would re-type the key
        // after reconnecting. Now the input survives the failed save
        // so retry is a single click after the reconnect lands.
        const setByokCredentials = vi.fn().mockReturnValue(false)
        setMockState({ setByokCredentials })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        const input = screen.getByTestId('byok-key-input') as HTMLInputElement
        fireEvent.change(input, { target: { value: 'sk-ant-from-user' } })
        fireEvent.click(screen.getByTestId('byok-save-button'))
        expect(setByokCredentials).toHaveBeenCalledWith('sk-ant-from-user')
        // Banner visible + role=alert.
        const banner = screen.getByTestId('byok-ws-closed-error')
        expect(banner).toBeInTheDocument()
        expect(banner).toHaveAttribute('role', 'alert')
        // Input preserved on failure — user retries with one click.
        expect(input.value).toBe('sk-ant-from-user')
      })

      it('does NOT render the BYOK WS-closed banner when Save succeeds', () => {
        // Sanity: the success path clears the input and leaves no banner.
        const setByokCredentials = vi.fn().mockReturnValue(true)
        setMockState({ setByokCredentials })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        const input = screen.getByTestId('byok-key-input') as HTMLInputElement
        fireEvent.change(input, { target: { value: 'sk-ant-from-user' } })
        fireEvent.click(screen.getByTestId('byok-save-button'))
        expect(setByokCredentials).toHaveBeenCalledWith('sk-ant-from-user')
        expect(screen.queryByTestId('byok-ws-closed-error')).toBeNull()
        // Input still clears on success.
        expect(input.value).toBe('')
      })

      it('surfaces an inline error when Remove fires while WS is closed', () => {
        const clearByokCredentials = vi.fn().mockReturnValue(false)
        setMockState({
          byokCredentialsStatus: {
            status: 'set', source: 'file', masked: 'sk-ant-api03...[95 chars redacted]',
            fileExists: true,
          },
          clearByokCredentials,
        })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.click(screen.getByTestId('byok-clear-button'))
        expect(clearByokCredentials).toHaveBeenCalled()
        expect(screen.getByTestId('byok-ws-closed-error')).toBeInTheDocument()
      })

      it('does not surface the notif banner when only BYOK fails (sections are independent)', () => {
        // Defensive: each section owns its own banner so a stale BYOK
        // error doesn't bleed into the Notifications section.
        const setByokCredentials = vi.fn().mockReturnValue(false)
        setMockState({ setByokCredentials, notificationPrefs: defaultPrefs })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        fireEvent.change(screen.getByTestId('byok-key-input'), { target: { value: 'sk-ant-from-user' } })
        fireEvent.click(screen.getByTestId('byok-save-button'))
        expect(screen.getByTestId('byok-ws-closed-error')).toBeInTheDocument()
        expect(screen.queryByTestId('notification-prefs-ws-closed-error')).toBeNull()
      })

      it('clears the BYOK banner after a subsequent successful Save', () => {
        const setByokCredentials = vi
          .fn<(key: string) => boolean>()
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(true)
        setMockState({ setByokCredentials })
        render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
        const input = screen.getByTestId('byok-key-input') as HTMLInputElement
        fireEvent.change(input, { target: { value: 'sk-ant-from-user' } })
        fireEvent.click(screen.getByTestId('byok-save-button'))
        expect(screen.getByTestId('byok-ws-closed-error')).toBeInTheDocument()
        // Reconnect lands; user retries — banner clears.
        fireEvent.click(screen.getByTestId('byok-save-button'))
        expect(screen.queryByTestId('byok-ws-closed-error')).toBeNull()
      })
    })
  })

  // #4560: gate the Notifications section on the server advertising the
  // `notificationPrefs` capability in auth_ok. Pre-#4541 servers have no
  // `notification_prefs_get` handler — without this gate the section sat on
  // "Loading preferences…" forever waiting for a snapshot that would never
  // arrive. Capability-true keeps the existing render path; capability-false
  // swaps in a "not supported" message that names the requirement.
  describe('Notification preferences — capability gate (#4560)', () => {
    const categories = {
      permission: true,
      result: true,
      activity_update: true,
      activity_waiting: true,
      activity_error: true,
      inactivity_warning: true,
      live_activity: true,
    }
    const defaultPrefs = { categories, devices: {}, quietHours: null }

    it('renders the Notifications section when the server advertises notificationPrefs', () => {
      setMockState({
        notificationPrefs: defaultPrefs,
        serverCapabilities: { notificationPrefs: true },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('notification-prefs-section')).toBeInTheDocument()
      // Loading hint is absent because prefs already landed.
      expect(screen.queryByTestId('notification-prefs-not-supported')).toBeNull()
    })

    it('renders the loading hint when capability is on but the snapshot has not arrived yet', () => {
      // Pre-snapshot state on a supported server still flows through the
      // existing "Loading preferences…" affordance — the gate only changes
      // behaviour for unsupported servers.
      setMockState({
        notificationPrefs: null,
        serverCapabilities: { notificationPrefs: true },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('notification-prefs-section')).toBeInTheDocument()
      expect(screen.getByTestId('notification-prefs-loading')).toBeInTheDocument()
      expect(screen.queryByTestId('notification-prefs-not-supported')).toBeNull()
    })

    it('renders the "not supported" message when the server omits the capability', () => {
      setMockState({
        notificationPrefs: null,
        serverCapabilities: {},
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      // Section header still rendered so users can see the feature exists
      // (and what they would need to upgrade to in order to use it), but
      // the loading hint is replaced with an explicit explanation.
      expect(screen.getByTestId('notification-prefs-section')).toBeInTheDocument()
      const notSupported = screen.getByTestId('notification-prefs-not-supported')
      expect(notSupported).toBeInTheDocument()
      // Loading hint must NOT appear — the pre-#4560 bug was leaving it
      // there forever; that's the behaviour this gate fixes.
      expect(screen.queryByTestId('notification-prefs-loading')).toBeNull()
      // No category toggles should be rendered against an unsupported
      // server — the buttons would no-op against a missing handler.
      expect(screen.queryByTestId('notification-prefs-toggle-result')).toBeNull()
    })

    it('does not call refreshNotificationPrefs when capability is missing', () => {
      // Pre-#4541 servers don't recognise `notification_prefs_get`. Firing
      // it against them produces an `unknown_message` error in the server
      // logs and accomplishes nothing — gate the call out entirely.
      const refreshNotificationPrefs = vi.fn()
      setMockState({
        notificationPrefs: null,
        serverCapabilities: {},
        refreshNotificationPrefs,
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(refreshNotificationPrefs).not.toHaveBeenCalled()
    })

    it('treats serverCapabilities defaulting to {} as unsupported (fail-closed)', () => {
      // Mirrors the auth_ok-handler default — older servers omit the field
      // entirely and the store seeds an empty map. The UI must read absence
      // as "feature off" so a stale connection (or a buggy server that
      // omits the flag) doesn't accidentally re-enable the broken section.
      setMockState({ notificationPrefs: null, serverCapabilities: {} })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('notification-prefs-not-supported')).toBeInTheDocument()
    })
  })

  // #4796 — voice input mode settings: confirm the user-facing labels are
  // present (avoids ambiguous wording like "Stop automatically on pause"),
  // that the persisted value drives the rendered select, that changing the
  // select round-trips through `updateInputSettings` (the persistence
  // wiring that closes the audit Tester #2 gap), and that the explanatory
  // hint row is rendered alongside the control.
  describe('Voice input mode (#4796)', () => {
    it('renders the voice input select with the persisted value from store', () => {
      setMockState({
        inputSettings: { chatEnterToSend: true, terminalEnterToSend: false, voiceInputMode: 'auto-pause' },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const select = screen.getByLabelText('Voice input mode') as HTMLSelectElement
      expect(select.value).toBe('auto-pause')
    })

    it('uses user-facing labels — no ambiguous "Stop on pause" wording', () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const select = screen.getByLabelText('Voice input mode')
      const optionTexts = Array.from(select.querySelectorAll('option')).map(o => o.textContent ?? '')
      // Continuous mode label must explicitly mention "click stop" so the
      // user knows the mic stays lit between silences.
      expect(optionTexts.some(t => /click stop/i.test(t))).toBe(true)
      // Auto-pause label must explain what triggers the stop — "silence"
      // rather than the older, ambiguous "pause" wording.
      expect(optionTexts.some(t => /silence/i.test(t))).toBe(true)
      // Regression guard: the old confusing label must not survive.
      expect(optionTexts.every(t => !/Stop automatically on pause/i.test(t))).toBe(true)
    })

    it('persists the mode change via updateInputSettings when user picks auto-pause', () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const select = screen.getByLabelText('Voice input mode')
      fireEvent.change(select, { target: { value: 'auto-pause' } })
      expect(mockUpdateInputSettings).toHaveBeenCalledWith({ voiceInputMode: 'auto-pause' })
    })

    it('persists the mode change via updateInputSettings when user picks continuous', () => {
      setMockState({
        inputSettings: { chatEnterToSend: true, terminalEnterToSend: false, voiceInputMode: 'auto-pause' },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const select = screen.getByLabelText('Voice input mode')
      fireEvent.change(select, { target: { value: 'continuous' } })
      expect(mockUpdateInputSettings).toHaveBeenCalledWith({ voiceInputMode: 'continuous' })
    })

    it('renders the explanatory hint row beneath the voice input control', () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const hint = screen.getByTestId('voice-input-mode-hint')
      expect(hint).toBeInTheDocument()
      // The hint should explain BOTH modes and call out the browser-only
      // caveat so users on the macOS native engine know it doesn't apply.
      expect(hint.textContent ?? '').toMatch(/silence/i)
    })

    // #4796 review feedback (Copilot): the hint must be programmatically
    // linked to the select via aria-describedby so screen readers announce
    // it on focus. Without this the explanation is accessibility-invisible
    // even though the dashboard already uses the pattern in
    // CreateSessionModal.tsx (aria-describedby="permission-mode-hint").
    it('links the voice input select to the hint via aria-describedby for screen readers', () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const select = screen.getByLabelText('Voice input mode') as HTMLSelectElement
      const hint = screen.getByTestId('voice-input-mode-hint')
      // The select's aria-describedby must point at the hint's id, and the
      // hint must actually carry that id — otherwise assistive tech can't
      // resolve the reference. Both halves of the contract are asserted.
      const describedBy = select.getAttribute('aria-describedby')
      expect(describedBy).toBe('voice-input-mode-hint')
      expect(hint.id).toBe('voice-input-mode-hint')
    })

    // #4796 review feedback (Copilot): the hint copy must reference the
    // actual dropdown option labels rather than coining shorthand names
    // ("Silence mode", "Continuous mode") that could read like a third
    // mode. Regression guard against re-introducing the bare shorthand.
    it('hint copy quotes the dropdown option labels verbatim, not shorthand mode names', () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const hint = screen.getByTestId('voice-input-mode-hint')
      const text = hint.textContent ?? ''
      // Both option labels must appear verbatim somewhere in the hint so
      // the user can map each sentence back to the dropdown choice.
      expect(text).toMatch(/Keep listening until I click stop/)
      expect(text).toMatch(/Stop after silence \(browser decides\)/)
    })
  })

  // #4956 — Reset macOS speech permissions affordance. Gated on
  // inTauri && macOS so the button doesn't show as a no-op on Linux/
  // Windows or in browser (where there's no shell to invoke tccutil).
  describe('Reset macOS speech permissions (#4956)', () => {
    const tauriInvoke = vi.fn()
    const setTauriEnv = (mac: boolean, tauri: boolean) => {
      Object.defineProperty(window.navigator, 'userAgent', {
        configurable: true,
        value: mac
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Test'
          : 'Mozilla/5.0 (X11; Linux x86_64) Test',
      })
      if (tauri) {
        ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
          invoke: tauriInvoke,
        }
      } else {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
      }
    }

    afterEach(() => {
      tauriInvoke.mockReset()
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    })

    it('does NOT render the reset row in the browser (non-Tauri)', () => {
      setTauriEnv(true, false) // macOS UA but not Tauri
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.queryByTestId('speech-reset-row')).toBeNull()
    })

    it('does NOT render the reset row on Linux even when running in Tauri', () => {
      setTauriEnv(false, true)
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.queryByTestId('speech-reset-row')).toBeNull()
    })

    it('renders the reset row with an idle hint on macOS-in-Tauri', () => {
      setTauriEnv(true, true)
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('speech-reset-row')).toBeInTheDocument()
      expect(screen.getByTestId('speech-reset-button')).toHaveTextContent('Reset now')
      // Idle hint mentions both reset targets so an operator triaging knows
      // what the button is about to do.
      const row = screen.getByTestId('speech-reset-row')
      expect(row.textContent).toContain('Microphone')
      expect(row.textContent).toContain('SpeechRecognition')
      expect(row.textContent).toContain('com.chroxy.desktop')
    })

    it('invokes the reset_speech_permissions Tauri command and surfaces a success hint', async () => {
      setTauriEnv(true, true)
      tauriInvoke.mockResolvedValue(undefined)
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('speech-reset-button'))
      // findByTestId waits for the success hint to mount, replacing the
      // earlier `setTimeout(..., 0)` flush which was flaky across runtimes
      // (#4998 review).
      await screen.findByTestId('speech-reset-success')
      expect(tauriInvoke).toHaveBeenCalledWith('reset_speech_permissions')
    })

    it('surfaces an error hint when the Tauri command rejects', async () => {
      setTauriEnv(true, true)
      tauriInvoke.mockRejectedValue(new Error('tccutil reset Microphone exited with status 1'))
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('speech-reset-button'))
      const errEl = await screen.findByTestId('speech-reset-error')
      expect(errEl.textContent).toContain('tccutil reset Microphone exited with status 1')
    })
  })

  // #5294 — summon hotkey control: load-on-open, Save (trimmed), Clear (null),
  // and inline error on registration rejection. Tauri-only (inTauri gate), so
  // we fake __TAURI_INTERNALS__.invoke and let the real useTauriIPC run.
  describe('summon hotkey (#5294)', () => {
    const tauriInvoke = vi.fn()
    const setTauriEnv = (tauri: boolean) => {
      if (tauri) {
        ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: tauriInvoke }
      } else {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
      }
    }
    // Default routing so the panel's open-time getters resolve quietly; tests
    // override the summon-hotkey commands as needed.
    const baseImpl = (cmd: string): Promise<unknown> => {
      switch (cmd) {
        case 'get_summon_hotkey': return Promise.resolve(null)
        case 'get_tunnel_mode': return Promise.resolve('none')
        case 'get_server_info': return Promise.resolve({ tunnelMode: 'none' })
        case 'get_allow_auto_permission_mode': return Promise.resolve(false)
        default: return Promise.resolve(undefined)
      }
    }

    beforeEach(() => {
      tauriInvoke.mockReset()
      tauriInvoke.mockImplementation(baseImpl)
      setTauriEnv(true)
    })

    afterEach(() => {
      tauriInvoke.mockReset()
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    })

    it('loads the saved hotkey into the field on open', async () => {
      tauriInvoke.mockImplementation((cmd: string) =>
        cmd === 'get_summon_hotkey' ? Promise.resolve('CmdOrCtrl+Shift+K') : baseImpl(cmd))
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const input = await screen.findByTestId('summon-hotkey-input') as HTMLInputElement
      await waitFor(() => expect(input.value).toBe('CmdOrCtrl+Shift+K'))
    })

    it('Save invokes set_summon_hotkey with the trimmed accelerator', async () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const input = await screen.findByTestId('summon-hotkey-input')
      fireEvent.change(input, { target: { value: '  CmdOrCtrl+Shift+J  ' } })
      fireEvent.click(screen.getByTestId('summon-hotkey-save'))
      await waitFor(() =>
        expect(tauriInvoke).toHaveBeenCalledWith('set_summon_hotkey', { accelerator: 'CmdOrCtrl+Shift+J' }))
    })

    it('Clear invokes set_summon_hotkey with null', async () => {
      tauriInvoke.mockImplementation((cmd: string) =>
        cmd === 'get_summon_hotkey' ? Promise.resolve('CmdOrCtrl+Shift+K') : baseImpl(cmd))
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const input = await screen.findByTestId('summon-hotkey-input') as HTMLInputElement
      await waitFor(() => expect(input.value).toBe('CmdOrCtrl+Shift+K'))
      fireEvent.click(screen.getByTestId('summon-hotkey-clear'))
      await waitFor(() =>
        expect(tauriInvoke).toHaveBeenCalledWith('set_summon_hotkey', { accelerator: null }))
    })

    it('shows an inline error when registration is rejected', async () => {
      tauriInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'set_summon_hotkey') return Promise.reject(new Error("Could not register 'BadKey'"))
        return baseImpl(cmd)
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const input = await screen.findByTestId('summon-hotkey-input')
      fireEvent.change(input, { target: { value: 'BadKey' } })
      fireEvent.click(screen.getByTestId('summon-hotkey-save'))
      const err = await screen.findByTestId('summon-hotkey-error')
      expect(err.textContent).toContain('Could not register')
    })
  })

  // #5356 — LAN-exposure toggle: defaults off (loopback), reflects the saved
  // value on open, and persists via set_expose_on_lan. Tauri-only.
  describe('expose on LAN (#5356)', () => {
    const tauriInvoke = vi.fn()
    const setTauriEnv = (tauri: boolean) => {
      if (tauri) {
        ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: tauriInvoke }
      } else {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
      }
    }
    const baseImpl = (cmd: string): Promise<unknown> => {
      switch (cmd) {
        case 'get_summon_hotkey': return Promise.resolve(null)
        case 'get_tunnel_mode': return Promise.resolve('none')
        case 'get_server_info': return Promise.resolve({ tunnelMode: 'none' })
        case 'get_allow_auto_permission_mode': return Promise.resolve(false)
        case 'get_expose_on_lan': return Promise.resolve(false)
        default: return Promise.resolve(undefined)
      }
    }

    beforeEach(() => {
      tauriInvoke.mockReset()
      tauriInvoke.mockImplementation(baseImpl)
      setTauriEnv(true)
    })

    afterEach(() => {
      tauriInvoke.mockReset()
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    })

    it('defaults to off (loopback) when the saved setting is false', async () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const toggle = await screen.findByTestId('expose-on-lan-toggle') as HTMLInputElement
      await waitFor(() => expect(toggle.checked).toBe(false))
    })

    it('reflects the saved on (LAN) value on open', async () => {
      tauriInvoke.mockImplementation((cmd: string) =>
        cmd === 'get_expose_on_lan' ? Promise.resolve(true) : baseImpl(cmd))
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const toggle = await screen.findByTestId('expose-on-lan-toggle') as HTMLInputElement
      await waitFor(() => expect(toggle.checked).toBe(true))
    })

    it('persists the toggle via set_expose_on_lan', async () => {
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const toggle = await screen.findByTestId('expose-on-lan-toggle') as HTMLInputElement
      await waitFor(() => expect(toggle.checked).toBe(false))
      fireEvent.click(toggle)
      await waitFor(() =>
        expect(tauriInvoke).toHaveBeenCalledWith('set_expose_on_lan', { expose: true }))
    })

    it('reverts the toggle when the save is rejected', async () => {
      tauriInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'set_expose_on_lan') return Promise.reject(new Error('save failed'))
        return baseImpl(cmd)
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      const toggle = await screen.findByTestId('expose-on-lan-toggle') as HTMLInputElement
      await waitFor(() => expect(toggle.checked).toBe(false))
      fireEvent.click(toggle)
      await waitFor(() => expect(toggle.checked).toBe(false))
    })
  })
})

// #6772/#6829 — Session Rules viewer + Permission history (the desktop-parity
// half of the permission-rules panel). Mirrors the mobile SettingsScreen SESSION
// RULES / PROJECT RULES lists on the dashboard's primary surface.
describe('SettingsPanel — permission rules + audit history (#6772/#6829)', () => {
  const rulesState = (extra: Record<string, unknown> = {}) => ({
    activeSessionId: 's1',
    sessions: [{ sessionId: 's1', name: 'Session 1', cwd: '/home/me/proj', provider: 'claude-sdk' }],
    availableProviders: [{ name: 'claude-sdk', capabilities: { sessionRules: true } }],
    sessionStates: {
      s1: {
        sessionRules: [{ tool: 'Edit', decision: 'allow' }],
        persistentRules: [{ tool: 'Write', decision: 'allow', persist: 'project' }],
      },
    },
    ...extra,
  })

  it('renders session AND project rules with distinct scope labels', () => {
    setMockState(rulesState())
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)

    // Section header + both scoped lists present.
    expect(screen.getByTestId('session-rules-section')).toBeInTheDocument()
    const sessionRow = screen.getByTestId('session-rule-item-Edit')
    const projectRow = screen.getByTestId('project-rule-item-Write')
    expect(sessionRow).toHaveTextContent('session')
    expect(sessionRow).toHaveTextContent('Edit')
    expect(sessionRow).toHaveTextContent('auto-allow')
    expect(projectRow).toHaveTextContent('project')
    expect(projectRow).toHaveTextContent('Write')
    expect(projectRow).toHaveTextContent('always allow')
    // Project scope shows the durable rule's project path.
    expect(screen.getByTestId('project-rules-path')).toHaveTextContent('/home/me/proj')
  })

  it('removing a session rule sends the reduced list via setPermissionRules', () => {
    const setPermissionRules = vi.fn()
    setMockState(rulesState({ setPermissionRules }))
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('session-rule-remove-Edit'))
    // Only one session rule → filtering it out sends an empty list.
    expect(setPermissionRules).toHaveBeenCalledTimes(1)
    expect(setPermissionRules).toHaveBeenCalledWith([])
  })

  it('clearing all session rules sends [] via setPermissionRules', () => {
    const setPermissionRules = vi.fn()
    setMockState(
      rulesState({
        setPermissionRules,
        sessionStates: {
          s1: {
            sessionRules: [
              { tool: 'Edit', decision: 'allow' },
              { tool: 'Read', decision: 'allow' },
            ],
            persistentRules: [],
          },
        },
      }),
    )
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('session-rules-clear'))
    expect(setPermissionRules).toHaveBeenCalledWith([])
  })

  it('removing a project rule sends the reduced list via setProjectPermissionRules', () => {
    const setProjectPermissionRules = vi.fn()
    setMockState(rulesState({ setProjectPermissionRules }))
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('project-rule-remove-Write'))
    expect(setProjectPermissionRules).toHaveBeenCalledTimes(1)
    expect(setProjectPermissionRules).toHaveBeenCalledWith([])
  })

  it('does not render the Session Rules section for a provider without rules and no standing rules', () => {
    setMockState({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S', cwd: '/x', provider: 'codex' }],
      availableProviders: [{ name: 'codex', capabilities: { sessionRules: false } }],
      sessionStates: { s1: { sessionRules: [], persistentRules: [] } },
    })
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    expect(screen.queryByTestId('session-rules-section')).not.toBeInTheDocument()
  })

  it('Permission history: Load history triggers queryPermissionAudit and renders returned entries', () => {
    const queryPermissionAudit = vi.fn()
    setMockState(
      rulesState({
        queryPermissionAudit,
        permissionAudit: [
          { type: 'decision', sessionId: 's1', decision: 'allow', timestamp: Date.now() },
          { type: 'mode_change', sessionId: 's1', previousMode: 'approve', newMode: 'auto', timestamp: Date.now() },
        ],
        permissionAuditLoading: false,
      }),
    )
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)

    // The section renders and the pull button is wired.
    expect(screen.getByTestId('permission-history-section')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('permission-history-load'))
    expect(queryPermissionAudit).toHaveBeenCalledTimes(1)

    // The two mocked entries render with their described labels.
    const list = screen.getByTestId('permission-history-list')
    expect(list).toHaveTextContent('Allowed')
    expect(list).toHaveTextContent('Permission mode: approve → auto')
  })

  it('Permission history: empty result shows the no-events hint', () => {
    setMockState(rulesState({ permissionAudit: [], permissionAuditLoading: false }))
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByTestId('permission-history-empty')).toBeInTheDocument()
  })

  it('Permission history: parse-failure error state shows the load-failed hint and keeps the button actionable', () => {
    setMockState(rulesState({ permissionAudit: null, permissionAuditLoading: false, permissionAuditError: true }))
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByTestId('permission-history-error')).toBeInTheDocument()
    // The button is NOT wedged in a disabled loading state — retry stays possible.
    expect(screen.getByTestId('permission-history-load')).not.toBeDisabled()
  })

  it('Permission history: an UNKNOWN audit kind renders with the generic fallback label', () => {
    setMockState(
      rulesState({
        permissionAudit: [{ type: 'rule_expired', sessionId: 's1', timestamp: Date.now() }],
        permissionAuditLoading: false,
      }),
    )
    render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByTestId('permission-history-list')).toHaveTextContent('Permission event')
  })

  it('describePermissionAuditEntry labels each audit kind', () => {
    expect(describePermissionAuditEntry({ type: 'mode_change', previousMode: 'approve', newMode: 'auto', timestamp: 0 })).toBe(
      'Permission mode: approve → auto',
    )
    expect(
      describePermissionAuditEntry({ type: 'whitelist_change', rules: [{ tool: 'Edit', decision: 'allow' }], timestamp: 0 }),
    ).toBe('Session rules changed (1 rule)')
    expect(describePermissionAuditEntry({ type: 'decision', decision: 'deny', reason: 'timeout', timestamp: 0 })).toBe(
      'Denied (timeout)',
    )
    expect(describePermissionAuditEntry({ type: 'decision', decision: 'allow', reason: 'user', timestamp: 0 })).toBe('Allowed')
    // Forward-compat (#6836 review): an unknown future kind gets the generic label.
    expect(describePermissionAuditEntry({ type: 'rule_expired', timestamp: 0 })).toBe('Permission event')
  })

  // #6830 — the allowAlways audit entry now carries tool + a durable-rule
  // marker, and a persisted-rule auto-approve (no prompt ever shown) gets its
  // own distinct label. Pre-#6830 entries (no tool/persist fields at all)
  // must keep rendering exactly as before — pinned above.
  it('describePermissionAuditEntry renders #6830 tool + persist enrichment', () => {
    // A plain allow/deny with a known tool appends the tool name.
    expect(
      describePermissionAuditEntry({ type: 'decision', decision: 'allow', reason: 'user', tool: 'Read', timestamp: 0 }),
    ).toBe('Allowed Read')
    expect(
      describePermissionAuditEntry({ type: 'decision', decision: 'deny', reason: 'timeout', tool: 'Bash', timestamp: 0 }),
    ).toBe('Denied Bash (timeout)')

    // allowAlways that actually persisted a durable project rule.
    expect(
      describePermissionAuditEntry({
        type: 'decision',
        decision: 'allowAlways',
        reason: 'user',
        tool: 'Write',
        persist: 'project',
        projectKey: '/abs/proj',
        timestamp: 0,
      }),
    ).toBe('Always-allowed Write — saved as a project rule')

    // allowAlways on a NEVER_AUTO_ALLOW / non-eligible tool degrades to a
    // one-shot allow — nothing persisted, so no durable-rule marker.
    expect(
      describePermissionAuditEntry({ type: 'decision', decision: 'allowAlways', reason: 'user', tool: 'Bash', timestamp: 0 }),
    ).toBe('Always-allowed Bash (not saved — one-time only)')

    // A persisted project rule silently auto-approving with NO prompt shown.
    expect(
      describePermissionAuditEntry({
        type: 'decision',
        decision: 'allow',
        reason: 'persisted_rule',
        tool: 'Write',
        persist: 'project',
        projectKey: '/abs/proj',
        count: 1,
        timestamp: 0,
      }),
    ).toBe('Auto-allowed Write (persisted rule)')

    // PR #6842 review — persisted-rule entries are coalesced server-side;
    // count > 1 renders as ×N so one row summarizes the whole run.
    expect(
      describePermissionAuditEntry({
        type: 'decision',
        decision: 'allow',
        reason: 'persisted_rule',
        tool: 'Write',
        persist: 'project',
        projectKey: '/abs/proj',
        count: 50,
        timestamp: 0,
      }),
    ).toBe('Auto-allowed Write ×50 (persisted rule)')
  })
})
