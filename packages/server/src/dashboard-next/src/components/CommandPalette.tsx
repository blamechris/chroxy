/**
 * CommandPalette — searchable command list overlay with keyboard navigation.
 */
import { useState, useEffect, useRef, useMemo } from 'react'

export interface Command {
  id: string
  name: string
  category: string
  shortcut?: string
  action: () => void
}

export interface CommandPaletteProps {
  commands: Command[]
  isOpen: boolean
  onClose: () => void
  mruList?: string[]
}

export function CommandPalette({ commands, isOpen, onClose, mruList }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    if (!query) return commands
    const lower = query.toLowerCase()
    return commands.filter(c => c.name.toLowerCase().includes(lower))
  }, [commands, query])

  const grouped = useMemo(() => {
    const map = new Map<string, Command[]>()
    for (const cmd of filtered) {
      const list = map.get(cmd.category) || []
      list.push(cmd)
      map.set(cmd.category, list)
    }
    if (mruList && mruList.length > 0) {
      const mruRank = new Map(mruList.map((id, i) => [id, i]))
      for (const [, cmds] of map) {
        cmds.sort((a, b) => {
          const ra = mruRank.get(a.id) ?? Infinity
          const rb = mruRank.get(b.id) ?? Infinity
          return ra - rb
        })
      }
    }
    return map
  }, [filtered, mruList])

  // Build stable id→flatIndex map for aria-selected
  const indexMap = useMemo(() => {
    const map = new Map<string, number>()
    let idx = 0
    for (const [, cmds] of grouped) {
      for (const cmd of cmds) {
        map.set(cmd.id, idx++)
      }
    }
    return map
  }, [grouped])

  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [isOpen])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  if (!isOpen) return null

  const executeCommand = (cmd: Command) => {
    cmd.action()
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (filtered.length > 0) setSelectedIndex(i => (i + 1) % filtered.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        if (filtered.length > 0) setSelectedIndex(i => (i - 1 + filtered.length) % filtered.length)
        break
      case 'Enter':
        e.preventDefault()
        if (filtered[selectedIndex]) {
          executeCommand(filtered[selectedIndex])
        }
        break
      case 'Escape':
        e.preventDefault()
        onClose()
        break
    }
  }

  return (
    <div className="command-palette" data-testid="command-palette">
      <div
        className="command-palette-backdrop"
        data-testid="command-palette-backdrop"
        onClick={onClose}
      />
      <div className="command-palette-dialog">
        <input
          ref={inputRef}
          className="command-palette-search"
          role="combobox"
          aria-expanded={true}
          aria-controls="command-palette-list"
          aria-autocomplete="list"
          placeholder="Type a command..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <div id="command-palette-list" role="listbox" className="command-palette-list">
          {filtered.length === 0 && (
            <div className="command-palette-empty">No matching commands</div>
          )}
          {Array.from(grouped.entries()).map(([category, cmds]) => (
            <div key={category} className="command-palette-group">
              <div className="command-palette-category">{category}</div>
              {cmds.map(cmd => {
                const idx = indexMap.get(cmd.id) ?? 0
                return (
                  <div
                    key={cmd.id}
                    role="option"
                    aria-selected={idx === selectedIndex}
                    className={`command-palette-item${idx === selectedIndex ? ' selected' : ''}`}
                    onClick={() => executeCommand(cmd)}
                  >
                    <span className="command-palette-item-name">{cmd.name}</span>
                    {cmd.shortcut && (
                      <span className="command-palette-item-shortcut">{cmd.shortcut}</span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
