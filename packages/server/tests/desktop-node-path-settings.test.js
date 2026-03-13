import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DESKTOP_SRC = resolve(import.meta.dirname, '../../desktop/src-tauri/src')

describe('settings.node_path is applied (#1938)', () => {
  it('ServerManager has a set_node_path method', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'server.rs'), 'utf-8')
    assert.ok(
      src.match(/pub\s+fn\s+set_node_path/),
      'server.rs should expose set_node_path method',
    )
  })

  it('handle_start reads settings.node_path and passes it to ServerManager', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'lib.rs'), 'utf-8')
    // Extract the handle_start function body and verify it reads node_path
    // from settings and passes it to set_node_path
    const handleStartMatch = src.match(/fn\s+handle_start\b[\s\S]*?^}/m)
    assert.ok(handleStartMatch, 'lib.rs should contain a handle_start function')
    const body = handleStartMatch[0]
    assert.ok(
      body.includes('node_path') && body.includes('set_node_path'),
      'handle_start should read node_path from settings and call mgr.set_node_path',
    )
  })
})
