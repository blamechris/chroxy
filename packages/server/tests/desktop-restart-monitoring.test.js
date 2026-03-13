import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DESKTOP_SRC = resolve(import.meta.dirname, '../../desktop/src-tauri/src')

describe('handle_restart monitoring (#1965)', () => {
  it('does not immediately set MenuState::Running on restart Ok', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'lib.rs'), 'utf-8')
    // Extract the handle_restart function body
    const startIdx = src.indexOf('fn handle_restart(')
    const nextFn = src.indexOf('\nfn ', startIdx + 1)
    const restartFn = src.slice(startIdx, nextFn)
    // Should NOT have a direct Ok(()) => MenuState::Running pattern
    assert.ok(
      !restartFn.match(/Ok\(\(\)\)\s*=>\s*update_menu_state\([^,]+,\s*MenuState::Running\)/),
      'handle_restart should not immediately set Running — must verify server status first',
    )
  })

  it('spawns a monitoring thread after restart', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'lib.rs'), 'utf-8')
    const startIdx = src.indexOf('fn handle_restart(')
    const nextFn = src.indexOf('\nfn ', startIdx + 1)
    const restartFn = src.slice(startIdx, nextFn)
    assert.ok(
      restartFn.includes('thread::spawn') || restartFn.includes('std::thread::spawn'),
      'handle_restart should spawn a monitoring thread to verify server status',
    )
  })
})
