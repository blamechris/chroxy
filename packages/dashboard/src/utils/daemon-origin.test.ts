/** #8268 — "is this the daemon that served this page?" (jsdom's page is http://localhost:3000). */
import { describe, it, expect, afterEach } from 'vitest'
import { isOwnDaemonUrl, isLocalDaemonUrl } from './daemon-origin'

afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ })

describe('isOwnDaemonUrl', () => {
  it('matches the page origin over ws and wss', () => {
    expect(isOwnDaemonUrl('ws://localhost:3000/ws')).toBe(true)
    expect(isOwnDaemonUrl('wss://localhost:3000/ws')).toBe(true)
  })

  it('treats the loopback spellings as one host', () => {
    expect(isOwnDaemonUrl('ws://127.0.0.1:3000/ws')).toBe(true)
    expect(isOwnDaemonUrl('ws://[::1]:3000/ws')).toBe(true)
  })

  it('rejects another port or another host', () => {
    expect(isOwnDaemonUrl('ws://localhost:8765/ws')).toBe(false)
    expect(isOwnDaemonUrl('wss://other-host.example.com/ws')).toBe(false)
    expect(isOwnDaemonUrl('ws://192.168.1.20:3000/ws')).toBe(false)
  })

  it('rejects garbage', () => {
    expect(isOwnDaemonUrl('')).toBe(false)
    expect(isOwnDaemonUrl('not a url')).toBe(false)
  })
})

describe('isLocalDaemonUrl', () => {
  it('outside the desktop app it is exactly "same origin"', () => {
    expect(isLocalDaemonUrl('ws://localhost:3000/ws')).toBe(true)
    expect(isLocalDaemonUrl('ws://localhost:8765/ws')).toBe(false)
    expect(isLocalDaemonUrl('wss://other-host.example.com/ws')).toBe(false)
  })

  it('inside the desktop app any loopback daemon is the local one, a remote host still is not', () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    expect(isLocalDaemonUrl('ws://127.0.0.1:8765/ws')).toBe(true)
    expect(isLocalDaemonUrl('ws://localhost:8765/ws')).toBe(true)
    expect(isLocalDaemonUrl('wss://other-host.example.com/ws')).toBe(false)
    expect(isLocalDaemonUrl('ws://192.168.1.20:8765/ws')).toBe(false)
  })
})
