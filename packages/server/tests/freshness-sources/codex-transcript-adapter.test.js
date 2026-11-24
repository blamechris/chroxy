/**
 * Codex transcripts are not supported: the adapter reads nothing, cannot be
 * listed, and every read is an `error`, never `idle` and never no status.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { REAL_TREE, SRC, cleanupTmp, cleanupVariants, mustKillTree, rig } from '../freshness-core/helpers/harness.js'
import { T0 } from './helpers/transcripts.js'

afterEach(() => cleanupTmp())
process.on('exit', cleanupVariants)

const proves = (name, check, mutants = {}) =>
  describe(name, () => {
    it('holds on the real code', async () => {
      await check(REAL_TREE)
    })
    for (const [label, edits] of Object.entries(mutants)) it(`mutant "${label}" fails it`, () => mustKillTree(check, label, edits))
  })

const edit = (file, from, to) => ({ file, from, to })
const C = 'freshness-sources/codex-transcript-adapter.js'

proves(
  'codex: unsupported is recorded as an error, not as a quiet or idle session',
  async (M) => {
    const { resolveTranscriptSource } = await import(pathToFileURL(path.join(SRC, 'transcript-sources.js')).href)
    // the locator still says the format is unsupported; when it stops saying so, a reader is due
    assert.equal(resolveTranscriptSource({ provider: 'codex', conversationId: 'x' }).code, 'unsupported')
    const a = M.createCodexTranscriptAdapter()
    assert.equal(a.source, M.CODEX_TRANSCRIPT_SOURCE)
    assert.equal(a.list(), null)
    assert.deepEqual(a.read({ source: a.source, native_id: 'x', incarnation: null }), { outcome: 'error', error_code: 'unsupported' })
    const r = rig(M)
    r.ticks([T0], { adapters: [a], config: M.coreConfig({ sources: { [a.source]: M.CODEX_TRANSCRIPT_CAPS } }), source: a.source })
    assert.equal(r.kinds('system', (x) => x.body.event === 'source_unreadable').length, 1)
    assert.equal(r.kinds('report').length, 0)
    M.sealAdapter(a)
    for (const bad of ['', 'Bad Name']) assert.throws(() => M.createCodexTranscriptAdapter({ source: bad }), M.AdapterContractError)
  },
  {
    'the source lists as empty': [edit(C, 'list: () => null', 'list: () => []')],
    'a read says there is no status': [edit(C, "read: () => ({ outcome: 'error', error_code: 'unsupported' })", "read: () => ({ outcome: 'no_report' })")],
    'any source name is accepted': [edit(C, "if (!validSourceName(source)) throw new AdapterContractError('adapter.source must be a short lowercase name')", '')],
  },
)
