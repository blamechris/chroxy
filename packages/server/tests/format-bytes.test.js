import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatBytes } from '../src/utils/format-bytes.js'

// #3543 — humanised byte labels for `stdin_dropped` log lines.  The raw
// cumulative byte count is preserved for scriptable consumers; this helper
// renders the human-friendly companion suffix shown alongside it.
describe('formatBytes', () => {
  describe('byte-range boundaries', () => {
    it('renders 0 as "0 B"', () => {
      assert.equal(formatBytes(0), '0 B')
    })

    it('renders 1 as "1 B"', () => {
      assert.equal(formatBytes(1), '1 B')
    })

    it('renders 1023 as "1023 B" (just below KiB boundary)', () => {
      // The boundary case proves we do NOT promote sub-1024 values to KiB.
      // Operators see exact bytes for small drops, which is more useful than
      // "1.0 KiB" for a 1023-byte payload.
      assert.equal(formatBytes(1023), '1023 B')
    })
  })

  describe('KiB range', () => {
    it('renders exactly 1024 as "1.0 KiB"', () => {
      assert.equal(formatBytes(1024), '1.0 KiB')
    })

    it('renders 1536 as "1.5 KiB"', () => {
      assert.equal(formatBytes(1536), '1.5 KiB')
    })

    it('renders 1024 * 1024 - 1 as a KiB label (just below MiB boundary)', () => {
      // 1048575 bytes = 1023.999... KiB, formatted to one decimal as 1024.0 KiB.
      // The exact rendering is implementation detail; the contract is the
      // unit suffix stays KiB until we hit a full MiB.
      const result = formatBytes(1024 * 1024 - 1)
      assert.ok(result.endsWith(' KiB'),
        `expected KiB suffix below MiB boundary, got "${result}"`)
    })
  })

  describe('MiB range', () => {
    it('renders exactly 1024 * 1024 as "1.0 MiB"', () => {
      assert.equal(formatBytes(1024 * 1024), '1.0 MiB')
    })

    it('renders 10 MiB (the stdin_dropped error threshold) as "10.0 MiB"', () => {
      // This is the load-bearing case: PR #3537 logs cumulative bytes at the
      // 10 MiB error-escalation threshold; that line is the primary motivation
      // for #3543.  Lock the exact rendering so the log-line shape stays stable.
      assert.equal(formatBytes(10 * 1024 * 1024), '10.0 MiB')
    })

    it('renders 1024^3 - 1 as an MiB label (just below GiB boundary)', () => {
      const result = formatBytes(1024 * 1024 * 1024 - 1)
      assert.ok(result.endsWith(' MiB'),
        `expected MiB suffix below GiB boundary, got "${result}"`)
    })
  })

  describe('GiB range', () => {
    it('renders exactly 1024^3 as "1.0 GiB"', () => {
      assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GiB')
    })

    it('renders 2.5 GiB as "2.5 GiB"', () => {
      assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.5 GiB')
    })
  })

  describe('defensive fallbacks', () => {
    it('renders negative inputs as "<n> B" without crashing', () => {
      // Caller upstream filters non-finite/negative input, but the helper
      // still has to be safe — a NaN here must not break a log line.
      assert.equal(formatBytes(-1), '-1 B')
    })

    it('renders NaN as "NaN B" without crashing', () => {
      assert.equal(formatBytes(NaN), 'NaN B')
    })

    it('renders Infinity as "Infinity B" without crashing', () => {
      assert.equal(formatBytes(Infinity), 'Infinity B')
    })
  })
})
