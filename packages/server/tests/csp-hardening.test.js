import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('CSP hardening', () => {
  it('Tauri CSP does not allow unsafe-inline for script-src', () => {
    const tauriConf = JSON.parse(
      readFileSync(join(__dirname, '../../desktop/src-tauri/tauri.conf.json'), 'utf-8')
    )
    const csp = tauriConf.app.security.csp
    assert.ok(csp, 'CSP should be defined in tauri.conf.json')

    // Parse script-src directive
    const scriptSrc = csp.split(';').find(d => d.trim().startsWith('script-src'))
    assert.ok(scriptSrc, 'script-src directive should exist')
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), 'script-src must not contain unsafe-inline')
    assert.ok(!scriptSrc.includes("'unsafe-eval'"), 'script-src must not contain unsafe-eval in production CSP')
  })

  it('Tauri CSP includes hardening directives', () => {
    const tauriConf = JSON.parse(
      readFileSync(join(__dirname, '../../desktop/src-tauri/tauri.conf.json'), 'utf-8')
    )
    const csp = tauriConf.app.security.csp
    assert.ok(csp.includes("frame-src 'none'"), 'CSP should forbid frame-src')
    assert.ok(csp.includes("object-src 'none'"), 'CSP should forbid object-src')
    assert.ok(csp.includes("base-uri 'self'"), 'CSP should restrict base-uri')
  })

  it('Tauri devCsp allows unsafe-inline and unsafe-eval for Vite HMR', () => {
    const tauriConf = JSON.parse(
      readFileSync(join(__dirname, '../../desktop/src-tauri/tauri.conf.json'), 'utf-8')
    )
    const devCsp = tauriConf.app.security.devCsp
    assert.ok(devCsp, 'devCsp should be defined for development')
    const scriptSrc = devCsp.split(';').find(d => d.trim().startsWith('script-src'))
    assert.ok(scriptSrc.includes("'unsafe-inline'"), 'devCsp should allow unsafe-inline for Vite')
    assert.ok(scriptSrc.includes("'unsafe-eval'"), 'devCsp should allow unsafe-eval for Vite HMR')
  })

  it('server HTTP CSP does not allow unsafe-inline for script-src', () => {
    const httpRoutes = readFileSync(
      join(__dirname, '../src/http-routes.js'), 'utf-8'
    )
    // Find the CSP header string in source
    const cspMatch = httpRoutes.match(/Content-Security-Policy[^:]*:\s*"([^"]+)"/)
    assert.ok(cspMatch, 'CSP header should be defined in http-routes.js')
    const csp = cspMatch[1]

    const scriptSrc = csp.split(';').find(d => d.trim().startsWith('script-src'))
    assert.ok(scriptSrc, 'script-src directive should exist')
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), 'script-src must not contain unsafe-inline')
  })

  it('server config injection uses meta tag, not inline script', () => {
    const httpRoutes = readFileSync(
      join(__dirname, '../src/http-routes.js'), 'utf-8'
    )
    assert.ok(httpRoutes.includes('<meta name="chroxy-config"'), 'config should be injected via meta tag')
    assert.ok(!httpRoutes.includes('<script>window.__CHROXY_CONFIG__'), 'must not use inline script for config injection')
  })
})
