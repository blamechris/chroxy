import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'

/**
 * Tests for session auto-labeling — when a session's first user_input is recorded,
 * the session name should be updated to a truncation of that input.
 */

function makeMockSession(overrides = {}) {
  const session = new EventEmitter()
  session.isRunning = false
  session.destroy = () => {}
  Object.assign(session, overrides)
  return session
}

describe('SessionManager auto-labeling', () => {
  let mgr

  beforeEach(() => {
    mgr = new SessionManager({ maxSessions: 5 })
  })

  it('auto-renames session on first user_input when name matches default pattern', () => {
    const session = makeMockSession()
    mgr._sessions.set('s1', { session, name: 'Session 1', cwd: '/tmp' })

    const events = []
    mgr.on('session_updated', (data) => events.push(data))

    mgr.recordUserInput('s1', 'Help me fix the authentication bug in login.ts')

    assert.equal(mgr.getSession('s1').name, 'Help me fix the authentication bug in...')
    assert.equal(events.length, 1)
    assert.equal(events[0].sessionId, 's1')
    assert.equal(events[0].name, 'Help me fix the authentication bug in...')
  })

  it('truncates long messages to 40 chars with ellipsis', () => {
    const session = makeMockSession()
    mgr._sessions.set('s1', { session, name: 'Session 1', cwd: '/tmp' })

    mgr.recordUserInput('s1', 'This is a really long message that exceeds the forty character limit for auto-labels')

    const name = mgr.getSession('s1').name
    assert.ok(name.length <= 43, `Name should be <=43 chars (40 + "..."), got ${name.length}: "${name}"`)
    assert.ok(name.endsWith('...'), 'Should end with ellipsis')
  })

  it('does not truncate short messages', () => {
    const session = makeMockSession()
    mgr._sessions.set('s1', { session, name: 'Session 1', cwd: '/tmp' })

    mgr.recordUserInput('s1', 'Fix the bug')

    assert.equal(mgr.getSession('s1').name, 'Fix the bug')
  })

  it('does not auto-rename on second user_input', () => {
    const session = makeMockSession()
    mgr._sessions.set('s1', { session, name: 'Session 1', cwd: '/tmp' })

    mgr.recordUserInput('s1', 'First message')
    mgr.recordUserInput('s1', 'Second message')

    assert.equal(mgr.getSession('s1').name, 'First message')
  })

  it('does not auto-rename if session has a custom name', () => {
    const session = makeMockSession()
    mgr._sessions.set('s1', { session, name: 'My Custom Session', cwd: '/tmp' })

    const events = []
    mgr.on('session_updated', (data) => events.push(data))

    mgr.recordUserInput('s1', 'Some input text')

    assert.equal(mgr.getSession('s1').name, 'My Custom Session')
    assert.equal(events.length, 0, 'Should not emit session_updated')
  })

  it('auto-renames "New Session" default names', () => {
    const session = makeMockSession()
    mgr._sessions.set('s1', { session, name: 'New Session', cwd: '/tmp' })

    mgr.recordUserInput('s1', 'Help me with something')

    assert.equal(mgr.getSession('s1').name, 'Help me with something')
  })

  it('handles empty user_input gracefully (no rename)', () => {
    const session = makeMockSession()
    mgr._sessions.set('s1', { session, name: 'Session 1', cwd: '/tmp' })

    const events = []
    mgr.on('session_updated', (data) => events.push(data))

    mgr.recordUserInput('s1', '')

    assert.equal(mgr.getSession('s1').name, 'Session 1')
    assert.equal(events.length, 0)
  })

  it('handles whitespace-only user_input gracefully (no rename)', () => {
    const session = makeMockSession()
    mgr._sessions.set('s1', { session, name: 'Session 1', cwd: '/tmp' })

    mgr.recordUserInput('s1', '   ')

    assert.equal(mgr.getSession('s1').name, 'Session 1')
  })

  it('truncates at word boundary when possible', () => {
    const session = makeMockSession()
    mgr._sessions.set('s1', { session, name: 'Session 1', cwd: '/tmp' })

    // 45 chars: "Help me refactor the authentication module now"
    mgr.recordUserInput('s1', 'Help me refactor the authentication module now')

    const name = mgr.getSession('s1').name
    assert.ok(name.length <= 43, `Name "${name}" should be <=43 chars`)
    assert.ok(name.endsWith('...'), 'Should end with ellipsis')
    // Should break at word boundary before "module"
    assert.ok(!name.includes('modul'), 'Should not include partial word')
  })

  it('skips attachment-only markers as labels', () => {
    const session = makeMockSession()
    mgr._sessions.set('s1', { session, name: 'Session 1', cwd: '/tmp' })

    // First message is attachment-only
    mgr.recordUserInput('s1', '[2 file(s) attached]')
    assert.equal(mgr.getSession('s1').name, 'Session 1')

    // Second message with actual text should still auto-label
    mgr.recordUserInput('s1', 'Review these files please')
    assert.equal(mgr.getSession('s1').name, 'Review these files please')
  })

  it('does not auto-rename after manual rename (even if name matches default pattern)', () => {
    const session = makeMockSession()
    mgr._sessions.set('s1', { session, name: 'Session 1', cwd: '/tmp' })

    // Manually rename to a default-looking name
    mgr.renameSession('s1', 'Session 5')

    // Next user input should NOT overwrite the manual rename
    mgr.recordUserInput('s1', 'This should not become the label')

    assert.equal(mgr.getSession('s1').name, 'Session 5')
  })
})
