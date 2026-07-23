/**
 * PermissionCommandEdit (#6773) — the editable command field rendered inside a
 * Bash permission prompt. Unlike the per-hunk Write/Edit review
 * (PreWriteDiffReview), a shell command is a single string, so this is a plain
 * editable textarea rather than diff machinery.
 *
 * It hands the edited command back as an `editedInput = { command }` the prompt
 * sends on Approve — but ONLY when the operator actually changed it (emits `null`
 * when the text is untouched, so a plain Allow runs the original command and we
 * never round-trip a redacted-pull command the operator didn't intend to edit).
 *
 * The server-side merge whitelist (permission-manager.js EDITABLE_INPUT_FIELDS,
 * `Bash: ['command']`) is the enforcement point: only `command` is substitutable,
 * and Bash carries no path field, so an edit changes WHAT runs but can't redirect
 * a write. Codex `shell` is deliberately NOT editable (codex owns command
 * execution and ignores updatedInput) — see isEditableCommandTool.
 */
import { useEffect, useState } from 'react'

type ToolInput = Record<string, unknown>

/**
 * Whether a tool exposes an editable single-line command field. Bash only — the
 * SDK/BYOK executor honours the merged `updatedInput`. Codex `shell` is excluded
 * (it re-runs its own already-parsed command regardless of updatedInput).
 */
export function isEditableCommandTool(tool: string): boolean {
  return tool === 'Bash'
}

export interface PermissionCommandEditProps {
  input: ToolInput
  /** Called with `{ command }` when edited, or `null` when unchanged. */
  onEditedInputChange: (editedInput: Record<string, string> | null) => void
}

export function PermissionCommandEdit({ input, onEditedInputChange }: PermissionCommandEditProps) {
  // Guard against a malformed/unexpected `command` (e.g. an object or number) —
  // `String(input.command ?? '')` would stringify it to "[object Object]" and
  // seed the editor with a corrupted default. Only a genuine string is treated
  // as editable content; anything else (missing or wrong-typed) degrades to the
  // same empty-field fallback as no command at all (matches the `typeof x ===
  // 'string' ? x : fallback` guard used elsewhere in this codebase, e.g.
  // ChildAgentEventList.tsx).
  const original = typeof input.command === 'string' ? input.command : ''
  const [value, setValue] = useState(original)

  // Reset when a new prompt/command arrives, and clear any pending edit.
  useEffect(() => {
    setValue(original)
    onEditedInputChange(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original])

  function onChange(next: string) {
    setValue(next)
    // Emit only a genuine edit — an untouched command is a plain Allow (null),
    // so we never re-send the (redacted) pulled command the operator didn't edit.
    onEditedInputChange(next === original ? null : { command: next })
  }

  const edited = value !== original
  return (
    <div className="perm-command-edit" data-testid="perm-command-edit">
      <label className="perm-command-edit-label" htmlFor="perm-command-input">
        Edit the command before running (optional):
      </label>
      <textarea
        id="perm-command-input"
        className="perm-command-edit-input"
        data-testid="perm-command-input"
        value={value}
        rows={2}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Editable shell command"
      />
      {edited && (
        <div className="perm-command-edit-hint" data-testid="perm-command-edited-hint">
          Command edited — Approve runs the modified command.
        </div>
      )}
    </div>
  )
}
