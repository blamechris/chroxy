import { describe, test, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const modalSrc = fs.readFileSync(
  path.resolve(__dirname, './CreateSessionModal.tsx'),
  'utf-8',
)

const connectionSrc = fs.readFileSync(
  path.resolve(__dirname, '../store/connection.ts'),
  'utf-8',
)

const typesSrc = fs.readFileSync(
  path.resolve(__dirname, '../store/types.ts'),
  'utf-8',
)

const messageHandlerSrc = fs.readFileSync(
  path.resolve(__dirname, '../store/message-handler.ts'),
  'utf-8',
)

const sidebarSrc = fs.readFileSync(
  path.resolve(__dirname, './Sidebar.tsx'),
  'utf-8',
)

// Server-side files
const schemasSrc = fs.readFileSync(
  path.resolve(__dirname, '../../../..', 'packages/server/src/ws-schemas.js'),
  'utf-8',
)

describe('Provider picker in session creation (#1366)', () => {
  test('CreateSessionData includes provider field', () => {
    expect(modalSrc).toMatch(/interface CreateSessionData[\s\S]*?provider\??\s*:\s*string/)
  })

  test('CreateSessionModal has provider selector UI', () => {
    expect(modalSrc).toMatch(/provider/i)
    expect(modalSrc).toMatch(/select|dropdown|radio/i)
  })

  test('provider passed to onCreate callback', () => {
    expect(modalSrc).toMatch(/provider/)
  })

  test('createSession store method accepts provider parameter', () => {
    const match = connectionSrc.match(/createSession:\s*\(([\s\S]{0,200}?)\)/)
    expect(match).toBeTruthy()
    expect(match![1]).toMatch(/provider/)
  })

  test('createSession sends provider in WS message', () => {
    expect(connectionSrc).toMatch(/create_session[\s\S]*?provider/)
  })

  test('default provider is claude-sdk', () => {
    expect(modalSrc).toMatch(/claude-sdk/)
  })

  // --- New tests for dynamic provider list ---

  test('ProviderInfo type exists in types.ts with name and capabilities', () => {
    expect(typesSrc).toMatch(/interface ProviderInfo/)
    expect(typesSrc).toMatch(/ProviderInfo[\s\S]*?name\s*:\s*string/)
    expect(typesSrc).toMatch(/ProviderInfo[\s\S]*?capabilities/)
  })

  test('availableProviders state exists in connection store', () => {
    expect(typesSrc).toMatch(/availableProviders\s*:\s*ProviderInfo\[\]/)
  })

  test('fetchProviders action exists in connection store', () => {
    expect(typesSrc).toMatch(/fetchProviders\s*:\s*\(\)\s*=>/)
  })

  test('message handler processes provider_list message', () => {
    expect(messageHandlerSrc).toMatch(/case\s+['"]provider_list['"]/)
  })

  test('list_providers is fetched on auth_ok', () => {
    expect(messageHandlerSrc).toMatch(/list_providers/)
  })

  test('ListProvidersSchema exists in ws-schemas', () => {
    expect(schemasSrc).toMatch(/ListProvidersSchema/)
  })

  test('list_providers handler exists in settings-handlers', () => {
    const settingsHandlersSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../..', 'packages/server/src/handlers/settings-handlers.js'),
      'utf-8'
    )
    expect(settingsHandlersSrc).toMatch(/list_providers/)
  })

  test('CreateSessionModal uses availableProviders from store', () => {
    expect(modalSrc).toMatch(/availableProviders/)
  })

  test('CreateSessionModal renders capability badges', () => {
    expect(modalSrc).toMatch(/capabilit/i)
  })

  test('capability badges are wrapped in a container with gap spacing', () => {
    expect(modalSrc).toMatch(/provider-capabilities/)
    expect(modalSrc).toMatch(/capability-badge/)
  })

  test('provider section wraps both select and badges', () => {
    expect(modalSrc).toMatch(/provider-section/)
  })

  test('ActiveSessionNode includes provider field', () => {
    expect(sidebarSrc).toMatch(/interface ActiveSessionNode[\s\S]*?provider\??\s*:\s*string/)
  })

  test('Sidebar displays provider badge on session items', () => {
    expect(sidebarSrc).toMatch(/provider/)
    expect(sidebarSrc).toMatch(/sidebar-provider|provider-badge/)
  })
})

// #5026: docker-byok provider-selector polish.
//
// PR #5021 added docker-byok server-side. The follow-up scope is purely the
// dashboard's provider selector — surface a human-readable label, explain
// the docker-byok vs. claude-byok trade-off, and visually distinguish
// containerized providers in the capability-badge row.
describe('docker-byok provider-selector polish (#5026)', () => {
  test('PROVIDER_BILLING has a docker-byok entry distinct from claude-byok', () => {
    // The two must NOT share the same billing copy — the whole point of
    // surfacing the polish is to explain the trade-off (sandboxed tools
    // vs. host-side tools, same ANTHROPIC_API_KEY).
    const billingMatch = modalSrc.match(/PROVIDER_BILLING[^}]*}/s)
    expect(billingMatch).toBeTruthy()
    const block = billingMatch![0]
    expect(block).toMatch(/['"]docker-byok['"]/)
    // Must mention BOTH "container" (the sandbox) and "ANTHROPIC_API_KEY"
    // (the billing identity) so the user can reason about the trade-off
    // without leaving the modal.
    const dockerByokLine = block.match(/['"]docker-byok['"]\s*:\s*['"][^'"]*['"]/)
    expect(dockerByokLine).toBeTruthy()
    expect(dockerByokLine![0]).toMatch(/container/i)
    expect(dockerByokLine![0]).toMatch(/ANTHROPIC_API_KEY/)
  })

  test('CAPABILITY_BADGES includes a Containerized entry', () => {
    // The badge row must surface `containerized` so docker-* providers
    // read as sandboxed at a glance. Without this, the badge row would
    // be identical to claude-byok's and the visual distinction collapses.
    // Match from `const CAPABILITY_BADGES` through the closing `]` of the
    // outer array — the inner `[]` for the tuple type makes a single
    // `[^\]]*` greedy stop too early.
    const badgesMatch = modalSrc.match(/const CAPABILITY_BADGES[\s\S]*?\n\]/)
    expect(badgesMatch).toBeTruthy()
    expect(badgesMatch![0]).toMatch(/['"]containerized['"]/)
    expect(badgesMatch![0]).toMatch(/['"]Containerized['"]/)
  })

  test('ProviderCapabilities type exposes the containerized field', () => {
    // The server-side ProviderClass.capabilities already returns
    // containerized for docker-*; the dashboard MUST expose it on the
    // shared interface so the badge filter and selector lookups are
    // type-safe (TS strict catches the typo if it isn't there).
    expect(typesSrc).toMatch(/interface ProviderCapabilities[\s\S]*?containerized\??\s*:\s*boolean/)
  })

  test('container settings hint surfaces when a containerized provider is selected', () => {
    // The polish issue's AC asks for "container image / memory / cpu /
    // containerUser knobs" to be surfaced. We route the user to the
    // Environments panel (the canonical settings surface) and explain
    // the defaults — both branches of the hint must reference the same
    // mental model.
    expect(modalSrc).toMatch(/provider-container-hint/)
    expect(modalSrc).toMatch(/containerized/)
    // Must mention the default image / memory / cpu so a user reading
    // the modal cold knows what they'll get without configuring.
    expect(modalSrc).toMatch(/node:22-slim/)
    expect(modalSrc).toMatch(/2g/i)
  })

  test('docker-byok appears in PROVIDER_LABELS', () => {
    // The selector renders `PROVIDER_LABELS[p.name] || p.name`; without
    // an entry the option would say "docker-byok" verbatim.
    const labelsSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../..', 'packages/store-core/src/provider-labels.ts'),
      'utf-8',
    )
    expect(labelsSrc).toMatch(/['"]docker-byok['"]/)
    // Must NOT regress to the generic external-provider fallback —
    // explicitly require the canonical metadata fields.
    expect(labelsSrc).toMatch(/['"]docker-byok['"][\s\S]*?label:\s*['"]Claude \(BYOK — Docker container\)['"]/)
  })
})
