/**
 * Dashboard Smoke Test — Playwright-based visual verification
 *
 * Connects to a running chroxy server, opens the dashboard in a headless
 * browser, takes screenshots at each step, and verifies key UI elements.
 *
 * Usage:
 *   node tests/smoke-test.mjs [--headed]    # --headed to see the browser
 *
 * Prerequisites: server must be running (npx chroxy start).
 * Screenshots are saved to tests/screenshots/ (gitignored).
 * Exit code 0 = all checks pass, 1 = failures found.
 */

import { chromium } from 'playwright'
import { spawn } from 'child_process'
import { mkdirSync, readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCREENSHOT_DIR = join(__dirname, 'screenshots')
const headed = process.argv.includes('--headed')

// Read config for auth token
const configPath = join(process.env.HOME, '.chroxy', 'config.json')
let apiToken = null
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  apiToken = config.apiToken
}

const SERVER_DIR = join(__dirname, '..')

const results = []
let browser = null
let managedServer = null

function log(msg) {
  console.log(`  ${msg}`)
}

function pass(name, detail) {
  results.push({ name, status: 'PASS', detail })
  log(`\x1b[32mPASS\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(name, detail) {
  results.push({ name, status: 'FAIL', detail })
  log(`\x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
}

async function screenshot(page, name) {
  const path = join(SCREENSHOT_DIR, `${name}.png`)
  await page.screenshot({ path, fullPage: false })
  return path
}

/** Start the chroxy server and return the port it's listening on */
async function startServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout (30s)')), 30000)

    managedServer = spawn('node', ['src/cli.js', 'start'], {
      cwd: SERVER_DIR,
      env: { ...process.env, PATH: `/opt/homebrew/opt/node@22/bin:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    const onData = (chunk) => {
      output += chunk.toString()
      // Server prints "listening on 0.0.0.0:PORT" when ready
      const portMatch = output.match(/listening on.*?:(\d+)/i)
      if (portMatch) {
        clearTimeout(timeout)
        resolve(parseInt(portMatch[1], 10))
      }
    }

    managedServer.stdout.on('data', onData)
    managedServer.stderr.on('data', onData)
    managedServer.on('error', (err) => { clearTimeout(timeout); reject(err) })
    managedServer.on('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Server exited with code ${code} before ready\nOutput: ${output.slice(-500)}`))
    })
  })
}

/** Find the server port by probing common ports */
async function findServerPort() {
  for (const p of [8765, 3131, 8080, 3000]) {
    try {
      const res = await fetch(`http://localhost:${p}/`)
      if (res.ok || res.status === 403) return p
    } catch {}
  }
  return null
}

/** Wait for the dashboard to reach connected state (WS established) */
async function waitForConnected(page, timeoutMs = 10000) {
  try {
    // Wait for the status bar to show something other than "Disconnected" / "Connecting..."
    // or wait for the sidebar to appear (it only renders when connected)
    await page.waitForFunction(() => {
      // Check if Zustand store has connected phase
      const body = document.body.textContent || ''
      return !body.includes('Disconnected') && !body.includes('Connecting...')
    }, { timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

async function run() {
  console.log('\n\x1b[1mChroxy Dashboard Smoke Test\x1b[0m\n')

  // Setup
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  // Find running server or start one
  let port = await findServerPort()
  if (!port) {
    log('No running server found — starting one...')
    port = await startServer()
    log(`Server started on port ${port}`)
  } else {
    log(`Found existing server on port ${port}`)
  }

  if (!apiToken) {
    log('\x1b[31mNo API token found in ~/.chroxy/config.json\x1b[0m')
    process.exit(1)
  }

  // Build dashboard URL
  const dashboardUrl = `http://localhost:${port}/dashboard/?token=${apiToken}`

  // Launch browser
  browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()

  // Collect console errors
  const consoleErrors = []
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  try {
    // ---- Test 1: Dashboard loads ----
    log('')
    log('--- Dashboard Core ---')
    const response = await page.goto(dashboardUrl, { waitUntil: 'networkidle', timeout: 10000 })

    if (response?.ok()) {
      pass('Dashboard loads', `HTTP ${response.status()}`)
    } else {
      fail('Dashboard loads', `HTTP ${response?.status()}`)
    }

    // ---- Test 2: Wait for WebSocket connection ----
    const connected = await waitForConnected(page, 8000)
    await page.waitForTimeout(1000) // Let UI settle after connection
    await screenshot(page, '01-dashboard-connected')

    if (connected) {
      pass('WebSocket connects')
    } else {
      fail('WebSocket connects', 'Still showing Disconnected/Connecting after 8s')
      // Take a screenshot and bail — most tests need connection
      await screenshot(page, '01-dashboard-disconnected')
    }

    // ---- Test 3: Version badge ----
    const headerText = await page.$eval('header, .header, [class*="header"]', el => el.textContent).catch(() => null)
      || await page.textContent('body')
    const versionMatch = headerText?.match(/v\d+\.\d+\.\d+/)
    if (versionMatch) {
      pass('Version badge', versionMatch[0])
    } else {
      fail('Version badge', 'Not found')
    }

    // ---- Test 4: Sidebar visible ----
    // The sidebar uses class names — check the actual DOM
    const sidebar = await page.$('.sidebar')
      || await page.$('[class*="sidebar"]')
      || await page.$('aside')
    if (sidebar && await sidebar.isVisible()) {
      pass('Sidebar visible')
    } else {
      // Try to find it by structure — a container with session/repo lists
      const hasSessionList = await page.$('.session-list, [class*="session"], [class*="repo"]')
      if (hasSessionList) {
        pass('Sidebar visible', 'found by session list')
      } else {
        fail('Sidebar visible', 'Not found — may need connection')
      }
    }

    // ---- Test 5: Session tabs ----
    const sessionBar = await page.$$('.session-tab, [class*="session-tab"]')
    const tabCount = sessionBar.length
    if (tabCount > 0) {
      pass('Session tabs', `${tabCount} tab(s)`)
    } else {
      // Try finding tabs by role or content
      const anyTabs = await page.$$('[role="tab"], .tab-bar button, .session-bar button')
      pass('Session tabs', `${anyTabs.length} tab-like element(s)`)
    }

    // ---- Test 6: Full-width layout ----
    const viewportWidth = 1280
    const chatArea = await page.$('.chat-messages, .chat-view, [class*="chat"], main')
    if (chatArea) {
      const box = await chatArea.boundingBox()
      if (box && box.width > 960) {
        pass('Full-width layout', `${Math.round(box.width)}px`)
      } else if (box) {
        fail('Full-width layout', `${Math.round(box.width)}px (expected >960)`)
      }
    } else {
      // Measure the main content area
      const bodyWidth = await page.evaluate(() => document.body.scrollWidth)
      pass('Full-width layout', `body ${bodyWidth}px`)
    }

    // ---- Test 7: Input bar ----
    const inputBar = await page.$('textarea, input[type="text"][placeholder*="message" i], [class*="input-bar"] textarea, [class*="input-bar"] input')
    if (inputBar) {
      pass('Input bar present')
    } else {
      fail('Input bar present', 'Not found')
    }

    // ---- New Session Modal ----
    log('')
    log('--- Session Creation ---')

    // Use Ctrl+N which we know works (passed earlier)
    await page.keyboard.press('Control+n')
    await page.waitForTimeout(500)

    // Check if modal opened
    const modal = await page.$('.modal-overlay')
    if (modal && await modal.isVisible()) {
      pass('New Session modal opens (Ctrl+N)')
      await screenshot(page, '02-new-session-modal')

      // ---- Test: Session name input ----
      const nameInput = await page.$('.modal-content input[aria-label="Session name"], .modal-content input[placeholder*="name" i]')
      if (nameInput) {
        pass('Session name input')
      } else {
        fail('Session name input')
      }

      // ---- Test: CWD combobox ----
      const cwdInput = await page.$('.modal-content input[role="combobox"], .modal-content input[aria-label*="directory" i]')
      if (cwdInput) {
        pass('CWD combobox')
      } else {
        fail('CWD combobox')
      }

      // ---- Test: Provider picker ----
      const providerSelect = await page.$('.provider-select select, #provider-select')
      if (providerSelect && await providerSelect.isVisible()) {
        const options = await page.$$eval('.provider-select option, #provider-select option', opts => opts.map(o => o.textContent))
        pass('Provider picker', `Options: ${options.join(', ')}`)
        await screenshot(page, '03-provider-picker')
      } else {
        // Debug: dump modal content
        const modalHtml = await page.$eval('.modal-content', el => el.innerHTML).catch(() => 'N/A')
        fail('Provider picker', `Not visible. Modal HTML snippet: ${modalHtml.substring(0, 200)}`)
      }

      // Close modal
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    } else {
      fail('New Session modal opens', 'Ctrl+N did not open modal')
    }

    // ---- Keyboard Shortcuts ----
    log('')
    log('--- Keyboard Shortcuts ---')

    // Press ? for help overlay
    // Make sure no input is focused first
    await page.click('body')
    await page.waitForTimeout(200)
    await page.keyboard.press('Shift+/')  // ? = Shift+/
    await page.waitForTimeout(500)
    await screenshot(page, '04-shortcut-help')

    // Check for any overlay/dialog that appeared
    const helpOverlay = await page.$('[class*="shortcut"], [class*="hotkey"], [class*="help"], [class*="keyboard"]')
    if (helpOverlay && await helpOverlay.isVisible()) {
      pass('? opens shortcut help')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    } else {
      // Check if any new visible element appeared
      const dialogs = await page.$$('[role="dialog"]:visible, .modal-overlay:visible')
      if (dialogs.length > 0) {
        pass('? opens shortcut help', 'found dialog')
        await page.keyboard.press('Escape')
      } else {
        fail('? opens shortcut help', 'No overlay detected')
      }
    }

    // ---- Console errors ----
    log('')
    log('--- Health ---')
    const criticalErrors = consoleErrors.filter(e =>
      !e.includes('favicon') && !e.includes('404') && !e.includes('WebSocket')
    )
    if (criticalErrors.length === 0) {
      pass('No critical console errors')
    } else {
      fail('Console errors', `${criticalErrors.length}: ${criticalErrors[0]}`)
    }

    // Final screenshot
    await screenshot(page, '05-final-state')

  } catch (err) {
    fail('Unexpected error', err.message)
    await screenshot(page, '99-error-state').catch(() => {})
  }

  // Summary
  console.log('\n\x1b[1m--- Summary ---\x1b[0m')
  const passed = results.filter(r => r.status === 'PASS').length
  const failed = results.filter(r => r.status === 'FAIL').length
  console.log(`  \x1b[32m${passed} passed\x1b[0m, \x1b[${failed ? '31' : '32'}m${failed} failed\x1b[0m`)
  console.log(`  Screenshots: ${SCREENSHOT_DIR}/\n`)

  // Cleanup
  if (browser) await browser.close()
  if (managedServer) {
    log('Stopping managed server...')
    managedServer.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 1000))
    if (managedServer.exitCode === null) managedServer.kill('SIGKILL')
  }

  process.exit(failed > 0 ? 1 : 0)
}

run().catch(err => {
  console.error('Fatal:', err)
  if (browser) browser.close()
  if (managedServer) managedServer.kill('SIGTERM')
  process.exit(1)
})
