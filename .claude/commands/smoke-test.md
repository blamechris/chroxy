# /smoke-test

Run an automated visual smoke test of the Chroxy web dashboard using Playwright. Launches a headless browser, navigates through key UI flows, takes screenshots, and reports pass/fail results.

## Arguments

- `$ARGUMENTS` - Optional flags:
  - `--headed` — Show the browser window (useful for debugging)
  - `--keep-screenshots` — Don't clean up screenshots after the run
  - If empty, runs headless and cleans up screenshots

## Instructions

### 0. Prerequisites

Verify Playwright is installed and the test script exists:

```bash
cd packages/server

# Check Playwright is available
node -e "require('playwright')" 2>/dev/null || {
  echo "Installing Playwright..."
  npm install --save-dev playwright
  npx playwright install chromium
}

# Check smoke test script exists
ls tests/smoke-test.mjs || {
  echo "ERROR: tests/smoke-test.mjs not found"
  exit 1
}
```

### 1. Rebuild Dashboard

The dashboard serves a compiled Vite bundle. Always rebuild before testing to pick up any source changes:

```bash
cd packages/server
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run dashboard:build
```

### 2. Ensure Server is Running

The smoke test connects to a running chroxy server. Check if one is already running:

```bash
# Probe common ports
for PORT in 8765 3131 8080 3000; do
  if curl -s "http://localhost:$PORT/" > /dev/null 2>&1 || \
     curl -s "http://localhost:$PORT/" 2>&1 | grep -q "403"; then
    echo "Found server on port $PORT"
    break
  fi
done
```

If no server is running, the test script will start one automatically and stop it when done.

### 3. Run the Smoke Test

```bash
cd packages/server
PATH="/opt/homebrew/opt/node@22/bin:$PATH" node tests/smoke-test.mjs $ARGUMENTS
```

Parse the arguments:
- If `$ARGUMENTS` contains `--headed`, pass it through
- If `$ARGUMENTS` contains `--keep-screenshots`, note it for cleanup step

The test script:
- Reads auth token from `~/.chroxy/config.json`
- Connects to `http://localhost:{port}/dashboard/?token={token}`
- Waits for WebSocket connection (sidebar appears)
- Runs checks across 4 categories
- Takes screenshots at each step
- Outputs PASS/FAIL for each check
- Exits 0 (all pass) or 1 (failures)

### 4. Read Screenshots

After the test runs, read each screenshot to visually verify the UI:

```bash
ls packages/server/tests/screenshots/*.png
```

Use the Read tool to view each screenshot image. For each screenshot:
- Verify the UI looks correct (layout, colors, text, element positions)
- Check for visual regressions (missing elements, broken layouts, overlapping content)
- Note any issues that the automated checks might have missed

**This visual review is the primary value of the skill** — automated checks confirm DOM presence, but screenshot review catches z-index issues, color problems, overlapping text, and other visual regressions.

### 5. Report Results

Combine the automated test output with your visual review:

```markdown
## Smoke Test Results

| # | Check | Status | Notes |
|---|-------|--------|-------|
| 1 | Dashboard loads | PASS | HTTP 200 |
| 2 | WebSocket connects | PASS | — |
| ... | ... | ... | ... |

**Automated:** X/Y passed
**Visual review:** [describe any issues seen in screenshots]
**Overall:** PASS / FAIL (with details)
```

If any checks fail:
- Read the relevant screenshot to diagnose the visual state
- Check if it's a test selector issue (test bug) vs. a real UI issue (app bug)
- For real issues, suggest a fix or create an issue

### 6. Cleanup

Unless `--keep-screenshots` was passed:

```bash
rm -rf packages/server/tests/screenshots
```

## Test Categories

| Category | Checks | What They Verify |
|----------|--------|-----------------|
| Dashboard Core | Page loads, WS connects, version badge, sidebar, session tabs, full-width layout, input bar | Basic rendering and connectivity |
| Session Creation | Ctrl+N opens modal, session name input, CWD combobox, provider picker (SDK/CLI) | New session flow works |
| Keyboard Shortcuts | `?` help overlay, `Ctrl+K` command palette, `Ctrl+N` new session | Shortcut bindings active |
| Health | Console errors | No JS exceptions |

## Adding New Checks

To add checks, edit `packages/server/tests/smoke-test.mjs`. Each check follows this pattern:

```javascript
// 1. Act — interact with the UI
await page.keyboard.press('Control+n')
await page.waitForTimeout(500)

// 2. Screenshot — capture current state
await screenshot(page, '02-modal-open')

// 3. Assert — verify expected result
const modal = await page.$('.modal-overlay')
if (modal && await modal.isVisible()) {
  pass('Modal opens')
} else {
  fail('Modal opens', 'Not visible')
}
```

Prefer stable selectors: `aria-label` > `role` > class names > text content.

## Critical Rules

1. **Never send real messages** — Smoke tests verify UI, not Claude. Don't submit the input bar.
2. **Rebuild dashboard first** — The server serves compiled bundles. Source changes aren't visible until `npm run dashboard:build`.
3. **Screenshots are temporary** — Always clean up unless `--keep-screenshots`. They're gitignored.
4. **Server lifecycle** — The test auto-starts a server if none is running, and stops it when done. If one is already running, it reuses it.
5. **Visual review is mandatory** — Read every screenshot. The automated checks are necessary but not sufficient.
6. **Idempotent** — Safe to run repeatedly. Don't create sessions or send messages.
<!-- skill-templates: smoke-test -->
