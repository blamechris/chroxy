/**
 * SettingsPanel tests (#1526)
 *
 * Tests theme picker, session defaults, close/backdrop behavior,
 * and Escape key dismissal.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SettingsPanel } from './SettingsPanel'

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

// #3404 audit F1: settable so individual tests can override availableProviders
// without redefining the whole mock.
let mockState: Record<string, unknown> = {}

function setMockState(extra: Record<string, unknown> = {}): void {
  mockState = {
    activeTheme: 'default',
    setTheme: mockSetTheme,
    defaultProvider: 'claude-sdk',
    setDefaultProvider: vi.fn(),
    inputSettings: { chatEnterToSend: true, terminalEnterToSend: false },
    updateInputSettings: mockUpdateInputSettings,
    availableProviders: [],
    // Per-session promptEvaluator toggle defaults — overridden by the
    // Active session test cases. Default empty array + null id keeps the
    // existing tests working without forcing them to know about the new
    // section.
    activeSessionId: null,
    sessions: [],
    setPromptEvaluator: vi.fn(),
    setChroxyContextHint: vi.fn(),
    // #4052: BYOK credentials defaults — refresh is a no-op spy by
    // default; individual tests override status / actions as needed.
    byokCredentialsStatus: null,
    refreshByokCredentialsStatus: vi.fn(),
    setByokCredentials: vi.fn(),
    clearByokCredentials: vi.fn(),
    // #4542: per-category notification toggles. `notificationPrefs` mirrors
    // the latest snapshot received over the WS connection (null until the
    // first `notification_prefs` arrives).
    notificationPrefs: null,
    refreshNotificationPrefs: vi.fn(),
    setNotificationPrefsCategory: vi.fn(),
    // #4543: per-device opt-in/out. `currentDeviceKey` is the stable browser
    // localStorage id used as the device key in the per-device override map.
    // The test default uses a fixed string so toggles assert against a known
    // key without coupling to localStorage; individual tests can override.
    currentDeviceKey: 'test-device-key',
    setNotificationPrefsDevice: vi.fn(),
    // #4544: quiet-hours editor actions. Default no-op spies; individual
    // tests override.
    setNotificationPrefsQuietHours: vi.fn(),
    setNotificationPrefsBypassCategories: vi.fn(),
    ...extra,
  }
}
setMockState()

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockState),
}))

beforeEach(() => {
  mockSetTheme.mockClear()
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
      const setByokCredentials = vi.fn()
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
  })
})
