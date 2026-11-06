import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionManager } from '../../src/session-manager.js'
import { BaseSession } from '../../src/base-session.js'
import { registerProvider } from '../../src/providers.js'
import { declareUnknownCustomization } from '../helpers/provider-customization.js'
class ReviewProvider extends BaseSession {
  static get capabilities() { return { resume: true } }
  start() {} sendMessage() {} interrupt() {} setModel() {} setPermissionMode() {}
  destroy() { this._destroyPendingBackgroundShells(); this.removeAllListeners() }
}
declareUnknownCustomization(ReviewProvider)
registerProvider('test-review-8854-persistence', ReviewProvider)
const dir = process.argv[2]
if (process.argv[3] === 'exit-before-ready') {
  process.disconnect()
} else {
  const sm = new SessionManager({ skipPreflight: true, stateFilePath: join(dir, 'crash.json') })
  const id = sm.createSession({ cwd: dir, provider: 'test-review-8854-persistence' })
  Date.now = () => 1800000000000
  sm.setDeclaredStatus(id, { state: 'blocked', summary: 'First', decision: 'First' })
  sm.setDeclaredStatus(id, { state: 'idle', summary: 'Cleared', decision: 'none' })
  sm.setDeclaredStatus(id, { state: 'blocked', summary: 'Crash recovery', decision: 'Pick crash target' })
  sm.serializeState()
  process.on('exit', () => writeFileSync(join(dir, 'graceful-exit'), 'exit cleanup ran'))
  // Parent kills only after this post-write readiness boundary. Parent-controlled
  // process.kill records SIGKILL for its libuv child handle on Windows too.
  process.send({ type: 'declared-state-ready' })
  process.once('message', (message) => {
    if (message === 'finish-gracefully') {
      sm.destroyAll()
      process.disconnect()
    }
  })
}
