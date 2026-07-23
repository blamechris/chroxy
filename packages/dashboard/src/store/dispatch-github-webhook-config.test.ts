/**
 * Integration test for the repo-events webhook-secret config wiring (#6540, item
 * 3 of #6536). Guards: a `github_webhook_config` REPLACES githubWebhookConfig +
 * clears loading; a malformed payload is dropped WITHOUT clearing loading.
 * Mirrors dispatch-repo-events.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0, DIRECTION_SERVER: 1,
}))
vi.mock('./persistence', () => ({ clearPersistedSession: vi.fn() }))

import { handleMessage, setStore, clearDeltaBuffers, clearPermissionSplits, stopHeartbeat, resetReplayFlags } from './message-handler'
import type { ConnectionState } from './types'
import type { ServerGithubWebhookConfigMessage } from '@chroxy/protocol'

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      state = { ...state, ...(typeof s === 'function' ? s(state) : s) }
    },
  }
}

function baseState(): Partial<ConnectionState> {
  return { connectionPhase: 'connected', socket: null, githubWebhookConfig: null, githubWebhookConfigLoading: true, messages: [] }
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

describe('dispatch: github_webhook_config (#6540)', () => {
  let store: ReturnType<typeof createMockStore>
  beforeEach(() => {
    store = createMockStore(baseState())
    setStore(store as never)
  })
  afterEach(() => {
    clearDeltaBuffers(); clearPermissionSplits(); stopHeartbeat(); resetReplayFlags()
  })

  it('applies a github_webhook_config and clears loading', () => {
    handleMessage(config() as never, {} as never)
    const s = store.getState()
    expect(s.githubWebhookConfig!.source).toBe('store')
    expect(s.githubWebhookConfig!.payloadUrl).toBe('https://abc.trycloudflare.com/api/github/webhook')
    expect(s.githubWebhookConfig!.deliveries.total).toBe(3)
    expect(s.githubWebhookConfigLoading).toBe(false)
  })

  it('applies a not-configured / LAN-only config', () => {
    handleMessage(config({ configured: false, source: 'none', lanOnly: true, note: 'no tunnel' }) as never, {} as never)
    const s = store.getState()
    expect(s.githubWebhookConfig!.configured).toBe(false)
    expect(s.githubWebhookConfig!.lanOnly).toBe(true)
    expect(s.githubWebhookConfigLoading).toBe(false)
  })

  it('drops a malformed payload WITHOUT clearing loading', () => {
    handleMessage({ type: 'github_webhook_config', source: 'bogus' } as never, {} as never)
    const s = store.getState()
    expect(s.githubWebhookConfig).toBeNull()
    expect(s.githubWebhookConfigLoading).toBe(true)
  })
})
