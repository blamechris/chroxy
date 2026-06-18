import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractCaseTypes,
  extractHandlersMapKeys,
  extractDashboardHandlerTypes,
} from '@chroxy/protocol/handler-coverage'

/**
 * Unit tests for the shared handler-coverage extractor (#6021).
 *
 * The headline case is the FORMATTING VARIATION that the previous, stricter
 * copies of this regex would have MISSED — proving the unified extractor is the
 * hardened, correct parse that both the protocol guard and the store-core lint
 * now share.
 */

describe('handler-coverage shared extractor (#6021)', () => {
  it('extracts case clause types', () => {
    const src = `
      switch (msg.type) {
        case 'auth_ok':
          break
        case 'session_list': {
          break
        }
      }
    `
    assert.deepEqual(
      [...extractCaseTypes(src)].sort(),
      ['auth_ok', 'session_list'],
    )
  })

  // ── The hardening proof ────────────────────────────────────────────────
  // A HANDLERS map whose FIRST value is a nested object literal whose closing
  // brace sits at column 0 (an `} as const`-style inline object, or a
  // prettier-collapsed value). The old store-core block regex
  // `const HANDLERS: Record<string, Handler> = {([\s\S]*?)\n}` is NON-GREEDY,
  // so it stopped its capture at the FIRST newline-prefixed `}` — the close of
  // the nested literal — truncating the map body to just `early_key: { ... }`
  // and SILENTLY DROPPING every key after it. (The old protocol block regex
  // `…([\s\S]*?)}` had the same failure mode against ANY first `}`, even the
  // indented one.) The unified brace-balanced extractor reads to the map's
  // MATCHING close brace, so it recovers every top-level key.
  it('recovers keys after a nested object literal value (old stricter regex would drop them)', () => {
    const src = [
      'const HANDLERS: Record<string, Handler> = {',
      '  early_key: makeHandler({',
      '  opt: true,',
      '}),',
      '  late_key_a: handleA,',
      '  late_key_b: handleB,',
      '}',
      '',
    ].join('\n')

    // Precondition: the OLD store-core stricter parse truncates at the first
    // `\n}` (the nested literal's close) and loses the late keys.
    const oldBlock = src.match(
      /const HANDLERS:\s*Record<string,\s*Handler>\s*=\s*\{([\s\S]*?)\n\}/,
    )
    const oldKeys = new Set()
    if (oldBlock) {
      for (const m of oldBlock[1].matchAll(/^\s*([a-z_]+):/gm)) oldKeys.add(m[1])
    }
    assert.ok(
      !oldKeys.has('late_key_a') && !oldKeys.has('late_key_b'),
      'precondition: the OLD stricter regex must miss the late keys',
    )

    // The unified extractor recovers all three top-level keys.
    const keys = extractHandlersMapKeys(src)
    assert.ok(keys.has('early_key'), 'early_key recovered')
    assert.ok(keys.has('late_key_a'), 'late_key_a recovered (old regex dropped it)')
    assert.ok(keys.has('late_key_b'), 'late_key_b recovered (old regex dropped it)')
  })

  it('tolerates a decorated closing brace (} as const / trailing tokens)', () => {
    const src = `
const HANDLERS: Record<string, Handler> = {
  alpha: handleAlpha,
  beta: handleBeta,
} as const
`
    assert.deepEqual([...extractHandlersMapKeys(src)].sort(), ['alpha', 'beta'])
  })

  it('returns no map keys when there is no HANDLERS map', () => {
    assert.equal(extractHandlersMapKeys('const x = 1').size, 0)
  })

  it('dashboard extractor unions case clauses and HANDLERS map keys', () => {
    const src = `
const HANDLERS: Record<string, Handler> = {
  pong: handlePong,
}
function handleMessage(msg) {
  switch (msg.type) {
    case 'auth_ok':
      break
  }
}
`
    assert.deepEqual(
      [...extractDashboardHandlerTypes(src)].sort(),
      ['auth_ok', 'pong'],
    )
  })
})
