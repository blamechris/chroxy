import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Command } from 'commander'
import { addServerOptions } from '../src/cli/shared.js'

/**
 * CLI flag wiring for `--dangerously-skip-permissions` on `chroxy start` /
 * `chroxy dev` (#4209).
 *
 * Mirrors the precedent set by `chroxy resume --dangerously-skip-permissions`
 * (packages/server/src/cli/session-cmd.js:59), but on the server-launch
 * commands so operators running a TUI-provider chroxy headlessly can opt
 * in without round-tripping through the dashboard. The flag flows into
 * `cliOverrides.skipPermissions` -> SessionManager `defaultSkipPermissions`
 * -> ClaudeTuiSession constructor (-> `--dangerously-skip-permissions`
 * literal on the claude PTY spawn).
 */
describe('chroxy start --dangerously-skip-permissions wiring (#4209)', () => {
  function makeServerCmd() {
    const program = new Command()
    program.exitOverride()
    const cmd = program
      .command('start')
      .helpOption(false)
      .action(() => {})
    addServerOptions(cmd)
    return { program, cmd }
  }

  it('registers --dangerously-skip-permissions as a recognised option', () => {
    const { cmd } = makeServerCmd()
    const optNames = cmd.options.map((o) => o.long)
    assert.ok(
      optNames.includes('--dangerously-skip-permissions'),
      `--dangerously-skip-permissions must be registered on chroxy start. Got: ${optNames.join(', ')}`,
    )
  })

  it('flag is documented as TUI-only in help text', () => {
    const { cmd } = makeServerCmd()
    const opt = cmd.options.find((o) => o.long === '--dangerously-skip-permissions')
    assert.ok(opt, 'option must exist')
    // Help copy should make the TUI-only constraint obvious so operators
    // running claude-sdk / claude-byok don't think they're configuring a
    // flag that does nothing.
    assert.match(opt.description, /TUI/i,
      'help text should call out TUI-only scope')
    assert.match(opt.description, /dangerously-skip-permissions/,
      'help text should name the underlying claude flag for searchability')
  })

  it('parsing `--dangerously-skip-permissions` sets options.dangerouslySkipPermissions to true', () => {
    const { program } = makeServerCmd()
    // commander auto-camelCases dashed flag names — verify that's what
    // loadAndMergeConfig will see, since the wiring there reads
    // `options.dangerouslySkipPermissions`.
    program.parse(['node', 'chroxy', 'start', '--dangerously-skip-permissions'])
    const opts = program.commands.find((c) => c.name() === 'start').opts()
    assert.equal(opts.dangerouslySkipPermissions, true,
      'commander must surface the boolean under dangerouslySkipPermissions')
  })

  it('absent flag leaves options.dangerouslySkipPermissions undefined', () => {
    const { program } = makeServerCmd()
    program.parse(['node', 'chroxy', 'start'])
    const opts = program.commands.find((c) => c.name() === 'start').opts()
    assert.equal(opts.dangerouslySkipPermissions, undefined,
      'absent flag must NOT default to false — preserves config-file precedence in loadAndMergeConfig')
  })
})
