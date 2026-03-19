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

/**
 * Files that intentionally retain user-facing console output (startup banners,
 * QR code display, CLI error messages with process.exit, etc.).
 * These are audited manually — the logger would wrap them in timestamps that
 * break the terminal UX.
 */
const CONSOLE_ALLOWED_FILES = new Set([
  'server-cli.js',
])

/** Discover all src/*.js files that import createLogger (excluding logger.js itself). */
function discoverLoggerFiles() {
  const files = readdirSync(SRC).filter(f => f.endsWith('.js') && f !== 'logger.js')
  return files.filter(f => {
    const src = readSrc(f)  // let errors propagate — a read failure is a test failure
    return /import\s*\{[^}]*\bcreateLogger\b[^}]*\}\s*from\s*['"]\.\/logger\.js['"]/.test(src)
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

      if (CONSOLE_ALLOWED_FILES.has(filename)) {
        it('is in the console-allowed list (user-facing output)', () => {
          // server-cli.js and similar files retain console.log for startup banners,
          // QR code display, and CLI error messages. These are audited manually.
          assert.ok(true)
        })
      } else {
        it('has no direct console.* calls', () => {
          const src = readSrc(filename)
          const count = countConsoleCalls(src)
          assert.equal(count, 0, `${filename} has ${count} direct console.* call(s) — use logger instead`)
        })
      }
    })
  }
})
