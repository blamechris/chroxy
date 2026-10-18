import assert from 'node:assert/strict'
import { before, after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'

// #8618: the dashboard header clipped the thinking level ("xhigh" → "Xhi") and
// truncated the sandbox badge on a codex session. Every control in
// `.header-center` is measured here, in a real browser, against the production
// stylesheet: a <select> must be at least as wide as THIS engine needs to show
// each option it can select (a clone holding only that option, sized by its
// intrinsic width — no floor, no cap, no flex), every control must sit inside
// the center column rather than past its hidden overflow, and the sandbox
// badge must show its own text at its own width, with the full label in its
// title. jsdom lays nothing out, so this cannot live in vitest; it runs in the
// Dashboard Smoke job beside tool-layout.test.mjs.

const root = fileURLToPath(new URL('../', import.meta.url))
let browser
let vite
let url

// The codex binary's own reasoning roster (`supportedReasoningEfforts`, #7730),
// written by hand here because this is a test (scripts/lint-thinking-level-roster.sh
// exempts tests on purpose) and handed to the fixture on the query string.
const CODEX_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh']
const SELECTED_LEVEL = 'xhigh'

const CASES = [
  // [case, viewport width, the sandbox label the fixture renders for it (null: no badge)]
  ['roomy', 1660, 'Read-only'],
  ['tight', 1660, 'Workspace write'],
  ['phone', 390, 'Workspace write'],
  ['no-badge', 1660, null],
]

async function measure(page, name) {
  const section = page.locator(`[data-case="${name}"]`)
  await section.locator('select[data-kind="thinking"]').waitFor({ state: 'visible' })
  return section.evaluate(section => {
    const center = section.querySelector('.header-center')
    if (!center) throw new Error('Fixture must render .header-center')
    const centerRect = center.getBoundingClientRect()
    const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width } }
    const selects = [...center.querySelectorAll('select')].map(select => {
      const needs = [...select.options].filter(o => !o.disabled).map(option => {
        // The width this engine needs to render exactly this option unclipped.
        // The clone sits beside the original so the same stylesheet applies;
        // the inline style strips any floor/cap/flex so what is left is the
        // label plus the select's own chrome (padding, border, arrow).
        const clone = select.cloneNode(false)
        const only = document.createElement('option')
        only.textContent = option.textContent
        clone.appendChild(only)
        clone.style.cssText = 'width:auto;min-width:0;max-width:none;flex:none;position:absolute;visibility:hidden'
        center.appendChild(clone)
        const needed = clone.getBoundingClientRect().width
        clone.remove()
        return { label: option.textContent, needed }
      })
      return { kind: select.dataset.kind, selected: select.selectedOptions[0]?.textContent ?? null, ...box(select), needs }
    })
    const badge = center.querySelector('[data-testid="codex-sandbox-badge"]')
    let badgeMeasure = null
    if (badge) {
      const twin = badge.cloneNode(true)
      twin.style.cssText = 'width:auto;min-width:0;max-width:none;flex:none;position:absolute;visibility:hidden'
      center.appendChild(twin)
      const natural = twin.getBoundingClientRect().width
      twin.remove()
      badgeMeasure = { text: badge.textContent, title: badge.getAttribute('title') ?? '', ...box(badge), natural, scrollWidth: badge.scrollWidth, clientWidth: badge.clientWidth }
    }
    const controls = [...center.children].map(el => ({ tag: el.tagName, kind: el.dataset.kind ?? null, ...box(el) }))
    return {
      center: box(center),
      selects,
      controls,
      badge: badgeMeasure,
    }
  })
}

describe('header controls layout (#8618)', () => {
  before(async () => {
    vite = await createServer({
      root,
      base: '/',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      plugins: [{
        name: 'header-layout-fixture',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url.startsWith('/__header-layout')) return next()
            try {
              const html = await server.transformIndexHtml(req.url, '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/scripts/header-layout.fixture.tsx"></script></body></html>')
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
    url = `http://127.0.0.1:${vite.httpServer.address().port}/__header-layout?levels=${encodeURIComponent(CODEX_LEVELS.join(','))}&selected=${SELECTED_LEVEL}`
    browser = await chromium.launch({ headless: true })
    const probe = await browser.newPage()
    try {
      await probe.goto(url)
      await probe.locator('[data-case="roomy"] select[data-kind="thinking"]').waitFor({ state: 'visible', timeout: 10000 })
    } finally {
      await probe.close()
    }
  })

  after(async () => {
    try { await browser?.close() } finally { await vite?.close() }
  })

  for (const [name, viewport, sandboxLabel] of CASES) {
    const withPage = async (fn) => {
      const page = await browser.newPage({ viewport: { width: viewport, height: 800 } })
      try {
        page.setDefaultTimeout(10000)
        await page.goto(url)
        await fn(await measure(page, name))
      } finally {
        await page.close()
      }
    }

    test(`${name}: every header <select> is wide enough for every option it can show`, () => withPage(m => {
      const thinking = m.selects.find(s => s.kind === 'thinking')
      assert.ok(thinking, 'the fixture renders the thinking select')
      assert.equal(thinking.selected, 'Xhigh', 'the fixture has xhigh selected')
      assert.ok(thinking.needs.some(n => n.label === 'Medium'), 'the codex roster is the binary\'s own, Medium included')
      assert.ok(m.selects.some(s => s.kind === 'permission'), 'the fixture renders the permission select')
      const clipped = m.selects.flatMap(s => s.needs.filter(n => s.width + 0.5 < n.needed).map(n => `${s.kind} is ${s.width.toFixed(1)}px but "${n.label}" needs ${n.needed.toFixed(1)}px`))
      assert.deepEqual(clipped, [], 'a select narrower than one of its labels clips that label mid-glyph')
    }))

    test(`${name}: every control sits inside the center column instead of past its hidden overflow`, () => withPage(m => {
      const expected = sandboxLabel === null ? 3 : 4
      assert.equal(m.controls.length, expected, `model, permission${sandboxLabel === null ? '' : ', badge'} and thinking are all mounted (got ${m.controls.length})`)
      const outside = m.controls.filter(c => c.left < m.center.left - 0.5 || c.right > m.center.right + 0.5).map(c => `${c.tag}[${c.kind}] ${c.left.toFixed(1)}..${c.right.toFixed(1)} vs column ${m.center.left.toFixed(1)}..${m.center.right.toFixed(1)}`)
      assert.deepEqual(outside, [], 'a control past the column edge is cut off by .header-center { overflow: hidden }')
    }))

    test(`${name}: the sandbox badge carries its full label and sizes to its own text`, () => withPage(m => {
      if (sandboxLabel === null) {
        assert.equal(m.badge, null, 'a session without a codex sandbox renders no badge')
        return
      }
      assert.ok(m.badge.title.includes(sandboxLabel), `title names the sandbox (${m.badge.title})`)
      assert.ok(m.badge.text.includes(sandboxLabel), `the visible text is the full label (${m.badge.text})`)
      // Wider than its own text means it inherited the model slot's floor
      // (#4464's 160px); narrower is only allowed under a real squeeze, where
      // the title still carries the full text.
      assert.ok(m.badge.width <= m.badge.natural + 1, `badge is ${m.badge.width.toFixed(1)}px for ${m.badge.natural.toFixed(1)}px of text — padded to a floor`)
      if (name === 'roomy') {
        assert.ok(m.badge.width >= m.badge.natural - 1, `badge truncated with room to spare (${m.badge.width.toFixed(1)} < ${m.badge.natural.toFixed(1)})`)
        assert.ok(m.badge.scrollWidth <= m.badge.clientWidth + 1, 'badge text is cut off although the column has room')
      }
    }))
  }
})
