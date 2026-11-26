/**
 * #8944 — the usage-reporting roster and the server's provider registry must
 * name the same providers, in BOTH directions (a roster checked in one
 * direction only is catalogue entry 28, in docs/false-safety-guards.md).
 *
 *   - every registered provider is classified — a provider added to the
 *     server registry and not classified here goes red, instead of quietly
 *     reading as a measured zero in the Tokens panel (the #8255 bug);
 *   - every classified name is a real registered provider — a stale or
 *     misspelled row is a classification that applies to nothing.
 *
 * The registered side is read from the production registry, not from a copy:
 * `getRegisteredProviderNames()` for the built-ins and
 * `DOCKER_PROVIDER_IDS` for the providers `registerDockerProvider` adds at
 * daemon start (the registry only holds them after that config-driven call).
 * Providers a config file adds at runtime cannot be enumerated here; the
 * panel's `turnsBilled > 0` gate covers them.
 */
import { describe, it, expect } from 'vitest'
import { PROVIDER_REPORTS_USAGE, providerReportsUsage } from './provider-usage-roster'
// @ts-expect-error — plain-JS server module, no type declarations
import { getRegisteredProviderNames, DOCKER_PROVIDER_IDS } from '../../../server/src/providers.js'

const registered: string[] = [...getRegisteredProviderNames(), ...DOCKER_PROVIDER_IDS]
const classified = Object.keys(PROVIDER_REPORTS_USAGE)

/** Names in `a` that are not in `b`, sorted. */
function missingFrom(a: string[], b: string[]): string[] {
  const set = new Set(b)
  return a.filter((n) => !set.has(n)).sort()
}

describe('provider usage roster (#8944)', () => {
  it('reads a non-empty registered roster (the comparison cannot pass over zero rows)', () => {
    expect(registered.length).toBeGreaterThan(5)
    expect(registered).toContain('claude-tui')
    expect(registered).toContain('claude-sdk')
  })

  it('classifies every registered provider', () => {
    expect(
      missingFrom(registered, classified),
      'registered but not classified: add a row to PROVIDER_REPORTS_USAGE (true if the provider reports token usage)',
    ).toEqual([])
  })

  it('every classified name is a registered provider', () => {
    expect(
      missingFrom(classified, registered),
      'classified but not registered: remove or correct the row in PROVIDER_REPORTS_USAGE',
    ).toEqual([])
  })

  it('the comparison goes red for a provider on either side only', () => {
    // Positive controls: the helper must report a one-sided difference.
    expect(missingFrom(['a', 'future-acp'], ['a'])).toEqual(['future-acp'])
    expect(missingFrom(['a', 'stale-row'], ['a'])).toEqual(['stale-row'])
    expect(missingFrom(['a'], ['a'])).toEqual([])
  })

  it('classifies claude-tui as not reporting, and an unlisted runtime provider as reporting', () => {
    expect(providerReportsUsage('claude-tui')).toBe(false)
    expect(providerReportsUsage('claude-sdk')).toBe(true)
    expect(providerReportsUsage('some-config-driven-endpoint')).toBe(true)
    expect(providerReportsUsage('constructor')).toBe(true)
  })
})
