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
    restore: (snapshot: T) => void
  },
): ComposerRecoveryResult {
  if (!isRetrySafeNotDispatched(delivery)) return 'ignored'
  if (!options.originalSessionActive || !options.composerUnchanged) return 'offer'
  options.restore(snapshot)
  return 'restored'
}
