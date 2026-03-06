/**
 * Command registry — maps palette entries to store actions.
 *
 * Exports a `useCommands()` hook returning Command[] wired to the
 * connection store. MRU state managed by useMruStore.
 */
import { useMemo } from 'react'
import { useConnectionStore } from './connection'
import { useMruStore } from './mru'
import type { Command } from '../components/CommandPalette'

export { useMruStore } from './mru'

export function getMruCommands(): string[] {
  return [...useMruStore.getState().mruList]
}

export function recordMruCommand(id: string): void {
  useMruStore.getState().recordCommand(id)
}

export function useCommands(): Command[] {
  const setViewMode = useConnectionStore(s => s.setViewMode)
  const sendInterrupt = useConnectionStore(s => s.sendInterrupt)
  const createSession = useConnectionStore(s => s.createSession)

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
  }, [setViewMode, sendInterrupt, createSession])
}
