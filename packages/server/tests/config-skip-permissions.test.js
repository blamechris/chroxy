import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { validateConfig, mergeConfig, resolveSkipPermissions } from '../src/config.js'
import { loadAndMergeConfig } from '../src/cli/shared.js'

/**
 * #4246 — `skipPermissions` config key undersold the danger relative to the
 * `--dangerously-skip-permissions` CLI flag. Fix is twofold:
 *
 *   1. Add a canonical `dangerouslySkipPermissions` config key that mirrors
 *      the CLI long-form. Backwards-compat: the legacy `skipPermissions` key
 *      is still honoured for a deprecation window, but emits a warning.
 *   2. `resolveSkipPermissions(config)` is the single read site — it returns
 *      the effective boolean, the source key it came from, and any
 *      deprecation warning. server-cli wires the warning into the boot log
 *      so operators can see when they're flying without seatbelts and why.
 *
 * Tests cover the schema, the merge precedence (canonical > legacy >
 * undefined), and the deprecation warning emitted when only the legacy key
 * is present.
 */
describe('config.dangerouslySkipPermissions (#4246)', () => {
  describe('schema', () => {
    it('accepts dangerouslySkipPermissions as a boolean', () => {
      const result = validateConfig({ dangerouslySkipPermissions: true })
      assert.equal(result.valid, true)
      assert.equal(result.warnings.length, 0)
    })

    it('warns when dangerouslySkipPermissions is not a boolean', () => {
      const result = validateConfig({ dangerouslySkipPermissions: 'yes' })
      assert.equal(result.valid, false)
      assert.ok(
        result.warnings.some((w) => w.includes('dangerouslySkipPermissions') && w.includes('boolean')),
        `expected a type warning for dangerouslySkipPermissions, got: ${JSON.stringify(result.warnings)}`,
      )
    })

    it('still accepts legacy skipPermissions key without an "unknown key" warning', () => {
      // The legacy key MUST remain in the schema so existing config.json
      // files don't start emitting "Unknown config key" warnings on
      // upgrade — that would be a worse UX than the original problem.
      const result = validateConfig({ skipPermissions: true })
      const unknownKeyWarning = result.warnings.find((w) => w.includes('Unknown config key') && w.includes('skipPermissions'))
      assert.equal(unknownKeyWarning, undefined,
        `legacy skipPermissions must not be flagged as unknown: ${JSON.stringify(result.warnings)}`)
    })
  })

  describe('resolveSkipPermissions', () => {
    it('returns enabled=false / source=null when neither key is set', () => {
      const result = resolveSkipPermissions({})
      assert.equal(result.enabled, false)
      assert.equal(result.source, null)
      assert.equal(result.deprecationWarning, null)
    })

    it('returns enabled=true / source=dangerouslySkipPermissions when canonical key is true', () => {
      const result = resolveSkipPermissions({ dangerouslySkipPermissions: true })
      assert.equal(result.enabled, true)
      assert.equal(result.source, 'dangerouslySkipPermissions')
      assert.equal(result.deprecationWarning, null,
        'canonical key must not produce a deprecation warning')
    })

    it('returns enabled=true / source=skipPermissions WITH deprecation warning when only legacy key is true', () => {
      const result = resolveSkipPermissions({ skipPermissions: true })
      assert.equal(result.enabled, true)
      assert.equal(result.source, 'skipPermissions')
      assert.ok(result.deprecationWarning,
        'legacy key MUST emit a deprecation warning so operators are nudged to rename')
      assert.match(result.deprecationWarning, /skipPermissions/,
        'warning mentions the legacy key by name')
      assert.match(result.deprecationWarning, /dangerouslySkipPermissions/,
        'warning names the canonical replacement key')
    })

    it('canonical key wins when both are present (precedence)', () => {
      const result = resolveSkipPermissions({
        dangerouslySkipPermissions: true,
        skipPermissions: false,
      })
      assert.equal(result.enabled, true,
        'dangerouslySkipPermissions wins over a contradictory legacy value')
      assert.equal(result.source, 'dangerouslySkipPermissions')
    })

    it('canonical key wins even when both are true — still warns about the legacy key being present', () => {
      // If the operator has both keys set to true, the canonical key is
      // authoritative BUT we should still call out the duplicate so they
      // can clean up the legacy entry. The warning fires whenever the
      // legacy key is present at all (even when overridden).
      const result = resolveSkipPermissions({
        dangerouslySkipPermissions: true,
        skipPermissions: true,
      })
      assert.equal(result.enabled, true)
      assert.equal(result.source, 'dangerouslySkipPermissions')
      assert.ok(result.deprecationWarning,
        'legacy key being present alongside canonical should still warn')
      assert.match(result.deprecationWarning, /skipPermissions/)
    })

    it('canonical false explicitly overrides legacy true', () => {
      const result = resolveSkipPermissions({
        dangerouslySkipPermissions: false,
        skipPermissions: true,
      })
      assert.equal(result.enabled, false,
        'an explicit dangerouslySkipPermissions=false must mask a stale legacy true')
      assert.equal(result.source, 'dangerouslySkipPermissions')
    })

    it('non-boolean canonical value is treated as unset and falls through to legacy', () => {
      // Defensive: if the canonical key got a malformed value (validateConfig
      // would have warned), don't silently fail-open OR fail-closed —
      // fall through to the legacy key path so we behave like the
      // canonical key wasn't there.
      const result = resolveSkipPermissions({
        dangerouslySkipPermissions: 'truthy-but-not-boolean',
        skipPermissions: true,
      })
      assert.equal(result.enabled, true)
      assert.equal(result.source, 'skipPermissions',
        'malformed canonical value must NOT swallow the legacy key — fall through')
    })

    it('handles null/undefined config object gracefully', () => {
      assert.doesNotThrow(() => resolveSkipPermissions(null))
      assert.doesNotThrow(() => resolveSkipPermissions(undefined))
      const result = resolveSkipPermissions(null)
      assert.equal(result.enabled, false)
      assert.equal(result.source, null)
    })
  })

  describe('mergeConfig integration', () => {
    let originalEnv

    beforeEach(() => {
      originalEnv = { ...process.env }
      // Strip anything that might leak in from the host environment.
      delete process.env.DANGEROUSLYSKIPPERMISSIONS
      delete process.env.SKIPPERMISSIONS
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('preserves dangerouslySkipPermissions through mergeConfig from file', () => {
      const merged = mergeConfig({ fileConfig: { dangerouslySkipPermissions: true } })
      assert.equal(merged.dangerouslySkipPermissions, true)
    })

    it('preserves legacy skipPermissions through mergeConfig from file', () => {
      // mergeConfig is the dumb plumbing layer — it doesn't perform the
      // alias migration (resolveSkipPermissions does). It just has to
      // surface both keys so the resolver sees them.
      const merged = mergeConfig({ fileConfig: { skipPermissions: true } })
      assert.equal(merged.skipPermissions, true)
    })

    it('CLI dangerouslySkipPermissions overrides file legacy skipPermissions', () => {
      const merged = mergeConfig({
        fileConfig: { skipPermissions: true },
        cliOverrides: { dangerouslySkipPermissions: false },
      })
      const resolved = resolveSkipPermissions(merged)
      assert.equal(resolved.enabled, false,
        'CLI explicit-disable of the canonical key must override a stale file-side legacy true')
    })
  })

  describe('loadAndMergeConfig end-to-end (canonical key)', () => {
    let tempDir
    let originalExitOverride

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'chroxy-cfg-skip-perms-'))
      originalExitOverride = process.exit
    })

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true })
      process.exit = originalExitOverride
    })

    it('CLI --dangerously-skip-permissions flag flows into config under the canonical key (#4246)', () => {
      const configPath = join(tempDir, 'config.json')
      writeFileSync(configPath, JSON.stringify({ apiToken: 't', port: 8765 }))
      // Mimic the Commander-parsed options object after the flag is set.
      const options = {
        config: configPath,
        dangerouslySkipPermissions: true,
      }
      const merged = loadAndMergeConfig(options)
      assert.equal(merged.dangerouslySkipPermissions, true,
        'CLI flag MUST land in the canonical config key, not the legacy one')
      assert.equal(merged.skipPermissions, undefined,
        'CLI flag must NOT populate the legacy key — that would defeat the rename')
      const resolved = resolveSkipPermissions(merged)
      assert.equal(resolved.enabled, true)
      assert.equal(resolved.source, 'dangerouslySkipPermissions')
      assert.equal(resolved.deprecationWarning, null,
        'CLI-flag path must NOT spurious-warn about deprecation — only the file-side legacy key does')
    })

    it('file-side legacy skipPermissions is still honoured by loadAndMergeConfig (backwards compat)', () => {
      const configPath = join(tempDir, 'config.json')
      writeFileSync(configPath, JSON.stringify({
        apiToken: 't',
        port: 8765,
        skipPermissions: true,
      }))
      const options = { config: configPath }
      const merged = loadAndMergeConfig(options)
      const resolved = resolveSkipPermissions(merged)
      assert.equal(resolved.enabled, true,
        'a config.json with the legacy key must continue to enable skip-permissions')
      assert.equal(resolved.source, 'skipPermissions')
      assert.ok(resolved.deprecationWarning,
        'legacy file-side key MUST surface a deprecation warning')
    })

    it('file-side canonical dangerouslySkipPermissions is honoured by loadAndMergeConfig', () => {
      const configPath = join(tempDir, 'config.json')
      writeFileSync(configPath, JSON.stringify({
        apiToken: 't',
        port: 8765,
        dangerouslySkipPermissions: true,
      }))
      const options = { config: configPath }
      const merged = loadAndMergeConfig(options)
      const resolved = resolveSkipPermissions(merged)
      assert.equal(resolved.enabled, true)
      assert.equal(resolved.source, 'dangerouslySkipPermissions')
      assert.equal(resolved.deprecationWarning, null)
    })
  })
})
