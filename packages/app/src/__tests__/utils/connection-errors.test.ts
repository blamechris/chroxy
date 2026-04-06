import { getConnectionErrorMessage } from '../../utils/connection-errors'

describe('getConnectionErrorMessage', () => {
  describe('Chroxy protocol close codes', () => {
    it('returns auth failed message for code 4001', () => {
      const msg = getConnectionErrorMessage(4001)
      expect(msg.title).toBe('Authentication failed')
      expect(msg.suggestion).toContain('token')
    })

    it('returns session not found message for code 4003', () => {
      const msg = getConnectionErrorMessage(4003)
      expect(msg.title).toBe('Session not found')
      expect(msg.suggestion).toBeDefined()
    })

    it('returns server limit message for code 4004', () => {
      const msg = getConnectionErrorMessage(4004)
      expect(msg.title).toBe('Server limit reached')
      expect(msg.suggestion).toBeDefined()
    })
  })

  describe('standard WebSocket close codes', () => {
    it('returns connection lost message for code 1006 with no reason', () => {
      const msg = getConnectionErrorMessage(1006)
      expect(msg.title).toBe('Connection lost')
      expect(msg.suggestion).toBeDefined()
    })

    it('returns timeout message when code 1006 and reason includes ETIMEDOUT', () => {
      const msg = getConnectionErrorMessage(1006, 'ETIMEDOUT')
      expect(msg.title).toContain('timed out')
    })

    it('returns server not reachable for code 1006 with ECONNREFUSED reason', () => {
      const msg = getConnectionErrorMessage(1006, 'ECONNREFUSED')
      expect(msg.title).toBe('Server not reachable')
    })

    it('returns connection refused message for code 1008', () => {
      const msg = getConnectionErrorMessage(1008)
      expect(msg.title).toBe('Connection refused')
      expect(msg.suggestion).toContain('token')
    })
  })

  describe('reason-based fallback matching', () => {
    it('returns timeout message when reason includes ETIMEDOUT', () => {
      const msg = getConnectionErrorMessage(undefined, 'ETIMEDOUT')
      expect(msg.title).toContain('timed out')
    })

    it('returns timeout message when reason includes timeout', () => {
      const msg = getConnectionErrorMessage(undefined, 'connection timeout')
      expect(msg.title).toContain('timed out')
    })

    it('returns server not reachable when reason includes ECONNREFUSED', () => {
      const msg = getConnectionErrorMessage(undefined, 'ECONNREFUSED 127.0.0.1:8765')
      expect(msg.title).toBe('Server not reachable')
    })
  })

  describe('unknown / generic cases', () => {
    it('returns generic message for unknown code', () => {
      const msg = getConnectionErrorMessage(9999)
      expect(msg.title).toBeDefined()
      expect(msg.suggestion).toBeDefined()
    })

    it('returns generic message when no code or reason provided', () => {
      const msg = getConnectionErrorMessage()
      expect(msg.title).toBe('Connection failed')
      expect(msg.suggestion).toBeDefined()
    })

    it('returns generic message when code is undefined and reason is unrecognised', () => {
      const msg = getConnectionErrorMessage(undefined, 'some weird error')
      expect(msg.title).toBe('Connection failed')
    })
  })
})
