import { describe, it, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * #9241 -- a Stop pressed while claude-sdk is still verifying the folder's project
 * settings (before any query exists) ends the turn with a `stopped` that carries no
 * `result` of its own. It is the requested stop, so it leaves the marker.
 *
 * The verification is held open by replacing the one module that decides it, so the
 * Stop lands inside the real window (`_pendingDecision`) and not a copy of it.
 */

const realSources = await import('../src/claude-setting-sources.js')
let release
const gate = new Promise((resolve) => { release = resolve })
mock.module('../src/claude-setting-sources.js', {
  namedExports: {
    ...realSources,
    projectSettingsDecidedWithoutScan: () => null,
    projectSettingsAllowedAsync: () => gate,
  },
})
const { SdkSession } = await import('../src/sdk-session.js')

const tmp = mkdtempSync(join(tmpdir(), 'sbr-preflight-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

describe('claude-sdk: Stop during the project-settings verification (#9241)', () => {
  it('leaves one marker, then stopped', async () => {
    const session = new SdkSession({ cwd: '/tmp', stateFilePath: join(tmp, 'state.json') })
    session._fetchSupportedModels = () => {}
    const seen = []
    session.on('result', (r) => seen.push(`result:${r.turnOutcome ?? '-'}`))
    session.on('stopped', () => seen.push('stopped'))
    const turn = session.sendMessage('go')
    assert.ok(session._pendingDecision, 'premise: the turn is inside the verification window')
    session.markStopRequested()
    await session.interrupt()
    release(true)
    await turn
    assert.deepEqual(seen, ['result:stopped_before_output', 'stopped'])
    session.destroy()
  })
})
