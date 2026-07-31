import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  mergeConfig,
  validateConfig,
  coerceDurationConfigValue,
  DURATION_MS_CONFIG_KEYS,
} from '../src/config.js'
import { ServerInactivityWarningSchema } from '@chroxy/protocol'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_SRC = join(HERE, '..', 'src', 'config.js')

/**
 * #7083 — duration config options are coerced to whole milliseconds at the merge site.
 *
 * A fractional `*_MS` value used to survive with ZERO validateConfig warnings and reach
 * the wire as `inactivity_warning.idleMs`, violating a schema that requires `.int()`.
 * The coercion sits in `mergeConfig`'s `setValue` — the sole writer into the merged
 * object — so it covers every precedence branch INCLUDING the config-file path, which
 * is JSON and has no parse step to hook.
 *
 * The scope boundary matters more than the fix: `costBudget` shares the same `'number'`
 * env branch and is USD, so coercing it would truncate a spend cap — and `0.50 -> 0`
 * makes `config.costBudget || null` falsy, disabling the budget entirely with no signal.
 */
describe('#7083 duration config coercion', () => {
  const ENV_KEYS = [
    'CHROXY_RESULT_TIMEOUT_MS', 'CHROXY_HARD_TIMEOUT_MS', 'CHROXY_STREAM_STALL_TIMEOUT_MS',
    'CHROXY_BACKGROUND_SHELL_HARD_QUIESCE_MS', 'CHROXY_MCP_TOOL_CALL_TIMEOUT_MS',
    'CHROXY_TERMINAL_DOWN_GRACE_MS', 'CHROXY_COST_BUDGET', 'PORT',
  ]
  let savedEnv

  beforeEach(() => {
    savedEnv = {}
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  // mergeConfig returns the merged object directly. An earlier version read `.config`
  // with a `??` fallback, which was always undefined and therefore merged TWICE on
  // every call — doubling the coercion warnings it was supposed to be observing.
  const mergeFile = (fileConfig) => mergeConfig({ fileConfig })

  it('CONTROL: an ordinary integer duration is untouched, so the assertions below mean something', () => {
    const merged = mergeFile({ resultTimeoutMs: 1800000 })
    assert.equal(merged.resultTimeoutMs, 1800000)
    assert.equal(coerceDurationConfigValue('resultTimeoutMs', 1800000), 1800000)
  })

  it('coerces a fractional value from the CONFIG FILE — the case an env-only fix misses', () => {
    // ~/.chroxy/config.json is JSON, so 1800000.5 arrives as a number with no parse
    // step. A fix inside parseEnvValue would leave this path fully broken.
    const merged = mergeFile({ resultTimeoutMs: 1800000.5 })
    assert.equal(merged.resultTimeoutMs, 1800000)
    assert.ok(Number.isInteger(merged.resultTimeoutMs))
  })

  it('coerces a fractional value from the ENV path', () => {
    process.env.CHROXY_RESULT_TIMEOUT_MS = '1800000.5'
    const merged = mergeFile({})
    assert.equal(merged.resultTimeoutMs, 1800000)
  })

  it('coerces on the CLI-override branch too (the fix is in setValue, not one branch)', () => {
    const merged = mergeConfig({ cliOverrides: { resultTimeoutMs: 1800000.5 } })
    assert.equal(merged.resultTimeoutMs, 1800000)
  })

  it('covers every allowlisted duration key, not just the one in the issue', () => {
    for (const key of DURATION_MS_CONFIG_KEYS) {
      assert.equal(coerceDurationConfigValue(key, 90000.7), 90000, `${key} must coerce`)
    }
  })

  // --- the scope boundary: what must NOT be touched -------------------------

  it('does NOT coerce costBudget — it is USD, and 0.50 -> 0 would disable the budget', () => {
    // The single most important assertion here. `config.costBudget || null` treats 0 as
    // "no budget", so truncating a sub-dollar cap silently removes the cap entirely.
    assert.equal(coerceDurationConfigValue('costBudget', 0.5), 0.5)
    assert.equal(coerceDurationConfigValue('costBudget', 5.5), 5.5)
    assert.equal(mergeFile({ costBudget: 0.5 }).costBudget, 0.5)
    process.env.CHROXY_COST_BUDGET = '5.50'
    assert.equal(mergeFile({}).costBudget, 5.5)
  })

  it('does NOT coerce non-duration numerics', () => {
    assert.equal(coerceDurationConfigValue('port', 8765.9), 8765.9)
    assert.equal(coerceDurationConfigValue('maxSessions', 5.7), 5.7)
    assert.equal(mergeFile({ port: 8765.9 }).port, 8765.9)
  })

  it('does NOT recurse into nested objects (pricing/billing are legitimately fractional)', () => {
    // A recursive walk would destroy providers.*.pricing.input and
    // billing.monthlyCreditBudgetUsd. The helper is a flat key lookup by design.
    const merged = mergeFile({
      billing: { monthlyCreditBudgetUsd: 12.5 },
      worktreeGc: { reapIntervalMs: 900000.5 },
    })
    assert.equal(merged.billing.monthlyCreditBudgetUsd, 12.5, 'nested USD survives')
    assert.equal(merged.worktreeGc.reapIntervalMs, 900000.5, 'nested ms is out of scope — see the comment in config.js')
  })

  it('coerces the per-provider duration MAP — it outranks the global and reaches result.duration', () => {
    // The gap review found. `providerStreamStallTimeoutMs.<id>` survives mergeConfig,
    // draws ZERO validateConfig warnings, is kept verbatim by
    // _sanitizeProviderTimeoutMap (isOperatorTimeoutInRange checks finite/positive/<=24h
    // but never integrality), OUTRANKS the coerced global, and is emitted as
    // result.duration. stream.ts records this exact field as blocked on #7083 before
    // .int() can be added — so coercing only the flat keys would have left #7095 unsafe.
    const merged = mergeFile({ providerStreamStallTimeoutMs: { 'claude-sdk': 1800000.5, codex: 60000 } })
    assert.equal(merged.providerStreamStallTimeoutMs['claude-sdk'], 1800000)
    assert.equal(merged.providerStreamStallTimeoutMs.codex, 60000, 'an already-integer entry is untouched')
  })

  it('the map coercion is ONE level deep — pricing and billing survive', () => {
    // Depth is what turns this into the change that truncates money.
    const merged = mergeFile({
      providers: { anthropicCompatible: [{ id: 'x', pricing: { input: 0.6, output: 3.75 } }] },
      billing: { monthlyCreditBudgetUsd: 12.5 },
    })
    assert.equal(merged.providers.anthropicCompatible[0].pricing.input, 0.6)
    assert.equal(merged.providers.anthropicCompatible[0].pricing.output, 3.75)
    assert.equal(merged.billing.monthlyCreditBudgetUsd, 12.5)
  })

  it('a non-object providerStreamStallTimeoutMs passes through for validateConfig to reject', () => {
    // The wrong-type warning must still fire on the operator's raw value.
    assert.equal(coerceDurationConfigValue('providerStreamStallTimeoutMs', 'nope'), 'nope')
    assert.equal(coerceDurationConfigValue('providerStreamStallTimeoutMs', null), null)
  })

  it('DOCUMENTED EXCEPTION: terminalDownGraceMs has no range validation, so +/-1 is legal and unwarned', () => {
    // Recorded rather than hidden. For the five range-checked keys, +/-1 is still below
    // the minimum and validateConfig still warns. terminalDownGraceMs is not range-
    // checked at all, so 0.4 becomes a legal, unwarned 1 — an invented value, tolerable
    // only because that key never reaches the wire.
    const merged = mergeFile({ terminalDownGraceMs: 0.4 })
    assert.equal(merged.terminalDownGraceMs, 1)
    const warnings = (validateConfig(merged).warnings || []).filter((w) => /terminalDownGrace/i.test(w))
    assert.deepEqual(warnings, [], 'no warning today — this test exists so that stays a known fact')
  })

  // --- boundaries and sentinels ---------------------------------------------

  it('truncation never pushes a legal value below its documented minimum', () => {
    // Every minimum is an integer, so trunc(v) >= min holds for any v >= min. Pinned
    // rather than argued: validateConfig must emit no below-minimum warning.
    const merged = mergeFile({
      resultTimeoutMs: 30000.9, streamStallTimeoutMs: 5000.9,
      backgroundShellHardQuiesceMs: 60000.9, mcpToolCallTimeoutMs: 1000.9,
    })
    assert.equal(merged.resultTimeoutMs, 30000)
    assert.equal(merged.streamStallTimeoutMs, 5000)
    const warnings = (validateConfig(merged).warnings || []).join('\n')
    assert.ok(!/minimum/i.test(warnings), `no below-minimum warning expected, got: ${warnings}`)
  })

  it('NEVER manufactures the 0 "disabled" sentinel from a non-zero input', () => {
    // trunc(0.4) === 0 would silently switch stall detection OFF — turning a value that
    // warns today into a quietly disabled feature. Sub-1 magnitudes go to +/-1: still
    // illegal, still warned about, never the sentinel.
    assert.equal(coerceDurationConfigValue('streamStallTimeoutMs', 0.4), 1)
    assert.notEqual(coerceDurationConfigValue('streamStallTimeoutMs', 0.4), 0)
    assert.equal(coerceDurationConfigValue('streamStallTimeoutMs', -0.5), -1)
    assert.equal(coerceDurationConfigValue('backgroundShellHardQuiesceMs', 0.4), 1)
    // and the coerced value is still out of range, so the operator still gets told
    const warnings = (validateConfig(mergeFile({ streamStallTimeoutMs: 0.4 })).warnings || []).join('\n')
    assert.ok(/streamStallTimeoutMs/.test(warnings), `expected a range warning, got: ${warnings}`)
  })

  it('an explicit 0 is preserved (disable stays disable)', () => {
    assert.equal(coerceDurationConfigValue('streamStallTimeoutMs', 0), 0)
    assert.equal(mergeFile({ streamStallTimeoutMs: 0 }).streamStallTimeoutMs, 0)
  })

  it('preserves the NaN-passthrough and Infinity contracts', () => {
    // parseEnvValue returns the raw STRING when parseFloat yields NaN; the range checks
    // have documented Infinity semantics. Both must survive the coercion untouched.
    assert.equal(coerceDurationConfigValue('resultTimeoutMs', 'notanumber'), 'notanumber')
    assert.equal(coerceDurationConfigValue('hardTimeoutMs', Infinity), Infinity)
    assert.equal(coerceDurationConfigValue('hardTimeoutMs', -Infinity), -Infinity)
    process.env.CHROXY_RESULT_TIMEOUT_MS = 'notanumber'
    assert.equal(typeof mergeFile({}).resultTimeoutMs, 'string')
  })

  // --- drift + the thing this actually unblocks ------------------------------

  it('DRIFT GUARD: the allowlist equals every *Ms number key in CONFIG_SCHEMA', () => {
    // A new duration option that is not allowlisted would silently opt out of the fix.
    // Source-scanned with a line reader, not grep — grep returns empty on large files.
    const lines = readFileSync(CONFIG_SRC, 'utf8').split('\n')
    const start = lines.findIndex((l) => l.includes('CONFIG_SCHEMA') && l.includes('='))
    assert.ok(start > 0, 'CONFIG_SCHEMA must be findable')
    const found = new Set()
    for (const line of lines.slice(start, start + 400)) {
      const m = line.match(/^\s*(\w+Ms):\s*'number'/)
      if (m) found.add(m[1])
    }
    assert.ok(found.size > 0, 'the scan found no *Ms number keys — the scan itself is broken')
    assert.deepEqual(
      [...found].sort(), [...DURATION_MS_CONFIG_KEYS].sort(),
      'DURATION_MS_CONFIG_KEYS has drifted from CONFIG_SCHEMA — add the new duration key (or document why it is excluded)',
    )
  })

  it('the emitted inactivity_warning satisfies the REAL wire schema (this unblocks #7095)', () => {
    process.env.CHROXY_RESULT_TIMEOUT_MS = '1800000.5'
    const merged = mergeFile({})
    // Field set taken from ServerInactivityWarningSchema itself — an invented shape
    // would fail for a reason unrelated to idleMs and prove nothing about the fix.
    const frame = { type: 'inactivity_warning', messageId: 'm1', prefab: 'idle', idleMs: merged.resultTimeoutMs }
    assert.ok(
      ServerInactivityWarningSchema.safeParse(frame).success,
      `the emitted frame must be wire-legal; idleMs was ${merged.resultTimeoutMs}`,
    )
    // Negative control: the RAW fractional value is what the schema rejects, so the
    // test above passes because of the coercion and not for some unrelated reason.
    const raw = { ...frame, idleMs: 1800000.5 }
    assert.equal(ServerInactivityWarningSchema.safeParse(raw).success, false)
  })
})
