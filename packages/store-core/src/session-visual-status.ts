export const SESSION_STALE_AFTER_MS = 60 * 60 * 1000

export type SessionVisualStatus = 'idle' | 'working' | 'stale'

export interface SessionVisualStatusInput {
  isBusy?: boolean
  isIdle?: boolean
  streamingMessageId?: string | null
  activeAgentCount?: number
  lastActivityAt?: number | null
  now?: number
  staleAfterMs?: number
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function deriveSessionVisualStatus(input: SessionVisualStatusInput): SessionVisualStatus {
  const isWorking =
    input.isBusy === true ||
    Boolean(input.streamingMessageId) ||
    input.isIdle === false ||
    (input.activeAgentCount ?? 0) > 0

  if (isWorking) return 'working'

  const staleAfterMs = input.staleAfterMs ?? SESSION_STALE_AFTER_MS
  const now = input.now ?? Date.now()
  const lastActivityAt = input.lastActivityAt

  if (staleAfterMs > 0 && isFiniteTimestamp(lastActivityAt) && now - lastActivityAt >= staleAfterMs) {
    return 'stale'
  }

  return 'idle'
}
