import assert from 'node:assert/strict'
import { before, after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'

// #8943: the collapsed sidebar panel header let its tab labels overlap the
// launcher and the metric text. The real SidebarPanelSlot is mounted collapsed
// with the production stylesheet at the widths below and a long metric, and
// every control's bounding box is measured in a real browser: no two of the
// tabs, launcher, metric and toggle intersect, the toggle shares row 1 with
// the tabs, every control is at least 44x44, and the header is a single row
// once the container query lets it be. jsdom lays nothing out, so this cannot
// live in vitest (SidebarPanelSlotHeaderLayout.test.tsx only pins the CSS
// properties). Runs in the Dashboard Smoke job beside sidebar-layout.test.mjs.

const root = fileURLToPath(new URL('../', import.meta.url))
let browser
let vite
let url

const WIDTHS = [240, 320, 480]
const WIDE = 480
const METRIC = '1234.5M tokens used today'
const FLOOR = 44

async function measure(page, width) {
  const section = page.locator(`[data-case="${width}"]`)
  await section.locator('[data-testid="sidebar-panel-slot-collapsed-metric"]').waitFor({ state: 'visible' })
  return section.evaluate(el => {
    const box = e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
    const q = id => el.querySelector(`[data-testid="${id}"]`)
    const named = [
      ['tab-tokens', q('sidebar-panel-slot-tab-tokens')],
      ['tab-mcp', q('sidebar-panel-slot-tab-mcp')],
      ['launcher', q('sidebar-panel-slot-launcher-control-room')],
      ['metric', q('sidebar-panel-slot-collapsed-metric')],
      ['toggle', q('sidebar-panel-slot-collapse-toggle')],
    ]
    return {
      controls: named.map(([name, e]) => ({ name, ...(e ? box(e) : { missing: true }) })),
      header: box(q('sidebar-panel-slot-header')),
    }
  })
}

// A control that did not mount (or measured NaN) must fail, not satisfy a
// comparison against nothing.
const present = m => {
  const missing = m.controls.filter(c => c.missing || !Number.isFinite(c.left)).map(c => c.name)
  assert.deepEqual(missing, [], 'every control is mounted and measured')
}

describe('collapsed sidebar panel header layout (#8943)', () => {
  before(async () => {
    vite = await createServer({
      root,
      base: '/',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      plugins: [{
        name: 'panel-header-layout-fixture',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url.startsWith('/__panel-header-layout')) return next()
            try {
              const html = await server.transformIndexHtml(req.url, '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/scripts/panel-header-layout.fixture.tsx"></script></body></html>')
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
    url = `http://127.0.0.1:${vite.httpServer.address().port}/__panel-header-layout?widths=${WIDTHS.join(',')}&metric=${encodeURIComponent(METRIC)}`
    browser = await chromium.launch({ headless: true })
  })

  after(async () => {
    try { await browser?.close() } finally { await vite?.close() }
  })

  for (const width of WIDTHS) {
    const withPage = async (fn) => {
      const page = await browser.newPage({ viewport: { width: 700, height: 900 } })
      try {
        page.setDefaultTimeout(10000)
        await page.goto(url)
        const m = await measure(page, width)
        console.log(`# ${width}: ${JSON.stringify(m)}`)
        present(m)
        await fn(m)
      } finally {
        await page.close()
      }
    }

    test(`${width}px: no two of the tabs, launcher, metric and toggle intersect`, () => withPage(m => {
      const overlaps = []
      for (let i = 0; i < m.controls.length; i++) {
        for (let j = i + 1; j < m.controls.length; j++) {
          const a = m.controls[i]
          const b = m.controls[j]
          const x = Math.min(a.right, b.right) - Math.max(a.left, b.left)
          const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
          if (x > 0.5 && y > 0.5) overlaps.push(`${a.name} x ${b.name} (${x.toFixed(1)}x${y.toFixed(1)}px)`)
        }
      }
      assert.deepEqual(overlaps, [], 'overlapping header controls')
    }))

    test(`${width}px: the toggle is on the first row, with the tabs`, () => withPage(m => {
      const toggle = m.controls.find(c => c.name === 'toggle')
      const tab = m.controls.find(c => c.name === 'tab-tokens')
      assert.ok(Math.abs(toggle.top - tab.top) <= 1, `the toggle (top ${toggle.top.toFixed(1)}) must share the tabs' row (top ${tab.top.toFixed(1)})`)
    }))

    test(`${width}px: every control is at least ${FLOOR}x${FLOOR}`, () => withPage(m => {
      const small = m.controls.filter(c => c.name !== 'metric' && (c.width < FLOOR - 0.5 || c.height < FLOOR - 0.5)).map(c => `${c.name} ${c.width.toFixed(1)}x${c.height.toFixed(1)}`)
      assert.deepEqual(small, [], `a control under ${FLOOR}x${FLOOR}`)
    }))

    if (width === WIDE) {
      test(`${width}px: the header is a single row`, () => withPage(m => {
        const centers = m.controls.map(c => (c.top + c.bottom) / 2)
        const spread = Math.max(...centers) - Math.min(...centers)
        assert.ok(spread <= 1, `all controls share one row (vertical centers differ by ${spread.toFixed(1)}px)`)
        assert.ok(m.header.height <= FLOOR + 2, `the header is one control tall (${m.header.height.toFixed(1)}px)`)
      }))
    }
  }
})
