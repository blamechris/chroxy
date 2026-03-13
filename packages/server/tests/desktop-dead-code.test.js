import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DESKTOP_SRC = resolve(import.meta.dirname, '../../desktop/src-tauri/src')

describe('desktop dead code removal (#1936)', () => {
  it('window.rs does not contain toggle_window function', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'window.rs'), 'utf-8')
    assert.ok(
      !src.match(/pub\s+fn\s+toggle_window/),
      'window.rs should not contain toggle_window — tray uses show_menu_on_left_click instead',
    )
  })

  it('lib.rs calls window::emit_server_error in error paths', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'lib.rs'), 'utf-8')
    const callSites = src.match(/window::emit_server_error\(/g) || []
    assert.ok(
      callSites.length >= 2,
      `lib.rs should have multiple window::emit_server_error() call sites in error paths, found ${callSites.length}`,
    )
  })
})
