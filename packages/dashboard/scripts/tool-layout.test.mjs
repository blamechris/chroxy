import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
let browser
let vite
let url

before(async () => {
  vite = await createServer({
    root,
    base: '/',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [{
      name: 'tool-layout-fixture',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== '/__tool-layout') return next()
          try {
            const html = await server.transformIndexHtml(req.url, '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/scripts/tool-layout.fixture.tsx"></script></body></html>')
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
  url = `http://127.0.0.1:${vite.httpServer.address().port}/__tool-layout`
  browser = await chromium.launch({ headless: true })
  const probe = await browser.newPage()
  try {
    await probe.goto(url)
    await probe.locator('[data-case="short-result"] pre').waitFor({ state: 'visible', timeout: 10000 })
  } finally {
    await probe.close()
  }
})

after(async () => {
  try { await browser?.close() } finally { await vite?.close() }
})

for (const width of [320, 800, 1440]) {
  for (const scenario of ['short-result', 'long-preview', 'long-expanded', 'running-input', 'grouped-control']) {
    test(`${scenario} keeps all text inside its tool card at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } })
      try {
        page.setDefaultTimeout(10000)
        await page.goto(url)
        const fixtureCase = scenario === 'long-expanded' ? 'long-preview' : scenario
        const section = page.locator(`[data-case="${fixtureCase}"]`)
        await section.locator('pre').first().waitFor({ state: 'visible' })
        if (scenario === 'long-expanded') await page.getByTestId('tool-result-expand-long').click()
        const measurements = await section.evaluate(section => {
          const card = section.querySelector('.tool-bubble, .tool-group')
          const bounds = card.getBoundingClientRect()
          const content = [...section.querySelectorAll('.tool-bubble pre, .tool-input, .tool-group-entry-detail-content')]
          return {
            cardRight: bounds.right,
            pageWidth: document.documentElement.clientWidth,
            content: content.map(element => {
              const range = document.createRange()
              range.selectNodeContents(element)
              return {
                textLength: element.textContent.length,
                // A clipping-only fix still fails: Range measures the text's
                // actual geometry, even when an ancestor hides its overflow.
                textOutside: [...range.getClientRects()].some(rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1),
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
                block: element.tagName === 'PRE',
              }
            }),
          }
        })
        assert.ok(measurements.content.length > 0, 'Fixture must render tool content')
        assert.ok(measurements.content.some(item => item.textLength >= 300), 'Fixture must exercise long output')
        assert.ok(measurements.cardRight <= measurements.pageWidth + 1, 'Card exceeds the viewport')
        assert.ok(measurements.content.every(item => !item.textOutside), 'Text escapes the card boundary')
        assert.ok(measurements.content.every(item => !item.block || item.scrollWidth <= item.clientWidth + 1), 'Preformatted output must wrap inside its own box')
        if (process.env.TOOL_LAYOUT_SCREENSHOTS && width === 800) {
          await mkdir(process.env.TOOL_LAYOUT_SCREENSHOTS, { recursive: true })
          await section.screenshot({ path: join(process.env.TOOL_LAYOUT_SCREENSHOTS, `${scenario}.png`) })
        }
      } finally {
        await page.close()
      }
    })
  }
}
