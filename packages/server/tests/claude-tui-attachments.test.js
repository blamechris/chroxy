import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { materializeAttachments, buildAttachmentsPromptSuffix } from '../src/claude-tui-attachments.js'

describe('claude-tui-attachments', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-tui-att-'))
  })

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  describe('materializeAttachments()', () => {
    it('returns [] and writes nothing for empty / null input', () => {
      assert.deepEqual(materializeAttachments(null, dir, 'msg-1'), [])
      assert.deepEqual(materializeAttachments([], dir, 'msg-1'), [])
      // No turn subdir should have been created either.
      assert.deepEqual(readdirSync(dir), [])
    })

    it('writes each attachment to a per-turn subdir with content-preserving bytes', () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
      const att = {
        type: 'image',
        mediaType: 'image/png',
        data: png.toString('base64'),
        name: 'screenshot.png',
      }
      const out = materializeAttachments([att], dir, 'msg-7')

      assert.equal(out.length, 1)
      assert.equal(out[0].name, 'screenshot.png')
      assert.equal(out[0].mediaType, 'image/png')
      assert.equal(out[0].size, png.length)
      assert.ok(out[0].path.includes('msg-7'), 'path lives inside per-turn subdir')
      assert.ok(existsSync(out[0].path), 'file exists on disk')
      const written = readFileSync(out[0].path)
      assert.ok(written.equals(png), 'bytes round-trip through base64 decode')
    })

    it('numbers files sequentially as att-1, att-2, ... not by user-supplied name', () => {
      // Filename is intentionally NOT the user's `name` field — that
      // value is path-unsafe (could contain ../, slashes, control chars).
      // We only display the original name in the prompt suffix; the
      // on-disk filename is always a predictable att-N pattern.
      const atts = [
        { type: 'image', mediaType: 'image/png', data: Buffer.from('a').toString('base64'), name: '../escape.png' },
        { type: 'image', mediaType: 'image/png', data: Buffer.from('b').toString('base64'), name: 'normal.png' },
      ]
      const out = materializeAttachments(atts, dir, 'msg-1')
      assert.equal(out.length, 2)
      assert.ok(out[0].path.endsWith('/att-1.png'), `expected att-1.png, got ${out[0].path}`)
      assert.ok(out[1].path.endsWith('/att-2.png'), `expected att-2.png, got ${out[1].path}`)
    })

    it('picks the extension from the original filename when present', () => {
      // mediaType text/plain would naturally map to .txt; prefer the
      // user's .tsx so syntax highlighting / `claude` Read tool's
      // language detection don't get misled.
      const att = {
        type: 'document',
        mediaType: 'text/plain',
        data: Buffer.from('export const x = 1').toString('base64'),
        name: 'App.tsx',
      }
      const out = materializeAttachments([att], dir, 'msg-2')
      assert.ok(out[0].path.endsWith('.tsx'), `expected .tsx from name, got ${out[0].path}`)
    })

    it('falls back to mediaType→extension when name has no extension', () => {
      const att = {
        type: 'document',
        mediaType: 'application/pdf',
        data: Buffer.from('%PDF-1.4').toString('base64'),
        name: 'paper',   // no extension
      }
      const out = materializeAttachments([att], dir, 'msg-3')
      assert.ok(out[0].path.endsWith('.pdf'), `expected .pdf from mediaType, got ${out[0].path}`)
    })

    it('falls back to .bin for unknown mediaType + extension-less name', () => {
      const att = {
        type: 'document',
        mediaType: 'application/x-totally-unknown',
        data: Buffer.from('opaque').toString('base64'),
        name: 'mystery',
      }
      const out = materializeAttachments([att], dir, 'msg-4')
      assert.ok(out[0].path.endsWith('.bin'), `expected .bin fallback, got ${out[0].path}`)
    })

    it('sanitizes the display name (no slashes / control chars)', () => {
      const att = {
        type: 'document',
        mediaType: 'text/plain',
        data: Buffer.from('x').toString('base64'),
        name: '../etc/passwd\nlol',
      }
      const out = materializeAttachments([att], dir, 'msg-5')
      assert.ok(!out[0].name.includes('/'), `slashes stripped, got ${JSON.stringify(out[0].name)}`)
      assert.ok(!out[0].name.includes('\n'), 'control chars stripped')
    })

    it('skips attachments missing data instead of crashing the whole turn', () => {
      // Upstream validation should catch this, but defense-in-depth.
      // A bad entry should not abort materialization of the good ones.
      const atts = [
        { type: 'image', mediaType: 'image/png', data: undefined, name: 'broken.png' },
        { type: 'image', mediaType: 'image/png', data: Buffer.from('ok').toString('base64'), name: 'good.png' },
      ]
      const out = materializeAttachments(atts, dir, 'msg-6')
      assert.equal(out.length, 1, 'only the well-formed attachment is materialized')
      assert.equal(out[0].name, 'good.png')
    })
  })

  describe('buildAttachmentsPromptSuffix()', () => {
    it('returns empty string for empty / null input', () => {
      assert.equal(buildAttachmentsPromptSuffix(null), '')
      assert.equal(buildAttachmentsPromptSuffix([]), '')
    })

    it('lists each file with its path and metadata', () => {
      const files = [
        { path: '/tmp/x/msg-1/att-1.png', name: 'screenshot.png', mediaType: 'image/png', size: 23456 },
        { path: '/tmp/x/msg-1/att-2.txt', name: 'notes.txt', mediaType: 'text/plain', size: 800 },
      ]
      const suffix = buildAttachmentsPromptSuffix(files)
      assert.ok(suffix.startsWith('\n'), 'starts with a separator so it appends cleanly')
      assert.match(suffix, /attached the following file\(s\)/)
      assert.match(suffix, /\/tmp\/x\/msg-1\/att-1\.png/)
      assert.match(suffix, /screenshot\.png/)
      assert.match(suffix, /image\/png/)
      assert.match(suffix, /22\.9KB|23\.0KB/)   // 23456 / 1024 ≈ 22.9
      assert.match(suffix, /\/tmp\/x\/msg-1\/att-2\.txt/)
      assert.match(suffix, /800B/)
    })

    it('formats byte sizes in B / KB / MB', () => {
      const files = [
        { path: '/a/tiny', name: 'a', mediaType: 'application/octet-stream', size: 42 },
        { path: '/a/kb', name: 'b', mediaType: 'application/octet-stream', size: 12 * 1024 },
        { path: '/a/mb', name: 'c', mediaType: 'application/octet-stream', size: 3 * 1024 * 1024 },
      ]
      const suffix = buildAttachmentsPromptSuffix(files)
      assert.match(suffix, /42B/, 'bytes')
      assert.match(suffix, /12\.0KB/, 'KB')
      assert.match(suffix, /3\.0MB/, 'MB')
    })
  })
})
