import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const LIB_RS = resolve(import.meta.dirname, '../../desktop/src-tauri/src/lib.rs')

describe('Phase 1 ServerStatus::Error emits server_error (#2079)', () => {
  it('Phase 1 Error branch calls window::emit_server_error', () => {
    const src = readFileSync(LIB_RS, 'utf-8')
    const lines = src.split('\n')

    // Find the Phase 1 ServerStatus::Error match arm (the first one, around line 558)
    // It should call emit_server_error, not just send_notification
    let phase1ErrorIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('ServerStatus::Error(ref msg)') && lines[i].includes('=>')) {
        phase1ErrorIdx = i
        break
      }
    }

    assert.ok(phase1ErrorIdx > 0, 'Should find Phase 1 ServerStatus::Error match arm')

    // Check that emit_server_error is called within 5 lines of the match arm
    const block = lines.slice(phase1ErrorIdx, phase1ErrorIdx + 6).join('\n')
    assert.ok(
      block.includes('emit_server_error'),
      `Phase 1 Error branch should call window::emit_server_error to notify dashboard. Block:\n${block}`,
    )
  })
})
