/**
 * CompactionMarker — #6768
 *
 * Distinct "Context compacted" divider for a `compact_boundary` SDK/CLI
 * system event (see store-core `ChatMessage.compactMetadata`), replacing
 * the generic muted system bubble that used to show the literal string
 * `compact_boundary` with no human-readable text and no token/trigger
 * data. Rendered by `useMessageRenderer` for `type: 'system'` messages
 * carrying `compactMetadata` — same wiring as `EvaluatorRewriteBanner`, so
 * today it surfaces on the System tab (where every `type: 'system'`
 * message renders; see `buildChatViewMessages.ts`'s chat-tab filter).
 *
 * Deliberately non-interactive and single-line — a compaction boundary is
 * informational, not something the operator acts on.
 */
import type { CompactBoundaryMeta } from '../store/types'
import { formatDurationTerse } from '@chroxy/store-core'

export interface CompactionMarkerProps {
  meta: CompactBoundaryMeta
}

function formatTokens(n: number | null): string {
  return n == null ? '?' : n.toLocaleString()
}

export function CompactionMarker({ meta }: CompactionMarkerProps) {
  const parts: string[] = ['Context compacted']
  if (meta.preTokens != null || meta.postTokens != null) {
    parts.push(`${formatTokens(meta.preTokens)} → ${formatTokens(meta.postTokens)} tokens`)
  }
  if (meta.durationMs != null) {
    parts.push(formatDurationTerse(meta.durationMs))
  }
  parts.push(meta.trigger === 'manual' ? 'manual' : 'auto')

  return (
    <div className="compaction-marker" data-testid="compaction-marker">
      <span className="compaction-marker-icon" aria-hidden="true">⊙</span>
      <span className="compaction-marker-text">{parts.join(' · ')}</span>
    </div>
  )
}
