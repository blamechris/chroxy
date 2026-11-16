import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { harnessVerdict, SMOKE_MIN_CASES, smokeMinCases, requireIdeFrom } from './helpers/harness-floor.mjs'

// Pure verdict fixtures only: this file never imports or runs the browser harness.
const pass = n => Array.from({ length: n }, () => ({ status: 'PASS' }))

describe('smoke-test mode-aware verdict (#7657, #8435)', () => {
  it('keeps the explicit 16-case local and existing 18-case required floors', () => {
    assert.equal(smokeMinCases(false), 16)
    assert.equal(smokeMinCases(true), 18)
    assert.equal(SMOKE_MIN_CASES, 18, 'existing callers keep the required-mode constant')
  })

  it('defaults the pure selector to the non-required mode', () => {
    assert.equal(smokeMinCases(), 16)
  })

  it('requireIdeFrom decides strictness from the flag and CI', () => {
    const table = [
      [{ CI: 'true' }, true, 'CI, flag unset -> strict'],
      [{}, false, 'no CI, flag unset -> lenient'],
      [{ CI: 'true', SMOKE_REQUIRE_IDE: '0' }, false, "flag '0' opts out under CI"],
      [{ SMOKE_REQUIRE_IDE: '1' }, true, "flag '1' without CI -> strict"],
      [{ CI: 'true', SMOKE_REQUIRE_IDE: '1' }, true, "flag '1' under CI -> strict"],
      [{ CI: 'true', SMOKE_REQUIRE_IDE: '' }, true, 'empty flag = unset, under CI'],
      [{ CI: 'true', SMOKE_REQUIRE_IDE: 'false' }, true, 'other flag value = unset, under CI'],
      [{ CI: 'true', SMOKE_REQUIRE_IDE: 'yes' }, true, 'typo cannot loosen CI'],
      [{ SMOKE_REQUIRE_IDE: 'true' }, false, 'other flag value = unset, no CI'],
      [{ CI: '' }, false, 'empty CI is not CI'],
      [{ CI: '0' }, false, "CI '0' is not CI"],
      [{ CI: 'false' }, false, "CI 'false' is not CI"],
    ]
    for (const [env, strict, why] of table) {
      assert.equal(requireIdeFrom(env), strict, why)
      assert.equal(smokeMinCases(requireIdeFrom(env)), strict ? 18 : 16, `floor: ${why}`)
    }
  })

  for (const { mode, requireIde, floor } of [
    { mode: 'non-required IDE', requireIde: false, floor: 16 },
    { mode: 'required IDE', requireIde: true, floor: 18 },
  ]) {
    describe(mode, () => {
      it('zero cases is broken, not passing', () => {
        const v = harnessVerdict([], smokeMinCases(requireIde))
        assert.equal(v.failed, 0)
        assert.equal(v.broken, true)
        assert.equal(v.exitCode, 1)
        assert.ok(v.summary.startsWith(`HARNESS BROKEN: ran 0 cases, expected at least ${floor}.`))
      })

      it('one below its floor is broken even when every case passes', () => {
        const v = harnessVerdict(pass(floor - 1), smokeMinCases(requireIde))
        assert.equal(v.total, floor - 1)
        assert.equal(v.failed, 0)
        assert.equal(v.broken, true)
        assert.equal(v.exitCode, 1)
      })

      it('a healthy run exactly at its floor passes', () => {
        const v = harnessVerdict(pass(floor), smokeMinCases(requireIde))
        assert.equal(v.total, floor)
        assert.equal(v.passed, floor)
        assert.equal(v.broken, false)
        assert.equal(v.exitCode, 0)
        assert.equal(v.summary, `${floor} passed, 0 failed`)
      })

      it('a healthy run above its floor passes', () => {
        const v = harnessVerdict(pass(floor + 1), smokeMinCases(requireIde))
        assert.equal(v.broken, false)
        assert.equal(v.exitCode, 0)
      })

      it('an actual recorded failure at its floor still fails', () => {
        const v = harnessVerdict([
          ...pass(floor - 1), { name: 'WebSocket connects', status: 'FAIL' },
        ], smokeMinCases(requireIde))
        assert.equal(v.broken, false)
        assert.equal(v.failed, 1)
        assert.equal(v.exitCode, 1)
        assert.equal(v.summary, `${floor - 1} passed, 1 failed`)
      })

      it('an actual recorded failure above its floor still fails', () => {
        const v = harnessVerdict([...pass(floor), { status: 'FAIL' }], smokeMinCases(requireIde))
        assert.equal(v.broken, false)
        assert.equal(v.failed, 1)
        assert.equal(v.exitCode, 1)
      })
    })
  }

  it('the healthy 16-row local fixture remains broken in required mode', () => {
    const v = harnessVerdict(pass(16), smokeMinCases(true))
    assert.equal(v.broken, true)
    assert.equal(v.exitCode, 1)
  })

  it('the historical 22-row required fixture remains a positive control', () => {
    const v = harnessVerdict(pass(22), smokeMinCases(true))
    assert.equal(v.broken, false)
    assert.equal(v.exitCode, 0)
    assert.ok(SMOKE_MIN_CASES < 22)
  })
})

// Static source assertions, not live smoke coverage. Keep them separate from
// the executed pure-helper cases above: Playwright/server remain out of graph.
describe('smoke-test source wiring (#7657, #8435)', () => {
  const src = readFileSync(new URL('./smoke-test.mjs', import.meta.url), 'utf8')

  it('the actual summary selects its floor from the shared mode boolean', () => {
    const summary = src.slice(src.indexOf('  // Summary'), src.indexOf('  // Cleanup'))
    const declarations = summary.split('\n').map(l => l.trim()).filter(l => l.startsWith('const verdict ='))
    assert.deepEqual(declarations, ['const verdict = harnessVerdict(results, smokeMinCases(requireIde))'])
    assert.equal((src.match(/\bharnessVerdict\(/g) || []).length, 1, 'no other or dead verdict call')
  })

  it('the strict mode flag is derived once and keeps both required-IDE failures', () => {
    assert.equal((src.match(/const requireIde = requireIdeFrom\(process\.env\)/g) || []).length, 1)
    assert.ok(!/SMOKE_REQUIRE_IDE\s*===/.test(src), 'no inline flag parse beside the shared helper')
    assert.equal((src.match(/\brequireIde\s*=/g) || []).length, 1, 'mode is never reassigned')
    assert.ok(src.indexOf('const requireIde =') < src.indexOf('async function run()'), 'same mode reaches probes and summary')
    assert.ok(src.includes("if (requireIde) fail('IDE quick-open palette',"), 'missing required palette must still fail')
    assert.ok(src.includes("if (requireIde) fail('IDE go-to-def fixture',"), 'missing required fixture must still fail')
  })

  it('the non-IDE source inventory has 16 base labels plus two best-effort labels', () => {
    const core = src.slice(src.indexOf('async function run()'), src.indexOf('    // ---- IDE Go-to-Definition')) +
      src.slice(src.indexOf('    // ---- Console errors ----'), src.indexOf('  // Summary'))
    const labels = [...new Set([...core.matchAll(/\bpass\('([^']+)'/g)].map(m => m[1]))]
    const bestEffort = ['Control Room sort/filter controls', 'Control Room refresh']
    const base = labels.filter(label => !bestEffort.includes(label))
    assert.deepEqual(base, [
      'Dashboard loads', 'WebSocket connects', 'Version badge', 'Sidebar visible',
      'Session tabs', 'Full-width layout', 'Input bar present',
      'New Session modal opens (Ctrl+N)', 'Session name input', 'CWD combobox',
      'Provider picker', '? opens shortcut help', 'Control Room opens',
      'Control Room tab present', 'Control Room renders', 'No critical console errors',
    ])
    assert.equal(base.length, 16)
    assert.deepEqual(labels.filter(label => bestEffort.includes(label)), bestEffort)
  })

  it('run() returns the floored verdict without any exit bypass', () => {
    // Enumeration catches added bypass exits that presence checks would miss.
    const runBody = src.slice(src.indexOf('async function run()'), src.lastIndexOf('\nrun()'))
    assert.ok(runBody.length > 1000, 'precondition: the run() body was actually located')
    const exitsInRun = runBody.split('\n').filter(l => /process\.exit\s*\(/.test(l) && !l.trimStart().startsWith('//'))
    assert.equal(exitsInRun.length, 0, 'run() must return its code, never exit')
    assert.ok(/return verdict\.exitCode/.test(runBody), 'the returned code is the verdict')

    const tail = src.slice(src.lastIndexOf('\nrun()'))
    const exits = tail.split('\n').filter(l => /process\.exit\s*\(/.test(l) && !l.trimStart().startsWith('//'))
    assert.equal(exits.length, 2, `expected exactly two module-scope exits, found ${exits.length}`)
    assert.ok(/process\.exit\(code\)/.test(exits[0]), 'success exits on the returned code')
    assert.ok(/process\.exit\(1\)/.test(exits[1]), 'fatal errors exit non-zero')
  })
})
