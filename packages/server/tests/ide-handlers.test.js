import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ideHandlers } from '../src/handlers/ide-handlers.js'
import { ServerSymbolsSnapshotSchema, ServerSymbolLocationSchema } from '@chroxy/protocol'
import { nsCtx } from './test-helpers.js'

/**
 * Handler tests for list_symbols (#6471) and resolve_symbol (#6475, epic #6469):
 * the opt-in `features.ide` gate (fail-closed when off) and the
 * symbols_snapshot / symbol_location emission shapes.
 */

const handleListSymbols = ideHandlers.list_symbols
const handleResolveSymbol = ideHandlers.resolve_symbol

/** Build a handler ctx with a send-capturing transport, a config (for the flag
 *  gate), and a sessionManager resolving the given cwd. */
function makeCtx({ ideEnabled = true, cwd = null } = {}) {
  const sent = []
  const ctx = nsCtx({
    send: (_ws, msg) => sent.push(msg),
    config: ideEnabled ? { features: { ide: true } } : { features: {} },
    sessionManager: { getSession: () => (cwd ? { cwd } : null) },
  })
  return { ctx, sent }
}

const client = { activeSessionId: 'sess-1' }

describe('list_symbols handler — feature gate', () => {
  it('is a no-op (no send) when features.ide is off', async () => {
    const { ctx, sent } = makeCtx({ ideEnabled: false, cwd: '/tmp' })
    await handleListSymbols({}, client, { type: 'list_symbols' }, ctx)
    assert.equal(sent.length, 0)
  })
})

describe('list_symbols handler — emission', () => {
  let root
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-ide-handler-'))
    writeFileSync(join(root, 'mod.ts'), 'export function exported() {}\nclass Local {}\n')
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  it('emits a schema-valid symbols_snapshot for the session workspace', async () => {
    const { ctx, sent } = makeCtx({ ideEnabled: true, cwd: root })
    await handleListSymbols({}, client, { type: 'list_symbols' }, ctx)
    assert.equal(sent.length, 1)
    const msg = sent[0]
    // Validate the emitted wire shape against the protocol schema.
    const parsed = ServerSymbolsSnapshotSchema.safeParse(msg)
    assert.ok(parsed.success, 'emitted message must satisfy ServerSymbolsSnapshotSchema')
    assert.equal(msg.error, null)
    assert.equal(msg.path, null)
    const names = msg.symbols.map((s) => s.name).sort()
    assert.deepEqual(names, ['Local', 'exported'])
    assert.equal(msg.symbols.find((s) => s.name === 'exported').exported, true)
  })

  it('echoes the requested path scope in the response', async () => {
    const { ctx, sent } = makeCtx({ ideEnabled: true, cwd: root })
    await handleListSymbols({}, client, { type: 'list_symbols', path: 'mod.ts' }, ctx)
    assert.equal(sent[0].path, 'mod.ts')
    assert.deepEqual(sent[0].symbols.map((s) => s.name).sort(), ['Local', 'exported'])
  })

  it('emits an error snapshot (empty symbols) when the session has no cwd', async () => {
    const { ctx, sent } = makeCtx({ ideEnabled: true, cwd: null })
    await handleListSymbols({}, client, { type: 'list_symbols' }, ctx)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'symbols_snapshot')
    assert.deepEqual(sent[0].symbols, [])
    assert.match(sent[0].error, /No workspace/)
  })
})

describe('resolve_symbol handler — feature gate', () => {
  it('is a no-op (no send) when features.ide is off', async () => {
    const { ctx, sent } = makeCtx({ ideEnabled: false, cwd: '/tmp' })
    await handleResolveSymbol({}, client, { type: 'resolve_symbol', symbol: 'exported' }, ctx)
    assert.equal(sent.length, 0)
  })
})

describe('resolve_symbol handler — emission', () => {
  let root
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-ide-resolve-h-'))
    writeFileSync(join(root, 'mod.ts'), 'export function exported() {}\nclass Local {}\n')
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  it('emits a schema-valid symbol_location with file + line on a hit', async () => {
    const { ctx, sent } = makeCtx({ ideEnabled: true, cwd: root })
    await handleResolveSymbol({}, client, { type: 'resolve_symbol', symbol: 'exported' }, ctx)
    assert.equal(sent.length, 1)
    const msg = sent[0]
    const parsed = ServerSymbolLocationSchema.safeParse(msg)
    assert.ok(parsed.success, 'emitted message must satisfy ServerSymbolLocationSchema')
    assert.equal(msg.symbol, 'exported')
    assert.equal(msg.file, 'mod.ts')
    assert.equal(msg.line, 1)
    assert.equal(msg.error, null)
  })

  it('emits a not-found symbol_location (null file/line + error) on a miss', async () => {
    const { ctx, sent } = makeCtx({ ideEnabled: true, cwd: root })
    await handleResolveSymbol({}, client, { type: 'resolve_symbol', symbol: 'nope' }, ctx)
    assert.equal(sent.length, 1)
    const msg = sent[0]
    assert.ok(ServerSymbolLocationSchema.safeParse(msg).success)
    assert.equal(msg.file, null)
    assert.equal(msg.line, null)
    assert.match(msg.error, /not found/i)
  })

  it('emits an error location when the symbol is empty', async () => {
    const { ctx, sent } = makeCtx({ ideEnabled: true, cwd: root })
    await handleResolveSymbol({}, client, { type: 'resolve_symbol', symbol: '   ' }, ctx)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'symbol_location')
    assert.equal(sent[0].file, null)
    assert.match(sent[0].error, /No symbol/)
  })

  it('emits an error location when the session has no cwd', async () => {
    const { ctx, sent } = makeCtx({ ideEnabled: true, cwd: null })
    await handleResolveSymbol({}, client, { type: 'resolve_symbol', symbol: 'exported' }, ctx)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'symbol_location')
    assert.equal(sent[0].file, null)
    assert.match(sent[0].error, /No workspace/)
  })
})
