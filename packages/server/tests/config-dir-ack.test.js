import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACK_FILE_NAME,
  applyStrandedAck,
  detectStrandedState,
  formatStrandedWarning,
  readStrandedAck,
  startupStrandedWarning,
  writeStrandedAck,
} from '../src/config-dir-migration.js'
import { runConfigDirAck, runConfigDirStatus } from '../src/cli/config-dir-cmd.js'
import { runDoctorChecks } from '../src/doctor.js'

const serverCliSrc = readFileSync(new URL('../src/server-cli.js', import.meta.url), 'utf-8')

/**
 * #7244 — acknowledging a deliberate second root.
 *
 * The mechanism is a SNAPSHOT of the stranded entry names, written into the
 * target root by `chroxy config-dir ack`. The warning stays quiet only while
 * every currently stranded name is in that snapshot, so an entry that appears
 * after the acknowledgement warns again. A flag could not do that.
 *
 * Source and target are injected at temp paths whose basenames are not
 * `.chroxy` (same convention as config-dir-migration.test.js).
 */

let tmpRoot
let source
let target

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'chroxy-ack-'))
  source = join(tmpRoot, 'src-state')
  target = join(tmpRoot, 'dst-state')
  mkdirSync(source, { recursive: true })
  mkdirSync(target, { recursive: true })
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

const put = (dir, name, body = 'x') => writeFileSync(join(dir, name), body)
const detect = () => detectStrandedState({ source, target })
const ackPath = () => join(target, ACK_FILE_NAME)
const capture = () => {
  const lines = []
  return { write: (s) => lines.push(String(s)), text: () => lines.join('\n') }
}

describe('stranded-state acknowledgement (#7244)', () => {
  it('not acknowledged: warns exactly as before', () => {
    put(source, 'config.json')
    put(source, 'push-tokens.json')
    const applied = applyStrandedAck(detect())

    assert.deepEqual(applied.stranded, ['config.json', 'push-tokens.json'])
    assert.deepEqual(applied.acknowledged, [])
    assert.deepEqual(formatStrandedWarning(applied), formatStrandedWarning(detect()))
  })

  it('acknowledged: the warning goes quiet', () => {
    put(source, 'config.json')
    put(source, 'push-tokens.json')
    writeStrandedAck(detect())
    const applied = applyStrandedAck(detect())

    assert.deepEqual(applied.stranded, [])
    assert.deepEqual(applied.acknowledged, ['config.json', 'push-tokens.json'])
    assert.deepEqual(formatStrandedWarning(applied), [])
  })

  it('acknowledged, then a NEW entry appears: warns again, naming only the new one', () => {
    put(source, 'config.json')
    writeStrandedAck(detect())
    put(source, 'server-identity.json')
    const applied = applyStrandedAck(detect())

    assert.deepEqual(applied.stranded, ['server-identity.json'])
    assert.deepEqual(applied.acknowledged, ['config.json'])
    assert.deepEqual(applied.highConsequence, ['server-identity.json'])

    const text = formatStrandedWarning(applied).join('\n')
    assert.ok(/server-identity\.json/.test(text), 'the new entry is named')
    assert.ok(!/config\.json/.test(text), 'the acknowledged entry is not re-listed')
    assert.ok(/1 .*acknowledged earlier/.test(text), `count line missing in: ${text}`)
    assert.ok(!/chroxy init/.test(text), 'init advice follows the unacknowledged set')
  })

  it('an acknowledged entry that is migrated afterwards drops out; a different new entry still warns', () => {
    put(source, 'a.json')
    put(source, 'b.json')
    writeStrandedAck(detect())
    put(target, 'a.json') // a migrated: no longer stranded
    put(source, 'c.json')
    const applied = applyStrandedAck(detect())

    assert.deepEqual(applied.stranded, ['c.json'])
    assert.deepEqual(applied.acknowledged, ['b.json'])
  })

  for (const [label, body] of [
    ['not JSON', '{nope'],
    ['wrong version', JSON.stringify({ version: 2, source: 'SRC', acknowledged: ['config.json'] })],
    ['acknowledged not an array', JSON.stringify({ version: 1, source: 'SRC', acknowledged: 'config.json' })],
    ['non-string entry', JSON.stringify({ version: 1, source: 'SRC', acknowledged: ['config.json', 7] })],
    ['a JSON array', '[]'],
    ['a different source root', JSON.stringify({ version: 1, source: '/elsewhere', acknowledged: ['config.json'] })],
  ]) {
    it(`malformed ack file (${label}) counts as no acknowledgement and never throws`, () => {
      put(source, 'config.json')
      put(target, ACK_FILE_NAME, body.replace('SRC', source))

      assert.equal(readStrandedAck(detect()), null)
      const applied = applyStrandedAck(detect())
      assert.deepEqual(applied.stranded, ['config.json'])
      assert.ok(formatStrandedWarning(applied).length > 0)
    })
  }

  it('an ack path that is a directory counts as no acknowledgement', () => {
    put(source, 'config.json')
    mkdirSync(ackPath())
    assert.deepEqual(applyStrandedAck(detect()).stranded, ['config.json'])
  })

  it('writes a 0600 snapshot with the documented shape', () => {
    put(source, 'config.json')
    const res = writeStrandedAck(detect(), { now: () => new Date('2026-10-09T00:00:00Z') })

    assert.deepEqual(res.acknowledged, ['config.json'])
    const doc = JSON.parse(readFileSync(ackPath(), 'utf-8'))
    assert.deepEqual(doc, { version: 1, source, acknowledged: ['config.json'], at: '2026-10-09T00:00:00.000Z' })
    if (process.platform !== 'win32') assert.equal(statSync(ackPath()).mode & 0o777, 0o600)
  })

  it('does not treat the ack file itself as stranded state', () => {
    put(source, 'config.json')
    writeStrandedAck(detect())
    assert.ok(!detect().stranded.includes(ACK_FILE_NAME))
  })
})

describe('startup warning (#7244)', () => {
  it('is quiet when acknowledged, names only the new entry afterwards, and is unchanged when not acknowledged', () => {
    put(source, 'config.json')
    assert.deepEqual(startupStrandedWarning(detect()), formatStrandedWarning(detect()))

    writeStrandedAck(detect())
    assert.deepEqual(startupStrandedWarning(detect()), [])

    put(source, 'push-tokens.json')
    const text = startupStrandedWarning(detect()).join('\n')
    assert.ok(/push-tokens\.json/.test(text) && !/config\.json/.test(text), text)
  })

  it('is what server-cli logs, and the missing-token exit keeps the RAW detection', () => {
    assert.ok(/startupStrandedWarning\(strandedState\)\)\s*log\.warn/.test(serverCliSrc), 'startup must log through startupStrandedWarning')
    assert.ok(/strandedState\?\.highConsequence\.includes\('config\.json'\)/.test(serverCliSrc))
  })
})

describe('chroxy config-dir ack (#7244)', () => {
  it('records the stranded names and says what it did', () => {
    put(source, 'config.json')
    const out = capture()
    const res = runConfigDirAck({ write: out.write, detect })

    assert.equal(res.acknowledged, true)
    assert.deepEqual(res.names, ['config.json'])
    assert.ok(existsSync(ackPath()))
    assert.ok(/config\.json/.test(out.text()))
    assert.ok(/warn(s|ing)? again/.test(out.text()), 'tells the operator a new entry still warns')
  })

  it('with nothing stranded says so and writes nothing', () => {
    const out = capture()
    const res = runConfigDirAck({ write: out.write, detect })

    assert.equal(res.acknowledged, false)
    assert.ok(!existsSync(ackPath()))
    assert.ok(/nothing (is )?stranded|No state stranded/i.test(out.text()))
  })

  it('when the root is not relocated says so and writes nothing', () => {
    put(source, 'config.json')
    const out = capture()
    const res = runConfigDirAck({ write: out.write, detect: () => detectStrandedState({ source, target: source }) })

    assert.equal(res.acknowledged, false)
    assert.ok(!existsSync(join(source, ACK_FILE_NAME)))
    assert.ok(/not relocated/i.test(out.text()))
  })

  it('refuses to acknowledge when the source could not be read', () => {
    const out = capture()
    const res = runConfigDirAck({
      write: out.write,
      detect: () => ({ ...detect(), unreadable: 'EACCES' }),
    })

    assert.equal(res.acknowledged, false)
    assert.ok(!existsSync(ackPath()))
    assert.ok(/EACCES/.test(out.text()))
  })

  it('a second ack replaces the snapshot with the current set', () => {
    put(source, 'a.json')
    runConfigDirAck({ write: () => {}, detect })
    put(source, 'b.json')
    runConfigDirAck({ write: () => {}, detect })

    assert.deepEqual(JSON.parse(readFileSync(ackPath(), 'utf-8')).acknowledged, ['a.json', 'b.json'])
  })
})

describe('chroxy config-dir status shows acknowledgements (#7244)', () => {
  it('marks acknowledged entries and keeps unacknowledged ones unmarked', () => {
    put(source, 'config.json')
    writeStrandedAck(detect())
    put(source, 'push-tokens.json')
    const out = capture()
    const res = runConfigDirStatus({ write: out.write, detect })

    assert.deepEqual(res.stranded, ['config.json', 'push-tokens.json'])
    assert.deepEqual(res.acknowledged, ['config.json'])
    assert.ok(/config\.json.*acknowledged/.test(out.text()))
    assert.ok(!/push-tokens\.json.*acknowledged/.test(out.text()))
  })
})

describe('doctor honours the acknowledgement (#7244)', () => {
  const run = async () => {
    const { checks } = await runDoctorChecks({ providers: ['claude-sdk'], detectStranded: detect })
    return checks.find((c) => c.name === 'Config/state root')
  }

  it('passes, noting the acknowledgement, when every stranded entry is acknowledged', async () => {
    put(source, 'push-tokens.json')
    writeStrandedAck(detect())
    const root = await run()

    assert.equal(root.status, 'pass')
    assert.ok(/acknowledged/.test(root.message), root.message)
  })

  it('warns again, naming only the new entry, when one appears after the acknowledgement', async () => {
    put(source, 'push-tokens.json')
    writeStrandedAck(detect())
    put(source, 'session-state.json')
    const root = await run()

    assert.equal(root.status, 'warn')
    assert.ok(/session-state\.json/.test(root.message), root.message)
    assert.ok(!/push-tokens\.json/.test(root.message), root.message)
  })

  it('an acknowledged config.json still turns a missing Config into the do-not-init advice', async () => {
    put(source, 'config.json')
    writeStrandedAck(detect())
    const { checks } = await runDoctorChecks({ providers: ['claude-sdk'], detectStranded: detect })
    const config = checks.find((c) => c.name === 'Config')

    assert.equal(config.status, 'fail')
    assert.ok(/Do NOT run 'chroxy init'/.test(config.message), config.message)
  })

  it('warns as before when not acknowledged', async () => {
    put(source, 'push-tokens.json')
    const root = await run()

    assert.equal(root.status, 'warn')
    assert.ok(/push-tokens\.json/.test(root.message), root.message)
  })
})
