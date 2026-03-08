import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Verifies ws-server.js and sdk-session.js use the structured logger
 * (logger.js) instead of calling console.* directly.
 *
 * RED: both files currently have direct console.* calls and no logger import.
 * GREEN: after refactor, 0 direct calls, both import createLogger.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '../src')

function readSrc(filename) {
  return readFileSync(join(SRC, filename), 'utf8')
}

/** Count direct console.log/warn/error/debug/info calls in source (ignores comments). */
function countConsoleCalls(source) {
  // Strip single-line and block comments before matching to avoid false positives
  // from documentation examples like: // do not use console.log(
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
    .replace(/\/\/[^\n]*/g, '')          // single-line comments
  return (stripped.match(/\bconsole\.(log|warn|error|debug|info)\(/g) || []).length
}

describe('logger usage', () => {
  describe('ws-server.js', () => {
    it('imports createLogger from logger.js', () => {
      const src = readSrc('ws-server.js')
      assert.ok(
        src.includes("from './logger.js'"),
        'ws-server.js must import from ./logger.js'
      )
    })

    it('has no direct console.* calls', () => {
      const src = readSrc('ws-server.js')
      const count = countConsoleCalls(src)
      assert.equal(count, 0, `ws-server.js has ${count} direct console.* call(s) — use logger instead`)
    })
  })

  describe('sdk-session.js', () => {
    it('imports createLogger from logger.js', () => {
      const src = readSrc('sdk-session.js')
      assert.ok(
        src.includes("from './logger.js'"),
        'sdk-session.js must import from ./logger.js'
      )
    })

    it('has no direct console.* calls', () => {
      const src = readSrc('sdk-session.js')
      const count = countConsoleCalls(src)
      assert.equal(count, 0, `sdk-session.js has ${count} direct console.* call(s) — use logger instead`)
    })
  })
})
