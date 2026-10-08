/**
 * PermissionOutcomeRecord — the compact transcript line for a permission prompt
 * that has ENDED (#7353, #8348).
 *
 * A prompt that expired or was answered is the only trace of a tool call the
 * agent asked for, so it stays in the transcript as a muted line with no
 * controls and no countdown. Two things render it:
 *
 *   - `PermissionPrompt`, when an expired card is dismissed (#7353): the card
 *     collapses to this line instead of vanishing;
 *   - `useMessageRenderer`, for a `permission_outcome` the server replayed
 *     (#8348), so the line survives a session switch or a reload — the live card
 *     does not, because `permission_request` frames are never in history.
 *
 * `stopped` (#8374) is a prompt the user cancelled with Stop: nothing timed out
 * and nobody refused it, so it says neither "expired" nor "denied". It is the
 * record for both a live Stop and a replayed one.
 *
 * #6894: a record built by `useMessageRenderer` passes a `detail` and so expands
 * to the full text (the line clamps a long command at three lines), the exact
 * decision and the asking session. A live-answered prompt and a replayed outcome
 * both do, so the two stay byte-identical (`replay-parity-dom.test.tsx`); a replay
 * only knows allowed / denied, never "for session". The expanded view has no
 * Allow / Deny: the prompt is over. The dismissed-expired line `PermissionPrompt`
 * draws passes no `detail` and stays a plain line.
 *
 * The `expired` wording and test id are #7353's, unchanged. It keeps the
 * `perm-desc-<id>` anchor the end-of-turn expired summary's "Jump to prompt"
 * link lands on. The `title` carries the full text for the 3-line clamp.
 */
import { useState } from 'react'
import type { PermissionOutcomeKind } from '@chroxy/store-core'
import { useInitialExpanded } from './chatExpandRegistry'
import { permissionInputText } from '../utils/permissionInputText'

export interface PermissionRecordDetail {
  /** The decision token the user answered with (`allow`, `allowSession`, `allowAlways`, `deny`). */
  decision?: string | null
  /** "Which session asked" label, when more than one session exists. */
  sessionLabel?: string
  /**
   * What was approved: the (server-sanitized) tool input the live prompt carried.
   * Absent on a record rebuilt from history -- the server journals the
   * description, not the input. Shown as text, bounded.
   */
  toolInput?: Record<string, unknown>
}

export interface PermissionOutcomeRecordProps {
  requestId: string
  tool: string
  description: string
  outcome: PermissionOutcomeKind
  /** Makes the line expandable (see the header). Omitted: a plain line, no control. */
  detail?: PermissionRecordDetail
}

/** The leading words of a record line, per outcome. Shared with the group line so the two read alike. */
export const PERMISSION_OUTCOME_LEAD: Record<PermissionOutcomeKind, string> = {
  expired: 'Permission expired',
  allowed: 'Permission allowed',
  denied: 'Permission denied',
  stopped: 'Permission stopped',
}

/** The trailing words of a record line ("" when the outcome needs none). */
export function permissionOutcomeSuffix(outcome: PermissionOutcomeKind): string {
  if (outcome === 'expired') return ' \u2014 dropped'
  if (outcome === 'stopped') return ' \u2014 not run'
  return ''
}

/**
 * What the user's decision token means, in the words the live card's answer line
 * used. The one definition: `PermissionPrompt` renders its own answer from it too.
 */
export function permissionDecisionLabel(answered: string): string {
  switch (answered) {
    case 'deny':
      return 'Denied'
    case 'allowSession':
      return 'Allowed for session'
    case 'allowAlways':
      return 'Always allowed (project)'
    default:
      return 'Allowed'
  }
}

export function PermissionOutcomeRecord({ requestId, tool, description, outcome, detail }: PermissionOutcomeRecordProps) {
  const expired = outcome === 'expired'
  // Persisted OUTSIDE the row (the virtualized ChatView unmounts rows that scroll
  // away): a remount re-reads the registry, so an expanded record stays expanded.
  const { initial, persist } = useInitialExpanded(`perm-record:${requestId}`, false)
  const [expanded, setExpanded] = useState(initial)
  const detailId = `perm-record-detail-${requestId}`
  const inputText = detail ? permissionInputText(tool, detail.toolInput) : null
  return (
    <div
      className={`permission-prompt permission-prompt-dropped${detail ? ' perm-record-expandable' : ''}`}
      // #7353's id for the expired line; the answered lines are new (#8348).
      data-testid={expired ? 'perm-dropped-record' : 'perm-outcome-record'}
      data-outcome={outcome}
      role="status"
      title={`${tool}: ${description}`}
    >
      <span className="perm-dropped-text" id={`perm-desc-${requestId}`} tabIndex={-1}>
        {PERMISSION_OUTCOME_LEAD[outcome]} — <span className="perm-tool">{tool}</span>: {description}
        {permissionOutcomeSuffix(outcome)}
      </span>
      {detail && (
        <button
          type="button"
          className="perm-record-toggle"
          data-testid="perm-record-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? detailId : undefined}
          aria-label={`${expanded ? 'Hide' : 'Show'} details of the ${tool} permission`}
          onClick={() => {
            const next = !expanded
            setExpanded(next)
            persist(next)
          }}
        >
          {expanded ? 'Hide details' : 'Details'}
        </button>
      )}
      {detail && expanded && (
        <div className="perm-record-detail" id={detailId} data-testid="perm-record-detail">
          <div className="perm-record-full">
            <span className="perm-tool">{tool}</span>: {description}
          </div>
          {inputText && (
            <pre className="perm-record-input" data-testid="perm-record-input">{inputText}</pre>
          )}
          {detail.decision && <div className="perm-record-decision">{permissionDecisionLabel(detail.decision)}</div>}
          {detail.sessionLabel && <div className="perm-record-session">{detail.sessionLabel}</div>}
        </div>
      )}
    </div>
  )
}
