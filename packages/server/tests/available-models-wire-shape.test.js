import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ServerAvailableModelsSchema } from '@chroxy/protocol'
import { createModelsRegistry } from '../src/models.js'

/**
 * #7089 — `available_models` sent `defaultModel: null` against a non-nullable
 * `z.string().optional()`, the single highest-volume wire-contract violation in the
 * codebase (309 failing sends across a 2337-test subset).
 *
 * The payload is built from a REAL registry rather than a literal, because that is
 * the only way to catch it: every existing fixture hardcodes a string default, and
 * `registry.getDefaultModelId()` returning null is exactly the condition those
 * fixtures cannot reproduce.
 */
describe('#7089 available_models wire shape', () => {
  /** Built the way every sender builds it (ws-history.js:729/:775/:911 and friends). */
  const payloadFrom = (registry, provider = null) => ({
    type: 'available_models',
    models: registry.getModels(),
    defaultModel: registry.getDefaultModelId(),
    provider,
  })

  it('a registry with NO default yields null — the condition fixtures cannot fake', () => {
    const registry = createModelsRegistry({})
    assert.equal(registry.getDefaultModelId(), null, 'precondition: a bare registry has no default')
    assert.ok(registry.getModels().length > 0, 'and it still has models, so the payload is otherwise real')
  })

  it('the payload from a default-less registry satisfies the wire schema', () => {
    const payload = payloadFrom(createModelsRegistry({}))
    assert.equal(payload.defaultModel, null)
    const result = ServerAvailableModelsSchema.safeParse(payload)
    assert.ok(
      result.success,
      `a real available_models payload must be wire-legal; got ${JSON.stringify((result.error?.issues || [])[0])}`,
    )
  })

  it('a string default still validates (the fix does not loosen the type)', () => {
    const payload = { ...payloadFrom(createModelsRegistry({})), defaultModel: 'claude-opus-5' }
    assert.ok(ServerAvailableModelsSchema.safeParse(payload).success)
  })

  it('nullable does NOT mean untyped — a non-string default is still refused', () => {
    // Guards the obvious over-correction: `.nullable()` must not become `.any()`.
    for (const bad of [42, {}, [], true]) {
      const r = ServerAvailableModelsSchema.safeParse({ ...payloadFrom(createModelsRegistry({})), defaultModel: bad })
      assert.equal(r.success, false, `defaultModel: ${JSON.stringify(bad)} must still be rejected`)
    }
  })

  it('provider stays nullable too (the field this fix was modelled on)', () => {
    const payload = payloadFrom(createModelsRegistry({}), null)
    assert.ok(ServerAvailableModelsSchema.safeParse(payload).success)
  })
})
