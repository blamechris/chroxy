import assert from 'node:assert/strict'
import { before, after, describe, test } from 'node:test'
import { createServer } from 'node:http'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
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
//   - after scrolling it into view, each button's box lies inside its footer and
//     the viewport, the button is the topmost element at its centre point, and its
//     label does not overflow the button (scroll size vs client size).
// These are box, centre-point and overflow checks: they do not prove every pixel
// of a button is unobscured.
// jsdom lays nothing out, so this cannot live in vitest (ModalButtonTapTarget.test.ts
// only pins the CSS declarations). Runs in the Dashboard Smoke job beside the
// other *-layout.test.mjs files. No button is clicked and every handler in the
// fixture is a no-op.
// Isolation:
//   - The fixture is built ONCE with Vite's production `build()` (no dev server). A
//     dev-server page always loads /@vite/client, which opens an HMR WebSocket (the
//     HTML, every hot module and every JS-imported stylesheet import it); a production
//     bundle contains none of that, and the build output is asserted to name no
//     `@vite/client`. The build uses `configFile: false`, so vite.config.ts (and its
//     dev proxy) is never loaded; only what the fixture needs is restated (the React
//     plugin, the __APP_VERSION__ define, the `@` alias and React dedupe), with
//     `envDir: false` so no repo .env file is read.
//   - The build goes to a fresh temp directory outside the repo, and an owned static
//     server on 127.0.0.1 (port 0) serves only the fixture page and regular files whose
//     path is contained both lexically and by real path in that directory (GET/HEAD,
//     known MIME types, nosniff); a missing file is 404 and any other read error 500.
//     Server, browser and build directory are all removed in `after()`.
//   - Each case runs in a fresh browser context with service workers blocked,
//     HTTP(S) to anything but that server's origin aborted and every WebSocket
//     refused, all installed before navigation; any blocked attempt fails the case.

const root = fileURLToPath(new URL('../', import.meta.url))
const FIXTURE = 'scripts/modal-buttons-layout.fixture.tsx'
const PAGE = '/__modal-buttons-layout'
const BUILD_PREFIX = 'chroxy-modal-layout-build-'
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}
let browser
let server
let outDir
let origin

// Every regular file under `dir`, as paths relative to it (the build output is small).
function listFiles(dir, rel = '') {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name
    return e.isDirectory() ? listFiles(dir, p) : e.isFile() ? [p] : []
  })
}

// Serve the fixture page and regular files contained in `outDir`; everything else 404/405.
function serveBuild(html) {
  return createServer((req, res) => {
    const send = (status, type, body) => {
      res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'method not allowed')
    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
    } catch {
      return send(400, 'text/plain', 'bad request')
    }
    if (pathname === PAGE) return send(200, 'text/html; charset=utf-8', html)
    if (pathname.includes('\0')) return send(400, 'text/plain', 'bad request')
    // Lexical containment first, then the real path: a symlink anywhere on the way
    // (the file or an intermediate directory) must still land inside the real outDir.
    const file = resolve(outDir, '.' + pathname)
    const type = MIME[extname(file)]
    if (!file.startsWith(outDir + sep) || !type) return send(404, 'text/plain', 'not found')
    let body
    try {
      const real = realpathSync(file)
      if (!real.startsWith(outDir + sep) || !lstatSync(real).isFile()) return send(404, 'text/plain', 'not found')
      body = readFileSync(real)
    } catch (e) {
      return e && e.code === 'ENOENT' ? send(404, 'text/plain', 'not found') : send(500, 'text/plain', 'read failed')
    }
    send(200, type, body)
  })
}

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
    const pkg = JSON.parse(readFileSync(resolve(root, '../../package.json'), 'utf-8'))
    outDir = mkdtempSync(join(realpathSync(tmpdir()), BUILD_PREFIX))
    await build({
      configFile: false,
      root,
      base: '/',
      logLevel: 'error',
      // No .env files are loaded from the repo, and no public dir is copied.
      envDir: false,
      publicDir: false,
      define: { __APP_VERSION__: JSON.stringify(pkg.version) },
      resolve: { alias: { '@': resolve(root, 'src') }, dedupe: ['react', 'react-dom'] },
      plugins: [react()],
      build: {
        outDir,
        emptyOutDir: true,
        manifest: true,
        copyPublicDir: false,
        rollupOptions: { input: resolve(root, FIXTURE) },
      },
    })
    const manifest = JSON.parse(readFileSync(join(outDir, '.vite', 'manifest.json'), 'utf-8'))
    const entry = manifest[FIXTURE]
    assert.equal(Boolean(entry && entry.isEntry && entry.file), true, `the build manifest has an entry for ${FIXTURE}`)
    // A production bundle carries no dev client; if one ever appears, it would open a socket.
    const files = listFiles(outDir).filter(f => f.endsWith('.js') || f.endsWith('.css'))
    const withClient = files.filter(f => readFileSync(join(outDir, f), 'utf-8').includes('@vite/client'))
    assert.deepEqual(withClient, [], 'no built file references @vite/client')
    const css = (entry.css ?? []).map(f => `<link rel="stylesheet" href="/${f}">`).join('')
    const html = `<!doctype html><html><head><meta charset="utf-8">${css}</head><body><div id="root"></div><script type="module" src="/${entry.file}"></script></body></html>`
    server = serveBuild(html)
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) })
    origin = `http://127.0.0.1:${server.address().port}`
    browser = await chromium.launch({ headless: true })
  })

  after(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        if (server) {
          server.closeAllConnections?.()
          await new Promise(ok => server.close(() => ok()))
        }
      } finally {
        // Remove only the directory this run created.
        if (outDir && basename(outDir).startsWith(BUILD_PREFIX) && dirname(outDir) === realpathSync(tmpdir())) {
          rmSync(outDir, { recursive: true, force: true })
        }
      }
    }
  })

  for (const [caseName, expected] of Object.entries(CASES)) {
    for (const [vpName, viewport] of VIEWPORTS) {
      const withPage = async (fn) => {
        // A fresh context per case, isolated BEFORE navigation: service workers are
        // blocked, every HTTP(S) request to anything but the fixture server is aborted,
        // and every WebSocket is refused. Blocked attempts are recorded and fail the case.
        const context = await browser.newContext({ viewport, serviceWorkers: 'block' })
        // Everything after the context exists, setup included, is inside the try, so a
        // failed route/routeWebSocket/newPage still closes the context.
        try {
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
          page.setDefaultTimeout(10000)
          await page.goto(`${origin}/__modal-buttons-layout?case=${caseName}`)
          const m = await measure(page)
          console.log(`# ${caseName} ${vpName}: ${JSON.stringify(m)}`)
          assert.deepEqual(errors, [], 'the fixture page raised no error')
          await fn(m)
          assert.deepEqual(blocked, [], 'no request left the fixture server and no WebSocket was attempted')
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

      test(`${caseName} ${vpName}: each footer button's box is in its footer and the viewport, topmost at its centre, label not overflowing`, () => withPage(m => {
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
