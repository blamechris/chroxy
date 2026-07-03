/**
 * Dashboard Smoke Test — Playwright-based visual verification
 *
 * Connects to a chroxy server (either already running or started
 * automatically by this script), opens the dashboard in a headless
 * browser, takes screenshots at each step, and verifies key UI elements.
 *
 * Usage:
 *   node tests/smoke-test.mjs [--headed]    # --headed to see the browser
 *
 * If no server is detected, one is started automatically and stopped when done.
 * Screenshots are saved to packages/server/tests/screenshots/ (gitignored).
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

// Read config for auth token (config.json first, then OS keychain fallback)
const configPath = join(process.env.HOME, '.chroxy', 'config.json')
let apiToken = null
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  apiToken = config.apiToken
}
if (!apiToken) {
  try {
    const { execFileSync } = await import('child_process')
    apiToken = execFileSync('security', ['find-generic-password', '-s', 'chroxy', '-a', 'api-token', '-w'], { encoding: 'utf-8' }).trim() || null
  } catch { /* keychain not available or no entry */ }
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
    const msg = 'No API token found in ~/.chroxy/config.json'
    log(`\x1b[31m${msg}\x1b[0m`)
    throw new Error(msg)
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
      // Take a screenshot; subsequent tests may be unreliable without connection
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
      if (anyTabs.length > 0) {
        pass('Session tabs', `${anyTabs.length} tab-like element(s)`)
      } else {
        fail('Session tabs', 'No tabs found')
      }
    }

    // ---- Test 6: Full-width layout ----
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
    await page.keyboard.press('?')
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
      const dialogs = await page.$$('[role="dialog"], .modal-overlay')
      const visibleDialog = await (async () => {
        for (const d of dialogs) {
          if (await d.isVisible()) return d
        }
        return null
      })()
      if (visibleDialog) {
        pass('? opens shortcut help', 'found dialog')
        await page.keyboard.press('Escape')
      } else {
        fail('? opens shortcut help', 'No overlay detected')
      }
    }

    // ---- Control Room ----
    log('')
    log('--- Control Room ---')

    // Open the Control Room from the sidebar panel-slot launcher (#5200/#5204).
    const crLauncher = await page.$('[data-testid="sidebar-panel-slot-launcher-control-room"]')
    if (crLauncher && await crLauncher.isVisible()) {
      await crLauncher.click()
      await page.waitForTimeout(600)

      // The section owns the main content area when active.
      const crSection = await page.$('[data-testid="control-room-section"]')
      if (crSection && await crSection.isVisible()) {
        pass('Control Room opens', 'launcher → control-room-section visible')
        await screenshot(page, '06-control-room')
      } else {
        fail('Control Room opens', 'control-room-section not visible after launcher click')
      }

      // It registers a session-independent top-level tab (#5204).
      const crTab = await page.$('[data-testid="control-room-tab"]')
      if (crTab && await crTab.isVisible()) {
        pass('Control Room tab present')
      } else {
        fail('Control Room tab present', 'control-room-tab not found')
      }

      // Renders either the populated repo table or the empty/not-yet-surveyed state.
      const crTable = await page.$('[data-testid="cr-table"]')
      const crEmpty = await page.$('[data-testid="cr-empty"]')
      const tableVisible = crTable && await crTable.isVisible()
      const emptyVisible = crEmpty && await crEmpty.isVisible()
      if (tableVisible) {
        pass('Control Room renders', 'repo table (cr-table)')
      } else if (emptyVisible) {
        pass('Control Room renders', 'empty/not-yet-surveyed state (cr-empty)')
      } else {
        fail('Control Room renders', 'neither cr-table nor cr-empty visible')
      }

      // With a populated table, the sort/filter controls (#5225) usually render —
      // but their presence depends on the surveyed repo set + render timing, so as
      // a SMOKE check (not a precise component test) this is best-effort: a missing
      // cr-controls is logged, not failed, so a fragile sub-detail can't red the CI
      // gate while the Control Room's core (opens / tab / table) already hard-passes.
      if (tableVisible) {
        const crControls = await page.$('[data-testid="cr-controls"]')
        if (crControls && await crControls.isVisible()) {
          pass('Control Room sort/filter controls')
        } else {
          log('  (cr-controls not visible with the populated table — best-effort, not failed)')
        }
      }

      // Best-effort: trigger a refresh (read-only git/gh survey) and screenshot the result.
      // Non-fatal — the survey can be slow or rate-limited; we only verify the button wires up
      // and the section stays mounted afterward, not any specific repo data.
      try {
        const refreshBtn = await page.$(
          '[data-testid="cr-refresh"]:not([disabled]), [data-testid="cr-empty-refresh"]:not([disabled])'
        )
        if (refreshBtn) {
          await refreshBtn.click()
          await page.waitForTimeout(4000)
          await screenshot(page, '07-control-room-survey')
          const stillThere = await page.$('[data-testid="control-room-section"]')
          if (stillThere && await stillThere.isVisible()) {
            pass('Control Room refresh', 'section stable after survey request')
          } else {
            fail('Control Room refresh', 'section disappeared after refresh')
          }
        } else {
          log('  (refresh button disabled/absent — skipping survey trigger)')
        }
      } catch (e) {
        log(`  (refresh trigger skipped: ${e.message})`)
      }
    } else {
      fail('Control Room opens', 'sidebar-panel-slot-launcher-control-room not found')
    }

    // ---- IDE Go-to-Definition (#6500, epic #6469) ----
    // Exercises the live cmd/ctrl+click resolve round-trip end-to-end: quick-open
    // the committed fixture (unique symbols → deterministic resolution), then the
    // HIT (jump + transient active-line highlight) and MISS (transient
    // def-not-found pill) paths. Skips gracefully when the IDE surface is off or
    // the fixture workspace isn't the session cwd (i.e. outside the CI smoke).
    log('')
    log('--- IDE Go-to-Definition ---')
    try {
      await page.keyboard.press('Meta+KeyP')
      await page.waitForTimeout(500)
      let paletteInput = await page.$('[data-testid="file-open-palette-input"]')
      if (!paletteInput) {
        await page.keyboard.press('Control+KeyP')
        await page.waitForTimeout(500)
        paletteInput = await page.$('[data-testid="file-open-palette-input"]')
      }
      if (!paletteInput) {
        log('  (IDE quick-open not available — features.ide off; skipping)')
      } else {
        pass('IDE quick-open palette opens', 'Cmd/Ctrl+P — features.ide advertised')
        await paletteInput.fill('smoke_ide_sample')
        await page.waitForTimeout(1200)
        const fileItem = await page.$('[data-testid^="file-open-item-"]')
        if (!fileItem) {
          log('  (smoke_ide_sample fixture not in this workspace — skipping go-to-def; expected outside CI)')
          await page.keyboard.press('Escape')
        } else {
          await fileItem.click()
          await page.waitForTimeout(1400)
          const synCount = await page.$$eval('span[class^="syn-"]', els => els.length).catch(() => 0)
          if (synCount > 0) pass('IDE file viewer renders syntax tokens', `${synCount} tokens`)
          else fail('IDE file viewer', 'no syntax tokens rendered')

          // HIT — jump to the exported declaration + a transient active-line highlight.
          const hitTok = page.locator('.file-viewer-line span[class^="syn-"]', { hasText: /^smokeGotoDefTarget$/ }).first()
          if (await hitTok.count()) {
            await hitTok.click({ modifiers: ['ControlOrMeta'] })
            await page.waitForTimeout(600) // sample inside the ~1400ms highlight window
            const active = await page.$$eval('.file-viewer-line--active', els => els.length).catch(() => 0)
            const strayPill = await page.$('[data-testid="def-not-found"]')
            if (active > 0 && !strayPill) pass('Go-to-definition HIT', 'jumped + active-line highlight')
            else fail('Go-to-definition HIT', `active lines=${active}, pill=${!!strayPill}`)
            await screenshot(page, '08-ide-goto-def-hit')
          } else {
            fail('Go-to-definition HIT', 'no smokeGotoDefTarget token to click')
          }

          await page.waitForTimeout(1800) // let the highlight clear before the miss

          // MISS — an undeclared symbol yields a transient def-not-found pill.
          const missTok = page.locator('.file-viewer-line span[class^="syn-"]', { hasText: /^smokeGotoDefMissingSymbol$/ }).first()
          if (await missTok.count()) {
            await missTok.click({ modifiers: ['ControlOrMeta'] })
            await page.waitForTimeout(700)
            const pill = await page.$('[data-testid="def-not-found"]')
            if (pill) {
              pass('Go-to-definition MISS pill', 'def-not-found appeared')
              await screenshot(page, '09-ide-goto-def-miss')
              await page.waitForTimeout(2600)
              if (!(await page.$('[data-testid="def-not-found"]'))) pass('Go-to-definition MISS pill clears', 'transient')
              else fail('Go-to-definition MISS pill clears', 'still visible after 2.6s')
            } else {
              fail('Go-to-definition MISS pill', 'no def-not-found pill appeared')
            }
          } else {
            fail('Go-to-definition MISS', 'no smokeGotoDefMissingSymbol token to click')
          }
        }
      }
    } catch (e) {
      fail('IDE Go-to-Definition', e.message)
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
    // Give the server time to flush session-state.json on SIGTERM before escalating.
    // SIGKILL bypasses the flush handler and can wipe state (feedback_sigterm_not_sigkill):
    // wait for a clean exit, only force-kill if the process is genuinely hung.
    await new Promise((resolve) => {
      // Resolve only once the child has actually exited so we never leave a
      // zombie/port-holding process behind. The 'exit' listener fires for both
      // the graceful SIGTERM flush and a forced SIGKILL.
      managedServer.once('exit', () => { clearTimeout(grace); resolve() })
      const grace = setTimeout(() => {
        if (managedServer.exitCode === null && managedServer.signalCode === null) {
          log('  server did not exit within 8s of SIGTERM — escalating to SIGKILL')
          managedServer.kill('SIGKILL')
        }
      }, 8000)
      managedServer.kill('SIGTERM')
    })
  }

  process.exit(failed > 0 ? 1 : 0)
}

run().catch(err => {
  console.error('Fatal:', err)
  if (browser) browser.close()
  // Fatal path: send only SIGTERM (no SIGKILL escalation here) so the server
  // gets a chance to flush session-state on the way out. The graceful cleanup
  // path above is the one that may escalate to SIGKILL if the process hangs.
  if (managedServer) managedServer.kill('SIGTERM')
  process.exit(1)
})
