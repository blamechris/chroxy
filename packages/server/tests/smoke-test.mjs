/**
 * Dashboard Smoke Test — Playwright-based visual verification
 *
 * Connects to a chroxy server YOU NAME, opens the dashboard in a headless
 * browser, takes screenshots at each step, and verifies key UI elements.
 *
 * Usage:
 *   node tests/smoke-test.mjs --port 9123 --token <t> [--headed]
 *   node tests/smoke-test.mjs --url http://127.0.0.1:9123 --token <t>
 *   node tests/smoke-test.mjs --preview <preview.json> [--headed]
 *
 * There is no default target (#8225). The script used to probe 8765/3131/8080/3000,
 * read the token from ~/.chroxy and start `chroxy start` with the real config, which
 * on a dev machine meant the production daemon. It now refuses port 8765 and a
 * ~/.chroxy config dir unless --i-mean-production is passed, and exits 2 with usage
 * when no target is given. The resolution lives in tests/helpers/smoke-target.mjs.
 * Screenshots are saved to packages/server/tests/screenshots/ (gitignored).
 * Exit code 0 = all checks pass, 1 = failures found, 2 = usage error, 3 = refused.
 */

import { mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import { harnessVerdict, SMOKE_MIN_CASES } from './helpers/harness-floor.mjs'
import { parseSmokeArgs, resolveSmokeTarget, USAGE } from './helpers/smoke-target.mjs'
const __dirname = dirname(fileURLToPath(import.meta.url))
const SCREENSHOT_DIR = join(__dirname, 'screenshots')

// Resolve the target BEFORE anything else (Playwright, the filesystem, the network)
// so a refused or malformed invocation touches nothing.
const parsed = parseSmokeArgs(process.argv.slice(2), process.env)
if (parsed.args.help) {
  console.log(USAGE)
  process.exit(0)
}
if (parsed.error) {
  console.error(`smoke-test: ${parsed.error}\n\n${USAGE}`)
  process.exit(2)
}
const target = resolveSmokeTarget(parsed.args, { home: process.env.HOME, env: process.env })
if (!target.ok) {
  console.error(`smoke-test: ${target.error}${target.kind === 'usage' ? `\n\n${USAGE}` : ''}`)
  process.exit(target.kind === 'refused' ? 3 : 2)
}
if (parsed.args.dryRun) {
  console.log(`smoke-test: would target ${target.origin} (${target.source}); token ${target.token.length} chars`)
  process.exit(0)
}
const headed = parsed.args.headed
const apiToken = target.token

// Playwright is imported only once the target is known, so a refusal never needs a browser.
const { chromium } = await import('playwright')

const results = []
let browser = null

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

  log(`Target: ${target.origin} (${target.source})`)

  // Build dashboard URL
  const dashboardUrl = `${target.origin}/dashboard/?token=${apiToken}`

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
    // Most specific first, one selector at a time. A combined selector list
    // returns the first match in DOCUMENT order, and `[class*="chat"]` also
    // matches header controls such as the model picker button
    // (`chat-settings-model-btn`, ~160px), which renders above the chat area
    // whenever the default session can switch models (claude-sdk, #8266).
    let chatArea = null
    for (const sel of ['.chat-messages', '.chat-view', 'main']) {
      chatArea = await page.$(sel)
      if (chatArea) break
    }
    if (chatArea) {
      const box = await chatArea.boundingBox()
      if (box && box.width > 960) {
        pass('Full-width layout', `${Math.round(box.width)}px`)
      } else if (box) {
        fail('Full-width layout', `${Math.round(box.width)}px (expected >960)`)
      } else {
        fail('Full-width layout', 'chat area is not rendered (no bounding box)')
      }
    } else {
      // The daemon boots with a default session, so a missing chat container
      // is a failure, not something to wave through on body width.
      fail('Full-width layout', 'no .chat-messages / .chat-view / main element')
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
      // In CI the daemon has features.ide on + the fixture as its cwd, so the IDE
      // surface + fixture are REQUIRED preconditions — a graceful skip there would
      // mask a regression. SMOKE_REQUIRE_IDE=1 makes a missing palette/fixture a
      // hard failure; unset (local, non-fixture daemon) keeps the section lenient.
      const requireIde = process.env.SMOKE_REQUIRE_IDE === '1'
      // Foreground the session view first — the Control Room section above leaves
      // its own panel open, which overlays the file viewer.
      const sessionTab = page.locator('[data-testid^="session-tab-"]').first()
      if (await sessionTab.count()) { await sessionTab.click().catch(() => {}); await page.waitForTimeout(500) }
      await page.keyboard.press('Meta+KeyP')
      await page.waitForTimeout(500)
      let paletteInput = await page.$('[data-testid="file-open-palette-input"]')
      if (!paletteInput) {
        await page.keyboard.press('Control+KeyP')
        await page.waitForTimeout(500)
        paletteInput = await page.$('[data-testid="file-open-palette-input"]')
      }
      if (!paletteInput) {
        if (requireIde) fail('IDE quick-open palette', 'features.ide expected (SMOKE_REQUIRE_IDE) but Cmd/Ctrl+P did not open the palette')
        else log('  (IDE quick-open not available — features.ide off; skipping)')
      } else {
        pass('IDE quick-open palette opens', 'Cmd/Ctrl+P — features.ide advertised')
        await paletteInput.fill('smoke_ide_sample')
        await page.waitForTimeout(1200)
        const fileItem = await page.$('[data-testid^="file-open-item-"]')
        if (!fileItem) {
          if (requireIde) fail('IDE go-to-def fixture', 'smoke_ide_sample expected (SMOKE_REQUIRE_IDE) but quick-open found no match')
          else log('  (smoke_ide_sample fixture not in this workspace — skipping go-to-def; expected outside CI)')
          await page.keyboard.press('Escape')
        } else {
          await fileItem.click()
          // Opening a file is a WS content round-trip + tokenize + render; poll
          // for the tokens rather than sampling at a fixed offset (CI is slower).
          let synCount = 0
          try {
            await page.waitForSelector('.file-viewer-line span[class^="syn-"]', { timeout: 6000 })
            synCount = await page.$$eval('span[class^="syn-"]', els => els.length).catch(() => 0)
          } catch { synCount = 0 }
          if (synCount > 0) pass('IDE file viewer renders syntax tokens', `${synCount} tokens`)
          else fail('IDE file viewer', 'no syntax tokens rendered')

          // HIT — jump to the exported declaration + a transient active-line
          // highlight. The highlight appears only after resolve + a content
          // re-fetch and lives ~1400ms, so poll for it (robust on a loaded runner)
          // rather than sampling at a fixed offset.
          // Identifier tokens only — exclude comment/string spans so the anchored
          // name can't match a mention inside a comment (defensive; the fixture's
          // comments are single spans whose text is the whole line anyway).
          const idTokenSel = '.file-viewer-line span[class^="syn-"]:not(.syn-comment):not(.syn-string)'
          const hitTok = page.locator(idTokenSel, { hasText: /^smokeGotoDefTarget$/ }).first()
          if (await hitTok.count()) {
            await hitTok.click({ modifiers: ['ControlOrMeta'] })
            let hitJumped = false
            try {
              await page.waitForSelector('.file-viewer-line--active', { timeout: 4000 })
              hitJumped = true
            } catch { hitJumped = false }
            const strayPill = await page.$('[data-testid="def-not-found"]')
            if (hitJumped && !strayPill) pass('Go-to-definition HIT', 'jumped + active-line highlight')
            else fail('Go-to-definition HIT', `jumped=${hitJumped}, pill=${!!strayPill}`)
            await screenshot(page, '08-ide-goto-def-hit')
          } else {
            fail('Go-to-definition HIT', 'no smokeGotoDefTarget token to click')
          }

          await page.waitForTimeout(1800) // let the highlight clear before the miss

          // MISS — an undeclared symbol yields a transient def-not-found pill.
          const missTok = page.locator(idTokenSel, { hasText: /^smokeGotoDefMissingSymbol$/ }).first()
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
  const verdict = harnessVerdict(results, SMOKE_MIN_CASES)
  const { passed, failed } = verdict
  console.log(`  \x1b[32m${passed} passed\x1b[0m, \x1b[${failed ? '31' : '32'}m${failed} failed\x1b[0m`)
  if (verdict.broken) console.log(`  \x1b[31m${verdict.summary}\x1b[0m`)
  console.log(`  Screenshots: ${SCREENSHOT_DIR}/\n`)

  // Cleanup
  if (browser) await browser.close()

  // RETURNED, not exited. `run()` contains no `process.exit` at all, and that is
  // an invariant a test can enumerate rather than a string it has to find:
  // review of #7681 defeated a substring check twice — once with an early
  // `process.exit(0)` ABOVE this line, once with a `process.exit(0)` below the
  // verdict — leaving both target substrings intact as dead code. A single exit
  // at module scope makes both of those visible as an extra exit inside `run()`.
  return verdict.exitCode
}

run()
  .then(code => process.exit(code))
  .catch(err => {
  console.error('Fatal:', err)
  if (browser) browser.close()
    process.exit(1)
  })
