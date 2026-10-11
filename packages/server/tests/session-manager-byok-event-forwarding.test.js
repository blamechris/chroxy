import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { DockerByokSession } from '../src/docker-byok-session.js'

const tmpDir = mkdtempSync(join(tmpdir(), 'sm-byok-fwd-'))
after(() => rmSync(tmpDir, { recursive: true, force: true }))

let n = 0
function makeManager() {
  return new SessionManager({
    skipPreflight: true,
    maxSessions: 5,
    stateFilePath: join(tmpDir, `state-${++n}.json`),
  })
}

function wire(mgr, session, provider) {
  mgr._sessions.set('s1', { session, name: 'S1', cwd: '/tmp', provider })
  const frames = []
  mgr.on('session_event', (e) => frames.push(e))
  mgr._wireSessionEvents('s1', session)
  return frames
}

// #8574: tool_start / tool_result are PROXIED events (recorded to history AND
// forwarded). A provider that also lists them in `customEvents` got a second
// listener from the transient loop, so every frame reached the client twice
// with distinct seq numbers.
describe('#8574 — a byok tool call reaches the client exactly once', () => {
  for (const [label, make] of [
    ['ClaudeByokSession', () => new ClaudeByokSession({ cwd: '/tmp' })],
    ['DockerByokSession', () => Object.create(DockerByokSession.prototype)],
  ]) {
    it(`${label}: one session_event per tool_start and per tool_result`, () => {
      const mgr = makeManager()
      const real = make()
      // DockerByokSession needs a container; only its class (customEvents) matters
      // to the wiring, so wire a plain emitter carrying that class.
      const session = real instanceof EventEmitter ? real : Object.assign(new EventEmitter(), { constructor: DockerByokSession })
      const frames = wire(mgr, session, 'byok')

      session.emit('tool_start', { messageId: 'm1', toolUseId: 't1', tool: 'Read', input: {} })
      session.emit('tool_result', { toolUseId: 't1', result: 'ok', truncated: false })

      assert.equal(frames.filter((f) => f.event === 'tool_start').length, 1, 'tool_start forwarded once')
      assert.equal(frames.filter((f) => f.event === 'tool_result').length, 1, 'tool_result forwarded once')
    })
  }

  it('still forwards the byok-only transient events (tool_input_delta, agent_event)', () => {
    const mgr = makeManager()
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    const frames = wire(mgr, session, 'byok')
    session.emit('tool_input_delta', { toolUseId: 't1', partialJson: '{}' })
    session.emit('agent_event', { toolUseId: 't1', type: 'tool_start', payload: {} })
    assert.equal(frames.filter((f) => f.event === 'tool_input_delta').length, 1)
    assert.equal(frames.filter((f) => f.event === 'agent_event').length, 1)
  })

  it('the one tool_start is recorded to history exactly once', () => {
    const mgr = makeManager()
    const session = new ClaudeByokSession({ cwd: '/tmp' })
    wire(mgr, session, 'byok')
    session.emit('tool_start', { messageId: 'm1', toolUseId: 't1', tool: 'Read', input: {} })
    const hist = mgr.getHistory('s1').filter((h) => h.type === 'tool_start' || h.messageType === 'tool_start')
    assert.equal(hist.length, 1, 'history holds a single tool_start entry')
  })

  // A third-party provider registered through registerProvider() is not covered
  // by the in-repo overlap guard, so the wiring defends itself: it drops the
  // overlap (and says so) instead of double-forwarding.
  it('an externally registered provider listing a proxied event in customEvents is not double-forwarded', () => {
    const mgr = makeManager()
    class Sloppy extends EventEmitter {
      static get customEvents() { return ['tool_start', 'tool_result', 'my_event'] }
    }
    const session = new Sloppy()
    const frames = wire(mgr, session, 'sloppy')
    session.emit('tool_start', { messageId: 'm1', toolUseId: 't1', tool: 'Read', input: {} })
    session.emit('my_event', { a: 1 })
    assert.equal(frames.filter((f) => f.event === 'tool_start').length, 1)
    assert.equal(frames.filter((f) => f.event === 'my_event').length, 1, 'non-overlapping custom events still forward')
  })
})
