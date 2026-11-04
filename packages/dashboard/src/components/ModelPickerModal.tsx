/**
 * ModelPickerModal (#6220) — modal model picker that replaces the cramped inline
 * model <select>. Lists the active provider's selectable models (grouped under a
 * provider header), marks the default + the active selection, supports a search
 * filter, and is keyboard-navigable (Esc/Tab via the shared Modal; Arrow keys to
 * move between options, Enter/click to select).
 *
 * Disallowed models (via `DISALLOWED_MODEL_IDS`) are excluded upstream in the
 * server registry so they never reach `availableModels`; as a defensive
 * forward-compat hook this also renders any entry flagged `disabled` as a
 * non-selectable row.
 */
import { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import { findModelEntry, resolveCurrentModel, modelChoices } from '@chroxy/store-core'
import { Modal } from './Modal'
import type { ModelInfo } from '../store/types'
import { isImeComposing } from '../utils/ime'

export interface ModelPickerModalProps {
  open: boolean
  onClose: () => void
  availableModels: ModelInfo[]
  activeModel: string | null
  defaultModelId: string | null
  /** Active provider label used as the group header (e.g. "claude-cli"). */
  providerLabel?: string | null
  /**
   * #8909 — model ids the backend refused for the client this session launched.
   * Matching rows render disabled and marked; the active one keeps its checkmark.
   */
  rejectedModelIds?: readonly string[]
  onSelect: (id: string) => void
}

/** An entry that may carry a forward-compat `disabled` flag (not yet on ModelInfo). */
type PickerModel = ModelInfo & { disabled?: boolean }

export function ModelPickerModal({
  open,
  onClose,
  availableModels,
  activeModel,
  defaultModelId,
  providerLabel,
  rejectedModelIds,
  onSelect,
}: ModelPickerModalProps) {
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // Reset the search each time the modal opens so a stale filter doesn't hide
  // the current model on reopen.
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  const choices = useMemo(() => modelChoices(availableModels), [availableModels])
  const activeEntry = findModelEntry(availableModels, resolveCurrentModel(activeModel, defaultModelId, providerLabel))
  const defaultEntry = findModelEntry(availableModels, defaultModelId)
  const rejectedSet = useMemo(() => new Set(rejectedModelIds ?? []), [rejectedModelIds])
  const isRejected = useCallback(
    (m: ModelInfo) => rejectedSet.size > 0 && (rejectedSet.has(m.id) || (m.fullId != null && rejectedSet.has(m.fullId))),
    [rejectedSet],
  )
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return choices
    return choices.filter(m => m.label.toLowerCase().includes(q)
      || m.id.toLowerCase().includes(q) || m.fullId?.toLowerCase().includes(q))
  }, [choices, query])

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id)
      onClose()
    },
    [onSelect, onClose],
  )

  // Arrow-key roving focus over the option rows (Esc + Tab-trap come from Modal).
  const handleListKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not([disabled])') ?? [],
    )
    if (items.length === 0) return
    const idx = items.findIndex((el) => el === document.activeElement)
    const nextIdx =
      e.key === 'ArrowDown'
        ? (idx + 1) % items.length
        : (idx - 1 + items.length) % items.length
    items[nextIdx]?.focus()
  }, [])

  // #6238: the search <input> is a sibling of the listbox, so its keydowns don't
  // bubble into `handleListKeyDown`. Wire the search-then-arrow flow directly:
  // ArrowDown jumps focus to the first enabled result; Enter selects when the
  // filter has narrowed to exactly one enabled match (type-to-pick).
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // #8064 — don't let an IME composition's commit key (usually Enter)
      // get read as "select the single matching model". `keyCode === 229`
      // is the Safari fallback for browsers that don't set `isComposing`
      // reliably.
      if (isImeComposing(e)) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        listRef.current
          ?.querySelector<HTMLButtonElement>('[role="option"]:not([disabled])')
          ?.focus()
        return
      }
      if (e.key === 'Enter') {
        const enabled = filtered.filter((m) => (m as PickerModel).disabled !== true && !isRejected(m))
        if (enabled.length === 1) {
          e.preventDefault()
          handleSelect(enabled[0]!.id)
        }
      }
    },
    [filtered, handleSelect, isRejected],
  )

  return (
    <Modal open={open} onClose={onClose} title="Select model" maxWidth="520px" closeOnBackdrop>
      <div className="model-picker" data-testid="model-picker">
        <input
          type="text"
          className="model-picker-search"
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          aria-label="Search models"
          data-testid="model-picker-search"
        />
        <div
          ref={listRef}
          className="model-picker-list"
          role="listbox"
          aria-label="Models"
          data-testid="model-picker-list"
          onKeyDown={handleListKeyDown}
        >
          {providerLabel ? (
            <div className="model-picker-group" data-testid="model-picker-group">
              {providerLabel}
            </div>
          ) : null}
          {filtered.length === 0 ? (
            <div className="model-picker-empty" data-testid="model-picker-empty">
              No models match “{query}”.
            </div>
          ) : (
            filtered.map((m) => {
              const isDefault = defaultEntry != null && (m.fullId || m.id) === (defaultEntry.fullId || defaultEntry.id)
              const isActive = activeEntry != null && (m.fullId || m.id) === (activeEntry.fullId || activeEntry.id)
              const rejected = isRejected(m)
              const disabled = (m as PickerModel).disabled === true || rejected
              return (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  disabled={disabled}
                  className={`model-picker-item${isActive ? ' model-picker-item-active' : ''}`}
                  data-testid={`model-picker-item-${m.id}`}
                  title={rejected
                    ? `The backend rejected ${m.fullId || m.id} for the client this session launched, so it cannot be used here.`
                    : (m.fullId || m.id)}
                  onClick={() => {
                    if (!disabled) handleSelect(m.id)
                  }}
                >
                  <span className="model-picker-item-label">
                    {m.label || m.id}
                    {isDefault ? ' (default)' : ''}
                    {rejected ? ' — refused by this session\'s client' : ''}
                  </span>
                  {isActive ? (
                    <span className="model-picker-item-check" aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                </button>
              )
            })
          )}
        </div>
      </div>
    </Modal>
  )
}
