/**
 * ProviderCredentialsPane tests (#3855).
 *
 * Verifies the pane renders one row per credential, surfaces masked status,
 * gates Edit/Remove on source, shows the env-precedence hint read-only, fires
 * the set/delete/test store actions, and renders inline test results — all
 * without ever rendering a raw secret (the store only holds masked previews).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ProviderCredentialsPane } from './ProviderCredentialsPane'
import type { ProviderCredentialEntry, ProviderCredentialTestResult } from '../store/types'

const mockSetCredential = vi.fn(() => true)
const mockDeleteCredential = vi.fn(() => true)
const mockTestCredential = vi.fn(() => true)
const mockRefresh = vi.fn(() => true)

let mockState: Record<string, unknown> = {}

function entry(over: Partial<ProviderCredentialEntry> = {}): ProviderCredentialEntry {
  return {
    key: 'OPENAI_API_KEY',
    provider: 'OpenAI / Codex',
    label: 'OpenAI API key',
    kind: 'api-key',
    status: 'missing',
    source: 'none',
    oauth: false,
    ...over,
  }
}

function setMockState(extra: Record<string, unknown> = {}): void {
  mockState = {
    credentialsStatus: { credentials: [], fileExists: false, fileError: null },
    credentialTestResults: {} as Record<string, ProviderCredentialTestResult>,
    refreshCredentialsStatus: mockRefresh,
    setCredential: mockSetCredential,
    deleteCredential: mockDeleteCredential,
    testCredential: mockTestCredential,
    ...extra,
  }
}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockState),
}))

beforeEach(() => {
  mockSetCredential.mockClear()
  mockDeleteCredential.mockClear()
  mockTestCredential.mockClear()
  mockRefresh.mockClear()
  setMockState()
})

afterEach(cleanup)

describe('ProviderCredentialsPane', () => {
  it('refreshes status when opened', () => {
    render(<ProviderCredentialsPane isOpen={true} />)
    expect(mockRefresh).toHaveBeenCalled()
  })

  it('shows a loading hint when no snapshot has arrived', () => {
    setMockState({ credentialsStatus: null })
    render(<ProviderCredentialsPane isOpen={true} />)
    expect(screen.getByTestId('provider-credentials-loading')).toBeTruthy()
  })

  it('renders one row per credential with masked status', () => {
    setMockState({
      credentialsStatus: {
        credentials: [
          entry({ key: 'OPENAI_API_KEY', status: 'set', source: 'store', masked: 'sk-o...[20 chars redacted]' }),
          entry({ key: 'GEMINI_API_KEY', provider: 'Google Gemini', label: 'Gemini API key', status: 'missing', source: 'none' }),
        ],
        fileExists: true,
      },
    })
    render(<ProviderCredentialsPane isOpen={true} />)
    expect(screen.getByTestId('credential-row-OPENAI_API_KEY')).toBeTruthy()
    expect(screen.getByTestId('credential-row-GEMINI_API_KEY')).toBeTruthy()
    const status = screen.getByTestId('credential-status-OPENAI_API_KEY')
    expect(status.textContent).toContain('Set (stored)')
    expect(status.textContent).toContain('sk-o...[20 chars redacted]')
  })

  it('shows the env-precedence hint read-only and hides Edit/Remove when env wins', () => {
    setMockState({
      credentialsStatus: {
        credentials: [entry({ key: 'OPENAI_API_KEY', status: 'set', source: 'env', masked: 'sk-e...[10 chars redacted]' })],
      },
    })
    render(<ProviderCredentialsPane isOpen={true} />)
    expect(screen.getByTestId('credential-env-hint-OPENAI_API_KEY')).toBeTruthy()
    expect(screen.queryByTestId('credential-edit-OPENAI_API_KEY')).toBeNull()
    expect(screen.queryByTestId('credential-remove-OPENAI_API_KEY')).toBeNull()
    // Test is still available for env-sourced credentials.
    expect(screen.getByTestId('credential-test-OPENAI_API_KEY')).toBeTruthy()
  })

  it('shows OAuth read-only status without a stored value', () => {
    setMockState({
      credentialsStatus: {
        credentials: [entry({ key: 'ANTHROPIC_API_KEY', provider: 'Anthropic', label: 'Anthropic API key', status: 'missing', source: 'oauth', oauth: true })],
      },
    })
    render(<ProviderCredentialsPane isOpen={true} />)
    const status = screen.getByTestId('credential-status-ANTHROPIC_API_KEY')
    expect(status.textContent).toContain('OAuth (subscription)')
    // No masked preview rendered for an OAuth source.
    expect(status.textContent).not.toContain('redacted')
  })

  it('expands the inline editor and fires setCredential on Save', () => {
    setMockState({
      credentialsStatus: { credentials: [entry({ key: 'GEMINI_API_KEY', provider: 'Google Gemini', label: 'Gemini API key' })] },
    })
    render(<ProviderCredentialsPane isOpen={true} />)
    fireEvent.click(screen.getByTestId('credential-edit-GEMINI_API_KEY'))
    const input = screen.getByTestId('credential-input-GEMINI_API_KEY') as HTMLInputElement
    expect(input.type).toBe('password') // never a visible text field
    fireEvent.change(input, { target: { value: 'gemini-new-key' } })
    fireEvent.click(screen.getByTestId('credential-save-GEMINI_API_KEY'))
    expect(mockSetCredential).toHaveBeenCalledWith('GEMINI_API_KEY', 'gemini-new-key')
  })

  it('fires deleteCredential on Remove for a stored value', () => {
    setMockState({
      credentialsStatus: { credentials: [entry({ key: 'GEMINI_API_KEY', status: 'set', source: 'store', masked: 'g...[5 chars redacted]' })] },
    })
    render(<ProviderCredentialsPane isOpen={true} />)
    fireEvent.click(screen.getByTestId('credential-remove-GEMINI_API_KEY'))
    expect(mockDeleteCredential).toHaveBeenCalledWith('GEMINI_API_KEY')
  })

  it('fires testCredential on Test and renders the inline result', () => {
    setMockState({
      credentialsStatus: { credentials: [entry({ key: 'OPENAI_API_KEY', status: 'set', source: 'store', masked: 'sk...[3 chars redacted]' })] },
      credentialTestResults: { OPENAI_API_KEY: { ok: true, model: 'models.list', latencyMs: 42 } },
    })
    render(<ProviderCredentialsPane isOpen={true} />)
    fireEvent.click(screen.getByTestId('credential-test-OPENAI_API_KEY'))
    expect(mockTestCredential).toHaveBeenCalledWith('OPENAI_API_KEY')
    const result = screen.getByTestId('credential-test-result-OPENAI_API_KEY')
    expect(result.textContent).toContain('OK')
    expect(result.textContent).toContain('42ms')
  })

  it('renders a failed test result with the error', () => {
    setMockState({
      credentialsStatus: { credentials: [entry({ key: 'OPENAI_API_KEY', status: 'set', source: 'store', masked: 'sk...[3 chars redacted]' })] },
      credentialTestResults: { OPENAI_API_KEY: { ok: false, error: 'Authentication failed (HTTP 401).' } },
    })
    render(<ProviderCredentialsPane isOpen={true} />)
    const result = screen.getByTestId('credential-test-result-OPENAI_API_KEY')
    expect(result.textContent).toContain('Failed')
    expect(result.textContent).toContain('401')
  })

  it('surfaces a WS-closed error when a write is dropped', () => {
    mockSetCredential.mockReturnValueOnce(false)
    setMockState({
      credentialsStatus: { credentials: [entry({ key: 'GEMINI_API_KEY' })] },
    })
    render(<ProviderCredentialsPane isOpen={true} />)
    fireEvent.click(screen.getByTestId('credential-edit-GEMINI_API_KEY'))
    fireEvent.change(screen.getByTestId('credential-input-GEMINI_API_KEY'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('credential-save-GEMINI_API_KEY'))
    expect(screen.getByTestId('credential-ws-closed-GEMINI_API_KEY')).toBeTruthy()
  })

  it('surfaces a file error from the store', () => {
    setMockState({
      credentialsStatus: { credentials: [entry()], fileError: 'credentials.json has mode 644; refusing to read' },
    })
    render(<ProviderCredentialsPane isOpen={true} />)
    expect(screen.getByTestId('provider-credentials-file-error').textContent).toContain('mode 644')
  })
})
