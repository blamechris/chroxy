/**
 * SlashCommandPicker — dropdown list of available slash commands.
 *
 * Appears above the InputBar when user types "/" at the start of input.
 * Supports filtering, keyboard navigation, and selection.
 */
import { useEffect, useRef, useMemo } from 'react'
import type { SlashCommand } from '../store/types'

export interface SlashCommandPickerProps {
  commands: SlashCommand[]
  filter: string
  onSelect: (name: string) => void
  onClose: () => void
  selectedIndex?: number
}

export function SlashCommandPicker({
  commands,
  filter,
  onSelect,
  onClose,
  selectedIndex = 0,
}: SlashCommandPickerProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const filtered = useMemo(() => {
    if (!filter) return commands
    const lower = filter.toLowerCase()
    return commands.filter(
      c => c.name.toLowerCase().includes(lower) || c.description.toLowerCase().includes(lower)
    )
  }, [commands, filter])

  if (filtered.length === 0) {
    return (
      <div className="slash-picker" data-testid="slash-picker" ref={ref}>
        <div role="listbox" aria-label="Slash commands">
          <div className="slash-picker-empty">No commands found</div>
        </div>
      </div>
    )
  }

  return (
    <div className="slash-picker" data-testid="slash-picker" ref={ref}>
      <div role="listbox" aria-label="Slash commands">
        {filtered.map((cmd, i) => (
          <div
            key={cmd.name}
            role="option"
            aria-selected={i === selectedIndex}
            className={`slash-picker-item${i === selectedIndex ? ' selected' : ''}`}
            onClick={() => onSelect(cmd.name)}
          >
            <div className="slash-picker-name">/{cmd.name}</div>
            <div className="slash-picker-desc">{cmd.description}</div>
            {cmd.source === 'user' && (
              <span className="slash-picker-badge">user</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
