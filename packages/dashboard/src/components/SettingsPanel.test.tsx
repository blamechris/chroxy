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
    // #4052: BYOK credentials defaults — refresh is a no-op spy by
    // default; individual tests override status / actions as needed.
    byokCredentialsStatus: null,
    refreshByokCredentialsStatus: vi.fn(),
    setByokCredentials: vi.fn(),
    clearByokCredentials: vi.fn(),
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
        byokCredentialsStatus: { status: 'set', source: 'file', masked: 'sk-ant-api03...[95 chars redacted]' },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.getByTestId('byok-status').textContent).toContain('Set (file)')
      expect(screen.getByTestId('byok-status').textContent).toContain('sk-ant-api03...[95 chars redacted]')
      // Remove button only visible when source = file (env key is owned outside).
      expect(screen.getByTestId('byok-clear-button')).toBeInTheDocument()
    })

    it('hides the Remove button when source is env (chroxy did not write the key)', () => {
      setMockState({
        byokCredentialsStatus: { status: 'set', source: 'env', masked: 'sk-ant-api03...[95 chars redacted]' },
      })
      render(<SettingsPanel isOpen={true} onClose={vi.fn()} />)
      expect(screen.queryByTestId('byok-clear-button')).not.toBeInTheDocument()
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
        byokCredentialsStatus: { status: 'set', source: 'file', masked: 'sk-ant-api03...[95 chars redacted]' },
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
})
