import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildServerBanner } from '../src/server-cli.js'

/**
 * Startup banner — issue #2953.
 *
 * The banner line (`Chroxy Server vX.Y.Z (<mode>)`) previously hardcoded a
 * `PROVIDER_LABELS` map that only knew about `claude-cli` / `claude-sdk`; any
 * other provider fell through to its raw id (e.g. `Mode: codex`). The helper
 * now delegates to `resolveProviderLabel()` so each provider owns its own
 * display name via `static get displayLabel()`.
 */
describe('buildServerBanner (#2953)', () => {
  it('uses the Claude Code (SDK) label for claude-sdk', () => {
    const line = buildServerBanner({ version: '1.2.3', provider: 'claude-sdk' })
    assert.match(line, /Chroxy Server v1\.2\.3 \(Claude Code \(SDK\)\)/)
  })

  it('uses the Claude Code (CLI) label for claude-cli', () => {
    const line = buildServerBanner({ version: '1.2.3', provider: 'claude-cli' })
    assert.match(line, /Chroxy Server v1\.2\.3 \(Claude Code \(CLI\)\)/)
  })

  it('uses the OpenAI Codex label for codex (no fallthrough to raw id)', () => {
    const line = buildServerBanner({ version: '1.2.3', provider: 'codex' })
    assert.match(line, /Chroxy Server v1\.2\.3 \(OpenAI Codex\)/)
    assert.doesNotMatch(line, /\(codex\)/)
  })

  it('uses the Google Gemini label for gemini (no fallthrough to raw id)', () => {
    const line = buildServerBanner({ version: '1.2.3', provider: 'gemini' })
    assert.match(line, /Chroxy Server v1\.2\.3 \(Google Gemini\)/)
    assert.doesNotMatch(line, /\(gemini\)/)
  })

  it('defaults to claude-sdk when no provider is supplied', () => {
    const line = buildServerBanner({ version: '1.2.3' })
    assert.match(line, /Chroxy Server v1\.2\.3 \(Claude Code \(SDK\)\)/)
  })

  it('falls back to the raw provider name for unknown providers', () => {
    const line = buildServerBanner({ version: '1.2.3', provider: 'my-custom-thing' })
    assert.match(line, /Chroxy Server v1\.2\.3 \(my-custom-thing\)/)
  })
})
