/* Served only by the isolated native-notification smoke fixture. */
;(async () => {
  const status = document.getElementById('status')
  const token = new URL(location.href).searchParams.get('token')
  history.replaceState(null, '', '/dashboard')
  const request = async (path, body) => {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error('fixture request rejected')
    return response.json()
  }
  const boundedInvoke = async (invoke, command, args) => {
    let timeout
    try {
      return await Promise.race([
        invoke(command, args),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('native IPC timed out')), 5000) }),
      ])
    } finally { clearTimeout(timeout) }
  }
  const fail = async reason => {
    status.textContent = `FAILED: ${reason}`
    await request('/smoke/fail', { reason }).catch(() => {})
  }
  try {
    const invoke = window.__TAURI_INTERNALS__?.invoke
    if (typeof invoke !== 'function') return await fail('missing native bridge')
    // A callable bridge alone is not readiness: verify native IPC works first.
    await boundedInvoke(invoke, 'get_server_info')
    await request('/smoke/ready', {})
    status.textContent = 'READY: waiting for explicit arm'
    for (;;) {
      const state = await request('/smoke/claim', {})
      if (state.claim) {
        status.textContent = 'INVOKING: one native notification'
        try {
          const result = await boundedInvoke(invoke, 'send_session_notification', {
            title: 'Chroxy isolated smoke',
            body: 'Native notification delivery check',
          })
          await request('/smoke/receipt', { nativeRoute: result === true })
          status.textContent = result === true
            ? 'SUBMITTED: native route acknowledged; OS card observation still required'
            : 'FAILED: native route not confirmed'
        } catch {
          await fail('native notification rejected or timed out')
        }
        return
      }
      if (state.state !== 'READY' && state.state !== 'ARMED') {
        status.textContent = `${state.state}: no notification replay`
        return
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  } catch {
    await fail('native probe or fixture request failed')
  }
})()
