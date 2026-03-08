/**
 * Verify pty-mirror.js and related PTY dead code removed (#1731).
 *
 * PTY/tmux mode was dropped in v0.2.0 (node-pty dependency removed).
 * Confirms the file is gone and all references cleaned up.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, '../src')

test('pty-mirror.js does not exist', () => {
  assert.equal(existsSync(join(srcDir, 'pty-mirror.js')), false)
})

test('ws-message-handlers.js has no pty-mirror import', () => {
  const src = readFileSync(join(srcDir, 'ws-message-handlers.js'), 'utf-8')
  assert.equal(src.includes('pty-mirror'), false)
  assert.equal(src.includes('PtyMirror'), false)
})

test('ws-message-handlers.js has no pty_spawn handler', () => {
  const src = readFileSync(join(srcDir, 'ws-message-handlers.js'), 'utf-8')
  assert.equal(src.includes("case 'pty_spawn'"), false)
})

test('ws-message-handlers.js has no pty_write handler', () => {
  const src = readFileSync(join(srcDir, 'ws-message-handlers.js'), 'utf-8')
  assert.equal(src.includes("case 'pty_write'"), false)
})

test('ws-message-handlers.js has no pty_resize handler', () => {
  const src = readFileSync(join(srcDir, 'ws-message-handlers.js'), 'utf-8')
  assert.equal(src.includes("case 'pty_resize'"), false)
})

test('ws-message-handlers.js has no pty_kill handler', () => {
  const src = readFileSync(join(srcDir, 'ws-message-handlers.js'), 'utf-8')
  assert.equal(src.includes("case 'pty_kill'"), false)
})

test('ws-server.js has no ptyMirrors references', () => {
  const src = readFileSync(join(srcDir, 'ws-server.js'), 'utf-8')
  assert.equal(src.includes('ptyMirror'), false)
})

test('ws-schemas.js has no pty message schemas', () => {
  const src = readFileSync(join(srcDir, 'ws-schemas.js'), 'utf-8')
  assert.equal(src.includes("'pty_spawn'"), false)
  assert.equal(src.includes("'pty_write'"), false)
  assert.equal(src.includes("'pty_resize'"), false)
  assert.equal(src.includes("'pty_kill'"), false)
})

test('node-pty not in server package.json dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(srcDir, '../package.json'), 'utf-8'))
  assert.equal(pkg.dependencies?.['node-pty'], undefined)
  assert.equal(pkg.optionalDependencies?.['node-pty'], undefined)
})
