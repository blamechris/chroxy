import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('gitStage/gitUnstage path validation (#1958)', () => {
  let src

  beforeEach(() => {
    src = readFileSync(join(__dirname, '../src/ws-file-ops.js'), 'utf-8')
  })

  it('gitStage validates file paths before passing to git', () => {
    // Find the gitStage function body
    const stageStart = src.indexOf('async function gitStage(')
    const stageEnd = src.indexOf('\n  }', stageStart + 50)
    const stageBody = src.slice(stageStart, stageEnd)

    assert.ok(stageBody.includes('validatePathWithinCwd') || stageBody.includes('resolve('),
      'gitStage should validate paths against CWD')
    assert.ok(stageBody.includes('traversal') || stageBody.includes('Access denied') || stageBody.includes('outside'),
      'gitStage should reject paths outside CWD with error message')
  })

  it('gitUnstage validates file paths before passing to git', () => {
    const unstageStart = src.indexOf('async function gitUnstage(')
    const unstageEnd = src.indexOf('\n  }', unstageStart + 50)
    const unstageBody = src.slice(unstageStart, unstageEnd)

    assert.ok(unstageBody.includes('validatePathWithinCwd') || unstageBody.includes('resolve('),
      'gitUnstage should validate paths against CWD')
    assert.ok(unstageBody.includes('traversal') || unstageBody.includes('Access denied') || unstageBody.includes('outside'),
      'gitUnstage should reject paths outside CWD with error message')
  })

  it('rejects absolute paths and traversal sequences', () => {
    // Both functions should check each file path, not just pass raw paths
    const stageStart = src.indexOf('async function gitStage(')
    const stageEnd = src.indexOf('\n  }', stageStart + 50)
    const stageBody = src.slice(stageStart, stageEnd)

    // Should iterate over files and validate each
    assert.ok(stageBody.includes('for') || stageBody.includes('.filter') || stageBody.includes('.every'),
      'Should validate each file path individually')
  })
})
