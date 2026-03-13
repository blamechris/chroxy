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
    assert.ok(
      src.includes('set_node_path'),
      'lib.rs handle_start should call mgr.set_node_path with the settings value',
    )
  })
})
