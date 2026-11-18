import assert from 'node:assert/strict'
import { before, after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'

// #8779: the shared modal footer buttons rendered 29px high. The REAL New
// Session modal (Create enabled, and disabled while creating), ConfirmDialog
// (plain and danger) and DirectoryBrowser (in a representative New Session modal
// shell; see the fixture) are mounted with the production stylesheet, one case
// per page, at a desktop and a narrow viewport. Only Create has a disabled state;
// the other footers' buttons are always enabled. Every
// footer button is measured in a real browser:
//   - the footer renders exactly the expected buttons in the expected
//     enabled/disabled states (so a case that rendered nothing cannot pass);
//   - each button's box is at least 44x44;
//   - each button sits inside its footer and the viewport, is the topmost
//     element at its centre, and its label fits without overflow.
// jsdom lays nothing out, so this cannot live in vitest (ModalButtonTapTarget.test.ts
// only pins the CSS declarations). Runs in the Dashboard Smoke job beside the
// other *-layout.test.mjs files. No button is clicked and every handler in the
// fixture is a no-op. Each case runs in a fresh browser context with service
// workers blocked, HTTP(S) to anything but the Vite origin aborted and every
// WebSocket refused, all set up before navigation; any blocked attempt fails the case.

const root = fileURLToPath(new URL('../', import.meta.url))
let browser
let vite
let origin

const FLOOR = 44
const VIEWPORTS = [
  ['desktop', { width: 1280, height: 800 }],
  ['narrow', { width: 360, height: 740 }],
]
// case -> the footer's buttons, in DOM order: [class, disabled]
const CASES = {
  'new-session': [['btn-modal-cancel', false], ['btn-modal-create', false]],
  'new-session-creating': [['btn-modal-cancel', false], ['btn-modal-create', true]],
  'confirm': [['btn-modal-cancel', false], ['btn-modal-create', false]],
  'confirm-danger': [['btn-modal-cancel', false], ['btn-modal-danger', false]],
  'directory': [['btn-modal-cancel', false], ['btn-modal-create', false]],
}
const SELECTOR = 'button.btn-modal-cancel, button.btn-modal-create, button.btn-modal-danger'

async function measure(page) {
  await page.locator(SELECTOR).first().waitFor({ state: 'visible' })
  return page.evaluate((selector) => {
    const box = r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height })
    return [...document.querySelectorAll(selector)].map((b) => {
      b.scrollIntoView({ block: 'center', inline: 'center' })
      const r = b.getBoundingClientRect()
      const footer = b.closest('.modal-buttons, .directory-browser-actions')
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return {
        cls: ['btn-modal-cancel', 'btn-modal-create', 'btn-modal-danger'].find(c => b.classList.contains(c)),
        label: b.textContent.trim(),
        disabled: b.disabled,
        ...box(r),
        footer: footer ? box(footer.getBoundingClientRect()) : null,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        topmost: hit !== null && b.contains(hit),
        overflowX: b.scrollWidth - b.clientWidth,
        overflowY: b.scrollHeight - b.clientHeight,
      }
    })
  }, SELECTOR)
}

describe('modal footer button layout (#8779)', () => {
  before(async () => {
    vite = await createServer({
      root,
      base: '/',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      plugins: [{
        name: 'modal-buttons-layout-fixture',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url.startsWith('/__modal-buttons-layout')) return next()
            try {
              const html = await server.transformIndexHtml(req.url, '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/scripts/modal-buttons-layout.fixture.tsx"></script></body></html>')
              res.setHeader('Content-Type', 'text/html')
              res.end(html)
            } catch (error) {
              next(error)
            }
          })
        },
      }],
    })
    await vite.listen()
    origin = `http://127.0.0.1:${vite.httpServer.address().port}`
    browser = await chromium.launch({ headless: true })
  })

  after(async () => {
    try { await browser?.close() } finally { await vite?.close() }
  })

  for (const [caseName, expected] of Object.entries(CASES)) {
    for (const [vpName, viewport] of VIEWPORTS) {
      const withPage = async (fn) => {
        // A fresh context per case, isolated BEFORE navigation: service workers are
        // blocked, every HTTP(S) request to anything but the Vite origin is aborted,
        // and every WebSocket is refused. Blocked attempts are recorded and fail the case.
        const context = await browser.newContext({ viewport, serviceWorkers: 'block' })
        const blocked = []
        await context.route('**/*', (route) => {
          const u = new URL(route.request().url())
          if (u.origin === origin) return route.continue()
          blocked.push(route.request().url())
          return route.abort('blockedbyclient')
        })
        await context.routeWebSocket(/.*/, (ws) => {
          blocked.push(`websocket ${ws.url()}`)
          return ws.close()
        })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', e => { errors.push(String(e)) })
        try {
          page.setDefaultTimeout(10000)
          await page.goto(`${origin}/__modal-buttons-layout?case=${caseName}`)
          const m = await measure(page)
          console.log(`# ${caseName} ${vpName}: ${JSON.stringify(m)}`)
          assert.deepEqual(errors, [], 'the fixture page raised no error')
          await fn(m)
          assert.deepEqual(blocked, [], 'no request left the Vite origin and no WebSocket was attempted')
        } finally {
          await context.close()
        }
      }

      test(`${caseName} ${vpName}: the footer renders the expected buttons and states`, () => withPage(m => {
        assert.deepEqual(m.map(b => [b.cls, b.disabled]), expected)
      }))

      test(`${caseName} ${vpName}: every footer button is at least ${FLOOR}x${FLOOR}`, () => withPage(m => {
        const small = m.filter(b => b.width < FLOOR - 0.5 || b.height < FLOOR - 0.5).map(b => `${b.cls} ${b.width.toFixed(1)}x${b.height.toFixed(1)}`)
        assert.equal(m.length, expected.length, 'every expected button was measured')
        assert.deepEqual(small, [], `a footer button under ${FLOOR}x${FLOOR}`)
      }))

      test(`${caseName} ${vpName}: no footer button is clipped, covered or truncated`, () => withPage(m => {
        const bad = []
        for (const b of m) {
          if (!b.footer) { bad.push(`${b.cls}: not inside a footer`); continue }
          const inFooter = b.left >= b.footer.left - 0.5 && b.right <= b.footer.right + 0.5 && b.top >= b.footer.top - 0.5 && b.bottom <= b.footer.bottom + 0.5
          const inViewport = b.left >= -0.5 && b.top >= -0.5 && b.right <= b.viewport.width + 0.5 && b.bottom <= b.viewport.height + 0.5
          if (!inFooter) bad.push(`${b.cls}: outside its footer`)
          if (!inViewport) bad.push(`${b.cls}: outside the viewport`)
          if (!b.topmost) bad.push(`${b.cls}: covered at its centre`)
          if (b.overflowX > 1 || b.overflowY > 1) bad.push(`${b.cls}: label "${b.label}" overflows by ${b.overflowX}x${b.overflowY}px`)
        }
        assert.equal(m.length, expected.length, 'every expected button was measured')
        assert.deepEqual(bad, [])
      }))
    }
  }
})
