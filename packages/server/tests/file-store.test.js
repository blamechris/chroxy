import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readJsonFile, writeJsonFile, ensureDir } from '../src/file-store.js'

describe('file-store', () => {
  let tmpDir

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'file-store-test-'))
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('readJsonFile', () => {
    it('returns default value for missing file', () => {
      const result = readJsonFile(join(tmpDir, 'nonexistent.json'), { empty: true })
      assert.deepStrictEqual(result, { empty: true })
    })

    it('returns null default when no default specified', () => {
      const result = readJsonFile(join(tmpDir, 'nonexistent.json'))
      assert.strictEqual(result, null)
    })

    it('throws for corrupt JSON', () => {
      const corruptPath = join(tmpDir, 'corrupt.json')
      writeFileSync(corruptPath, '{not valid json!!!')
      assert.throws(() => readJsonFile(corruptPath), SyntaxError)
    })

    it('reads valid JSON', () => {
      const validPath = join(tmpDir, 'valid.json')
      writeFileSync(validPath, JSON.stringify({ key: 'value', count: 42 }))
      const result = readJsonFile(validPath)
      assert.deepStrictEqual(result, { key: 'value', count: 42 })
    })

    it('reads JSON arrays', () => {
      const arrayPath = join(tmpDir, 'array.json')
      writeFileSync(arrayPath, JSON.stringify(['a', 'b', 'c']))
      const result = readJsonFile(arrayPath, [])
      assert.deepStrictEqual(result, ['a', 'b', 'c'])
    })
  })

  describe('writeJsonFile', () => {
    it('creates parent directories', () => {
      const nestedPath = join(tmpDir, 'deep', 'nested', 'dir', 'data.json')
      writeJsonFile(nestedPath, { created: true })
      const raw = readFileSync(nestedPath, 'utf-8')
      assert.deepStrictEqual(JSON.parse(raw), { created: true })
    })

    it('writes pretty-printed JSON with trailing newline', () => {
      const outPath = join(tmpDir, 'pretty.json')
      writeJsonFile(outPath, { a: 1 })
      const raw = readFileSync(outPath, 'utf-8')
      assert.strictEqual(raw, '{\n  "a": 1\n}\n')
    })

    it('overwrites existing file', () => {
      const overwritePath = join(tmpDir, 'overwrite.json')
      writeJsonFile(overwritePath, { version: 1 })
      writeJsonFile(overwritePath, { version: 2 })
      const result = readJsonFile(overwritePath)
      assert.deepStrictEqual(result, { version: 2 })
    })
  })

  describe('ensureDir', () => {
    it('creates nested directories', () => {
      const dirPath = join(tmpDir, 'ensure', 'nested', 'path')
      ensureDir(dirPath)
      // Verify by writing a file inside it
      const testFile = join(dirPath, 'test.txt')
      writeFileSync(testFile, 'ok')
      assert.strictEqual(readFileSync(testFile, 'utf-8'), 'ok')
    })

    it('is idempotent on existing directory', () => {
      const dirPath = join(tmpDir, 'ensure', 'nested', 'path')
      // Should not throw when called again
      ensureDir(dirPath)
    })
  })
})
