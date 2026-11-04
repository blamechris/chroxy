import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServerProviderRuntimeInfoSchema } from '../dist/index.js'

const frame = {
  type: 'provider_runtime_info', sessionId: 's1', provider: 'codex', binaryVersion: 'unknown', inputRequiresReady: true,
  capabilities: [{ name: 'mcp', state: 'unknown' }],
  customization: {
    nativeDiscovery: { state: 'unknown', files: ['AGENTS.md'], delivery: 'unknown', precedence: 'global-root-cwd' },
    chroxyChannels: [{ channel: 'first-user-turn', lifetime: 'first-turn', content: ['skills'] }],
    nativeSkills: 'unknown', runtimeToggles: false, toolConstraints: 'provider-runtime',
    policyDecisions: true, memoryProjection: 'provider-native',
    mcp: { discovery: 'unknown', toolCalls: 'unknown' },
    byteBudgets: { nativeDocuments: 'unknown', chroxySkills: 1, projectInstructions: 'unsupported' },
    egress: 'cloud',
  },
  projectInstructions: {
    status: 'unsupported', enforcement: 'instructional', compilerVersion: '1', budgetBytes: 0, totalBytes: 0,
    sources: [], rules: [], includedRequiredRuleIds: [],
  },
}

describe('provider_runtime_info schema', () => {
  it('round-trips explicit unknown states', () => {
    assert.deepEqual(ServerProviderRuntimeInfoSchema.parse(frame), frame)
  })

  it('defaults the new static readiness trait off for older runtime frames', () => {
    const { inputRequiresReady: _removed, ...olderFrame } = frame
    assert.equal(ServerProviderRuntimeInfoSchema.parse(olderFrame).inputRequiresReady, false)
  })

  it('rejects an unknown capability state and unknown top-level fields', () => {
    assert.throws(() => ServerProviderRuntimeInfoSchema.parse({ ...frame, capabilities: [{ name: 'mcp', state: 'maybe' }] }))
    assert.throws(() => ServerProviderRuntimeInfoSchema.parse({ ...frame, surprise: true }))
  })

  it('accepts the optional launched-binary path and newer-client fields, and still validates without them (#8609)', () => {
    const extra = { binaryPath: '/opt/codex/bin/codex', newerBinary: { path: '/Applications/ChatGPT.app/x/bin/codex', version: '0.166.0-alpha.5.1' } }
    assert.deepEqual(ServerProviderRuntimeInfoSchema.parse({ ...frame, ...extra }), { ...frame, ...extra })
    assert.ok(ServerProviderRuntimeInfoSchema.safeParse(frame).success, 'an older server omits both')
  })

  it('bounds the binary path and rejects extra keys on newerBinary (#8609)', () => {
    assert.throws(() => ServerProviderRuntimeInfoSchema.parse({ ...frame, binaryPath: 'x'.repeat(1025) }))
    assert.throws(() => ServerProviderRuntimeInfoSchema.parse({ ...frame, binaryPath: '' }))
    assert.throws(() => ServerProviderRuntimeInfoSchema.parse({ ...frame, newerBinary: { path: '/a', version: '1.0.0', extra: 1 } }))
  })

  it('accepts an optional bounded rejectedModels list and still validates without it (#8909)', () => {
    assert.deepEqual(ServerProviderRuntimeInfoSchema.parse({ ...frame, rejectedModels: ['gpt-6.1-sol'] }), { ...frame, rejectedModels: ['gpt-6.1-sol'] })
    assert.ok(ServerProviderRuntimeInfoSchema.safeParse(frame).success, 'an older server omits it')
    assert.ok(ServerProviderRuntimeInfoSchema.safeParse({ ...frame, rejectedModels: [] }).success)
  })

  it('bounds rejectedModels entries and count (#8909)', () => {
    assert.throws(() => ServerProviderRuntimeInfoSchema.parse({ ...frame, rejectedModels: ['m'.repeat(129)] }))
    assert.throws(() => ServerProviderRuntimeInfoSchema.parse({ ...frame, rejectedModels: [''] }))
    assert.throws(() => ServerProviderRuntimeInfoSchema.parse({ ...frame, rejectedModels: Array.from({ length: 65 }, (_, i) => `m${i}`) }))
    assert.ok(ServerProviderRuntimeInfoSchema.safeParse({ ...frame, rejectedModels: Array.from({ length: 64 }, (_, i) => `m${i}`) }).success)
  })
})
