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
})
