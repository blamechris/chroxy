/**
 * Tests for native folder picker integration in CreateSessionModal (#1473)
 *
 * When running in Tauri, the Browse button should use the native OS folder
 * picker via __TAURI_INTERNALS__.invoke('pick_directory'). In browser context,
 * it falls back to the server-based DirectoryBrowser.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const modalSource = fs.readFileSync(
  path.resolve(__dirname, './CreateSessionModal.tsx'),
  'utf-8',
)

describe('Native folder picker integration (#1473)', () => {
  it('checks isTauri() before opening native dialog', () => {
    expect(modalSource).toMatch(/isTauri\(\)/)
  })

  it('invokes pick_directory Tauri command', () => {
    expect(modalSource).toMatch(/invoke\('pick_directory'/)
  })

  it('accesses __TAURI_INTERNALS__ for invoke', () => {
    expect(modalSource).toMatch(/__TAURI_INTERNALS__/)
  })

  it('falls back to server-based browser when not in Tauri', () => {
    // Should still have the setBrowsing(true) + handleBrowseNavigate path
    expect(modalSource).toMatch(/setBrowsing\(true\)/)
    expect(modalSource).toMatch(/handleBrowseNavigate\(startPath\)/)
  })

  it('passes defaultPath to pick_directory', () => {
    expect(modalSource).toMatch(/defaultPath:/)
  })

  it('updates CWD and name when folder is selected', () => {
    // After native selection, should set cwd and generate name
    expect(modalSource).toMatch(/setCwd\(selected\)/)
    expect(modalSource).toMatch(/generateDefaultName\(selected/)
  })
})
