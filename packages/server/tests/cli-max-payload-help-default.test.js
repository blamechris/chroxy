import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
 * These tests pin every advertised number to the runtime fallback, so they
 * cannot drift apart again: whichever side someone edits, the others must move
 * with it or this file goes red.
 *
 * There are FOUR surfaces quoting this default, not three — the WsServer
 * fallback, the `--max-payload` help text, CONFIG.md, and `.env.example`, which
 * documents the `CHROXY_MAX_PAYLOAD` spelling of the same setting. `.env.example`
 * was missed by an audit that grepped only the CLI-flag spelling (`max-payload`)
 * and so never saw `CHROXY_MAX_PAYLOAD`. It is the worst of the four to leave
 * stale: its value is meant to be uncommented as-is, so a 1 MB literal there
 * doesn't merely misinform — it silently drops the cap 10x for anyone who uses
 * it. Static files can't import the constant, so they get pinned by test instead.
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

  /**
   * The single `.env.example` line documenting `CHROXY_MAX_PAYLOAD` — the env
   * spelling of the same setting, and the fourth surface quoting its default.
   */
  function envExampleMaxPayloadLine() {
    const path = fileURLToPath(new URL('../.env.example', import.meta.url))
    const line = readFileSync(path, 'utf8')
      .split('\n')
      .find((l) => l.includes('CHROXY_MAX_PAYLOAD'))
    assert.ok(line, '.env.example should document CHROXY_MAX_PAYLOAD')
    return line
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

  it('.env.example ships CHROXY_MAX_PAYLOAD at the cap WsServer falls back to', () => {
    // That line is meant to be uncommented verbatim, so a stale literal here is
    // not just wrong documentation — it hands the operator a 10x smaller cap.
    const line = envExampleMaxPayloadLine()
    const match = /CHROXY_MAX_PAYLOAD=(\d+)/.exec(line)
    assert.ok(match, `.env.example must show CHROXY_MAX_PAYLOAD as a byte literal, got: ${line}`)
    const advertised = Number(match[1])
    const effective = runtimeFallbackMaxPayload()
    assert.equal(
      advertised,
      effective,
      `.env.example ships CHROXY_MAX_PAYLOAD=${advertised} but WsServer falls back to ${effective} bytes`,
    )
  })

  it('CONFIG.md documents the cap WsServer falls back to', () => {
    // CONFIG.md is the third hand-copied surface. It happened to be correct, but
    // "correct today" is what the help text was before it drifted 10x.
    const path = fileURLToPath(new URL('../CONFIG.md', import.meta.url))
    const row = readFileSync(path, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('| `maxPayload`'))
    assert.ok(row, 'CONFIG.md should carry a `maxPayload` row')
    const match = /[Ee]ffective default `(\d+)`/.exec(row)
    assert.ok(match, `CONFIG.md must state maxPayload's effective default in bytes, got: ${row}`)
    const documented = Number(match[1])
    const effective = runtimeFallbackMaxPayload()
    assert.equal(
      documented,
      effective,
      `CONFIG.md documents ${documented} bytes but WsServer falls back to ${effective} bytes`,
    )
  })

  it('.env.example prose megabyte figure agrees with its byte literal', () => {
    // The 10x drift this issue is about lived in prose, not in a value — so the
    // human-readable half of the line gets pinned too.
    const line = envExampleMaxPayloadLine()
    const match = /\(default:\s*(\d+)\s*MB\)/i.exec(line)
    assert.ok(match, `.env.example must state CHROXY_MAX_PAYLOAD's default in MB, got: ${line}`)
    const advertisedBytes = Number(match[1]) * 1024 * 1024
    const effective = runtimeFallbackMaxPayload()
    assert.equal(
      advertisedBytes,
      effective,
      `.env.example prose says ${match[1]}MB but WsServer falls back to ${effective} bytes`,
    )
  })
})
