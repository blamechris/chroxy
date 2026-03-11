import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('respondToQuestion multi-question support (#1945)', () => {
  let sdkSrc

  beforeEach(() => {
    sdkSrc = readFileSync(join(__dirname, '../src/sdk-session.js'), 'utf-8')
  })

  it('respondToQuestion accepts optional answersMap parameter', () => {
    // The method signature should accept (text, answersMap)
    const match = sdkSrc.match(/respondToQuestion\s*\(\s*text\s*,\s*answersMap\s*\)/)
    assert.ok(match, 'respondToQuestion should accept (text, answersMap) parameters')
  })

  it('uses answersMap when provided instead of mapping single text to all questions', () => {
    // The method body should check for answersMap before falling back to single-text mapping
    const methodStart = sdkSrc.indexOf('respondToQuestion(text, answersMap)')
    assert.ok(methodStart > -1, 'Method should have answersMap parameter')
    const methodBody = sdkSrc.slice(methodStart, sdkSrc.indexOf('\n  }', methodStart + 100) + 4)
    assert.ok(methodBody.includes('answersMap'), 'respondToQuestion body should use answersMap')
    assert.ok(methodBody.includes('Object.keys(answersMap)') || methodBody.includes('Object.assign'),
      'Should check or use answersMap contents')
  })
})

describe('UserQuestionResponseSchema (#1945)', () => {
  let schemaSrc

  beforeEach(() => {
    schemaSrc = readFileSync(join(__dirname, '../src/ws-schemas.js'), 'utf-8')
  })

  it('includes optional answers field for per-question responses', () => {
    assert.ok(schemaSrc.includes('answers:'), 'UserQuestionResponseSchema should have answers field')
  })
})

describe('handleUserQuestionResponse (#1945)', () => {
  let handlerSrc

  beforeEach(() => {
    handlerSrc = readFileSync(join(__dirname, '../src/handlers/input-handlers.js'), 'utf-8')
  })

  it('passes answers map to respondToQuestion when present', () => {
    assert.ok(handlerSrc.includes('msg.answers'), 'Handler should check for msg.answers')
    assert.ok(handlerSrc.includes('respondToQuestion'), 'Handler should call respondToQuestion')
  })
})
