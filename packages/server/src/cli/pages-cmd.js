/**
 * chroxy publish / chroxy pages — publish HTML artifacts to a self-hosted,
 * unguessable URL served by the running daemon (Chroxy Pages, #5683).
 *
 *   chroxy publish report.html [--title "..."]   → prints the share URL
 *   chroxy pages list                            → list published pages
 *   chroxy pages rm <slug>                       → revoke a page
 *
 * All three talk to the LOCAL daemon over loopback with the primary token from
 * connection.json (the daemon owns the in-memory pages manifest, so publishing
 * must go through it — see the design doc). The shareable URL is built from the
 * daemon's public `httpUrl` (the tunnel/LAN base) so it opens on any device.
 */

import { basename } from 'path'

function portFromUrl(url) {
  if (typeof url !== 'string') return null
  const m = url.match(/:(\d+)(?:\/|$)/)
  return m ? parseInt(m[1], 10) : null
}

/** Strip a trailing slash so we can append a rooted path cleanly. */
function trimSlash(s) {
  return typeof s === 'string' ? s.replace(/\/+$/, '') : s
}

async function daemonRequest(method, path, deps, { body } = {}) {
  const readConnectionInfo =
    deps.readConnectionInfo || (await import('../connection-info.js')).readConnectionInfo
  const fetchFn = deps.fetchFn || globalThis.fetch
  const defaultPort = deps.defaultPort || 8765

  const info = readConnectionInfo()
  if (!info) return { ok: false, reason: 'not_running' }
  if (!info.apiToken) return { ok: false, reason: 'no_token' }
  const port = portFromUrl(info.httpUrl) || portFromUrl(info.wsUrl) || defaultPort

  const headers = { Authorization: `Bearer ${info.apiToken}`, Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    })
    let json = null
    try { json = await res.json() } catch { /* non-JSON */ }
    if (!res.ok) {
      return { ok: false, reason: 'http_error', status: res.status, message: json?.error || `HTTP ${res.status}` }
    }
    return { ok: true, json, publicBase: trimSlash(info.httpUrl) || null }
  } catch (err) {
    return { ok: false, reason: 'unavailable', message: err?.message || 'request failed' }
  }
}

function reportFailure(result, writeErr) {
  if (result.reason === 'not_running') {
    writeErr('Chroxy server is not running. Start it with `chroxy start`.')
  } else if (result.reason === 'no_token') {
    writeErr('Server is running without an auth token — publishing is unavailable.')
  } else {
    writeErr(`Request failed: ${result.message || result.reason}`)
  }
}

export async function runPublishCmd(filePath, options = {}, deps = {}) {
  const readFileFn = deps.readFile || (await import('fs')).readFileSync
  const write = deps.write || console.log
  const writeErr = deps.writeErr || console.error

  let html
  try {
    html = readFileFn(filePath, 'utf8')
  } catch (err) {
    writeErr(`Cannot read ${filePath}: ${err?.message || err}`)
    return { ok: false, reason: 'read_failed' }
  }
  const title = options.title || basename(filePath).replace(/\.[^.]+$/, '') || 'Untitled'

  const result = await daemonRequest('POST', '/api/pages', deps, { body: { title, html } })
  if (!result.ok) {
    if (options.json) write(JSON.stringify(result, null, 2))
    else reportFailure(result, writeErr)
    return result
  }
  const url = result.publicBase ? `${result.publicBase}${result.json.path}` : result.json.path
  const out = { ok: true, slug: result.json.slug, url, title: result.json.title }
  if (options.json) write(JSON.stringify(out, null, 2))
  else write(`Published "${out.title}" → ${url}`)
  return out
}

export async function runPagesListCmd(options = {}, deps = {}) {
  const write = deps.write || console.log
  const writeErr = deps.writeErr || console.error
  const result = await daemonRequest('GET', '/api/pages', deps)
  if (!result.ok) {
    if (options.json) write(JSON.stringify(result, null, 2))
    else reportFailure(result, writeErr)
    return result
  }
  const pages = (result.json?.pages || []).map((p) => ({
    ...p,
    url: result.publicBase ? `${result.publicBase}${p.path}` : p.path,
  }))
  if (options.json) {
    write(JSON.stringify({ ok: true, pages }, null, 2))
  } else if (pages.length === 0) {
    write('No published pages.')
  } else {
    for (const p of pages) write(`${p.slug}  ${p.title}\n  ${p.url}`)
  }
  return { ok: true, pages }
}

export async function runPagesRmCmd(slug, options = {}, deps = {}) {
  const write = deps.write || console.log
  const writeErr = deps.writeErr || console.error
  const result = await daemonRequest('DELETE', `/api/pages/${encodeURIComponent(slug)}`, deps)
  if (!result.ok) {
    if (options.json) write(JSON.stringify(result, null, 2))
    else reportFailure(result, writeErr)
    return result
  }
  const removed = result.json?.removed === true
  if (options.json) write(JSON.stringify({ ok: true, removed }, null, 2))
  else write(removed ? `Removed ${slug}` : `No page with slug ${slug}`)
  return { ok: true, removed }
}

export function registerPagesCommands(program) {
  program
    .command('publish <file>')
    .description('Publish an HTML file to an unguessable share URL served by the running daemon')
    .option('--title <title>', 'Title for the page (defaults to the filename)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (file, options) => {
      const result = await runPublishCmd(file, options)
      if (!result.ok) process.exitCode = 1
    })

  const pages = program.command('pages').description('Manage published Chroxy Pages')
  pages
    .command('list')
    .description('List published pages')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      const result = await runPagesListCmd(options)
      if (!result.ok) process.exitCode = 1
    })
  pages
    .command('rm <slug>')
    .description('Remove a published page (revokes its share link)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (slug, options) => {
      const result = await runPagesRmCmd(slug, options)
      if (!result.ok) process.exitCode = 1
    })
}
