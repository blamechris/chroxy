import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('SettingsPanel dynamic provider dropdown (#1966)', () => {
  const src = readFileSync(
    join(__dirname, '../src/dashboard-next/src/components/SettingsPanel.tsx'),
    'utf-8'
  )

  const labelsSrc = readFileSync(
    join(__dirname, '../src/dashboard-next/src/lib/provider-labels.ts'),
    'utf-8'
  )

  it('reads availableProviders from the store', () => {
    assert.ok(src.includes('availableProviders'),
      'Should use availableProviders from connection store')
  })

  it('imports shared PROVIDER_LABELS with Gemini entry', () => {
    assert.ok(src.includes('PROVIDER_LABELS'),
      'Should import PROVIDER_LABELS from shared module')
    assert.ok(labelsSrc.includes("'gemini'") && labelsSrc.includes('Gemini CLI'),
      'Shared module should have Gemini CLI in provider labels')
  })

  it('renders dynamic options when availableProviders is non-empty', () => {
    assert.ok(src.includes('availableProviders.map'),
      'Should map over availableProviders to render options')
  })

  it('falls back to static options when no providers available', () => {
    assert.ok(src.includes('Claude Code (SDK)') && src.includes('Claude Code (CLI)'),
      'Should have static fallback options')
  })

  it('normalizes defaultProvider against available list', () => {
    assert.ok(src.includes('effectiveProvider'),
      'Should compute effectiveProvider for defaultProvider validation')
  })
})
