/**
 * GithubWebhookConfig (#6540, item 3 of #6536) — renderer + interaction tests.
 *
 * Covers the webhook-secret setup panel against a mocked `github_webhook_config`:
 *   - collapsed vs expanded (toggle)
 *   - payload URL + copy, recommended events, delivery readout
 *   - status tag reflects configured / source
 *   - set/rotate sends the typed secret and clears the input; Clear calls clear
 *   - Generate fills a random secret (write-only field — never shows the stored value)
 *   - env-wins hides the editable field
 *   - LAN-only note renders
 *   - refresh fires when the panel opens
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ServerGithubWebhookConfigMessage } from '@chroxy/protocol'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      githubWebhookConfig: null,
      githubWebhookConfigLoading: false,
      connectionPhase: 'connected',
      requestGithubWebhookConfig: () => false,
      setGithubWebhookSecret: () => false,
      clearGithubWebhookSecret: () => false,
    }),
}))

import { GithubWebhookConfig, generateWebhookSecret } from './GithubWebhookConfig'

afterEach(cleanup)

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
    expect(a.startsWith('whsec_')).toBe(true)
    expect(a.length).toBeGreaterThan(40)
    expect(a).not.toEqual(b)
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

  it('env-wins hides the editable field and shows a hint', () => {
    render(<GithubWebhookConfig open onToggle={() => {}} config={config({ source: 'env' })} onRefresh={() => {}} />)
    expect(screen.getByTestId('github-webhook-env-hint')).toBeTruthy()
    expect(screen.queryByTestId('github-webhook-secret-input')).toBeNull()
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
