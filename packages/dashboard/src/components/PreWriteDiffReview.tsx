/**
 * PreWriteDiffReview (#6543 PR-3, IDE P3 feature B) — the per-hunk pre-write
 * review rendered inside a Write/Edit permission prompt. It turns the agent's
 * proposed edit into a diff, lets the operator drop individual hunks, and hands
 * the narrowed content back as an `editedInput` the prompt sends on Approve.
 *
 * Wires the whole feature-B stack together:
 *   - the pulled tool input (#6550 `get_permission_input`),
 *   - the client differ (#6546 `computeHunks`/`applyHunks`),
 *   - the selectable hunk component (#6548 `HunkView`),
 *   - the server merge whitelist (#6552) — which is why we only ever emit the
 *     ONE content field per tool (Write→`content`, Edit→`new_string`); the
 *     server ignores anything else, so the path can't be redirected here either.
 *
 * The diff base: Edit is self-contained (`old_string → new_string`); Write is
 * `'' → content` (review the whole proposed body; a disk-diff base is a
 * follow-up). Emits `null` when every hunk is kept (no edit → a plain Allow).
 */
import { useEffect, useMemo, useState } from 'react'
import { computeHunks, applyHunks } from '@chroxy/store-core'
import { HunkView } from './DiffViewerPanel'

type ToolInput = Record<string, unknown>

/** Per-tool: the substitutable content field + how to derive the diff sides. */
const TOOL_DIFF: Record<string, { field: string; base: (i: ToolInput) => string; proposed: (i: ToolInput) => string }> = {
  Write: { field: 'content', base: () => '', proposed: (i) => String(i.content ?? '') },
  Edit: { field: 'new_string', base: (i) => String(i.old_string ?? ''), proposed: (i) => String(i.new_string ?? '') },
}

/** Whether a tool has a per-hunk pre-write review (drives the prompt's gate). */
export function isReviewableTool(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_DIFF, tool)
}

export interface PreWriteDiffReviewProps {
  tool: string
  input: ToolInput
  /** Called with the narrowed `editedInput` (or `null` when all hunks are kept). */
  onEditedInputChange: (editedInput: Record<string, string> | null) => void
}

export function PreWriteDiffReview({ tool, input, onEditedInputChange }: PreWriteDiffReviewProps) {
  const spec = TOOL_DIFF[tool]
  const { base, hunks } = useMemo(() => {
    if (!spec) return { base: '', hunks: [] }
    const b = spec.base(input)
    return { base: b, hunks: computeHunks(b, spec.proposed(input)) }
  }, [spec, input])

  // All hunks kept by default. Reset when the diff changes (new prompt/input).
  const [selected, setSelected] = useState<Set<number>>(() => new Set(hunks.map((_, i) => i)))
  useEffect(() => {
    setSelected(new Set(hunks.map((_, i) => i)))
    onEditedInputChange(null) // fresh prompt → no edit until the operator drops a hunk
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunks])

  // Emit on toggle (NOT in a render effect) so a non-memoized parent callback
  // can't cause a render loop. `selected` is read from the closure — fine for a
  // human clicking one hunk at a time.
  function toggle(i: number) {
    const next = new Set(selected)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    setSelected(next)
    const allKept = next.size === hunks.length
    onEditedInputChange(allKept ? null : { [spec!.field]: applyHunks(base, hunks, next) })
  }

  if (!spec || hunks.length === 0) return null

  const droppedCount = hunks.length - selected.size
  const allDropped = selected.size === 0
  // #6555: dropping EVERY hunk means an empty result (an empty file for Write / a
  // no-op for Edit) — call that out clearly rather than the generic "narrowed" copy.
  const hint = allDropped
    ? `All hunks dropped — Approve writes ${tool === 'Write' ? 'an empty file' : 'no change'}.`
    : droppedCount === 0
      ? 'Review the proposed change — uncheck a hunk to drop it from the write.'
      : `${droppedCount} hunk${droppedCount === 1 ? '' : 's'} dropped — Approve writes the narrowed content.`
  return (
    <div className="prewrite-diff-review" data-testid="prewrite-diff-review">
      <div className={`prewrite-diff-hint${allDropped ? ' prewrite-diff-hint-warn' : ''}`} data-testid="prewrite-diff-hint">
        {hint}
      </div>
      {hunks.map((hunk, i) => (
        <HunkView
          key={i}
          hunk={hunk}
          viewMode="unified"
          selectable
          selected={selected.has(i)}
          onToggle={() => toggle(i)}
        />
      ))}
    </div>
  )
}
