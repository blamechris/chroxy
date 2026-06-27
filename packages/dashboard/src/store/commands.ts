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

export function useCommands(isPtyProvider = true): Command[] {
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
        action: () => createSession({ name: 'New Session' }),
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
        id: 'toggle-view',
        name: 'Toggle View',
        category: 'View',
        shortcut: 'Cmd+Shift+D',
        action: () => {
          const current = useConnectionStore.getState().viewMode
          setViewMode(current === 'chat' ? 'terminal' : 'chat')
        },
      },
      {
        id: 'toggle-sidebar',
        name: 'Toggle Sidebar',
        category: 'View',
        shortcut: 'Cmd+B',
        action: () => {
          // No-op here — sidebar state is managed in App.tsx
          // The global shortcut handler handles this directly
        },
      },
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
    // Sessions without a terminal (non claude-tui / non user-shell providers)
    // have no PTY view — App.tsx's guard bounces viewMode='terminal' straight
    // back to Chat, so "Switch to Terminal" / "Toggle View" would be a confusing
    // do-nothing entry in the palette. Hide the terminal commands for those.
    if (!isPtyProvider) {
      return commands.filter(c => c.id !== 'switch-terminal' && c.id !== 'toggle-view')
    }
    return commands
  }, [setViewMode, sendInterrupt, createSession, isPtyProvider])
}
