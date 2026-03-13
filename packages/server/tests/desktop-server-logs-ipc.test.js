import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DESKTOP_SRC = resolve(import.meta.dirname, '../../desktop/src-tauri/src')

describe('get_server_logs IPC command (#1971)', () => {
  it('ServerManager exposes a get_logs method', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'server.rs'), 'utf-8')
    assert.ok(
      src.match(/pub\s+fn\s+get_logs/),
      'server.rs should have a public get_logs method',
    )
  })

  it('lib.rs has a get_server_logs IPC command', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'lib.rs'), 'utf-8')
    assert.ok(
      src.includes('fn get_server_logs'),
      'lib.rs should define a get_server_logs IPC command',
    )
  })

  it('get_server_logs is registered in invoke_handler', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'lib.rs'), 'utf-8')
    const handlerBlock = src.match(/generate_handler!\[([^\]]+)\]/)
    assert.ok(handlerBlock, 'lib.rs should have a generate_handler! invocation')
    assert.ok(
      handlerBlock[1].includes('get_server_logs'),
      'get_server_logs should be listed inside generate_handler![...]',
    )
  })
})
