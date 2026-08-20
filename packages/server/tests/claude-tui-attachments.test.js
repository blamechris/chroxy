import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, chmodSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename, dirname } from 'path'
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
      assert.equal(basename(out[0].path), 'att-1.png', `expected att-1.png, got ${out[0].path}`)
      assert.equal(basename(dirname(out[0].path)), 'msg-1', 'file must live in the per-turn subdir')
      assert.equal(basename(out[1].path), 'att-2.png', `expected att-2.png, got ${out[1].path}`)
      assert.equal(basename(dirname(out[1].path)), 'msg-1', 'file must live in the per-turn subdir')
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

    it('rejects unsafe extensions (control chars, slashes, absurd length) and falls back', () => {
      // pickExtension trusts extname(name) only when it matches a tight
      // allowlist (short ASCII alphanumerics). A malicious or sloppy
      // client could otherwise smuggle newlines, path separators, or
      // megabytes of junk into the on-disk att-N<ext> filename — the
      // upstream validator only checks that name is a string.
      const cases = [
        { name: 'evil.png\nlol', mediaType: 'image/png', expectExt: '.png' },           // control char in ext
        { name: 'bad.with spaces', mediaType: 'image/png', expectExt: '.png' },         // space in ext
        // The NUL is written as a \u0000 ESCAPE, never as a raw byte (#7103): the
        // byte must still reach pickExtension()'s SAFE_EXTENSION gate at runtime,
        // but a literal NUL in this file hides the WHOLE file from every
        // NUL-sniffing code search. Deleting it would silently delete the only
        // coverage for NUL sanitization in an attachment extension.
        { name: 'bad.\u0000nul', mediaType: 'image/png', expectExt: '.png' },        // NUL in ext
        { name: `huge.${'a'.repeat(500)}`, mediaType: 'image/png', expectExt: '.png' }, // absurdly long ext
        { name: 'no-real-ext.', mediaType: 'image/png', expectExt: '.png' },            // bare dot
        { name: 'weird.💀', mediaType: 'image/png', expectExt: '.png' },                 // non-ASCII
      ]
      for (const c of cases) {
        const out = materializeAttachments(
          [{ type: 'image', mediaType: c.mediaType, data: Buffer.from('x').toString('base64'), name: c.name }],
          dir,
          `safe-ext-${Math.random().toString(36).slice(2)}`,
        )
        assert.ok(
          out[0].path.endsWith(c.expectExt),
          `name=${JSON.stringify(c.name)} should fall back to ${c.expectExt}, got ${out[0].path}`,
        )
      }
    })

    it('preserves common compound extensions (.tar.gz, .tar.bz2, ...) [#4023]', () => {
      // extname() only returns the final extension, so without explicit
      // compound-extension handling `archive.tar.gz` becomes `.gz` on
      // disk and the agent loses the "this is a tarball" hint. Pin the
      // four documented compounds + case-insensitivity.
      const cases = [
        { name: 'archive.tar.gz', expectExt: '.tar.gz' },
        { name: 'snapshot.tar.bz2', expectExt: '.tar.bz2' },
        { name: 'data.tar.xz', expectExt: '.tar.xz' },
        { name: 'big.tar.zst', expectExt: '.tar.zst' },
        // Case-insensitive lookup, original case preserved in result.
        { name: 'ARCHIVE.TAR.GZ', expectExt: '.TAR.GZ' },
        { name: 'Mixed.TaR.Gz', expectExt: '.TaR.Gz' },
        // Compound must match the END of the name; a `.tar.gz` mid-name
        // doesn't count.
        { name: 'archive.tar.gz.bak', expectExt: '.bak' },
      ]
      for (const c of cases) {
        const out = materializeAttachments(
          [{ type: 'document', mediaType: 'application/octet-stream', data: Buffer.from('x').toString('base64'), name: c.name }],
          dir,
          `compound-${Math.random().toString(36).slice(2)}`,
        )
        assert.ok(
          out[0].path.endsWith(c.expectExt),
          `name=${JSON.stringify(c.name)} should keep ${c.expectExt}, got ${out[0].path}`,
        )
      }
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

    // #5333 (IP-5) — disk-write failure containment contract. The bare
    // mkdirSync/writeFileSync in materializeAttachments deliberately let an
    // fs fault (ENOSPC, ENOTDIR, EACCES, ...) propagate to the caller: the
    // ONLY call site (claude-tui-session.js sendMessage, #4012/#4021) wraps
    // the call in try/catch, warns, and proceeds with the unaugmented prompt
    // — so a full disk degrades one turn's attachments, it does not crash
    // the daemon. This test pins the "throws upward" half of that contract;
    // if a refactor swallows fs faults here instead, the caller's warn (and
    // the user-visible "attachments dropped" signal) silently disappears.
    it('propagates a disk-write fault to the caller instead of swallowing it (#5333)', () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      const att = { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'x.png' }
      // Point baseDir UNDER a regular file so mkdirSync faults like a real
      // fs-layer failure (ENOTDIR here; same propagation path as ENOSPC).
      const fileAsDir = join(dir, 'not-a-dir')
      writeFileSync(fileAsDir, 'x')
      assert.throws(
        () => materializeAttachments([att], join(fileAsDir, 'attachments'), 'msg-9'),
        (err) => typeof err.code === 'string',
        'expected a real fs error (with a code), not a synthetic throw',
      )
    })

    // Companion to the test above: same contract, but faulting at the
    // writeFileSync stage (mkdir succeeds, the per-file write fails) so a
    // future per-attachment try/catch refactor can't swallow write-stage
    // ENOSPC-class faults without failing a test. POSIX-only: chmod-based
    // read-only dirs don't translate to win32 semantics, and root bypasses
    // permission checks entirely.
    it('propagates a write-stage fault too (read-only turn dir) (#5333)', {
      skip: process.platform === 'win32' || process.getuid?.() === 0,
    }, () => {
      const att = { type: 'image', mediaType: 'image/png', data: Buffer.from('x').toString('base64'), name: 'x.png' }
      const turnDir = join(dir, 'msg-ro')
      mkdirSync(turnDir, { recursive: true, mode: 0o500 })
      try {
        assert.throws(
          () => materializeAttachments([att], dir, 'msg-ro'),
          (err) => typeof err.code === 'string',
          'expected the writeFileSync fault to propagate to the caller',
        )
      } finally {
        // Re-open the dir so afterEach's rmSync can clean the tree.
        chmodSync(turnDir, 0o700)
      }
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

    it('numbers surviving files sequentially when earlier entries are skipped', () => {
      // The on-disk filename counter advances only on successful writes —
      // if the first attachment is malformed, the second one becomes
      // att-1, not att-2. Avoids confusing gaps in the per-turn dir.
      const atts = [
        { type: 'image', mediaType: 'image/png', data: undefined, name: 'broken1.png' },
        { type: 'image', mediaType: 'image/png', data: Buffer.from('a').toString('base64'), name: 'first-good.png' },
        { type: 'image', mediaType: 'image/png', data: undefined, name: 'broken2.png' },
        { type: 'image', mediaType: 'image/png', data: Buffer.from('b').toString('base64'), name: 'second-good.png' },
      ]
      const out = materializeAttachments(atts, dir, 'msg-skip-seq')
      assert.equal(out.length, 2)
      assert.equal(basename(out[0].path), 'att-1.png', `expected att-1.png, got ${out[0].path}`)
      assert.equal(basename(dirname(out[0].path)), 'msg-skip-seq', 'file must live in the per-turn subdir')
      assert.equal(basename(out[1].path), 'att-2.png', `expected att-2.png, got ${out[1].path}`)
      assert.equal(basename(dirname(out[1].path)), 'msg-skip-seq', 'file must live in the per-turn subdir')
      // And on disk: exactly att-1.png and att-2.png, no gaps.
      const files = readdirSync(join(dir, 'msg-skip-seq')).sort()
      assert.deepEqual(files, ['att-1.png', 'att-2.png'])
    })
  })

  describe('buildAttachmentsPromptSuffix()', () => {
    // #4026: function now returns { suffix, truncated, omitted, bareFallback,
    // byteLength, cap } so the caller (claude-tui-session.js) can log a warn
    // when the cap fires. Previously returned just the string and the
    // truncation was silent — that defeated the cap's whole purpose
    // (catching pathological path-generation regressions before users notice).

    it('returns empty-suffix result for empty / null input', () => {
      const r1 = buildAttachmentsPromptSuffix(null)
      assert.equal(r1.suffix, '')
      assert.equal(r1.truncated, false)
      assert.equal(r1.omitted, 0)
      assert.equal(r1.bareFallback, false)
      const r2 = buildAttachmentsPromptSuffix([])
      assert.equal(r2.suffix, '')
      assert.equal(r2.truncated, false)
    })

    it('contains NO embedded newlines — the TUI PTY treats \\n as Enter', () => {
      // The whole reason this suffix is single-line — see the function
      // docstring + the parallel comment in claude-tui-session.js where
      // skills-prefix routes around the same PTY behaviour. If this
      // assertion ever fails, the fix has regressed and turns will
      // prematurely submit mid-suffix.
      const files = [
        { path: '/tmp/x/msg-1/att-1.png', name: 'a.png', mediaType: 'image/png', size: 100 },
        { path: '/tmp/x/msg-1/att-2.txt', name: 'b.txt', mediaType: 'text/plain', size: 200 },
        { path: '/tmp/x/msg-1/att-3.md', name: 'c.md', mediaType: 'text/markdown', size: 300 },
      ]
      const { suffix } = buildAttachmentsPromptSuffix(files)
      assert.ok(!suffix.includes('\n'), `suffix must not contain LF, got ${JSON.stringify(suffix)}`)
      assert.ok(!suffix.includes('\r'), 'suffix must not contain CR either')
    })

    it('lists each file with its path and metadata', () => {
      const files = [
        { path: '/tmp/x/msg-1/att-1.png', name: 'screenshot.png', mediaType: 'image/png', size: 23456 },
        { path: '/tmp/x/msg-1/att-2.txt', name: 'notes.txt', mediaType: 'text/plain', size: 800 },
      ]
      const { suffix, truncated, omitted } = buildAttachmentsPromptSuffix(files)
      assert.ok(suffix.startsWith(' '), 'starts with a space so it appends cleanly to the user prompt')
      assert.match(suffix, /attached the following file\(s\)/)
      assert.match(suffix, /\/tmp\/x\/msg-1\/att-1\.png/)
      assert.match(suffix, /screenshot\.png/)
      assert.match(suffix, /image\/png/)
      assert.match(suffix, /22\.9KB|23\.0KB/)   // 23456 / 1024 ≈ 22.9
      assert.match(suffix, /\/tmp\/x\/msg-1\/att-2\.txt/)
      assert.match(suffix, /800B/)
      // Single-line list separator.
      assert.match(suffix, /;/, 'multi-file list uses ; separator')
      // Happy path — no truncation flags should be set.
      assert.equal(truncated, false)
      assert.equal(omitted, 0)
    })

    it('caps suffix at MAX_ATTACHMENT_SUFFIX_BYTES and notes the omitted count [#4024] + flags truncation [#4026]', () => {
      // Build many entries with a path long enough that the full suffix
      // would exceed 8KB. Each entry ~300 bytes, so ~30 entries lands
      // squarely past the cap. The truncation marker explicitly names
      // the omitted count so the agent (and a human reading the
      // transcript) knows files were dropped.
      const longPath = '/tmp/chroxy-claude-tui/s-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/attachments/msg-1'
      const files = []
      for (let i = 1; i <= 40; i++) {
        files.push({
          path: `${longPath}/att-${i}-with-an-unusually-padded-name-for-testing.png`,
          name: `attachment-${i}-with-an-unusually-padded-name-for-testing.png`,
          mediaType: 'image/png',
          size: 1024,
        })
      }
      const result = buildAttachmentsPromptSuffix(files)
      // Hard byte ceiling: must respect the cap.
      assert.ok(Buffer.byteLength(result.suffix, 'utf8') <= 8 * 1024,
        `suffix should fit under 8KB cap, got ${Buffer.byteLength(result.suffix, 'utf8')} bytes`)
      // Truncation marker present.
      assert.match(result.suffix, /\.\.\.and \d+ more file\(s\) omitted/,
        `expected truncation marker in suffix, got: ${result.suffix.slice(-200)}`)
      // Single-line invariant from #4012 still holds even after truncation.
      assert.ok(!result.suffix.includes('\n'), 'truncated suffix must still be single-line')
      // #4026: structured flags pin the observable signal the caller's
      // log.warn keys off. Without these, ops can't grep production
      // logs for cap-fires.
      assert.equal(result.truncated, true)
      assert.equal(result.bareFallback, false)
      assert.ok(result.omitted > 0 && result.omitted < files.length,
        `omitted must be (0, files.length) for regular truncation, got ${result.omitted}`)
      assert.equal(result.byteLength, Buffer.byteLength(result.suffix, 'utf8'))
      assert.equal(result.cap, 8 * 1024)
    })

    it('returns a bare marker + bareFallback flag when even one entry is bigger than the cap [#4026]', () => {
      // Pathological: single path that alone exceeds 8KB. The function
      // should degrade gracefully rather than throw or emit something
      // garbled — the files are still on disk and the agent at least
      // knows attachments were intended.
      const huge = '/' + 'x'.repeat(10 * 1024)
      const result = buildAttachmentsPromptSuffix([
        { path: huge, name: 'huge', mediaType: 'application/octet-stream', size: 1 },
      ])
      assert.match(result.suffix, /Attachment list omitted: 1 file\(s\) exceeded the suffix size cap/)
      assert.ok(Buffer.byteLength(result.suffix, 'utf8') <= 8 * 1024 + 200,
        `bare marker should fit in the small fallback budget, got ${Buffer.byteLength(result.suffix, 'utf8')} bytes`)
      // #4026: bareFallback === true is the SEPARATE log line the caller
      // emits (ops differentiates "some files dropped" from "all paths
      // omitted from prompt" — the latter is the worst, most-lossy path
      // and signals a pathological path-generation regression).
      assert.equal(result.truncated, true)
      assert.equal(result.bareFallback, true)
      assert.equal(result.omitted, 1, 'omitted equals total files count when bare-fallback fires')
    })

    it('formats byte sizes in B / KB / MB', () => {
      const files = [
        { path: '/a/tiny', name: 'a', mediaType: 'application/octet-stream', size: 42 },
        { path: '/a/kb', name: 'b', mediaType: 'application/octet-stream', size: 12 * 1024 },
        { path: '/a/mb', name: 'c', mediaType: 'application/octet-stream', size: 3 * 1024 * 1024 },
      ]
      const { suffix } = buildAttachmentsPromptSuffix(files)
      assert.match(suffix, /42B/, 'bytes')
      assert.match(suffix, /12\.0KB/, 'KB')
      assert.match(suffix, /3\.0MB/, 'MB')
    })
  })
})
