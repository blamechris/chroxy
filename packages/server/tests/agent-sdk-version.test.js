import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  sdkClaudeCodeVersion,
  _resetAgentSdkVersionCacheForTest,
} from '../src/utils/agent-sdk-version.js'

/**
 * Unit tests for reading the installed @anthropic-ai/claude-agent-sdk
 * package's own `claudeCodeVersion` field (#7986) — SdkSession's derived
 * minimum-version floor.
 */

describe('sdkClaudeCodeVersion', () => {
  beforeEach(() => {
    _resetAgentSdkVersionCacheForTest()
  })

  it('resolves the package root via require.resolve, then reads its package.json', () => {
    let resolvedRequest = null
    let readPath = null
    const version = sdkClaudeCodeVersion({
      requireFn: {
        resolve: (request) => {
          resolvedRequest = request
          return '/fake/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
        },
      },
      readFileSync: (path) => {
        readPath = path
        return JSON.stringify({ claudeCodeVersion: '2.1.141' })
      },
    })
    assert.equal(resolvedRequest, '@anthropic-ai/claude-agent-sdk')
    // path.join speaks the host's separator (backslashes on the Windows runner),
    // so compare with separators normalized rather than against the host form.
    assert.equal(readPath.replace(/\\/g, '/'), '/fake/node_modules/@anthropic-ai/claude-agent-sdk/package.json')
    assert.equal(version, '2.1.141')
  })

  it('returns null when require.resolve throws (SDK not installed)', () => {
    const version = sdkClaudeCodeVersion({
      requireFn: { resolve: () => { throw new Error('Cannot find module') } },
      readFileSync: () => { throw new Error('unreachable') },
    })
    assert.equal(version, null)
  })

  it('returns null when package.json is unreadable', () => {
    const version = sdkClaudeCodeVersion({
      requireFn: { resolve: () => '/fake/sdk.mjs' },
      readFileSync: () => { throw new Error('ENOENT') },
    })
    assert.equal(version, null)
  })

  it('returns null when package.json is not valid JSON', () => {
    const version = sdkClaudeCodeVersion({
      requireFn: { resolve: () => '/fake/sdk.mjs' },
      readFileSync: () => 'not json',
    })
    assert.equal(version, null)
  })

  it('returns null when claudeCodeVersion is missing from package.json', () => {
    const version = sdkClaudeCodeVersion({
      requireFn: { resolve: () => '/fake/sdk.mjs' },
      readFileSync: () => JSON.stringify({ version: '0.2.141' }),
    })
    assert.equal(version, null)
  })

  it('returns null when claudeCodeVersion is present but empty/non-string', () => {
    const version = sdkClaudeCodeVersion({
      requireFn: { resolve: () => '/fake/sdk.mjs' },
      readFileSync: () => JSON.stringify({ claudeCodeVersion: '' }),
    })
    assert.equal(version, null)
  })

  it('is memoized — the seams are only consulted on the first call', () => {
    let calls = 0
    const seams = {
      requireFn: { resolve: () => { calls += 1; return '/fake/sdk.mjs' } },
      readFileSync: () => JSON.stringify({ claudeCodeVersion: '2.1.141' }),
    }
    const first = sdkClaudeCodeVersion(seams)
    const second = sdkClaudeCodeVersion(seams)
    assert.equal(first, '2.1.141')
    assert.equal(second, '2.1.141')
    assert.equal(calls, 1, 'the second call must be served from the memoized value')
  })

  it('_resetAgentSdkVersionCacheForTest() clears the memo so seams take effect again', () => {
    const first = sdkClaudeCodeVersion({
      requireFn: { resolve: () => '/fake/sdk.mjs' },
      readFileSync: () => JSON.stringify({ claudeCodeVersion: '2.1.141' }),
    })
    _resetAgentSdkVersionCacheForTest()
    const second = sdkClaudeCodeVersion({
      requireFn: { resolve: () => '/fake/sdk.mjs' },
      readFileSync: () => JSON.stringify({ claudeCodeVersion: '9.9.9' }),
    })
    assert.equal(first, '2.1.141')
    assert.equal(second, '9.9.9')
  })

  // #7986 review N4: the old code memoized `null` too, so a single transient
  // read failure (an ENOENT racing a Renovate bump, a mid-reinstall race)
  // disabled the version gate for the rest of the daemon's process lifetime.
  it('does NOT memoize a null result — a failed read is retried on the next call', () => {
    let calls = 0
    const version1 = sdkClaudeCodeVersion({
      requireFn: { resolve: () => { calls += 1; throw new Error('transient') } },
      readFileSync: () => { throw new Error('unreachable') },
    })
    assert.equal(version1, null)
    assert.equal(calls, 1)

    // Same function, now succeeding — must NOT be short-circuited by a
    // memoized null from the failed call above.
    const version2 = sdkClaudeCodeVersion({
      requireFn: { resolve: () => { calls += 1; return '/fake/sdk.mjs' } },
      readFileSync: () => JSON.stringify({ claudeCodeVersion: '2.1.141' }),
    })
    assert.equal(version2, '2.1.141')
    assert.equal(calls, 2, 'the second call must re-invoke the seams — a memoized null would skip them')
  })

  it('once a real version is memoized, it is never overwritten by a later call\'s (different) seams', () => {
    const first = sdkClaudeCodeVersion({
      requireFn: { resolve: () => '/fake/sdk.mjs' },
      readFileSync: () => JSON.stringify({ claudeCodeVersion: '2.1.141' }),
    })
    let calls = 0
    const second = sdkClaudeCodeVersion({
      requireFn: { resolve: () => { calls += 1; return '/fake/sdk.mjs' } },
      readFileSync: () => JSON.stringify({ claudeCodeVersion: '9.9.9' }),
    })
    assert.equal(first, '2.1.141')
    assert.equal(second, '2.1.141', 'a real cached version must not be replaced by a later call')
    assert.equal(calls, 0, 'the seams must not even be consulted once a real version is memoized')
  })
})

// #7986 — a PIN test against the REAL installed SDK (no injected seams). This
// is deliberately NOT mocked: the whole point of minVersion gating is that a
// Renovate bump of @anthropic-ai/claude-agent-sdk could drop or rename the
// `claudeCodeVersion` field, which would silently disable the version gate
// (preflight treats a null minimum as "skip, with a warning" rather than a
// hard failure — see preflight.js). Without this test, that regression would
// be invisible: every mocked unit test above would keep passing.
describe('sdkClaudeCodeVersion — pin against the real installed SDK', () => {
  beforeEach(() => {
    _resetAgentSdkVersionCacheForTest()
  })

  it('returns a parseable major.minor.patch string, not null', () => {
    const version = sdkClaudeCodeVersion()
    assert.equal(typeof version, 'string', 'the installed @anthropic-ai/claude-agent-sdk must carry a claudeCodeVersion field')
    assert.match(version, /^\d+\.\d+\.\d+/, `expected a leading major.minor.patch, got: ${JSON.stringify(version)}`)
  })
})
