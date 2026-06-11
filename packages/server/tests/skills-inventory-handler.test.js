import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { controlRoomHandlers } from '../src/handlers/control-room-handlers.js'
import { registeredMessageTypes } from '../src/ws-message-handlers.js'
import { createSpy, createMockSessionManager, nsCtx } from './test-helpers.js'
import { ServerSkillsInventorySnapshotSchema } from '@chroxy/protocol'

/**
 * #5554 — tests for the Control Room Skills inventory WS handler.
 *
 * The survey itself (control-room/skills-inventory.js) is injected via
 * `ctx.surveySkillsInventory` so the handler test never touches the real
 * filesystem or the user's home directory.
 */

const SAMPLE_SNAPSHOT = {
  generatedAt: '2026-06-11T00:00:00.000Z',
  root: '/home/user/Projects',
  global: [
    {
      name: 'batch-merge', description: 'Merge PRs in a batch', source: 'global',
      activation: 'auto', active: true, providers: [], version: null,
      trustState: null, communityAuthor: null, hash: '0a76684', installed: '2026-06-03',
      lastUsed: '2026-06-10T00:00:00.000Z', useCount: 12, usedRepos: ['/home/user/Projects/chroxy'],
    },
  ],
  globalError: null,
  repos: [
    {
      name: 'chroxy', path: '/home/user/Projects/chroxy',
      skills: [
        {
          name: 'coding-style', description: 'Repo coding style', source: 'repo',
          activation: 'auto', active: true, providers: [], version: null,
          trustState: null, communityAuthor: null, hash: null, installed: null,
          overridesGlobal: false, lastUsed: null, useCount: 0, usedRepos: [],
        },
      ],
      error: null,
    },
  ],
}

function makeCtx(overrides = {}) {
  const sendSpy = createSpy()
  const { manager } = createMockSessionManager([
    { id: 'sess-1', name: 'Work', cwd: '/home/user/Projects/chroxy' },
  ])
  return nsCtx({
    send: sendSpy,
    sessionManager: manager,
    config: { repos: [], controlRoomRoot: '/home/user/Projects' },
    surveySkillsInventory: createSpy(async () => SAMPLE_SNAPSHOT),
    resolveRepoSet: createSpy(() => SAMPLE_SNAPSHOT.repos.map(r => ({ name: r.name, path: r.path }))),
    ...overrides,
    _send: sendSpy,
  })
}

describe('skills_inventory_request handler (#5554)', () => {
  let ctx, client, ws

  beforeEach(() => {
    ctx = makeCtx()
    client = { id: 'client-A' }
    ws = {}
  })

  it('is registered in the WS handler registry', () => {
    assert.ok(
      registeredMessageTypes.includes('skills_inventory_request'),
      'skills_inventory_request should be in registeredMessageTypes',
    )
    assert.equal(typeof controlRoomHandlers.skills_inventory_request, 'function')
  })

  it('replies with a schema-conformant skills_inventory_snapshot', async () => {
    const handler = controlRoomHandlers.skills_inventory_request
    await handler(ws, client, { type: 'skills_inventory_request', requestId: 'r1' }, ctx)

    assert.equal(ctx._send.callCount, 1)
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'skills_inventory_snapshot')
    assert.equal(payload.requestId, 'r1')

    const { requestId, ...rest } = payload
    void requestId
    const parsed = ServerSkillsInventorySnapshotSchema.safeParse(rest)
    assert.ok(parsed.success, `snapshot should be schema-valid: ${JSON.stringify(parsed.error?.issues)}`)
    assert.equal(payload.root, SAMPLE_SNAPSHOT.root)
    assert.equal(payload.global.length, 1)
    assert.equal(payload.repos.length, 1)
    assert.equal(payload.repos[0].skills[0].name, 'coding-style')
  })

  it('resolves the repo set from config.repos and controlRoomRoot', async () => {
    ctx = makeCtx({ config: { repos: [{ path: '/x', name: 'x' }], controlRoomRoot: '/root' } })
    const handler = controlRoomHandlers.skills_inventory_request
    await handler(ws, client, { type: 'skills_inventory_request' }, ctx)

    assert.equal(ctx.resolveRepoSet.callCount, 1)
    const [arg] = ctx.resolveRepoSet.lastCall
    assert.deepEqual(arg.repos, [{ path: '/x', name: 'x' }])
    assert.equal(arg.root, '/root')
  })

  it('joins usage aggregates from the recorder', async () => {
    const aggregates = new Map([['batch-merge', { lastUsed: 123, count: 4, repos: ['/r'] }]])
    ctx = makeCtx({
      skillsUsageRecorder: { aggregatesByName: () => aggregates },
    })
    const handler = controlRoomHandlers.skills_inventory_request
    await handler(ws, client, { type: 'skills_inventory_request' }, ctx)

    assert.equal(ctx.surveySkillsInventory.callCount, 1)
    const [, opts] = ctx.surveySkillsInventory.lastCall
    assert.strictEqual(opts.usage, aggregates, 'recorder aggregates should be passed to the survey')
  })

  it('passes null usage when no recorder is wired', async () => {
    const handler = controlRoomHandlers.skills_inventory_request
    await handler(ws, client, { type: 'skills_inventory_request' }, ctx)
    const [, opts] = ctx.surveySkillsInventory.lastCall
    assert.equal(opts.usage, null)
  })

  it('rejects a session-bound client with a schema-valid FORBIDDEN snapshot', async () => {
    client.boundSessionId = 'sess-1'
    const handler = controlRoomHandlers.skills_inventory_request
    await handler(ws, client, { type: 'skills_inventory_request', requestId: 'rf' }, ctx)

    assert.equal(ctx.surveySkillsInventory.callCount, 0, 'survey must not run for a bound client')
    const [, payload] = ctx._send.lastCall
    assert.equal(payload.type, 'skills_inventory_snapshot')
    assert.equal(payload.error.code, 'FORBIDDEN')
    assert.equal(payload.requestId, 'rf')
    assert.deepEqual(payload.global, [])
    assert.deepEqual(payload.repos, [])
    const { requestId, ...rest } = payload
    void requestId
    assert.ok(ServerSkillsInventorySnapshotSchema.safeParse(rest).success, 'FORBIDDEN reply must be a valid snapshot')
  })

  it('rejects an overlapping in-flight survey with SURVEY_IN_PROGRESS', async () => {
    // A survey that never settles pins the in-flight guard for this client.
    let release
    const gate = new Promise((res) => { release = res })
    ctx = makeCtx({ surveySkillsInventory: createSpy(() => gate.then(() => SAMPLE_SNAPSHOT)) })
    const handler = controlRoomHandlers.skills_inventory_request

    const first = handler(ws, client, { type: 'skills_inventory_request' }, ctx)
    // Second request lands while the first is still in flight.
    await handler(ws, client, { type: 'skills_inventory_request' }, ctx)

    const rejected = ctx._send.lastCall
    assert.equal(rejected[1].error.code, 'SURVEY_IN_PROGRESS')

    release()
    await first
  })

  it('degrades a thrown survey to a SURVEY_FAILED snapshot', async () => {
    ctx = makeCtx({ surveySkillsInventory: createSpy(async () => { throw new Error('boom') }) })
    const handler = controlRoomHandlers.skills_inventory_request
    await handler(ws, client, { type: 'skills_inventory_request' }, ctx)

    const [, payload] = ctx._send.lastCall
    assert.equal(payload.error.code, 'SURVEY_FAILED')
    assert.equal(payload.error.message, 'boom')
    const { requestId, ...rest } = payload
    void requestId
    assert.ok(ServerSkillsInventorySnapshotSchema.safeParse(rest).success)
  })
})
