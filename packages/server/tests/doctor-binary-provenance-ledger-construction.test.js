/**
 * #8074 review N1 — "gates off never constructs (or touches) the real
 * binary-trust.json ledger" (doctor-binary-provenance.test.js) could not
 * actually detect ledger CONSTRUCTION: `BinaryProvenanceLedger`'s constructor
 * only READS its backing file (`_loadRecords()`); it never writes on
 * construction. So checking `existsSync(defaultBinaryTrustFile())` after a
 * gates-off `runDoctorChecks()` call proves nothing about whether
 * `new BinaryProvenanceLedger()` ran — with gates off, `buildBinaryProvenanceOptions`
 * returns `null` regardless, so the ledger (real or mutant-always-constructed)
 * is never READ FROM or WRITTEN TO either way. Mutant R3 (the lazy
 * `provenanceGateOn ? new BinaryProvenanceLedger() : null` replaced with an
 * unconditional `new BinaryProvenanceLedger()`) survived that test.
 *
 * This file mocks `binary-provenance-trust.js`'s `BinaryProvenanceLedger`
 * export with a spy BEFORE importing `doctor.js`, so `runDoctorChecks()`'s
 * `new BinaryProvenanceLedger()` call (if it happens at all) hits the spy
 * instead of the real class — proving CONSTRUCTION itself, not merely a
 * filesystem side effect. Kept in its own file (rather than folded into
 * `doctor-binary-provenance.test.js`) because `mock.module` replaces the
 * module for every import in this process; isolating it means the rest of
 * that suite keeps exercising the REAL ledger class for its explicit
 * `binaryProvenanceLedger` overrides.
 */
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { registerProvider } from '../src/providers.js'
import { SdkSession } from '../src/sdk-session.js'

const constructorCalls = []
class SpyBinaryProvenanceLedger {
  constructor(opts) {
    constructorCalls.push(opts)
  }
  getRecord() { return null }
  approve() { return true }
}

mock.module('../src/binary-provenance-trust.js', {
  namedExports: {
    BinaryProvenanceLedger: SpyBinaryProvenanceLedger,
    // doctor.js only imports BinaryProvenanceLedger from this module, but the
    // real module also exports these — provided so the mock fully shadows
    // the real module's surface for any other importer in this process.
    defaultBinaryTrustFile: () => '/dev/null/unused-in-this-suite',
    binaryTrustFileExists: () => false,
  },
})

// Imported AFTER the mock is installed, so `runDoctorChecks`'s
// `import { BinaryProvenanceLedger } from './binary-provenance-trust.js'`
// resolves to the spy above.
const { runDoctorChecks } = await import('../src/doctor.js')
const { verifyProvenance: realVerifyProvenance } = await import('../src/utils/verify-provenance.js')

// #8093 review S5: with `providers: []` there is no provider row, but
// `runDoctorChecks` still runs the cloudflared row unconditionally, resolved
// off the real PATH with no fixture seam here. On a host where the real
// `cloudflared` happens to be an npm JS launcher, the gate-on test below
// would walk that REAL installed package tree. Pin `classifyBinary` to a
// `native`-only stub, same as doctor-binary-provenance.test.js's gate-on
// calls — this file is about ledger CONSTRUCTION, not classification.
const CLASSIFY_NATIVE_VERIFY_PROVENANCE = (opts) => realVerifyProvenance({ ...opts, classifyBinary: () => ({ kind: 'native' }) })

// #8096: `providers: []` does NOT mean "no provider row" — `resolveProviders`
// (doctor.js) falls back to `DEFAULT_PROVIDER` ('claude-tui') whenever the
// `providers` array is empty, and `effectiveDefault === 'claude-tui'` then
// ALSO runs the claude-tui-driving version probe (doctor.js step 5.6). Both
// resolve the REAL `claude` binary via its fixed `CLAUDE_BINARY_CANDIDATES`
// list (`~/.local/bin/claude` on this repo's own dev machines) — the gate-on
// test below would then hash (and, were the gate off, exec) the REAL `claude`
// installed on the machine running this suite, which has nothing to do with
// what these two tests actually check (ledger CONSTRUCTION, not which
// provider ran). A no-op fixture provider under a name that is never
// `'claude-tui'` sidesteps BOTH the provider row's own binary resolution and
// the 5.6 probe (which only fires for that literal name) in one move.
class NoopProviderSession extends SdkSession {
  static get preflight() { return null }
}
registerProvider('chroxy-8096-ledger-noop-provider', NoopProviderSession)

// #8096: the cloudflared row (see the comment on CLASSIFY_NATIVE_VERIFY_PROVENANCE
// above) resolves via `which cloudflared` off this PROCESS'S real PATH first,
// then falls through to the fixed `CLOUDFLARED_CANDIDATES` install paths —
// either can find (and, gate off, exec) a REAL cloudflared. Both call sites
// below route through this helper: it scopes PATH empty and points
// `cloudflaredCandidates` at nothing, restoring PATH afterward regardless of
// outcome. See doctor-binary-provenance.test.js's `runDoctorChecksNoRealCloudflared`
// for the identical reasoning (duplicated here rather than shared across
// files — this file already keeps its own small, self-contained fixture set).
async function runDoctorChecksNoRealCloudflared(opts) {
  const savedPath = process.env.PATH
  process.env.PATH = ''
  try {
    return await runDoctorChecks({ cloudflaredCandidates: [], ...opts })
  } finally {
    process.env.PATH = savedPath
  }
}

describe('runDoctorChecks — ledger construction, gates off (#8074 review N1)', () => {
  it('never constructs BinaryProvenanceLedger when gates are off', async () => {
    constructorCalls.length = 0
    await runDoctorChecksNoRealCloudflared({ providers: ['chroxy-8096-ledger-noop-provider'], binaryProvenanceMode: 'off', binarySignatureGate: false })
    assert.equal(constructorCalls.length, 0, 'gates off must never construct the ledger — red under mutant R3 (unconditional `new BinaryProvenanceLedger()`)')
  })

  it('DOES construct BinaryProvenanceLedger when a gate is on and no override is supplied (sanity check on the spy itself)', async () => {
    constructorCalls.length = 0
    await runDoctorChecksNoRealCloudflared({
      providers: ['chroxy-8096-ledger-noop-provider'],
      binaryProvenanceMode: 'block',
      binarySignatureGate: false,
      verifyProvenance: CLASSIFY_NATIVE_VERIFY_PROVENANCE,
    })
    assert.equal(constructorCalls.length, 1, 'gate on with no override must construct exactly one ledger — proves the spy is actually wired into runDoctorChecks, so the first assertion is not vacuously true')
  })
})
