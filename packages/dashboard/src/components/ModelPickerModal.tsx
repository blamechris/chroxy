/**
 * ModelPickerModal (#6220) — modal model picker that replaces the cramped inline
 * model <select>. Lists the active provider's selectable models (grouped under a
 * provider header), marks the default + the active selection, supports a search
 * filter, and is keyboard-navigable (Esc/Tab via the shared Modal; Arrow keys to
 * move between options, Enter/click to select).
 *
 * Disallowed models (e.g. fable, #6219) are excluded upstream in the server
 * registry so they never reach `availableModels`; as a defensive forward-compat
 * hook this also renders any entry flagged `disabled` as a non-selectable row.
 */
import { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import { Modal } from './Modal'
import type { ModelInfo } from '../store/types'

export interface ModelPickerModalProps {
  open: boolean
  onClose: () => void
  availableModels: ModelInfo[]
  activeModel: string | null
  defaultModelId: string | null
  /** Active provider label used as the group header (e.g. "claude-cli"). */
  providerLabel?: string | null
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
  onSelect,
}: ModelPickerModalProps) {
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // Reset the search each time the modal opens so a stale filter doesn't hide
  // the current model on reopen.
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  // Resolve the active model to its short id the same way the status bar does
  // (it can arrive as a short id OR a full id) so the checkmark lands on the
  // right row (#5628).
  const activeId = useMemo(() => {
    const entry = availableModels.find((m) => m.id === activeModel || m.fullId === activeModel)
    return entry?.id ?? activeModel ?? null
  }, [availableModels, activeModel])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return availableModels
    return availableModels.filter(
      (m) =>
        m.label?.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.fullId?.toLowerCase().includes(q),
    )
  }, [availableModels, query])

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

  return (
    <Modal open={open} onClose={onClose} title="Select model" maxWidth="520px" closeOnBackdrop>
      <div className="model-picker" data-testid="model-picker">
        <input
          type="text"
          className="model-picker-search"
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
              const isDefault = defaultModelId != null && m.id === defaultModelId
              const isActive = m.id === activeId
              const disabled = (m as PickerModel).disabled === true
              return (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  disabled={disabled}
                  className={`model-picker-item${isActive ? ' model-picker-item-active' : ''}`}
                  data-testid={`model-picker-item-${m.id}`}
                  title={m.fullId || m.id}
                  onClick={() => {
                    if (!disabled) handleSelect(m.id)
                  }}
                >
                  <span className="model-picker-item-label">
                    {m.label || m.id}
                    {isDefault ? ' (default)' : ''}
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
