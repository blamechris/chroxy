import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerAvailableModelsSchema } from '@chroxy/protocol'
// Registers the real provider classes so the #7722 block below gets a genuine
// codex registry rather than a fall-through to the Claude one.
import '../src/providers.js'
import {
  createModelsRegistry,
  reloadModelsOverlay,
  updateModels,
  resetModels,
  getRegistryForProvider,
  _resetModelsOverlayForTests,
  _resetProviderRegistryCacheForTests,
} from '../src/models.js'

/**
 * #7089 — `available_models` sent `defaultModel: null` against a non-nullable
 * `z.string().optional()`, the single highest-volume wire-contract violation in the
 * codebase (309 failing sends across a 2337-test subset).
 *
 * Field-level nullability coverage (null / string / omitted / non-string refused) lives
 * in packages/protocol/tests/schemas.test.js beside the equivalent `provider` block —
 * that suite imports ../src via tsx, so it validates THIS branch rather than resolving
 * @chroxy/protocol through the main clone's symlink. This file's job is narrower and
 * complementary: prove a payload built by a REAL sender is wire-legal.
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
})

/**
 * #7722 — the overlay hot-reload became a second REAL sender of
 * `available_models`, emitting one payload per affected registry. This file's
 * remit is proving a payload built by a real sender is wire-legal, so the new
 * sender belongs here: a codex registry has no SDK-reported default, so its
 * payload carries `defaultModel: null` — the exact #7089 condition a literal
 * fixture cannot reproduce.
 */
describe('#7722 overlay reload payloads are wire-legal', () => {
  let dir
  const overlay = (obj) => {
    dir = mkdtempSync(join(tmpdir(), 'overlay-wire-'))
    const path = join(dir, 'models.json')
    writeFileSync(path, JSON.stringify(obj))
    return path
  }
  // A bare test process has NO SDK feed, so EVERY registry's getDefaultModelId()
  // is null — including the Claude one. An assertion that the codex payload's
  // defaultModel is null would then hold even if the builder hardcoded null for
  // every payload, because nothing in the harness can tell the two apart. Seed a
  // real Claude default so the field carries information.
  beforeEach(() => {
    _resetProviderRegistryCacheForTests()
    _resetModelsOverlayForTests()
    resetModels()
    updateModels([
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'seeded' },
      { value: 'claude-opus-4-8', displayName: 'Default (Opus 4.8)', description: 'seeded' },
    ])
  })
  afterEach(() => {
    _resetProviderRegistryCacheForTests()
    _resetModelsOverlayForTests()
    resetModels()
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
  })

  it('every payload from a real reload satisfies the schema', () => {
    const path = overlay({
      'codex-wire-9': { provider: 'codex', label: 'Codex Wire 9' },
      'claude-wire-9': { label: 'Claude Wire 9' },
    })
    const { broadcasts } = reloadModelsOverlay(path)
    assert.ok(broadcasts.length >= 2, 'precondition: more than the Claude roster was built')
    for (const { message } of broadcasts) {
      const result = ServerAvailableModelsSchema.safeParse(message)
      assert.ok(
        result.success,
        `payload tagged ${message.provider} is not wire-legal: ${result.success ? '' : JSON.stringify(result.error.issues)}`,
      )
    }
  })

  it('each payload carries ITS OWN registry default — null for codex, the seeded id for Claude', () => {
    const path = overlay({
      'codex-wire-9': { provider: 'codex', label: 'Codex Wire 9' },
      'claude-wire-9': { label: 'Claude Wire 9' },
    })
    const { broadcasts } = reloadModelsOverlay(path)
    const codex = broadcasts.find((b) => b.message.provider === 'codex')?.message
    const dflt = broadcasts.find((b) => b.isDefault)?.message
    assert.ok(codex && dflt, 'precondition: both payloads were built')

    // The precondition that makes the next two assertions mean something: the
    // two registries genuinely disagree about their default.
    assert.equal(getRegistryForProvider('claude-sdk').getDefaultModelId(), 'opus-4-8', 'the seed took')
    assert.equal(getRegistryForProvider('codex').getDefaultModelId(), null, 'codex has no SDK-reported default')

    // RED under: hardcoding `defaultModel: null` on either payload, or swapping
    // the two registries' defaults.
    assert.equal(dflt.defaultModel, 'opus-4-8')
    // The #7089 shape, reached through a real sender rather than a literal.
    assert.equal(codex.defaultModel, null)
    assert.ok(ServerAvailableModelsSchema.safeParse(codex).success, 'a null default is wire-legal')
  })
})
