/**
 * PermissionRecordGroup -- one compact line for a run of identical RESOLVED
 * permission prompts (#6894, follow-up to #6626).
 *
 * "Permission allowed ×3 — shell: Do you want to allow npm registry lookup?"
 * stands in for three identical records. It is expandable: the members are the
 * individual records, in order, each still the line (and, for a prompt answered
 * live, the expandable record) it would have been on its own, so nothing is lost
 * to the grouping -- only collapsed.
 *
 * Which prompts group is decided in `@chroxy/store-core`
 * (`findResolvedPermissionRuns`); a pending prompt never reaches this component,
 * so a group has no countdown and no Allow / Deny.
 *
 * Anchors: every member keeps its `perm-desc-<requestId>` jump target (the
 * end-of-turn expired summary's "Jump to prompt" link names one of them). While
 * collapsed, the first member's is the toggle and the others are empty focusable
 * anchors beside it, so a jump lands on the group line whichever member it names;
 * expanded, each member record carries its own, so no id is ever on the page twice.
 */
import { useState, type ReactNode } from 'react'
import type { PermissionOutcomeKind } from '@chroxy/store-core'
import { PERMISSION_OUTCOME_LEAD, permissionOutcomeSuffix } from './PermissionOutcomeRecord'
import { useInitialExpanded } from './chatExpandRegistry'
import { permissionInputParts } from '../utils/permissionInputText'
import { PermissionInputContent } from './PermissionInputContent'

export interface PermissionRecordGroupProps {
  /** The synthetic row id; keys the persisted expand state. */
  groupId: string
  /** `requestId` of every member, in order -- the jump-link anchors while collapsed. */
  requestIds: string[]
  tool: string
  description: string
  outcome: PermissionOutcomeKind
  /**
   * The tool input every member shares (the group key includes it): shown on the
   * line so the group says what was approved. Absent for members rebuilt from history.
   */
  toolInput?: Record<string, unknown>
  /** How many prompts the line stands for (>= 2). */
  count: number
  /** The member records. Called only while expanded, so a collapsed group mounts none. */
  renderMembers: () => ReactNode
}

export function PermissionRecordGroup({
  groupId,
  requestIds,
  tool,
  description,
  outcome,
  count,
  toolInput,
  renderMembers,
}: PermissionRecordGroupProps) {
  const { initial, persist } = useInitialExpanded(`perm-group:${groupId}`, false)
  const [expanded, setExpanded] = useState(initial)
  const inputParts = permissionInputParts(tool, toolInput)
  const membersId = `perm-group-members-${groupId}`
  return (
    <div
      className="perm-group"
      data-testid="perm-group"
      data-outcome={outcome}
      data-count={count}
    >
      <button
        type="button"
        className="perm-group-toggle"
        data-testid="perm-group-toggle"
        // The jump-link anchor while collapsed (a button takes focus() as is);
        // once expanded the first member carries it.
        id={expanded ? undefined : `perm-desc-${requestIds[0]}`}
        aria-expanded={expanded}
        // Only while the list it controls exists.
        aria-controls={expanded ? membersId : undefined}
        aria-label={`${expanded ? 'Hide' : 'Show'} all ${count} ${tool} permissions`}
        title={`${tool}: ${description}`}
        onClick={() => {
          const next = !expanded
          setExpanded(next)
          persist(next)
        }}
      >
        <span className="perm-group-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className="perm-dropped-text">
          {PERMISSION_OUTCOME_LEAD[outcome]}{' '}
          <span className="perm-group-count" data-testid="perm-group-count">×{count}</span>
          {' — '}
          <span className="perm-tool">{tool}</span>: {description}
          {permissionOutcomeSuffix(outcome)}
          {inputParts && (
            <span className="perm-group-input" data-testid="perm-group-input"><PermissionInputContent parts={inputParts} /></span>
          )}
        </span>
      </button>
      {!expanded && requestIds.slice(1).map((requestId) => (
        <span key={requestId} className="perm-group-anchor" id={`perm-desc-${requestId}`} tabIndex={-1} />
      ))}
      {expanded && (
        <div className="perm-group-members" id={membersId} data-testid="perm-group-members">
          {renderMembers()}
        </div>
      )}
    </div>
  )
}
