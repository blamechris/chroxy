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
          const ra = mruRank.get(a.id)
          const rb = mruRank.get(b.id)
          if (ra !== undefined && rb !== undefined) return ra - rb
          if (ra !== undefined) return -1
          if (rb !== undefined) return 1
          return 0
        })
      }
    }
    return map
  }, [filtered, mruList])

  // Flat ordered list matching the visual render order (grouped + MRU-sorted)
  const flatItems = useMemo(() => {
    const items: Command[] = []
    for (const [, cmds] of grouped) {
      items.push(...cmds)
    }
    return items
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
        if (flatItems.length > 0) setSelectedIndex(i => (i + 1) % flatItems.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        if (flatItems.length > 0) setSelectedIndex(i => (i - 1 + flatItems.length) % flatItems.length)
        break
      case 'Enter':
        e.preventDefault()
        if (flatItems[selectedIndex]) {
          executeCommand(flatItems[selectedIndex])
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
          {flatItems.length === 0 && (
            <div className="command-palette-empty">No matching commands</div>
          )}
          {Array.from(grouped.entries()).map(([category, cmds]) => (
            <div key={category} className="command-palette-group">
              <div className="command-palette-category">{category}</div>
              {cmds.map(cmd => {
                const idx = flatItems.indexOf(cmd)
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
