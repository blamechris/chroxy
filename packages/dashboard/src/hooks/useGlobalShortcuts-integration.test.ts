import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const appSource = fs.readFileSync(
  path.resolve(__dirname, '../App.tsx'),
  'utf-8',
)

const commandsSource = fs.readFileSync(
  path.resolve(__dirname, '../store/commands.ts'),
  'utf-8',
)

describe('Global keyboard shortcuts (#1334)', () => {
  it('Cmd+Shift+P toggles command palette', () => {
    // Should handle Cmd+Shift+P alongside Cmd+K
    expect(appSource).toMatch(/shiftKey[\s\S]{0,100}['"]p['"]|['"]p['"][\s\S]{0,100}shiftKey/)
  })

  it('Cmd+Shift+D toggles view mode', () => {
    expect(appSource).toMatch(/shiftKey[\s\S]{0,100}['"]d['"]|['"]d['"][\s\S]{0,100}shiftKey/)
  })

  it('toggle-view command has shortcut badge', () => {
    expect(commandsSource).toMatch(/toggle-view[\s\S]*?shortcut/)
  })

  it('toggle-sidebar command has shortcut badge', () => {
    expect(commandsSource).toMatch(/toggle-sidebar[\s\S]*?shortcut/)
  })
})
