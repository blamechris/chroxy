/**
 * Tests for SetupWizard (#6787) — wires get_setup_state / check_dependencies
 * / save_setup_config to a first-run onboarding panel.
 *
 * Mocks `window.__TAURI_INTERNALS__.invoke` the same way useVoiceInput.test.ts
 * does, since SetupWizard talks to Tauri commands directly rather than
 * through a WS-driven store.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { SetupWizard } from './SetupWizard'

type InvokeResponses = {
  setupState?: unknown
  dependencies?: unknown
  saveSetupConfigImpl?: (args: Record<string, unknown>) => unknown
}

let mockInvoke: ReturnType<typeof vi.fn>

function setupTauriMock(responses: InvokeResponses) {
  mockInvoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'get_setup_state') return responses.setupState
    if (cmd === 'check_dependencies') return responses.dependencies
    if (cmd === 'save_setup_config') {
      if (responses.saveSetupConfigImpl) return responses.saveSetupConfigImpl(args || {})
      return undefined
    }
    if (cmd === 'start_server') return undefined
    return undefined
  })

  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: { invoke: mockInvoke },
    writable: true,
    configurable: true,
  })
}

function clearTauriMock() {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
}

const PASSING_DEPS = {
  node22: { found: true, path: '/usr/local/bin/node', version: 'v22.1.0' },
  cloudflared: { found: true },
  claude: { found: true, version: '1.0.0' },
}

const FAILING_DEPS = {
  node22: { found: false, path: null, version: null },
  cloudflared: { found: false },
  claude: { found: false, version: null },
}

afterEach(() => {
  cleanup()
  clearTauriMock()
})

describe('SetupWizard', () => {
  it('renders nothing outside Tauri (plain web dashboard, #6787)', async () => {
    // No __TAURI_INTERNALS__ defined at all.
    render(<SetupWizard />)
    expect(screen.queryByTestId('setup-wizard')).not.toBeInTheDocument()
    // Give any stray effects a tick to settle before asserting stability.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId('setup-wizard')).not.toBeInTheDocument()
  })

  it('renders nothing when setup is already complete (isFirstRun: false)', async () => {
    setupTauriMock({ setupState: { isFirstRun: false, port: 8765, tunnelMode: 'none', isRunning: true } })
    render(<SetupWizard />)
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('get_setup_state', undefined))
    expect(screen.queryByTestId('setup-wizard')).not.toBeInTheDocument()
    // check_dependencies must never be called when the wizard doesn't show.
    expect(mockInvoke).not.toHaveBeenCalledWith('check_dependencies', undefined)
  })

  it('renders the wizard on first run and shows pass/fail dependency rows', async () => {
    setupTauriMock({
      setupState: { isFirstRun: true, port: 8765, tunnelMode: 'none', isRunning: false },
      dependencies: FAILING_DEPS,
    })
    render(<SetupWizard />)

    await screen.findByTestId('setup-wizard')

    await waitFor(() => {
      expect(screen.getByTestId('setup-wizard-dep-node')).toHaveClass('setup-wizard-dep-row--fail')
      expect(screen.getByTestId('setup-wizard-dep-cloudflared')).toHaveClass('setup-wizard-dep-row--fail')
      expect(screen.getByTestId('setup-wizard-dep-claude')).toHaveClass('setup-wizard-dep-row--fail')
    })
  })

  it('shows passing dependency rows when all tools are found', async () => {
    setupTauriMock({
      setupState: { isFirstRun: true, port: 8765, tunnelMode: 'none', isRunning: false },
      dependencies: PASSING_DEPS,
    })
    render(<SetupWizard />)

    await screen.findByTestId('setup-wizard')

    await waitFor(() => {
      expect(screen.getByTestId('setup-wizard-dep-node')).toHaveClass('setup-wizard-dep-row--pass')
      expect(screen.getByTestId('setup-wizard-dep-cloudflared')).toHaveClass('setup-wizard-dep-row--pass')
      expect(screen.getByTestId('setup-wizard-dep-claude')).toHaveClass('setup-wizard-dep-row--pass')
    })
    expect(screen.getByText(/v22\.1\.0/)).toBeInTheDocument()
  })

  it('re-check button re-invokes check_dependencies', async () => {
    setupTauriMock({
      setupState: { isFirstRun: true, port: 8765, tunnelMode: 'none', isRunning: false },
      dependencies: FAILING_DEPS,
    })
    render(<SetupWizard />)
    await screen.findByTestId('setup-wizard')
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('check_dependencies', undefined))

    const callsBefore = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'check_dependencies').length
    fireEvent.click(screen.getByTestId('setup-wizard-recheck'))

    await waitFor(() => {
      const callsAfter = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'check_dependencies').length
      expect(callsAfter).toBeGreaterThan(callsBefore)
    })
  })

  it('finish calls save_setup_config with the chosen port + tunnel mode, then hides', async () => {
    setupTauriMock({
      setupState: { isFirstRun: true, port: 8765, tunnelMode: 'none', isRunning: false },
      dependencies: PASSING_DEPS,
    })
    render(<SetupWizard />)
    await screen.findByTestId('setup-wizard')

    fireEvent.change(screen.getByTestId('setup-wizard-port'), { target: { value: '9090' } })
    fireEvent.change(screen.getByTestId('setup-wizard-tunnel-mode'), { target: { value: 'quick' } })
    fireEvent.click(screen.getByTestId('setup-wizard-finish'))

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('save_setup_config', { port: 9090, tunnelMode: 'quick' })
    })
    await waitFor(() => expect(screen.queryByTestId('setup-wizard')).not.toBeInTheDocument())
    // Finishing also starts the embedded server, mirroring the existing
    // "Start Server" affordance.
    expect(mockInvoke).toHaveBeenCalledWith('start_server', undefined)
  })

  it('surfaces a save error and keeps the wizard open on failure', async () => {
    setupTauriMock({
      setupState: { isFirstRun: true, port: 8765, tunnelMode: 'none', isRunning: false },
      dependencies: PASSING_DEPS,
      saveSetupConfigImpl: () => {
        throw new Error('disk full')
      },
    })
    render(<SetupWizard />)
    await screen.findByTestId('setup-wizard')

    fireEvent.click(screen.getByTestId('setup-wizard-finish'))

    await screen.findByTestId('setup-wizard-error')
    expect(screen.getByTestId('setup-wizard')).toBeInTheDocument()
  })
})
