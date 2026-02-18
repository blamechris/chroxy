import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MessageTransformPipeline, transforms } from '../src/message-transform.js'

describe('MessageTransformPipeline', () => {
  it('passes through unchanged when no transforms configured', () => {
    const pipeline = new MessageTransformPipeline([])
    assert.equal(pipeline.apply('hello'), 'hello')
    assert.equal(pipeline.hasTransforms, false)
  })

  it('skips unknown transform names', () => {
    const pipeline = new MessageTransformPipeline(['nonexistent'])
    assert.equal(pipeline.apply('hello'), 'hello')
    assert.equal(pipeline.hasTransforms, false)
  })

  it('applies transforms in order', () => {
    const pipeline = new MessageTransformPipeline(['voiceCleanup', 'contextAnnotation'])
    const result = pipeline.apply('um hello world', {
      isVoiceInput: true,
      cwd: '/tmp/project',
    })
    // voiceCleanup removes "um" and adds period, then contextAnnotation prepends context
    assert.ok(result.startsWith('[cwd: /tmp/project]'))
    assert.ok(result.includes('hello world.'))
  })
})

describe('contextAnnotation transform', () => {
  const transform = transforms.contextAnnotation

  it('prepends cwd and model', () => {
    const result = transform('fix the bug', { cwd: '/home/user/project', model: 'opus' })
    assert.equal(result, '[cwd: /home/user/project, model: opus]\n\nfix the bug')
  })

  it('includes git branch when available', () => {
    const result = transform('fix the branch issue', { cwd: '/tmp', gitBranch: 'feat/new' })
    assert.ok(result.includes('branch: feat/new'))
  })

  it('returns message unchanged when no context available', () => {
    const result = transform('fix the bug please', {})
    assert.equal(result, 'fix the bug please')
  })

  it('skips annotation for short messages', () => {
    const result = transform('yes', { cwd: '/tmp', model: 'opus' })
    assert.equal(result, 'yes')
  })

  it('skips annotation for plan approvals', () => {
    const result = transform('approve', { cwd: '/tmp', model: 'opus' })
    assert.equal(result, 'approve')
  })

  it('annotates messages at the threshold length', () => {
    const result = transform('0123456789', { cwd: '/tmp' })
    assert.ok(result.startsWith('[cwd: /tmp]'))
  })
})

describe('voiceCleanup transform', () => {
  const transform = transforms.voiceCleanup

  it('skips non-voice input', () => {
    const result = transform('um hello', { isVoiceInput: false })
    assert.equal(result, 'um hello')
  })

  it('removes filler words at start', () => {
    assert.equal(transform('um fix the bug', { isVoiceInput: true }), 'fix the bug.')
    assert.equal(transform('uh, do something', { isVoiceInput: true }), 'do something.')
    assert.equal(transform('like add a test', { isVoiceInput: true }), 'add a test.')
    assert.equal(transform('okay run tests', { isVoiceInput: true }), 'run tests.')
    assert.equal(transform('well, it works', { isVoiceInput: true }), 'it works.')
    assert.equal(transform('basically just fix it', { isVoiceInput: true }), 'just fix it.')
  })

  it('adds period if missing', () => {
    const result = transform('fix the bug', { isVoiceInput: true })
    assert.equal(result, 'fix the bug.')
  })

  it('does not add period if one exists', () => {
    assert.equal(transform('fix the bug.', { isVoiceInput: true }), 'fix the bug.')
    assert.equal(transform('fix the bug!', { isVoiceInput: true }), 'fix the bug!')
    assert.equal(transform('fix the bug?', { isVoiceInput: true }), 'fix the bug?')
  })

  it('removes mid-sentence um/uh after commas', () => {
    const result = transform('please, um, fix the bug', { isVoiceInput: true })
    assert.equal(result, 'please, fix the bug.')
  })

  it('removes standalone um/uh mid-sentence', () => {
    const result = transform('please um fix the bug', { isVoiceInput: true })
    assert.equal(result, 'please fix the bug.')
  })

  it('removes multiple mid-sentence fillers', () => {
    const result = transform('fix, uh, the um bug', { isVoiceInput: true })
    assert.equal(result, 'fix, the bug.')
  })

  it('removes trailing comma left by filler at end', () => {
    const result = transform('fix the bug, um', { isVoiceInput: true })
    assert.equal(result, 'fix the bug.')
  })

  it('handles empty input', () => {
    const result = transform('', { isVoiceInput: true })
    assert.equal(result, '')
  })
})
