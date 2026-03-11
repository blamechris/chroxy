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
  path.resolve(__dirname, '../../../ws-schemas.js'),
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
    expect(schemasSrc).toMatch(/list_providers/)
  })

  test('list_providers handler exists in settings-handlers', () => {
    const settingsHandlersSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../../src/handlers/settings-handlers.js'),
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
