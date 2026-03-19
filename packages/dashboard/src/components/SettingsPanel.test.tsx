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

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      activeTheme: 'default',
      setTheme: mockSetTheme,
      defaultProvider: 'claude-sdk',
      setDefaultProvider: vi.fn(),
      inputSettings: { chatEnterToSend: true, terminalEnterToSend: false },
      updateInputSettings: mockUpdateInputSettings,
    }
    return selector(state)
  },
}))

beforeEach(() => {
  mockSetTheme.mockClear()
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
})
