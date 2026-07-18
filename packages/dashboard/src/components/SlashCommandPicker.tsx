/**
 * SlashCommandPicker — dropdown list of available slash commands.
 *
 * Appears above the InputBar when user types "/" at the start of input.
 * Supports filtering, keyboard navigation, and selection.
 */
import { Fragment, useEffect, useRef, useMemo } from 'react'
import type { SlashCommand } from '../store/types'

// Chat redesign #6391 (slice 8): section headers for the source groups. Any
// future/unknown source falls into "Other".
const SLASH_GROUP_LABEL: Record<string, string> = {
  builtin: 'Built-in',
  project: 'Project',
  user: 'User',
  // #6823: prompts from connected MCP servers (`/mcp__server__prompt`).
  mcp: 'MCP',
}

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
        {filtered.map((cmd, i) => {
          // #6391 (slice 8): insert a source group header whenever the source
          // changes. The list is sorted by source upstream (App.tsx), so this
          // produces clean Built-in / Project / User sections without reordering
          // here — the flat index `i` stays the keyboard-nav index.
          const showHeader = i === 0 || filtered[i - 1]!.source !== cmd.source
          return (
            <Fragment key={cmd.name}>
              {showHeader && (
                <div className="slash-picker-group" role="presentation">
                  {SLASH_GROUP_LABEL[cmd.source] ?? 'Other'}
                </div>
              )}
              <div
                role="option"
                aria-selected={i === selectedIndex}
                className={`slash-picker-item${i === selectedIndex ? ' selected' : ''}`}
                onClick={() => onSelect(cmd.name)}
              >
                <div className="slash-picker-name">/{cmd.name}</div>
                <div className="slash-picker-desc">{cmd.description}</div>
                {/*
                  #3856 — surface a chip on each row so users can tell a
                  provider built-in (locked, can't be shadowed) apart from a
                  user/project markdown skill (their own file, safe to edit).
                  `project` is the implicit default and stays badgeless to keep
                  the row chrome quiet for the most common case.
                */}
                {cmd.source === 'builtin' && (
                  <span className="slash-picker-badge slash-picker-badge-builtin">built-in</span>
                )}
                {cmd.source === 'user' && (
                  <span className="slash-picker-badge">user</span>
                )}
                {/* #6823: MCP-server prompt — badge it so users can tell a
                    prompt sourced from a connected MCP server apart from a
                    provider built-in or a local markdown skill. */}
                {cmd.source === 'mcp' && (
                  <span className="slash-picker-badge slash-picker-badge-mcp">mcp</span>
                )}
              </div>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
