import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('@chroxy/protocol codex constants (#6689)', () => {
  it('exports the canonical sandbox mode list', async () => {
    const { CODEX_SANDBOX_MODES } = await import('../src/codex.ts')
    assert.deepEqual(
      [...CODEX_SANDBOX_MODES],
      ['read-only', 'workspace-write', 'danger-full-access'],
      'the three codex-cli sandbox modes, in ascending authority order',
    )
  })

  it('defaults to workspace-write', async () => {
    const { CODEX_DEFAULT_SANDBOX, CODEX_SANDBOX_MODES } = await import('../src/codex.ts')
    assert.equal(CODEX_DEFAULT_SANDBOX, 'workspace-write')
    assert.ok(CODEX_SANDBOX_MODES.includes(CODEX_DEFAULT_SANDBOX), 'default is a member of the mode list')
  })

  it('exports the codex provider id', async () => {
    const { CODEX_PROVIDER } = await import('../src/codex.ts')
    assert.equal(CODEX_PROVIDER, 'codex')
  })

  it('has UI metadata (label + description) for every mode', async () => {
    const { CODEX_SANDBOX_MODES, CODEX_SANDBOX_MODE_META } = await import('../src/codex.ts')
    const metaIds = CODEX_SANDBOX_MODE_META.map((m) => m.id)
    assert.deepEqual(metaIds, [...CODEX_SANDBOX_MODES], 'meta covers exactly the modes, in order')
    for (const m of CODEX_SANDBOX_MODE_META) {
      assert.ok(typeof m.label === 'string' && m.label.length > 0, `${m.id} has a non-empty label`)
      assert.ok(typeof m.description === 'string' && m.description.length > 0, `${m.id} has a non-empty description`)
    }
  })

  it('re-exports the codex constants from the main entry point', async () => {
    const mod = await import('../src/index.ts')
    assert.ok(mod.CODEX_SANDBOX_MODES, 'CODEX_SANDBOX_MODES re-exported')
    assert.equal(mod.CODEX_DEFAULT_SANDBOX, 'workspace-write')
    assert.equal(mod.CODEX_PROVIDER, 'codex')
    assert.ok(mod.CODEX_SANDBOX_MODE_META, 'CODEX_SANDBOX_MODE_META re-exported')
  })

  it('create_session schema accepts every canonical sandbox mode', async () => {
    const { CreateSessionSchema, CODEX_SANDBOX_MODES } = await import('../src/index.ts')
    for (const mode of CODEX_SANDBOX_MODES) {
      const result = CreateSessionSchema.safeParse({ type: 'create_session', codexSandbox: mode })
      assert.ok(result.success, `codexSandbox=${mode} should be accepted`)
    }
  })

  it('create_session schema rejects an out-of-enum sandbox mode', async () => {
    const { CreateSessionSchema } = await import('../src/index.ts')
    const result = CreateSessionSchema.safeParse({ type: 'create_session', codexSandbox: 'gimme-root' })
    assert.ok(!result.success, 'an unknown sandbox mode is rejected by the single-sourced enum')
  })

  it('codexSandbox is optional (omitting it is valid)', async () => {
    const { CreateSessionSchema } = await import('../src/index.ts')
    const result = CreateSessionSchema.safeParse({ type: 'create_session', name: 'x' })
    assert.ok(result.success, 'a create_session without codexSandbox is valid')
  })
})
