/**
 * GithubWebhookConfig (#6540, item 3 of #6536) — renderer + interaction tests.
 *
 * Covers the webhook-secret setup panel against a mocked `github_webhook_config`:
 *   - collapsed vs expanded (toggle)
 *   - payload URL + copy (success and failure paths), recommended events, delivery readout
 *   - status tag reflects configured / source
 *   - set/rotate sends the typed secret and clears the input; Clear calls clear
 *   - Generate fills a random secret (write-only field — never shows the stored value)
 *   - Generate is disabled, and never falls back to a weak PRNG, without a secure RNG
 *   - env-wins hides the editable field and describes it as a fallback, not a precedence win
 *   - LAN-only note renders
 *   - refresh fires when the panel opens
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ServerGithubWebhookConfigMessage } from '@chroxy/protocol'

const { addServerError, writeText } = vi.hoisted(() => ({
  addServerError: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock('../store/connection', () => {
  const state = {
    githubWebhookConfig: null,
    githubWebhookConfigLoading: false,
    connectionPhase: 'connected',
    requestGithubWebhookConfig: () => false,
    setGithubWebhookSecret: () => false,
    clearGithubWebhookSecret: () => false,
    addServerError,
  }
  const useConnectionStore = (selector: (s: unknown) => unknown) => selector(state)
  useConnectionStore.getState = () => state
  return { useConnectionStore }
})

vi.mock('../utils/clipboard', () => ({ writeText }))

import { GithubWebhookConfig, generateWebhookSecret } from './GithubWebhookConfig'

afterEach(cleanup)
beforeEach(() => {
  addServerError.mockClear()
  writeText.mockReset()
  writeText.mockResolvedValue(true)
})

/** Force `globalThis.crypto` off so `generateWebhookSecret` takes its no-secure-RNG branch. */
function withoutSecureCrypto<T>(run: () => T): T {
  const original = globalThis.crypto
  // @ts-expect-error — deliberately simulating a non-secure context for the test.
  delete globalThis.crypto
  try {
    return run()
  } finally {
    globalThis.crypto = original
  }
}

function config(over: Partial<ServerGithubWebhookConfigMessage> = {}): ServerGithubWebhookConfigMessage {
  return {
    type: 'github_webhook_config',
    generatedAt: '2026-07-23T12:00:00.000Z',
    configured: true,
    source: 'store',
    payloadUrl: 'https://abc.trycloudflare.com/api/github/webhook',
    lanOnly: false,
    note: null,
    recommendedEvents: ['pull_request', 'issues', 'push', 'release'],
    deliveries: { total: 3, verified: 2, rejected: 1, lastAt: '2026-07-23T11:59:00.000Z', lastResult: 'verified', lastKind: 'push' },
    ...over,
  }
}

describe('generateWebhookSecret', () => {
  it('produces a prefixed high-entropy secret', () => {
    const a = generateWebhookSecret()
    const b = generateWebhookSecret()
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a?.startsWith('whsec_')).toBe(true)
    expect(a?.length).toBeGreaterThan(40)
    expect(a).not.toEqual(b)
  })

  // Copilot review (#6940): must NEVER fall back to Math.random() — that PRNG
  // is guessable and this value becomes HMAC key material. Without a secure
  // RNG, the function must return null rather than a weak secret.
  it('returns null (never a Math.random() fallback) when no secure RNG is available', () => {
    withoutSecureCrypto(() => {
      expect(generateWebhookSecret()).toBeNull()
    })
  })
})

describe('GithubWebhookConfig (#6540)', () => {
  it('collapsed shows only the toggle (no body)', () => {
    render(<GithubWebhookConfig open={false} onToggle={() => {}} config={config()} onRefresh={() => {}} />)
    expect(screen.getByTestId('github-webhook-toggle')).toBeTruthy()
    expect(screen.queryByTestId('github-webhook-body')).toBeNull()
  })

  it('expanded renders payload URL, events, deliveries and a Rotate/Clear for a stored secret', () => {
    render(<GithubWebhookConfig open onToggle={() => {}} config={config()} onRefresh={() => {}} />)
    expect(screen.getByTestId('github-webhook-payload-url').textContent).toBe('https://abc.trycloudflare.com/api/github/webhook')
    expect(screen.getByTestId('github-webhook-status').textContent).toContain('stored')
    expect(screen.getByTestId('github-webhook-event-pull_request')).toBeTruthy()
    expect(screen.getByTestId('github-webhook-deliveries-total').textContent).toBe('3')
    expect(screen.getByTestId('github-webhook-deliveries-verified').textContent).toBe('2')
    // configured + source=store → the button reads "Rotate" and Clear is present
    expect(screen.getByTestId('github-webhook-save').textContent).toBe('Rotate')
    expect(screen.getByTestId('github-webhook-clear')).toBeTruthy()
  })

  it('sends the typed secret on Save/Rotate and clears the input', () => {
    const onSetSecret = vi.fn(() => true)
    render(<GithubWebhookConfig open onToggle={() => {}} config={config({ configured: false, source: 'none' })} onRefresh={() => {}} onSetSecret={onSetSecret} />)
    const input = screen.getByTestId('github-webhook-secret-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'my-webhook-secret' } })
    fireEvent.click(screen.getByTestId('github-webhook-save'))
    expect(onSetSecret).toHaveBeenCalledWith('my-webhook-secret')
    expect(input.value).toBe('')
  })

  it('Clear calls the clear action', () => {
    const onClearSecret = vi.fn(() => true)
    render(<GithubWebhookConfig open onToggle={() => {}} config={config()} onRefresh={() => {}} onClearSecret={onClearSecret} />)
    fireEvent.click(screen.getByTestId('github-webhook-clear'))
    expect(onClearSecret).toHaveBeenCalled()
  })

  it('Generate fills the write-only field with a fresh secret', () => {
    render(<GithubWebhookConfig open onToggle={() => {}} config={config({ configured: false, source: 'none' })} onRefresh={() => {}} />)
    const input = screen.getByTestId('github-webhook-secret-input') as HTMLInputElement
    expect(input.value).toBe('')
    fireEvent.click(screen.getByTestId('github-webhook-generate'))
    expect(input.value.startsWith('whsec_')).toBe(true)
  })

  it('disables Generate and shows a note (no weak secret) when no secure RNG is available', () => {
    withoutSecureCrypto(() => {
      render(<GithubWebhookConfig open onToggle={() => {}} config={config({ configured: false, source: 'none' })} onRefresh={() => {}} />)
      const generateBtn = screen.getByTestId('github-webhook-generate') as HTMLButtonElement
      const input = screen.getByTestId('github-webhook-secret-input') as HTMLInputElement
      expect(generateBtn.disabled).toBe(true)
      fireEvent.click(generateBtn)
      expect(input.value).toBe('')
      expect(screen.getByTestId('github-webhook-generate-unavailable')).toBeTruthy()
    })
  })

  it('Copy flashes "Copied" only after a successful write', async () => {
    writeText.mockResolvedValue(true)
    render(<GithubWebhookConfig open onToggle={() => {}} config={config()} onRefresh={() => {}} />)
    fireEvent.click(screen.getByTestId('github-webhook-copy'))
    expect(writeText).toHaveBeenCalledWith('https://abc.trycloudflare.com/api/github/webhook')
    await waitFor(() => expect(screen.getByTestId('github-webhook-copy').textContent).toBe('Copied'))
    expect(addServerError).not.toHaveBeenCalled()
  })

  // Copilot review (#6940): a rejected/unavailable clipboard write must never
  // show "Copied" and must not produce an unhandled rejection — the helper
  // resolves to `false` and the component surfaces a warning toast instead.
  it('Copy never claims success when the clipboard write fails', async () => {
    writeText.mockResolvedValue(false)
    render(<GithubWebhookConfig open onToggle={() => {}} config={config()} onRefresh={() => {}} />)
    fireEvent.click(screen.getByTestId('github-webhook-copy'))
    await waitFor(() => expect(addServerError).toHaveBeenCalled())
    expect(screen.getByTestId('github-webhook-copy').textContent).toBe('Copy')
    expect(addServerError).toHaveBeenCalledWith(expect.any(String), undefined, 'warning')
  })

  it('env-wins hides the editable field and describes it as a fallback', () => {
    render(<GithubWebhookConfig open onToggle={() => {}} config={config({ source: 'env' })} onRefresh={() => {}} />)
    const hint = screen.getByTestId('github-webhook-env-hint')
    expect(hint).toBeTruthy()
    expect(hint.textContent).toContain('fallback')
    expect(hint.textContent).not.toMatch(/takes precedence over it here|environment variable.*takes precedence over a stored value/)
    expect(screen.queryByTestId('github-webhook-secret-input')).toBeNull()
    // The status tag must not claim the env var "wins" — a stored secret does.
    expect(screen.getByTestId('github-webhook-status').textContent).not.toMatch(/^Set \(environment\)$/)
  })

  it('renders the LAN-only unreachable note', () => {
    render(<GithubWebhookConfig open onToggle={() => {}} config={config({ lanOnly: true, note: 'No tunnel active — GitHub cannot reach this.' })} onRefresh={() => {}} />)
    expect(screen.getByTestId('github-webhook-lan-note').textContent).toContain('No tunnel active')
  })

  it('refreshes the config when the panel opens', () => {
    const onRefresh = vi.fn()
    render(<GithubWebhookConfig open onToggle={() => {}} config={null} onRefresh={onRefresh} />)
    expect(onRefresh).toHaveBeenCalled()
  })
})
