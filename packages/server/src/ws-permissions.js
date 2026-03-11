// -- Permission TTL --
const PERMISSION_TTL_MS = 300_000 // 5 minutes

// -- Broadcast safety --
const MAX_INPUT_BYTES = 10_240 // 10KB max for broadcast
const SENSITIVE_KEYS = new Set(['token', 'password', 'apikey', 'secret', 'authorization', 'credential', 'private_key', 'api_key'])

/**
 * Sanitize tool input for broadcast: redact sensitive fields and truncate large values.
 */
function sanitizeToolInput(input) {
  if (!input || typeof input !== 'object') return input

  const result = {}
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]'
    } else if (typeof value === 'string' && value.length > MAX_INPUT_BYTES) {
      result[key] = value.slice(0, MAX_INPUT_BYTES) + '... [truncated]'
    } else {
      result[key] = value
    }
  }

  // Final size check on the whole object
  const serialized = JSON.stringify(result)
  if (serialized.length > MAX_INPUT_BYTES) {
    return { _truncated: true, summary: serialized.slice(0, MAX_INPUT_BYTES) + '... [truncated]' }
  }
  return result
}

/**
 * Create a permission handler for the WsServer.
 * Manages HTTP permission lifecycle (hook requests, responses, resend, resolve).
 *
 * @param {Object} opts
 * @param {Function} opts.sendFn - (ws, message) => void
 * @param {Function} opts.broadcastFn - (message) => void
 * @param {Function} opts.validateBearerAuth - (req, res) => boolean
 * @param {Object|null} opts.pushManager - PushManager instance (nullable)
 * @param {Map} opts.pendingPermissions - requestId -> { resolve, timer } (owned by WsServer)
 * @param {Map} opts.permissionSessionMap - requestId -> sessionId (owned by WsServer)
 * @param {Function} opts.getSessionManager - () => sessionManager (late-bound for test compat)
 * @returns {Object} Permission handler methods
 */
export function createPermissionHandler({ sendFn, broadcastFn, validateBearerAuth, pushManager, pendingPermissions, permissionSessionMap, getSessionManager }) {
  let _permissionCounter = 0

  /** Handle POST /permission from the hook script */
  function handlePermissionRequest(req, res) {
    if (!validateBearerAuth(req, res)) {
      console.warn('[ws] Rejected unauthenticated POST /permission')
      return
    }

    const MAX_BODY = 65536
    let body = ''
    let oversized = false
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) {
        oversized = true
        req.destroy()
      }
    })
    req.on('end', () => {
      if (oversized) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ decision: 'deny' }))
        return
      }

      let hookData
      try {
        hookData = JSON.parse(body)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ decision: 'deny' }))
        return
      }

      const requestId = `perm-${++_permissionCounter}-${Date.now()}`

      console.log(`[ws] Permission request ${requestId}: ${hookData.tool_name || 'unknown tool'}`)

      const tool = hookData.tool_name || 'Unknown tool'
      const toolInput = hookData.tool_input || {}
      const sanitizedInput = sanitizeToolInput(toolInput)
      const description = toolInput.description
        || toolInput.command
        || toolInput.file_path
        || toolInput.pattern
        || toolInput.query
        || JSON.stringify(toolInput).slice(0, 200)

      broadcastFn({
        type: 'permission_request',
        requestId,
        tool,
        description,
        input: sanitizedInput,
        remainingMs: 300_000,
      })

      if (pushManager) {
        pushManager.send('permission', 'Permission needed', `Claude wants to use: ${tool}`, { requestId, tool }, 'permission')
      }

      let closed = false

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        pendingPermissions.delete(requestId)
        permissionSessionMap.delete(requestId)
      }

      const onClose = () => {
        if (closed) return
        closed = true
        console.log(`[ws] Permission ${requestId} connection closed by client`)
        cleanup()
      }

      req.on('aborted', onClose)
      res.on('close', onClose)

      const timer = setTimeout(() => {
        if (closed) return
        closed = true
        console.log(`[ws] Permission ${requestId} timed out, auto-denying`)
        cleanup()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ decision: 'deny' }))
      }, 300_000)

      pendingPermissions.set(requestId, {
        resolve: (decision) => {
          if (closed) return
          closed = true
          cleanup()
          console.log(`[ws] Permission ${requestId} resolved: ${decision}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ decision }))
        },
        timer,
        data: { requestId, tool, description, input: sanitizedInput, remainingMs: 300_000, createdAt: Date.now() },
      })
    })
  }

  /** Handle POST /permission-response from iOS notification actions (HTTP fallback) */
  function handlePermissionResponseHttp(req, res) {
    if (!validateBearerAuth(req, res)) {
      console.warn('[ws] Rejected unauthenticated POST /permission-response')
      return
    }

    const MAX_BODY = 4096
    let body = ''
    let oversized = false
    req.on('data', (chunk) => {
      if (oversized) return
      body += chunk
      if (body.length > MAX_BODY) {
        oversized = true
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'body too large' }))
      }
    })
    req.on('end', () => {
      if (oversized) return

      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid JSON' }))
        return
      }

      const { requestId, decision } = parsed
      if (!requestId || typeof requestId !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'missing requestId' }))
        return
      }

      const validDecisions = ['allow', 'deny', 'allowAlways']
      if (!validDecisions.includes(decision)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `invalid decision, must be one of: ${validDecisions.join(', ')}` }))
        return
      }

      // Try SDK-mode first (in-process permission via sessionManager)
      const originSessionId = permissionSessionMap.get(requestId)
      const sm = getSessionManager()
      if (originSessionId && sm) {
        const entry = sm.getSession(originSessionId)
        if (entry && typeof entry.session.respondToPermission === 'function') {
          permissionSessionMap.delete(requestId)
          entry.session.respondToPermission(requestId, decision)
          console.log(`[ws] Permission ${requestId} resolved via HTTP: ${decision} (SDK)`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          return
        }
      }

      // Fall back to legacy HTTP-held permission
      const pending = pendingPermissions.get(requestId)
      if (pending) {
        permissionSessionMap.delete(requestId)
        resolvePermission(requestId, decision)
        console.log(`[ws] Permission ${requestId} resolved via HTTP: ${decision} (legacy)`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unknown or expired requestId' }))
      }
    })
  }

  /** Re-send any pending permission requests to a newly connected/reconnected client */
  function resendPendingPermissions(ws) {
    // SDK-mode: check all sessions for pending permissions
    const sm = getSessionManager()
    if (sm?._sessions instanceof Map) {
      for (const [sessionId, entry] of sm._sessions) {
        if (entry.session?._pendingPermissions instanceof Map) {
          for (const [requestId] of entry.session._pendingPermissions) {
            const permData = entry.session._lastPermissionData?.get(requestId)
            if (permData) {
              const elapsed = Math.max(0, Date.now() - (permData.createdAt ?? Date.now()))
              const ttl = permData.remainingMs ?? PERMISSION_TTL_MS
              const remainingMs = Math.min(ttl, Math.max(0, ttl - elapsed))
              if (remainingMs <= 0) {
                console.log(`[ws] Skipping expired permission ${requestId}`)
                continue
              }
              console.log(`[ws] Re-sending pending permission ${requestId} to reconnected client (${Math.round(remainingMs / 1000)}s remaining)`)
              permissionSessionMap.set(requestId, sessionId)
              const { createdAt: _ca, remainingMs: _origMs, ...clientPayload } = permData
              sendFn(ws, { type: 'permission_request', ...clientPayload, remainingMs, sessionId })
            }
          }
        }
      }
    }

    // Legacy HTTP-held permissions
    for (const [requestId, pending] of pendingPermissions) {
      if (pending.data) {
        const elapsed = Math.max(0, Date.now() - (pending.data.createdAt ?? Date.now()))
        const ttl = pending.data.remainingMs ?? PERMISSION_TTL_MS
        const remainingMs = Math.min(ttl, Math.max(0, ttl - elapsed))
        if (remainingMs <= 0) {
          console.log(`[ws] Skipping expired legacy permission ${requestId}`)
          continue
        }
        console.log(`[ws] Re-sending pending legacy permission ${requestId} to reconnected client (${Math.round(remainingMs / 1000)}s remaining)`)
        const { createdAt: _ca, remainingMs: _origMs, ...clientPayload } = pending.data
        sendFn(ws, { type: 'permission_request', ...clientPayload, remainingMs })
      }
    }
  }

  /** Resolve a pending permission request */
  function resolvePermission(requestId, decision) {
    const pending = pendingPermissions.get(requestId)
    if (pending) {
      pending.resolve(decision)
    } else {
      console.warn(`[ws] No pending permission for ${requestId}`)
    }
  }

  /** Clean up: auto-deny all pending permissions */
  function destroy() {
    for (const [, pending] of pendingPermissions) {
      clearTimeout(pending.timer)
      try { pending.resolve('deny') } catch {}
    }
    pendingPermissions.clear()
    permissionSessionMap.clear()
  }

  return {
    handlePermissionRequest,
    handlePermissionResponseHttp,
    resendPendingPermissions,
    resolvePermission,
    destroy,
  }
}

// Exported for testing
export { sanitizeToolInput }
