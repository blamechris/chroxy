/**
 * Maps WebSocket close codes and error reasons to user-readable messages
 * with suggested actions.
 *
 * Close codes defined by Chroxy protocol:
 *   4001 — authentication failed
 *   4003 — session not found
 *   4004 — server client limit reached
 *
 * Standard WebSocket close codes used here:
 *   1006 — abnormal closure (no close frame received)
 *   1008 — policy violation
 */

export interface ConnectionErrorMessage {
  title: string
  suggestion: string
}

export function getConnectionErrorMessage(code?: number, reason?: string): ConnectionErrorMessage {
  switch (code) {
    case 4001:
      return { title: 'Authentication failed', suggestion: 'Check your token in Settings.' }
    case 4003:
      return { title: 'Session not found', suggestion: 'Create a new session.' }
    case 4004:
      return { title: 'Server limit reached', suggestion: 'Disconnect another client first.' }
    case 1006:
      if (reason?.includes('ETIMEDOUT') || reason?.includes('timeout')) {
        return { title: 'Connection timed out', suggestion: 'Check your network or tunnel URL.' }
      }
      if (reason?.includes('ECONNREFUSED')) {
        return { title: 'Server not reachable', suggestion: 'Check the server is running.' }
      }
      return { title: 'Connection lost', suggestion: 'Check that the server is running.' }
    case 1008:
      return { title: 'Connection refused', suggestion: 'Check your authentication token.' }
    default:
      if (reason?.includes('ETIMEDOUT') || reason?.includes('timeout')) {
        return { title: 'Connection timed out', suggestion: 'Check your network or tunnel URL.' }
      }
      if (reason?.includes('ECONNREFUSED')) {
        return { title: 'Server not reachable', suggestion: 'Check the server is running.' }
      }
      return { title: 'Connection failed', suggestion: 'Check your network and server status.' }
  }
}
