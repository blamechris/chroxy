import { isRetrySafeNotDispatched, type InputDeliveryRecord } from './input-delivery'

export type ComposerRecoveryResult = 'ignored' | 'restored' | 'offer'

/**
 * Restore only when a correlated acknowledgement proves non-dispatch and the
 * original composer is still empty. Readiness changes never call this helper.
 */
export function recoverRejectedComposer<T>(
  delivery: InputDeliveryRecord | undefined,
  snapshot: T,
  options: {
    originalSessionActive: boolean
    composerUnchanged: boolean
    restore: (snapshot: T) => void | boolean
  },
): ComposerRecoveryResult {
  if (!isRetrySafeNotDispatched(delivery)) return 'ignored'
  if (!options.originalSessionActive || !options.composerUnchanged) return 'offer'
  return options.restore(snapshot) === false ? 'offer' : 'restored'
}

/** Retain each proven-unsent submission until send, dismissal, or intentional clear.
 * Restored entries track subsequent edits, and become offers if their origin is
 * removed. FIFO offers prevent a later acknowledgement replacing earlier work.
 */
export class ComposerRecoveryQueue<T extends { clientMessageId: string; sessionId: string }> {
  private entries = new Map<string, { snapshot: T; restored: boolean }>()

  get hasWork(): boolean { return this.entries.size > 0 }
  get offer(): T | null {
    for (const entry of this.entries.values()) if (!entry.restored) return entry.snapshot
    return null
  }
  retain(snapshot: T, restored = false): void {
    this.entries.set(snapshot.clientMessageId, { snapshot, restored })
  }
  dismiss(clientMessageId: string): void { this.entries.delete(clientMessageId) }
  releaseRestored(sessionId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.restored && entry.snapshot.sessionId === sessionId) this.entries.delete(id)
    }
  }
  updateRestored(sessionId: string, update: (snapshot: T) => T | null): void {
    for (const [id, entry] of this.entries) {
      if (!entry.restored || entry.snapshot.sessionId !== sessionId) continue
      const snapshot = update(entry.snapshot)
      if (snapshot) entry.snapshot = snapshot
      else this.entries.delete(id)
    }
  }
  prune(liveSessionIds: ReadonlySet<string>): void {
    for (const entry of this.entries.values()) {
      if (!liveSessionIds.has(entry.snapshot.sessionId)) entry.restored = false
    }
  }
}
