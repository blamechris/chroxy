import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { remapClaudeSpawn } from '../src/environments/backends/container-claude-spawn.js'

const JS = '/opt/lib/node_modules/@anthropic-ai/claude-code/cli.js'
const BIN = '/usr/local/bin/claude'

describe('remapClaudeSpawn (#8027)', () => {
  it('maps a native basename `claude` to node + container cli.js', () => {
    assert.deepEqual(
      remapClaudeSpawn({ cmd: '/Users/me/.local/bin/claude', args: ['-p', '--x'], containerCliPath: JS }),
      { cmd: 'node', args: [JS, '-p', '--x'], remapped: true },
    )
  })

  it('maps `claude.exe` and a Windows backslash path', () => {
    for (const cmd of ['/h/claude.exe', 'C:\\Users\\me\\bin\\claude.exe']) {
      const r = remapClaudeSpawn({ cmd, args: ['-p'], containerCliPath: JS })
      assert.deepEqual(r, { cmd: 'node', args: [JS, '-p'], remapped: true }, cmd)
    }
  })

  it('execs a non-js container claude directly', () => {
    assert.deepEqual(
      remapClaudeSpawn({ cmd: '/h/claude', args: ['-p'], containerCliPath: BIN }),
      { cmd: BIN, args: ['-p'], remapped: true },
    )
  })

  it('maps an exact pinned host path with an unusual basename', () => {
    const pinned = '/home/me/.local/share/claude/versions/2.1.7'
    const r = remapClaudeSpawn({ cmd: pinned, args: ['-p'], containerCliPath: JS, hostClaudePath: pinned })
    assert.deepEqual(r, { cmd: 'node', args: [JS, '-p'], remapped: true })
    // normalisation: redundant segments still match
    const r2 = remapClaudeSpawn({ cmd: '/home/me/./.local/share/claude/versions/2.1.7', args: [], containerCliPath: JS, hostClaudePath: pinned })
    assert.equal(r2.remapped, true)
  })

  it('does not treat a different path as the pinned one', () => {
    const r = remapClaudeSpawn({ cmd: '/home/me/other', args: ['-p'], containerCliPath: JS, hostClaudePath: '/home/me/versions/2.1.7' })
    assert.equal(r.remapped, false)
  })

  it('ignores an empty hostClaudePath', () => {
    const r = remapClaudeSpawn({ cmd: '', args: [], containerCliPath: JS, hostClaudePath: '' })
    assert.equal(r.remapped, false)
  })

  it('maps the old JS shape, node kept for a js container path', () => {
    assert.deepEqual(
      remapClaudeSpawn({ cmd: 'node', args: ['/h/node_modules/@anthropic-ai/claude-code/cli.js', '-p'], containerCliPath: JS }),
      { cmd: 'node', args: [JS, '-p'], remapped: true },
    )
  })

  it('maps the old JS shape to a direct exec for a non-js container path', () => {
    assert.deepEqual(
      remapClaudeSpawn({ cmd: 'node', args: ['/h/@anthropic-ai/claude-code/cli.js', '-p'], containerCliPath: BIN }),
      { cmd: BIN, args: ['-p'], remapped: true },
    )
  })

  it('handles empty args', () => {
    assert.deepEqual(
      remapClaudeSpawn({ cmd: '/h/claude', containerCliPath: JS }),
      { cmd: 'node', args: [JS], remapped: true },
    )
  })

  it('passes non-claude commands through', () => {
    assert.deepEqual(
      remapClaudeSpawn({ cmd: 'bash', args: ['-c', 'x'], containerCliPath: JS, hostClaudePath: '/h/claude' }),
      { cmd: 'bash', args: ['-c', 'x'], remapped: false },
    )
    assert.equal(remapClaudeSpawn({ cmd: '/h/claude-utils', args: [], containerCliPath: JS }).remapped, false)
  })

  it('remaps a Windows backslash cli.js path', () => {
    const r = remapClaudeSpawn({
      cmd: 'node',
      args: ['C:\\Users\\me\\AppData\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', '-p'],
      containerCliPath: JS,
    })
    assert.deepEqual(r, { cmd: 'node', args: [JS, '-p'], remapped: true })
  })

  it('does NOT remap an arg that only contains the cli.js substring mid-string', () => {
    for (const a of ['/w/@anthropic-ai/claude-code/cli.js.map', '/w/@anthropic-ai/claude-code/cli.js/../x.js', 'prefix@anthropic-ai/claude-code/cli.js', '/w/x@anthropic-ai/claude-code/cli.jsx']) {
      const r = remapClaudeSpawn({ cmd: 'node', args: [a, '-p'], containerCliPath: JS })
      assert.equal(r.remapped, false, a)
      assert.equal(r.args[0], a)
    }
  })

  it('maps bun + host cli.js to node + the container cli.js', () => {
    assert.deepEqual(
      remapClaudeSpawn({ cmd: 'bun', args: ['/h/node_modules/@anthropic-ai/claude-code/cli.js', '-p'], containerCliPath: JS }),
      { cmd: 'node', args: [JS, '-p'], remapped: true },
    )
  })

  it('maps a pinned JS script path in args[0]', () => {
    const pinned = '/h/custom/claude-cli.mjs'
    assert.deepEqual(
      remapClaudeSpawn({ cmd: 'node', args: [pinned, '-p'], containerCliPath: JS, hostClaudePath: pinned }),
      { cmd: 'node', args: [JS, '-p'], remapped: true },
    )
  })
})
