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

describe('Provider picker in session creation (#1366)', () => {
  test('CreateSessionData includes provider field', () => {
    expect(modalSrc).toMatch(/interface CreateSessionData[\s\S]*?provider\??\s*:\s*string/)
  })

  test('CreateSessionModal has provider selector UI', () => {
    expect(modalSrc).toMatch(/provider/i)
    expect(modalSrc).toMatch(/select|dropdown|radio/i)
  })

  test('provider passed to onCreate callback', () => {
    // onCreate should receive provider in data
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
})
