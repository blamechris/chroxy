import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DESKTOP_SRC = resolve(import.meta.dirname, '../../desktop/src-tauri/src')

describe('startup timeout notification (#1941)', () => {
  it('handle_start notifies on startup timeout instead of silently returning', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'lib.rs'), 'utf-8')
    // The old code had a bare `return` after `if !reached_running`
    // New code should notify via send_notification and emit_server_error
    assert.ok(
      !src.match(/if\s+!reached_running\s*\{\s*return;\s*\/\/\s*Startup timeout/),
      'lib.rs should not silently return on startup timeout — must notify user',
    )
  })

  it('emits server_error event on startup timeout', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'lib.rs'), 'utf-8')
    // After monitor_startup refactor, timeout handling lives in the helper.
    // Verify the helper (or handle_start path) emits server_error on timeout.
    const helper = src.match(/fn\s+monitor_startup\b[\s\S]*?^fn\s/m)?.[0]
    if (helper) {
      // Refactored: monitor_startup handles timeout internally
      assert.ok(
        helper.includes('emit_server_error'),
        'monitor_startup should emit server_error on timeout',
      )
    } else {
      // Original: inline block
      const timeoutBlock = src.match(/if\s+!reached_running\s*\{[\s\S]*?\}/)?.[0] || ''
      assert.ok(
        timeoutBlock.includes('emit_server_error'),
        'Startup timeout block should emit server_error event for the dashboard',
      )
    }
  })

  it('updates menu state to Stopped on startup timeout', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'lib.rs'), 'utf-8')
    const helper = src.match(/fn\s+monitor_startup\b[\s\S]*?^fn\s/m)?.[0]
    if (helper) {
      // Refactored: monitor_startup handles menu state on timeout
      assert.ok(
        helper.includes('MenuState::Stopped'),
        'monitor_startup should revert menu state to Stopped on timeout',
      )
    } else {
      // Original: inline block
      const timeoutBlock = src.match(/if\s+!reached_running\s*\{[\s\S]*?\}/)?.[0] || ''
      assert.ok(
        timeoutBlock.includes('MenuState::Stopped'),
        'Startup timeout block should revert menu state to Stopped',
      )
    }
  })
})
