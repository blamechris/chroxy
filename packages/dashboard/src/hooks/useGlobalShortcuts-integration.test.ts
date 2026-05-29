/**
 * Global keyboard-shortcut wiring (#1334, #3852, #4412).
 *
 * Pre-#4412 these tests grep'd App.tsx for the raw `shiftKey` / `'p'`
 * combos because the keydown ladder was hand-rolled. After #4412 the
 * ladder dispatches by registry id, so the literal combos live in
 * `shortcuts/defaults.ts` instead. The assertions are now against the
 * registry contents (still a static check — no React rendering) so a
 * regression that drops a shortcut entry from defaults.ts still fails
 * here.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { DEFAULT_SHORTCUTS } from '../shortcuts/defaults'

const commandsSource = fs.readFileSync(
  path.resolve(__dirname, '../store/commands.ts'),
  'utf-8',
)

function findShortcut(id: string) {
  return DEFAULT_SHORTCUTS.find(s => s.id === id)
}

describe('Global keyboard shortcuts (#1334, #3852, #4412)', () => {
  it('Cmd+Shift+P (VSCode palette alias) is registered', () => {
    const shortcut = findShortcut('palette.toggle.vscode')
    expect(shortcut?.defaultBinding).toBe('cmd+shift+p')
  })

  it('Cmd+Shift+D (toggle chat/terminal view) is registered', () => {
    const shortcut = findShortcut('view.toggleChatTerminal')
    expect(shortcut?.defaultBinding).toBe('cmd+shift+d')
  })

  it('toggle-view command has shortcut badge', () => {
    expect(commandsSource).toMatch(/toggle-view[\s\S]*?shortcut/)
  })

  it('toggle-sidebar command has shortcut badge', () => {
    expect(commandsSource).toMatch(/toggle-sidebar[\s\S]*?shortcut/)
  })
})
