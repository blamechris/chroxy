/**
 * Extension message handler.
 *
 * Handles: extension_message
 *
 * Forwards provider-specific payloads to the active session without
 * bloating the core protocol. The session is responsible for
 * interpreting the provider + subtype combination.
 */

function handleExtensionMessage(ws, client, msg, ctx) {
  const { provider, subtype, data } = msg
  if (typeof provider !== 'string' || !provider) {
    ctx.send(ws, { type: 'session_error', message: 'extension_message requires a non-empty provider field' })
    return
  }
  if (typeof subtype !== 'string' || !subtype) {
    ctx.send(ws, { type: 'session_error', message: 'extension_message requires a non-empty subtype field' })
    return
  }

  const targetSessionId = msg.sessionId || client.activeSessionId
  const entry = ctx.sessionManager.getSession(targetSessionId)
  if (!entry) {
    const message = msg.sessionId
      ? `Session not found: ${msg.sessionId}`
      : 'No active session'
    ctx.send(ws, { type: 'session_error', message })
    return
  }

  if (typeof entry.session.handleExtensionMessage === 'function') {
    entry.session.handleExtensionMessage({ provider, subtype, data })
  } else {
    console.log(`[ws] extension_message (${provider}/${subtype}) received; session does not handle it`)
  }
}

export const extensionHandlers = {
  extension_message: handleExtensionMessage,
}
