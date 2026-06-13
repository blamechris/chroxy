// #5683 / #5684 — Chroxy Pages store.
//
// Manages HTML artifacts published to an unguessable, self-hosted URL served by
// the daemon's own HTTP server over the existing tunnel (see the `/p/<slug>`
// route in http-routes.js). The slug IS the access capability — anyone with the
// link can view the page, no bearer token required — so the slug must be
// cryptographically random and the serve path must be tightly contained.
//
// Storage layout (under ~/.chroxy/pages/, redirectable via the constructor for
// sandbox-safe tests):
//   pages/<slug>/index.html        — the page entry + any co-located assets
//   pages/index.json               — manifest { version, pages: { <slug>: meta } }
//
// Design: docs/design/chroxy-pages.md

import { randomBytes } from 'node:crypto'
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, rmSync,
  existsSync, realpathSync,
} from 'node:fs'
import { join, resolve, sep, posix } from 'node:path'

export const MANIFEST_VERSION = 1
export const DEFAULT_MAX_PAGE_BYTES = 5 * 1024 * 1024 //  5 MB per page
export const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024 // 100 MB across all pages
export const SLUG_BYTES = 16 // → 22-char base64url
export const DEFAULT_ENTRY = 'index.html'

// base64url alphabet; length-bounded to reject anything that isn't a plausible
// minted slug before it ever touches the filesystem.
const SLUG_RE = /^[A-Za-z0-9_-]{16,64}$/

/** True iff `slug` matches the minted-slug shape (cheap pre-fs guard). */
export function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug)
}

const EXT_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', // served, but script-src 'none' CSP blocks execution
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** MIME type for a file path by extension; `application/octet-stream` fallback. */
export function mimeForPath(p) {
  const dot = p.lastIndexOf('.')
  const ext = dot >= 0 ? p.slice(dot).toLowerCase() : ''
  return EXT_MIME[ext] || 'application/octet-stream'
}

export class PagesStore {
  /**
   * @param {object} opts
   * @param {string} opts.pagesDir          root dir for published pages (e.g. ~/.chroxy/pages)
   * @param {number} [opts.maxPageBytes]     per-page size cap
   * @param {number} [opts.maxTotalBytes]    total-across-pages size cap
   */
  constructor({ pagesDir, maxPageBytes = DEFAULT_MAX_PAGE_BYTES, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES } = {}) {
    if (!pagesDir) throw new Error('PagesStore requires a pagesDir')
    this._pagesDir = resolve(pagesDir)
    this._maxPageBytes = maxPageBytes
    this._maxTotalBytes = maxTotalBytes
    this._manifestPath = join(this._pagesDir, 'index.json')
    this._manifest = this._loadManifest()
  }

  _loadManifest() {
    try {
      const raw = JSON.parse(readFileSync(this._manifestPath, 'utf8'))
      if (raw && typeof raw === 'object' && raw.pages && typeof raw.pages === 'object') {
        return { version: MANIFEST_VERSION, pages: raw.pages }
      }
    } catch {
      // missing / malformed → fresh manifest
    }
    return { version: MANIFEST_VERSION, pages: {} }
  }

  _saveManifest() {
    const tmp = `${this._manifestPath}.tmp`
    try {
      mkdirSync(this._pagesDir, { recursive: true })
      writeFileSync(tmp, JSON.stringify(this._manifest), 'utf8')
      renameSync(tmp, this._manifestPath)
    } catch (err) {
      try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
      throw err
    }
  }

  /** Mint a fresh, unique, cryptographically-random base64url slug. */
  _mintSlug() {
    for (let i = 0; i < 8; i++) {
      const slug = randomBytes(SLUG_BYTES).toString('base64url')
      if (!this._manifest.pages[slug]) return slug
    }
    // Astronomically unlikely; fail loudly rather than overwrite.
    throw new Error('Failed to mint a unique page slug')
  }

  /** Current total bytes across all published pages. */
  _totalBytes() {
    let total = 0
    for (const slug in this._manifest.pages) total += this._manifest.pages[slug].bytes || 0
    return total
  }

  /**
   * Validate a relative file path supplied by a publisher: a forward-slash
   * relative path with no traversal, drive, or absolute component. Returns the
   * normalized relative path, or null if it would escape the page directory.
   */
  _safeRelPath(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0) return null
    // Reject backslashes, NUL, leading slash, drive letters up front.
    if (relPath.includes('\0') || relPath.includes('\\')) return null
    if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) return null
    const normalized = posix.normalize(relPath)
    if (normalized === '.' || normalized.startsWith('..') || normalized.includes('/../') || normalized.endsWith('/..')) {
      return null
    }
    if (normalized.startsWith('/')) return null
    return normalized
  }

  /**
   * Publish a page from an array of in-memory files.
   * @param {object} opts
   * @param {string} [opts.title]
   * @param {Array<{path: string, content: Buffer|string}>} opts.files — must include `index.html`
   * @returns {{ slug, title, createdAt, bytes, entry }}
   */
  publish({ title = 'Untitled', files } = {}) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('publish requires a non-empty files array')
    }
    // Normalize + validate every file path, and compute total size.
    const prepared = []
    let bytes = 0
    let hasEntry = false
    for (const f of files) {
      const rel = this._safeRelPath(f?.path)
      if (!rel) throw new Error(`Invalid page file path: ${JSON.stringify(f?.path)}`)
      const content = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content ?? ''), 'utf8')
      bytes += content.byteLength
      if (rel === DEFAULT_ENTRY) hasEntry = true
      prepared.push({ rel, content })
    }
    if (!hasEntry) throw new Error(`publish requires an "${DEFAULT_ENTRY}" file`)
    if (bytes > this._maxPageBytes) {
      throw new Error(`Page too large: ${bytes} bytes exceeds the ${this._maxPageBytes}-byte per-page cap`)
    }
    if (this._totalBytes() + bytes > this._maxTotalBytes) {
      throw new Error(`Publishing would exceed the ${this._maxTotalBytes}-byte total pages cap`)
    }

    const slug = this._mintSlug()
    const dir = join(this._pagesDir, slug)
    mkdirSync(dir, { recursive: true })
    for (const { rel, content } of prepared) {
      const dest = join(dir, rel)
      mkdirSync(resolve(dest, '..'), { recursive: true })
      writeFileSync(dest, content)
    }
    const meta = { slug, title: String(title).slice(0, 200), createdAt: Date.now(), bytes, entry: DEFAULT_ENTRY }
    this._manifest.pages[slug] = meta
    this._saveManifest()
    return meta
  }

  /** Convenience: publish a single self-contained HTML document. */
  publishHtml({ title, html } = {}) {
    return this.publish({ title, files: [{ path: DEFAULT_ENTRY, content: html }] })
  }

  /** Manifest entry for a slug, or null. */
  get(slug) {
    if (!isValidSlug(slug)) return null
    return this._manifest.pages[slug] || null
  }

  /** All published pages, newest first. */
  list() {
    return Object.values(this._manifest.pages).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  /** Delete a page (revokes its share link). Returns true if it existed. */
  remove(slug) {
    if (!isValidSlug(slug) || !this._manifest.pages[slug]) return false
    delete this._manifest.pages[slug]
    this._saveManifest()
    try { rmSync(join(this._pagesDir, slug), { recursive: true, force: true }) } catch { /* best-effort */ }
    return true
  }

  /**
   * Resolve a request for `pages/<slug>/<relPath>` to an absolute, CONTAINED
   * file path. Returns null when the slug is unknown/invalid, the relative path
   * is unsafe, or the resolved real path escapes the page directory (symlink
   * defence). An empty relPath resolves to the page's entry (index.html).
   */
  resolveFile(slug, relPath) {
    if (!isValidSlug(slug)) return null
    const meta = this._manifest.pages[slug]
    if (!meta) return null

    const rel = (!relPath || relPath === '' || relPath === '/') ? meta.entry || DEFAULT_ENTRY : this._safeRelPath(relPath)
    if (!rel) return null

    const pageDir = join(this._pagesDir, slug)
    const candidate = resolve(pageDir, rel)
    // Lexical containment: the resolved path must sit under the page dir.
    const pageDirWithSep = resolve(pageDir) + sep
    if (candidate !== resolve(pageDir) && !candidate.startsWith(pageDirWithSep)) return null
    if (!existsSync(candidate)) return null
    // Symlink defence: the REAL path must also stay contained.
    let real
    try { real = realpathSync(candidate) } catch { return null }
    const realDir = (() => { try { return realpathSync(pageDir) } catch { return resolve(pageDir) } })()
    if (real !== realDir && !real.startsWith(realDir + sep)) return null
    return real
  }
}
