import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { defaultShell, writeFileRestricted, forceKill, isWindows } from '../src/platform.js'

describe('platform', () => {
  describe('isWindows', () => {
    it('is a boolean', () => {
      assert.strictEqual(typeof isWindows, 'boolean')
    })
  })

  describe('defaultShell()', () => {
    it('returns a non-empty string', () => {
      const shell = defaultShell()
      assert.strictEqual(typeof shell, 'string')
      assert.ok(shell.length > 0)
    })
  })

  describe('writeFileRestricted()', () => {
    let tmpDir

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'platform-test-'))
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('writes file content correctly', () => {
      const filePath = join(tmpDir, 'test.txt')
      writeFileRestricted(filePath, 'hello world')
      const content = readFileSync(filePath, 'utf-8')
      assert.strictEqual(content, 'hello world')
    })

    it('overwrites existing file', () => {
      const filePath = join(tmpDir, 'test.txt')
      writeFileRestricted(filePath, 'first')
      writeFileRestricted(filePath, 'second')
      const content = readFileSync(filePath, 'utf-8')
      assert.strictEqual(content, 'second')
    })

    if (!isWindows) {
      it('sets 0o600 permissions on Unix', () => {
        const filePath = join(tmpDir, 'restricted.txt')
        writeFileRestricted(filePath, 'secret')
        const mode = statSync(filePath).mode & 0o777
        assert.strictEqual(mode, 0o600)
      })
    }
  })

  describe('forceKill()', () => {
    it('calls kill on the child object', () => {
      let killed = false
      let signal = null
      const fakeChild = {
        kill(sig) {
          killed = true
          signal = sig
        },
      }
      forceKill(fakeChild)
      assert.ok(killed)
      assert.strictEqual(signal, 'SIGKILL')
    })
  })
})
