/**
 * Integration tests for the MCPFleet add/remove lifecycle (#6974).
 *
 * Covers the live-fleet half of the slice: a newly configured server attaches
 * and connects without a session restart, a removed one disconnects cleanly and
 * drops out of the `getServerStatuses()` snapshot that feeds `mcp_servers`.
 *
 * The MCPClient factory is stubbed via a `_makeClient` override so nothing is
 * spawned — this exercises fleet bookkeeping, not real MCP children.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCPFleet } from '../src/byok-mcp-fleet.js'

const QUIET = { info() {}, warn() {}, error() {}, debug() {} }

/**
 * Build a fleet whose clients are inert stubs. `trustStorePath` points at a temp
 * dir so no real trust store is read or written (and no permission manager is
 * passed, so no trust gate runs — gate behaviour is covered by #6824's tests).
 */
function makeFleet(configs, { dir }) {
  const fleet = new MCPFleet(configs, { log: QUIET, trustStorePath: join(dir, 'mcp-trust.json'), startCapMs: 50 })
  const stub = (cfg) => ({
    name: cfg.name,
    state: 'ready',
    tools: [],
    prompts: [],
    resources: [],
    started: false,
    destroyed: false,
    async start() { this.started = true },
    async destroy() { this.destroyed = true },
  })
  fleet._makeClient = stub
  // Rebuild the constructor's clients through the stub factory.
  fleet._clients = configs.filter((c) => !fleet._disabled.has(c.name)).map(stub)
  return fleet
}

describe('#6974 MCPFleet.addServer', () => {
  it('attaches and starts a new server, and it appears in the status snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-fleet-add-'))
    try {
      const fleet = makeFleet([{ name: 'existing', command: 'a', args: [], env: {} }], { dir })

      const res = await fleet.addServer({ name: 'fresh', command: 'b', args: [], env: {} })
      assert.equal(res.added, true)

      const names = fleet.getServerStatuses().map((s) => s.name).sort()
      assert.deepEqual(names, ['existing', 'fresh'])
      const client = fleet.clients.find((c) => c.name === 'fresh')
      assert.ok(client, 'a client was built for the new server')
      assert.equal(client.started, true, 'the new server was connected without a session restart')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a duplicate name and leaves the existing client untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-fleet-dup-'))
    try {
      const fleet = makeFleet([{ name: 'dup', command: 'a', args: [], env: {} }], { dir })
      const before = fleet.clients.length

      const res = await fleet.addServer({ name: 'dup', command: 'other', args: [], env: {} })
      assert.equal(res.added, false)
      assert.equal(fleet.clients.length, before, 'no second client for the same name')
      assert.equal(fleet.getServerStatuses().filter((s) => s.name === 'dup').length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('clears a stale parked entry so an added server is never born disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-fleet-stale-'))
    try {
      const fleet = makeFleet([{ name: 'gone', command: 'a', args: [], env: {} }], { dir })
      // Park it, then remove it — the parked-set entry must not linger and taint
      // a later add of the same name.
      await fleet.setEnabled('gone', false)
      await fleet.removeServer('gone')
      assert.deepEqual(fleet.disabledServers, [])

      await fleet.addServer({ name: 'gone', command: 'a', args: [], env: {} })
      const entry = fleet.getServerStatuses().find((s) => s.name === 'gone')
      assert.equal(entry.enabled, true, 'a re-added server is enabled')
      assert.notEqual(entry.status, 'disabled')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a nameless config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-fleet-noname-'))
    try {
      const fleet = makeFleet([], { dir })
      assert.equal((await fleet.addServer({ command: 'x' })).added, false)
      assert.equal((await fleet.addServer(null)).added, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('#6974 MCPFleet.removeServer', () => {
  it('destroys the client and drops the server from the snapshot entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-fleet-rm-'))
    try {
      const fleet = makeFleet([
        { name: 'keep', command: 'a', args: [], env: {} },
        { name: 'drop', command: 'b', args: [], env: {} },
      ], { dir })
      const dropClient = fleet.clients.find((c) => c.name === 'drop')

      const res = await fleet.removeServer('drop')
      assert.equal(res.removed, true)
      assert.equal(dropClient.destroyed, true, 'the client was torn down')
      // Unlike disable (which reports status 'disabled'), a removal leaves the
      // snapshot altogether so it drops out of the mcp_servers broadcast.
      assert.deepEqual(fleet.getServerStatuses().map((s) => s.name), ['keep'])
      assert.equal(fleet.clients.find((c) => c.name === 'drop'), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removing a PARKED server clears its parked-set entry (no ghost in persistence)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-fleet-rm-parked-'))
    try {
      const fleet = makeFleet([{ name: 'parked', command: 'a', args: [], env: {} }], { dir })
      await fleet.setEnabled('parked', false)
      assert.deepEqual(fleet.disabledServers, ['parked'])

      assert.equal((await fleet.removeServer('parked')).removed, true)
      assert.deepEqual(fleet.disabledServers, [], 'no ghost entry left to persist')
      assert.deepEqual(fleet.getServerStatuses(), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removing an unknown server is a clean no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-fleet-rm-ghost-'))
    try {
      const fleet = makeFleet([{ name: 'keep', command: 'a', args: [], env: {} }], { dir })
      assert.equal((await fleet.removeServer('never-existed')).removed, false)
      assert.deepEqual(fleet.getServerStatuses().map((s) => s.name), ['keep'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a throwing destroy is swallowed and the server is still removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-fleet-rm-throw-'))
    try {
      const fleet = makeFleet([{ name: 'bad', command: 'a', args: [], env: {} }], { dir })
      fleet.clients[0].destroy = async () => { throw new Error('destroy failed') }

      const res = await fleet.removeServer('bad')
      assert.equal(res.removed, true, 'a failed teardown must not block the removal')
      assert.deepEqual(fleet.getServerStatuses(), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
