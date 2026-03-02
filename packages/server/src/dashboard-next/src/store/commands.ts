/**
 * Command registry — maps palette entries to store actions.
 *
 * Exports a `useCommands()` hook returning Command[] wired to the
 * connection store, and MRU helpers persisted to localStorage.
 */
import { useMemo } from 'react'
import { useConnectionStore } from './connection'
import type { Command } from '../components/CommandPalette'

const MRU_KEY = 'chroxy-mru-commands'
const MRU_MAX = 10

export function getMruCommands(): string[] {
  try {
    const raw = localStorage.getItem(MRU_KEY)
    if (!raw) return []
    return JSON.parse(raw)
  } catch {
    return []
  }
}

export function recordMruCommand(id: string): void {
  const mru = getMruCommands().filter(x => x !== id)
  mru.unshift(id)
  localStorage.setItem(MRU_KEY, JSON.stringify(mru.slice(0, MRU_MAX)))
}

export function useCommands(): Command[] {
  const setViewMode = useConnectionStore(s => s.setViewMode)
  const sendInterrupt = useConnectionStore(s => s.sendInterrupt)
  const createSession = useConnectionStore(s => s.createSession)
  const viewMode = useConnectionStore(s => s.viewMode)

  return useMemo(() => {
    const commands: Command[] = [
      // Session
      {
        id: 'new-session',
        name: 'New Session',
        category: 'Session',
        shortcut: 'Cmd+N',
        action: () => createSession('New Session'),
      },
      {
        id: 'interrupt',
        name: 'Interrupt',
        category: 'Session',
        shortcut: 'Cmd+.',
        action: () => sendInterrupt(),
      },
      // View
      {
        id: 'switch-chat',
        name: 'Switch to Chat',
        category: 'View',
        action: () => setViewMode('chat'),
      },
      {
        id: 'switch-terminal',
        name: 'Switch to Terminal',
        category: 'View',
        action: () => setViewMode('terminal'),
      },
      {
        id: 'switch-files',
        name: 'Switch to Files',
        category: 'View',
        action: () => setViewMode('files'),
      },
    ]
    return commands
  }, [setViewMode, sendInterrupt, createSession, viewMode])
}
