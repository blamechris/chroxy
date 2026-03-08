import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Verifies that every src/*.js file that imports createLogger uses the
 * structured logger exclusively — no direct console.* calls.
 *
 * Files are discovered dynamically: any file added to src/ that imports
 * createLogger is automatically covered without manual test updates.
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

/** Discover all src/*.js files that import createLogger (excluding logger.js itself). */
function discoverLoggerFiles() {
  const files = readdirSync(SRC).filter(f => f.endsWith('.js') && f !== 'logger.js')
  return files.filter(f => {
    const src = readSrc(f)  // let errors propagate — a read failure is a test failure
    return src.includes("from './logger.js'") && src.includes('createLogger')
  })
}

describe('logger usage', () => {
  const loggerFiles = discoverLoggerFiles()

  // Sanity: always expect at least the two originally-migrated files
  it('discovers at least ws-server.js and sdk-session.js', () => {
    assert.ok(loggerFiles.includes('ws-server.js'), 'ws-server.js must be discovered')
    assert.ok(loggerFiles.includes('sdk-session.js'), 'sdk-session.js must be discovered')
  })

  for (const filename of loggerFiles) {
    describe(filename, () => {
      it('imports createLogger from logger.js', () => {
        const src = readSrc(filename)
        assert.ok(
          src.includes("from './logger.js'"),
          `${filename} must import from ./logger.js`
        )
      })

      it('has no direct console.* calls', () => {
        const src = readSrc(filename)
        const count = countConsoleCalls(src)
        assert.equal(count, 0, `${filename} has ${count} direct console.* call(s) — use logger instead`)
      })
    })
  }
})
