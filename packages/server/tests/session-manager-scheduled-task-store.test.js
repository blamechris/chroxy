import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SessionManager } from '../src/session-manager.js'
import { ScheduledTaskStore } from '../src/scheduled-task-store.js'

/**
 * #6862 — SessionManager wires + LOADS a default ScheduledTaskStore on daemon
 * start, whose file sits next to the session-state file (so a temp stateFilePath
 * keeps it out of the real ~/.chroxy). A caller may inject its own store. This
 * only asserts the store is constructed + loaded on boot; nothing fires it.
 *
 * Per the #4633 rule every SessionManager here is given a temp stateFilePath.
 */
describe('#6862 SessionManager scheduled-task store wiring', () => {
  let sm
  let dir

  afterEach(() => {
    try { sm?.destroy?.() } catch { /* ignore */ }
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('constructs a default ScheduledTaskStore next to the state file and loads it', () => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-sched-'))
    // Pre-seed the on-disk registry so load-on-start is observable.
    writeFileSync(join(dir, 'scheduled-tasks.json'), JSON.stringify({
      version: 1,
      tasks: [{
        id: 'seeded', name: 'Nightly', enabled: true, prompt: 'do the thing',
        target: {}, cadence: { kind: 'cron', expression: '0 9 * * *' },
        nextRun: null, lastRun: null, createdAt: 0, updatedAt: 0,
      }],
    }))
    sm = new SessionManager({ stateFilePath: join(dir, 'state.json') })
    assert.ok(sm.scheduledTaskStore instanceof ScheduledTaskStore, 'default store constructed')
    const seeded = sm.scheduledTaskStore.get('seeded')
    assert.ok(seeded, 'pre-seeded task loaded on daemon start')
    assert.equal(seeded.prompt, 'do the thing')
    assert.ok(Number.isFinite(seeded.nextRun), 'cron nextRun computed on load')
  })

  it('accepts an injected store instead of the default', () => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-sm-sched-'))
    const injected = new ScheduledTaskStore({ filePath: join(dir, 'custom.json') })
    sm = new SessionManager({ stateFilePath: join(dir, 'state.json'), scheduledTaskStore: injected })
    assert.equal(sm.scheduledTaskStore, injected, 'injected store used verbatim')
  })
})
