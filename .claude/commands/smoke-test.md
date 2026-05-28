# /smoke-test

Run an automated visual smoke test of the application using Playwright. Launches a headless browser, navigates through key UI flows, takes screenshots, and reports pass/fail results.

## Arguments

- `$ARGUMENTS` - Optional flags:
  - `--headed` — Show the browser window (useful for debugging)
  - `--keep-screenshots` — Don't clean up screenshots after the run
  - If empty, runs headless and cleans up screenshots

## Instructions

### 0. Prerequisites

Verify Playwright is installed and the test script exists:

```bash
# Check Playwright is available
node -e "require('playwright')" 2>/dev/null || {
  echo "Installing Playwright..."
  npm install --save-dev playwright
  npx playwright install chromium
}

# Check smoke test script exists
test -f packages/server/tests/smoke-test.mjs || {
  echo "Smoke test script not found at packages/server/tests/smoke-test.mjs"
  exit 1
}
```

### 1. Ensure Application is Running

The smoke test connects to a running application instance. Check if one is already running, or start one:

```bash
# Probe for running server on common ports
for port in 8765 3131 8080 3000; do
  if curl -s http://localhost:$port/health >/dev/null 2>&1; then
    echo "Server already running on port $port"
    exit 0
  fi
done

# No server found — start one
echo "Starting chroxy server..."
npx chroxy start
```

### 2. Run the Smoke Test

First, rebuild the dashboard to ensure UI changes are visible:

```bash
cd packages/server
npm run dashboard:build
```

Then run the smoke test:

```bash
cd packages/server
node tests/smoke-test.mjs $ARGUMENTS
```

The test script should:
- Connect to the running application
- Navigate through key UI flows
- Take screenshots at each step (saved to a gitignored directory)
- Output PASS/FAIL for each check
- Exit 0 (all pass) or 1 (failures)

### 3. Read Screenshots

After the test runs, read each screenshot to visually verify the UI:

```bash
# Screenshots are saved to packages/server/tests/screenshots/
ls -la packages/server/tests/screenshots/
```

Use the Read tool to view each screenshot image. For each screenshot:
- Verify the UI looks correct (layout, colors, text, element positions)
- Check for visual regressions (missing elements, broken layouts, overlapping content)
- Note any issues that the automated checks might have missed

### 4. Report Results

Output a summary table:

```markdown
## Smoke Test Results

| # | Check | Status | Notes |
|---|-------|--------|-------|
| 1 | Dashboard loads | PASS | HTTP 200, WS connects |
| 2 | Session creation | PASS | Ctrl+N modal opens |
| 3 | Keyboard shortcuts | PASS | ? and Ctrl+K work |

**Screenshots reviewed:** N
**Visual issues found:** M (describe any issues)

If the test failed, check that the server is running and the dashboard was rebuilt. If WS connection fails, verify the API token is loaded from `~/.chroxy/config.json`.
```

### 5. Cleanup

```bash
# Remove screenshots unless --keep-screenshots was passed
if [[ "$ARGUMENTS" != *"--keep-screenshots"* ]]; then
  rm -rf packages/server/tests/screenshots/
fi
```

If the application was started by this skill (not already running), stop it.

## Writing the Smoke Test Script

If the test script doesn't exist yet, create it following these patterns:

### Script Structure

```javascript
/**
 * Smoke Test — Playwright-based visual verification
 *
 * Prerequisites: application must be running.
 * Screenshots saved to packages/server/tests/screenshots/ (gitignored).
 */

import { chromium } from 'playwright'
// ... setup

async function run() {
  // 1. Find running application (probe ports 8765, 3131, 8080, 3000)
  // 2. Load API token from ~/.chroxy/config.json
  // 3. Launch browser
  // 4. Navigate to http://localhost:{port}/dashboard/?token={token}
  // 5. Wait for WS connection (page should NOT contain "Disconnected" or "Connecting...")
  // 6. Run checks — each one:
  //    a. Interact with UI (click, type, navigate)
  //    b. Take screenshot
  //    c. Assert element exists / is visible / has correct content
  //    d. Log PASS or FAIL
  // 7. Output summary
  // 8. Exit with appropriate code
}
```

### Check Patterns

Each check should:
1. **Act** — Navigate, click, type
2. **Screenshot** — Capture current state
3. **Assert** — Verify expected elements/content
4. **Report** — Log PASS/FAIL with details

```javascript
// Example: Check a modal opens
await page.keyboard.press('Control+n')
await page.waitForTimeout(500)
await screenshot(page, '02-modal-open')

const modal = await page.$('.modal-overlay')
if (modal && await modal.isVisible()) {
  pass('Modal opens')
} else {
  fail('Modal opens', 'Not visible after Ctrl+N')
}
```

### Selector Strategy

Prefer stable selectors in this order:
1. `aria-label`, `role`, `data-testid` attributes
2. Class names matching component names
3. Semantic HTML elements (`header`, `main`, `nav`)
4. Text content (last resort — fragile)

### Connection Handling

The dashboard connects via WebSocket automatically on load. Always wait for the "ready" state:

```javascript
// Wait for WS connection to establish
await page.waitForFunction(() => {
  const body = document.body.innerText
  return !body.includes('Disconnected') && !body.includes('Connecting...')
}, { timeout: 10000 })
```

## Test Categories

Organize checks into logical groups:

| Category | What to Verify |
|----------|---------------|
| Dashboard Core | Page loads (HTTP 200), WS connects, version badge, sidebar, session tabs, full-width layout, input bar |
| Session Creation | Ctrl+N opens modal, session name input, CWD combobox, provider picker (SDK/CLI options) |
| Keyboard Shortcuts | `?` opens help overlay, `Ctrl+K` command palette, `Ctrl+N` new session |
| Health | No critical console errors |

## Critical Rules

1. **Never send real messages** — Smoke tests verify UI, not backend processing. Don't submit forms that trigger expensive operations.
2. **Screenshots are temporary** — Always clean up unless `--keep-screenshots`. Add the directory to `.gitignore`.
3. **Fail fast on no connection** — If the app isn't running or can't connect, report immediately instead of running checks that will all fail.
4. **Stable selectors** — Use aria labels and roles, not brittle CSS class names that change with refactors.
5. **Visual verification is the point** — The automated checks catch DOM presence. Reading screenshots catches visual regressions (z-index, color, spacing).
6. **Idempotent** — Safe to run repeatedly. Don't create persistent state (sessions, data, etc.) that would affect the next run.
7. **Dashboard rebuild required** — Always run `npm run dashboard:build` before testing. Provider picker CSS and other UI elements are invisible without the rebuild.
8. **Keyboard shortcut quirk** — The `?` shortcut fails if the textarea has focus (keystroke goes to input, not shortcut handler). Click the page body first before testing keyboard shortcuts.
<!-- skill-templates: smoke-test 9652481 2026-05-27 -->
