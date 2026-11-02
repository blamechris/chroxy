import assert from 'node:assert/strict'
import { before, after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'

// #8888: on a short window the sidebar's scroll column (.sidebar-scroll)
// overflowed and the project tree sat at its 96px floor with its own scroller,
// a small scroller nested in the column scroller. The tree must flow with the
// column there, and still fill the free space (inner scroller, panel slot
// visible, column not overflowing) on a tall window. Measured in a real
// browser against the production stylesheet with the real Sidebar and more
// than 20 sessions; jsdom lays nothing out, so this cannot live in vitest.
// Runs in the Dashboard Smoke job beside header-layout.test.mjs.

const root = fileURLToPath(new URL('../', import.meta.url))
let browser
let vite
let base

const CASES = [
  // [name, viewport height, archived section, expected mode]
  ['short-collapsed', 640, 'collapsed', 'flow'],
  ['short-expanded', 640, 'expanded', 'flow'],
  ['tiny-collapsed', 480, 'collapsed', 'flow'],
  ['tall-collapsed', 1200, 'collapsed', 'boxed'],
  ['tall-expanded', 1200, 'expanded', 'boxed'],
]

async function measure(page, archived) {
  await page.locator('[data-testid="sidebar-scroll"] .sidebar-tree').waitFor({ state: 'visible' })
  await page.locator('[data-testid="sidebar-archived-toggle"]').waitFor({ state: 'visible' })
  if (archived === 'expanded') {
    await page.locator('[data-testid="sidebar-archived-toggle"]').click()
    await page.locator('[data-testid="sidebar-archived-section"]').waitFor({ state: 'visible' })
  }
  // Let the observer settle, then sample the mode over several frames: a
  // flip-flop shows up as more than one distinct value.
  return page.evaluate(async () => {
    const frame = () => new Promise(r => requestAnimationFrame(() => r()))
    for (let i = 0; i < 10; i++) await frame()
    const col = document.querySelector('[data-testid="sidebar-scroll"]')
    const tree = col.querySelector('.sidebar-tree')
    const modes = new Set()
    for (let i = 0; i < 20; i++) {
      modes.add(tree.classList.contains('sidebar-tree--flow') ? 'flow' : 'boxed')
      await frame()
    }
    const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } }
    const colRect = rect(col)
    const slot = col.querySelector('.sidebar-panel-slot')
    const picker = col.querySelector('.server-picker')
    const next = tree.nextElementSibling
    const treeRect = rect(tree)
    // Scroll the column to its end: every section must then be inside it.
    col.scrollTop = col.scrollHeight
    await frame()
    const endCol = rect(col)
    return {
      modes: [...modes],
      sessions: document.querySelectorAll('[data-testid^="session-item-"]').length,
      col: { clientHeight: col.clientHeight, scrollHeight: col.scrollHeight, overflowY: getComputedStyle(col).overflowY },
      tree: { clientHeight: tree.clientHeight, scrollHeight: tree.scrollHeight, overflowY: getComputedStyle(tree).overflowY },
      slot: slot ? rect(slot) : null,
      colRect,
      treeBottomGap: next ? rect(next).top - treeRect.bottom : null,
      pickerBottom: picker ? rect(picker).bottom : null,
      endColBottom: endCol.bottom,
    }
  })
}

describe('sidebar project tree layout (#8888)', () => {
  before(async () => {
    vite = await createServer({
      root,
      base: '/',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      plugins: [{
        name: 'sidebar-layout-fixture',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url.startsWith('/__sidebar-layout')) return next()
            try {
              const html = await server.transformIndexHtml(req.url, '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/scripts/sidebar-layout.fixture.tsx"></script></body></html>')
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
    base = `http://127.0.0.1:${vite.httpServer.address().port}/__sidebar-layout`
    browser = await chromium.launch({ headless: true })
  })

  after(async () => {
    try { await browser?.close() } finally { await vite?.close() }
  })

  for (const [name, height, archived, mode] of CASES) {
    const withPage = async (fn) => {
      const page = await browser.newPage({ viewport: { width: 1280, height } })
      try {
        page.setDefaultTimeout(10000)
        await page.goto(base)
        const m = await measure(page, archived)
        console.log(`# ${name}: ${JSON.stringify(m)}`)
        await fn(m)
      } finally {
        await page.close()
      }
    }

    test(`${name}: the fixture mounts more than 20 sessions and settles in ${mode} mode without flipping`, () => withPage(m => {
      assert.ok(m.sessions > 20, `the fixture renders more than 20 sessions (got ${m.sessions})`)
      assert.deepEqual(m.modes, [mode], `the tree's mode must be stable ${mode} after settling (saw ${m.modes.join(',')})`)
    }))

    if (mode === 'flow') {
      test(`${name}: the tree is not a scroller nested in the column scroller, and every section is reachable`, () => withPage(m => {
        assert.ok(m.col.scrollHeight > m.col.clientHeight + 1, `the column scrolls on a short window (${m.col.scrollHeight} vs ${m.col.clientHeight})`)
        assert.ok(m.tree.scrollHeight <= m.tree.clientHeight + 1, `the tree has no content hidden behind its own scroll (scrollHeight ${m.tree.scrollHeight} > clientHeight ${m.tree.clientHeight})`)
        assert.ok(m.tree.overflowY !== 'auto' && m.tree.overflowY !== 'scroll', `the tree's overflow-y is ${m.tree.overflowY}, a nested scroller`)
        assert.ok(m.pickerBottom <= m.endColBottom + 1, `the server list is reachable at the end of the column (bottom ${m.pickerBottom} vs ${m.endColBottom})`)
      }))
    } else {
      test(`${name}: the tree fills the free space, scrolls inside, and the panel slot stays visible`, () => withPage(m => {
        assert.ok(m.col.scrollHeight <= m.col.clientHeight + 1, `the column must not overflow on a tall window (${m.col.scrollHeight} vs ${m.col.clientHeight})`)
        assert.ok(m.tree.scrollHeight > m.tree.clientHeight + 1, `the list is longer than the tree box, so it scrolls inside it (${m.tree.scrollHeight} vs ${m.tree.clientHeight})`)
        assert.ok(m.tree.overflowY === 'auto', `the tree keeps its own scroller (overflow-y ${m.tree.overflowY})`)
        assert.ok(m.slot !== null && m.slot.bottom <= m.colRect.bottom + 1 && m.slot.top >= m.colRect.top, `the panel slot is visible inside the column without scrolling (${JSON.stringify(m.slot)} vs ${JSON.stringify(m.colRect)})`)
        assert.ok(m.pickerBottom <= m.colRect.bottom + 1, `the server list is visible without scrolling (bottom ${m.pickerBottom} vs column ${m.colRect.bottom})`)
        assert.ok(Math.abs(m.treeBottomGap) <= 1, `the tree's bottom touches the next section (gap ${m.treeBottomGap})`)
      }))
    }
  }
})
