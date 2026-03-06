import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, '../src')

/**
 * Static source analysis tests — verify dead code removal
 * and source-level invariants without importing modules.
 */

describe('#986 — no tmux references in server source', () => {
  it('server-cli.js has no tmux references', () => {
    const source = readFileSync(join(srcDir, 'server-cli.js'), 'utf-8')
    const tmuxMatches = source.match(/tmux/gi) || []
    assert.equal(tmuxMatches.length, 0,
      `Found ${tmuxMatches.length} tmux reference(s) in server-cli.js — PTY/tmux was removed in v0.2.0`)
  })

  it('push.js has no tmux references', () => {
    const source = readFileSync(join(srcDir, 'push.js'), 'utf-8')
    const tmuxMatches = source.match(/tmux/gi) || []
    assert.equal(tmuxMatches.length, 0,
      `Found ${tmuxMatches.length} tmux reference(s) in push.js — PTY/tmux was removed in v0.2.0`)
  })

  it('server-cli.js JSDoc does not mention auto-discovering sessions', () => {
    const source = readFileSync(join(srcDir, 'server-cli.js'), 'utf-8')
    assert.ok(!source.includes('Auto-discovers'),
      'JSDoc should not mention auto-discovering tmux sessions')
  })
})
