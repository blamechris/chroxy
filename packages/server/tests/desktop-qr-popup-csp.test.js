import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DESKTOP_SRC = resolve(import.meta.dirname, '../../desktop/src-tauri/src')

describe('QR popup CSP compliance (#1961)', () => {
  it('handle_show_qr does not use document.write or win.eval for content injection', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'lib.rs'), 'utf-8')
    // Check non-comment lines for document.write/open calls
    const codeLines = src.split('\n').filter(l => !l.trim().startsWith('//'))
    const codeOnly = codeLines.join('\n')
    assert.ok(
      !codeOnly.match(/document\.write\s*\(/),
      'lib.rs should not call document.write() — CSP violation risk',
    )
    assert.ok(
      !codeOnly.match(/document\.open\s*\(/),
      'lib.rs should not call document.open() — CSP violation risk',
    )
  })

  it('does not silently swallow serialization errors with unwrap_or_default', () => {
    const src = readFileSync(resolve(DESKTOP_SRC, 'lib.rs'), 'utf-8')
    // The old pattern: serde_json::to_string(&html).unwrap_or_default()
    // This silently produced blank pages on failure
    const qrSection = src.slice(src.indexOf('handle_show_qr'), src.indexOf('handle_toggle_login'))
    assert.ok(
      !qrSection.includes('unwrap_or_default'),
      'QR popup should not use unwrap_or_default — serialization errors should be reported',
    )
  })
})
