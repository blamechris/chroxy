/**
 * Shared protocol and message types used by both the mobile app and web dashboard.
 *
 * These types represent the wire protocol between the Chroxy server and its clients.
 * Platform-specific types (SessionState, ConnectionState) remain in each consumer.
 *
 * Split into domain files (#6201 Tier-3, barrel re-export) — this index re-exports
 * the full surface so every `from './types'` / `from '../types'` import is unchanged.
 */
export * from './chat'
export * from './session'
export * from './model'
export * from './connection'
export * from './settings'
export * from './server-signals'
export * from './git'
export * from './conversation'
