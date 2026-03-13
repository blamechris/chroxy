import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const LIB_RS_PATH = resolve(
  import.meta.dirname,
  '../../desktop/src-tauri/src/lib.rs'
)
const src = readFileSync(LIB_RS_PATH, 'utf8')

describe('desktop monitoring helper extraction', () => {
  it('should define a shared monitoring helper function', () => {
    // Look for a function named monitor_startup or wait_for_server_ready
    const hasHelper =
      /fn\s+(monitor_startup|wait_for_server_ready)\s*\(/.test(src)
    assert.ok(
      hasHelper,
      'lib.rs should contain a shared monitoring helper (monitor_startup or wait_for_server_ready)'
    )
  })

  it('handle_start should call the shared monitoring helper', () => {
    // Extract handle_start body
    const startMatch = src.match(
      /fn handle_start\b[\s\S]*?^fn\s/m
    )
    assert.ok(startMatch, 'handle_start function should exist')
    const startBody = startMatch[0]

    const callsHelper =
      /monitor_startup|wait_for_server_ready/.test(startBody)
    assert.ok(
      callsHelper,
      'handle_start should call the shared monitoring helper instead of inline polling'
    )
  })

  it('handle_restart should call the shared monitoring helper', () => {
    // Extract handle_restart body
    const restartMatch = src.match(
      /fn handle_restart\b[\s\S]*?^fn\s/m
    )
    assert.ok(restartMatch, 'handle_restart function should exist')
    const restartBody = restartMatch[0]

    const callsHelper =
      /monitor_startup|wait_for_server_ready/.test(restartBody)
    assert.ok(
      callsHelper,
      'handle_restart should call the shared monitoring helper instead of inline polling'
    )
  })

  it('the helper should handle success, error, and timeout paths', () => {
    // Extract the helper function body
    const helperMatch = src.match(
      /fn\s+(?:monitor_startup|wait_for_server_ready)\b[\s\S]*?^fn\s/m
    )
    assert.ok(helperMatch, 'helper function should exist for body inspection')
    const helperBody = helperMatch[0]

    // Success path: emit server_ready
    assert.ok(
      /emit_server_ready/.test(helperBody),
      'helper should call emit_server_ready on success'
    )

    // Error path: emit server_error and send_notification
    assert.ok(
      /emit_server_error/.test(helperBody),
      'helper should call emit_server_error on error'
    )
    assert.ok(
      /send_notification/.test(helperBody),
      'helper should call send_notification on error/timeout'
    )

    // Timeout path: check for timeout handling (60-second loop)
    assert.ok(
      /timeout|60/.test(helperBody),
      'helper should handle the 60-second timeout case'
    )
  })
})
