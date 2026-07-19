/**
 * ViewerPreWriteReview (#6544, IDE P3.3 feature A) — surfaces the #6543 per-hunk
 * pre-write diff review ON THE FILE VIEWER (the IDE editor surface), not only in
 * the permission-prompt card.
 *
 * When a Write/Edit permission is pending for the file the operator is currently
 * viewing in the FileBrowserPanel, this renders the agent's PROPOSED change as a
 * diff right inside the viewer, lets the operator drop individual hunks, and
 * Approve/Deny routes through the SAME `editedInput` → `sendPermissionResponse`
 * seam #6543 established (#6552 whitelists which field the server merges). There
 * is NO new approval protocol here: the narrowed content rides the existing
 * per-hunk `editedInput` on the permission response.
 *
 * Delta over #6543: LOCATION. #6543 renders the review inside the permission
 * card; this correlates the pending write to the open file and renders it on the
 * IDE viewer so the operator reviews (and narrows) the edit in the file's own
 * context before approving. The permission card keeps working independently —
 * both surfaces read the same store state and drive the same `respond`.
 *
 * Gated on `features.ide` (the whole IDE surface is opt-in). Renders nothing
 * when the flag is off, when no live reviewable write targets the open file, or
 * once the request is resolved (locally via `resolvedPermissions` or by another
 * client). Reuses PreWriteDiffReview for the diff/hunk-toggle mechanics.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useConnectionStore } from '../store/connection'
import type { ChatMessage, PermissionDecision } from '../store/types'
import { isLivePermissionPrompt } from '@chroxy/store-core'
import { PreWriteDiffReview, isReviewableTool } from './PreWriteDiffReview'

// Stable empty array so the messages selector never returns a fresh reference
// (a new `[]` each render would re-run the memo + churn the subscription).
const EMPTY_MESSAGES: ChatMessage[] = []

/**
 * Tolerant path match between a permission's `file_path` and the viewer's open
 * file. Claude passes an ABSOLUTE `file_path` for Write/Edit; the viewer's
 * selection is absolute (a file-tree click) OR workspace-relative (a symbol
 * jump), so compare tolerantly — an exact match, or one path tail-matching the
 * other. Both nulls => no match (nothing to correlate).
 */
export function pathMatchesViewer(filePath: string | null | undefined, viewed: string | null): boolean {
  if (!filePath || !viewed) return false
  const a = filePath.replace(/\\/g, '/')
  const b = viewed.replace(/\\/g, '/')
  if (a === b) return true
  const tail = (p: string) => p.replace(/^\.?\//, '')
  return a.endsWith('/' + tail(b)) || b.endsWith('/' + tail(a))
}

/**
 * The first live, reviewable (Write/Edit) permission whose target `file_path`
 * matches the file open in the viewer — or null. Pure so it's unit-testable
 * without the store. `now` gates the expiry inside `isLivePermissionPrompt`.
 */
export function findPendingWriteForFile(
  messages: ChatMessage[],
  viewed: string | null,
  now: number,
): ChatMessage | null {
  if (!viewed) return null
  for (const m of messages) {
    if (!isLivePermissionPrompt(m, now)) continue
    if (!m.tool || !isReviewableTool(m.tool)) continue
    const fp = m.toolInput && typeof m.toolInput.file_path === 'string' ? (m.toolInput.file_path as string) : null
    if (pathMatchesViewer(fp, viewed)) return m
  }
  return null
}

export interface ViewerPreWriteReviewProps {
  /** The path currently open in the viewer (absolute, or workspace-relative). */
  filePath: string | null
}

export function ViewerPreWriteReview({ filePath }: ViewerPreWriteReviewProps) {
  const ideEnabled = useConnectionStore((s) => s.serverCapabilities?.ide === true)
  const messages = useConnectionStore((s) => {
    const id = s.activeSessionId
    return (id ? s.sessionStates[id]?.messages : undefined) ?? EMPTY_MESSAGES
  })

  // The live reviewable write (if any) targeting the open file. Date.now() at
  // memo time is sufficient — the store's permission_resolved / permission_expired
  // handlers mutate the message (which re-runs this memo); the authoritative
  // countdown lives on the permission card, not here.
  const pending = useMemo(
    () => (ideEnabled ? findPendingWriteForFile(messages, filePath, Date.now()) : null),
    [ideEnabled, messages, filePath],
  )
  const requestId = pending?.requestId ?? null
  const tool = pending?.tool ?? null

  // A locally-recorded resolution (this client just answered — on the viewer OR
  // the card) flips `resolvedPermissions` before the server's broadcast sets the
  // message's `answered`, so read it here to hide the review immediately (#2833).
  const answered = useConnectionStore((s) => (requestId ? s.resolvedPermissions?.[requestId] ?? null : null))
  const pulledInput = useConnectionStore((s) => (requestId ? s.permissionInputs?.[requestId] : undefined))
  const requestPermissionInput = useConnectionStore((s) => s.requestPermissionInput)
  const sendPermissionResponse = useConnectionStore((s) => s.sendPermissionResponse)
  // #5699 — answering is refused while disconnected (the server expires the
  // request on drop); disable the buttons so a tap isn't a silent no-op.
  const connected = useConnectionStore((s) => s.connectionPhase === 'connected')

  const [editedInput, setEditedInput] = useState<Record<string, string> | null>(null)
  // #2852-style double-submit guard: the ref flips synchronously on the first
  // click, before the store's `answered` state catches up a render later.
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)

  // Reset per-request UI state when the target request changes (a new write, or
  // the current one resolved and a different one now matches this file).
  useEffect(() => {
    setEditedInput(null)
    submittingRef.current = false
    setSubmitting(false)
  }, [requestId])

  // Pull the full redacted tool input once for a live, not-yet-answered write
  // (the broadcast input is truncated — #6543/#6550). The diff renders once it
  // lands; until then the plain Approve/Deny still work.
  useEffect(() => {
    if (ideEnabled && requestId && !answered && pulledInput === undefined) {
      requestPermissionInput(requestId)
    }
  }, [ideEnabled, requestId, answered, pulledInput, requestPermissionInput])

  const respond = (decision: PermissionDecision) => {
    if (!requestId || submittingRef.current || answered || !connected) return
    submittingRef.current = true
    setSubmitting(true)
    // #6543: carry the per-hunk narrowing on an approve only (never on a deny).
    const result = sendPermissionResponse(requestId, decision, decision === 'deny' ? null : editedInput)
    if (result !== 'sent') {
      // #6308: the socket can flip OPEN→CLOSING after the `connected` gate but
      // before this synchronous send, so sendPermissionResponse returns false
      // while `connected` is still true. Reset so the buttons don't wedge with
      // submitting=true. (On 'sent', markPermissionResolved flips `answered` and
      // this component unmounts, so keeping submitting=true there is fine.)
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  if (!ideEnabled || !pending || !requestId || answered) return null

  // Narrow the discriminated `permission_input` union: only the found:true
  // variant carries `input` (the found:false variant is a security message).
  const proposedInput = pulledInput?.found ? pulledInput.input : null
  const hasDiff = proposedInput !== null

  return (
    <div className="viewer-prewrite-review" data-testid="viewer-prewrite-review" role="group" aria-label="Pending write review">
      <div className="viewer-prewrite-title" data-testid="viewer-prewrite-title">
        <span className="viewer-prewrite-tool">{tool}</span> proposed for this file — review before approving.
      </div>

      {/* Reuse the #6543 per-hunk review: dropped hunks become `editedInput`. A
          refusal / not-yet-pulled input simply shows no diff (the buttons still
          send a plain Approve, which writes the full proposed content). */}
      {hasDiff && (
        <PreWriteDiffReview
          tool={tool as string}
          input={proposedInput as Record<string, unknown>}
          onEditedInputChange={setEditedInput}
        />
      )}
      {!hasDiff && (
        <div className="viewer-prewrite-loading" data-testid="viewer-prewrite-loading">
          {pulledInput?.found === false ? 'Proposed change unavailable — approve to write it as-is.' : 'Loading proposed change…'}
        </div>
      )}

      <div className="viewer-prewrite-buttons">
        <button
          type="button"
          className="btn-allow"
          data-testid="viewer-prewrite-approve"
          onClick={() => respond('allow')}
          disabled={submitting || !connected}
          aria-label={`Approve ${tool} to this file`}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn-deny"
          data-testid="viewer-prewrite-deny"
          onClick={() => respond('deny')}
          disabled={submitting || !connected}
          aria-label={`Deny ${tool} to this file`}
        >
          Deny
        </button>
      </div>
      {!connected && (
        <div className="viewer-prewrite-disconnected" data-testid="viewer-prewrite-disconnected" role="status">
          Disconnected — reconnect to answer.
        </div>
      )}
    </div>
  )
}
