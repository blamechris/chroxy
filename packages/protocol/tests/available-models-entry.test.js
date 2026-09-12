/**
 * `ServerAvailableModelsEntrySchema` — the additive metadata fields (#7723).
 *
 * The entry schema is the wire contract for one row of `available_models`.
 * #7723 widened it with `provenance` / `reasoningLevels` /
 * `defaultReasoningLevel`, so the two properties that have to hold are:
 *
 *  1. an entry carrying NONE of them is completely unchanged by the parse —
 *     older servers and the Claude path emit exactly that shape today; and
 *  2. a field of the wrong shape (including a `provenance` value a NEWER
 *     server invented) drops that FIELD and never the model — the same
 *     fail-soft `contextWindow` has always had.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const load = () => import('../src/schemas/server/stream.ts')

describe('ServerAvailableModelsEntrySchema (#7723)', () => {
  it('round-trips an entry with none of the new fields byte-identically', async () => {
    const { ServerAvailableModelsEntrySchema } = await load()
    const entry = { id: 'opus', label: 'Opus', fullId: 'claude-opus-4-8', contextWindow: 1_000_000 }
    const result = ServerAvailableModelsEntrySchema.safeParse(entry)
    assert.ok(result.success, 'a plain entry must parse')
    // Byte-identical: same keys, same order, same values — no key is
    // materialised as `undefined` by the new optional declarations.
    assert.equal(JSON.stringify(result.data), JSON.stringify(entry))
    assert.deepEqual(Object.keys(result.data), ['id', 'label', 'fullId', 'contextWindow'])
  })

  it('round-trips an entry with no contextWindow either', async () => {
    const { ServerAvailableModelsEntrySchema } = await load()
    const entry = { id: 'sonnet', label: 'Sonnet', fullId: 'claude-sonnet-4-6' }
    const result = ServerAvailableModelsEntrySchema.safeParse(entry)
    assert.ok(result.success, 'an entry without contextWindow must parse')
    assert.equal(JSON.stringify(result.data), JSON.stringify(entry))
  })

  it('keeps the new fields when present', async () => {
    const { ServerAvailableModelsEntrySchema } = await load()
    const entry = {
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      fullId: 'gpt-5.5',
      contextWindow: 272_000,
      provenance: 'discovered',
      reasoningLevels: ['low', 'medium', 'high'],
      defaultReasoningLevel: 'medium',
    }
    const result = ServerAvailableModelsEntrySchema.safeParse(entry)
    assert.ok(result.success, 'an entry with the new fields must parse')
    assert.equal(JSON.stringify(result.data), JSON.stringify(entry))
  })

  it('a malformed contextWindow drops only that field and does not reject the entry', async () => {
    const { ServerAvailableModelsEntrySchema } = await load()
    for (const bad of ['200000', null, {}, [], Number.NaN, -1]) {
      const result = ServerAvailableModelsEntrySchema.safeParse({
        id: 'a', label: 'A', fullId: 'a', contextWindow: bad,
      })
      assert.ok(result.success, `contextWindow ${JSON.stringify(bad)} must NOT reject the entry`)
      // Identity survives — the handler is what drops the unusable value.
      assert.equal(result.data.id, 'a')
      assert.equal(result.data.label, 'A')
      assert.equal(result.data.fullId, 'a')
    }
  })

  it('a provenance value outside the union does not reject the entry', async () => {
    const { ServerAvailableModelsEntrySchema } = await load()
    // The whole point of NOT using z.enum here: a newer server inventing a
    // fourth provenance must cost an older client the FIELD, not the model.
    for (const bad of ['inferred', 42, null, ['manual']]) {
      const result = ServerAvailableModelsEntrySchema.safeParse({
        id: 'a', label: 'A', fullId: 'a', provenance: bad,
      })
      assert.ok(result.success, `provenance ${JSON.stringify(bad)} must NOT reject the entry`)
      assert.equal(result.data.fullId, 'a')
    }
  })

  it('malformed reasoning fields do not reject the entry', async () => {
    const { ServerAvailableModelsEntrySchema } = await load()
    const result = ServerAvailableModelsEntrySchema.safeParse({
      id: 'a', label: 'A', fullId: 'a', reasoningLevels: 'high', defaultReasoningLevel: 7,
    })
    assert.ok(result.success, 'malformed reasoning fields must NOT reject the entry')
    assert.equal(result.data.id, 'a')
  })

  it('still rejects an entry missing the identity fields', async () => {
    const { ServerAvailableModelsEntrySchema } = await load()
    // The widening must not have loosened the required triple.
    assert.equal(ServerAvailableModelsEntrySchema.safeParse({ id: 'a', label: 'A' }).success, false)
    assert.equal(ServerAvailableModelsEntrySchema.safeParse({ label: 'A', fullId: 'a' }).success, false)
    assert.equal(ServerAvailableModelsEntrySchema.safeParse({ id: 1, label: 'A', fullId: 'a' }).success, false)
  })
})

describe('MODEL_ENTRY_METADATA_KEYS / MODEL_PROVENANCE_VALUES (#7723)', () => {
  it('the metadata roster matches the schema, in BOTH directions', async () => {
    const { ServerAvailableModelsEntrySchema, MODEL_ENTRY_METADATA_KEYS } = await load()
    // The identity + window keys are the pre-#7723 shape; everything else the
    // schema declares IS optional metadata and must be in the roster the
    // server copies entries through with. Read both ways: a schema field
    // missing from the roster is dropped on its way to the wire, and a roster
    // key missing from the schema is copied into a field no client parses.
    const IDENTITY_KEYS = ['id', 'label', 'fullId', 'contextWindow']
    const schemaMetadataKeys = Object.keys(ServerAvailableModelsEntrySchema.shape)
      .filter((k) => !IDENTITY_KEYS.includes(k))
      .sort()
    assert.deepEqual(
      schemaMetadataKeys,
      [...MODEL_ENTRY_METADATA_KEYS].sort(),
      'ServerAvailableModelsEntrySchema optional-metadata keys and MODEL_ENTRY_METADATA_KEYS have drifted',
    )
  })

  it('every identity key is still declared by the schema', async () => {
    const { ServerAvailableModelsEntrySchema } = await load()
    for (const k of ['id', 'label', 'fullId', 'contextWindow']) {
      assert.ok(k in ServerAvailableModelsEntrySchema.shape, `schema must still declare ${k}`)
    }
  })

  it('the provenance values are unique non-empty strings and frozen', async () => {
    const { MODEL_PROVENANCE_VALUES } = await load()
    assert.ok(Object.isFrozen(MODEL_PROVENANCE_VALUES), 'MODEL_PROVENANCE_VALUES must be frozen')
    assert.ok(MODEL_PROVENANCE_VALUES.length > 0, 'MODEL_PROVENANCE_VALUES must not be empty')
    for (const v of MODEL_PROVENANCE_VALUES) {
      assert.equal(typeof v, 'string')
      assert.notEqual(v.trim(), '')
    }
    assert.equal(new Set(MODEL_PROVENANCE_VALUES).size, MODEL_PROVENANCE_VALUES.length)
  })

  it('is re-exported from the package entry point', async () => {
    const mod = await import('../src/index.ts')
    assert.ok(mod.MODEL_PROVENANCE_VALUES, 'MODEL_PROVENANCE_VALUES must be exported from the barrel')
    assert.ok(mod.MODEL_ENTRY_METADATA_KEYS, 'MODEL_ENTRY_METADATA_KEYS must be exported from the barrel')
  })
})
