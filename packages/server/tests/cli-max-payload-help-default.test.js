import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Command } from 'commander'
import { addServerOptions } from '../src/cli/shared.js'
import { WsServer } from '../src/ws-server.js'

/**
 * #7011 — `--max-payload` advertised a default that the server never used.
 *
 * The help string in `cli/shared.js` carried a hand-copied literal
 * (`default: 1048576` = 1 MB) with nothing tying it to the fallback WsServer
 * actually applies when `maxPayload` is unset (10 MB, widened for image /
 * document attachments). Commander is given no `defaultValue` for this option,
 * so `chroxy start --help` was the ONLY place an operator could learn the
 * default — and it understated it by 10x, which would send someone raising a
 * limit that was never the constraint.
 *
 * These tests pin the advertised number to the runtime fallback, so the two
 * cannot drift apart again: whichever side someone edits, the other must move
 * with it or this file goes red.
 */
describe('--max-payload advertised default (#7011)', () => {
  /** The `--max-payload` Option object as `chroxy start` registers it. */
  function maxPayloadOption() {
    const program = new Command()
    program.exitOverride()
    const cmd = program.command('start').helpOption(false).action(() => {})
    addServerOptions(cmd)
    const opt = cmd.options.find((o) => o.long === '--max-payload')
    assert.ok(opt, '--max-payload should be a registered start option')
    return opt
  }

  /**
   * The byte cap WsServer actually applies when no `maxPayload` is supplied —
   * i.e. what an operator gets from a bare `chroxy start`. Constructed only
   * (never `start()`ed), so no socket is bound and nothing needs closing.
   */
  function runtimeFallbackMaxPayload() {
    const server = new WsServer({ port: 0, apiToken: 'test-token' })
    return server._maxPayload
  }

  it('help text advertises a numeric byte default', () => {
    const opt = maxPayloadOption()
    assert.match(
      opt.description,
      /\(default:\s*\d+\)/,
      `--max-payload help must advertise its default in bytes, got: ${opt.description}`,
    )
  })

  it('the advertised default equals the cap WsServer falls back to', () => {
    const opt = maxPayloadOption()
    const advertised = Number(/\(default:\s*(\d+)\)/.exec(opt.description)[1])
    const effective = runtimeFallbackMaxPayload()
    assert.equal(
      advertised,
      effective,
      `--max-payload help advertises ${advertised} bytes but WsServer falls back to ${effective} bytes`,
    )
  })

  it('WsServer still honours an explicit --max-payload over its default', () => {
    // Positive control: the fallback under test is a fallback, not a hard-coded
    // cap — without this, the assertion above would still pass if WsServer had
    // stopped reading `maxPayload` at all.
    const server = new WsServer({ port: 0, apiToken: 'test-token', maxPayload: 4096 })
    assert.equal(server._maxPayload, 4096)
    assert.notEqual(server._maxPayload, runtimeFallbackMaxPayload())
  })
})
