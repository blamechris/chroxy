import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDiff } from '../src/diff-parser.js'

describe('parseDiff', () => {
  it('returns empty array for null/undefined/empty input', () => {
    assert.deepEqual(parseDiff(null), [])
    assert.deepEqual(parseDiff(undefined), [])
    assert.deepEqual(parseDiff(''), [])
  })

  it('parses a simple modified file diff', () => {
    const diff = [
      'diff --git a/src/app.js b/src/app.js',
      'index abc1234..def5678 100644',
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -10,6 +10,8 @@ function main() {',
      '   const x = 1',
      '-  const y = 2',
      '+  const y = 3',
      '+  const z = 4',
      '   return x',
    ].join('\n')

    const files = parseDiff(diff)
    assert.equal(files.length, 1)
    assert.equal(files[0].path, 'src/app.js')
    assert.equal(files[0].status, 'modified')
    assert.equal(files[0].additions, 2)
    assert.equal(files[0].deletions, 1)
    assert.equal(files[0].hunks.length, 1)

    const hunk = files[0].hunks[0]
    assert.equal(hunk.header, '@@ -10,6 +10,8 @@ function main() {')
    assert.equal(hunk.lines.length, 5)
    assert.deepEqual(hunk.lines[0], { type: 'context', content: '  const x = 1' })
    assert.deepEqual(hunk.lines[1], { type: 'deletion', content: '  const y = 2' })
    assert.deepEqual(hunk.lines[2], { type: 'addition', content: '  const y = 3' })
    assert.deepEqual(hunk.lines[3], { type: 'addition', content: '  const z = 4' })
    assert.deepEqual(hunk.lines[4], { type: 'context', content: '  return x' })
  })

  it('parses a new file', () => {
    const diff = [
      'diff --git a/new-file.txt b/new-file.txt',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/new-file.txt',
      '@@ -0,0 +1,3 @@',
      '+line 1',
      '+line 2',
      '+line 3',
    ].join('\n')

    const files = parseDiff(diff)
    assert.equal(files.length, 1)
    assert.equal(files[0].path, 'new-file.txt')
    assert.equal(files[0].status, 'added')
    assert.equal(files[0].additions, 3)
    assert.equal(files[0].deletions, 0)
  })

  it('parses a deleted file', () => {
    const diff = [
      'diff --git a/old-file.txt b/old-file.txt',
      'deleted file mode 100644',
      'index abc1234..0000000',
      '--- a/old-file.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line 1',
      '-line 2',
    ].join('\n')

    const files = parseDiff(diff)
    assert.equal(files.length, 1)
    assert.equal(files[0].path, 'old-file.txt')
    assert.equal(files[0].status, 'deleted')
    assert.equal(files[0].additions, 0)
    assert.equal(files[0].deletions, 2)
  })

  it('parses a renamed file', () => {
    const diff = [
      'diff --git a/old-name.js b/new-name.js',
      'similarity index 95%',
      'rename from old-name.js',
      'rename to new-name.js',
      'index abc1234..def5678 100644',
      '--- a/old-name.js',
      '+++ b/new-name.js',
      '@@ -1,3 +1,3 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 3',
      ' const c = 4',
    ].join('\n')

    const files = parseDiff(diff)
    assert.equal(files.length, 1)
    assert.equal(files[0].path, 'new-name.js')
    assert.equal(files[0].status, 'renamed')
    assert.equal(files[0].additions, 1)
    assert.equal(files[0].deletions, 1)
  })

  it('parses multiple files', () => {
    const diff = [
      'diff --git a/file1.js b/file1.js',
      'index abc..def 100644',
      '--- a/file1.js',
      '+++ b/file1.js',
      '@@ -1,2 +1,3 @@',
      ' line 1',
      '+new line',
      ' line 2',
      'diff --git a/file2.js b/file2.js',
      'index ghi..jkl 100644',
      '--- a/file2.js',
      '+++ b/file2.js',
      '@@ -5,3 +5,2 @@',
      ' line 5',
      '-removed',
      ' line 7',
    ].join('\n')

    const files = parseDiff(diff)
    assert.equal(files.length, 2)
    assert.equal(files[0].path, 'file1.js')
    assert.equal(files[0].additions, 1)
    assert.equal(files[0].deletions, 0)
    assert.equal(files[1].path, 'file2.js')
    assert.equal(files[1].additions, 0)
    assert.equal(files[1].deletions, 1)
  })

  it('parses multiple hunks in a single file', () => {
    const diff = [
      'diff --git a/big.js b/big.js',
      'index abc..def 100644',
      '--- a/big.js',
      '+++ b/big.js',
      '@@ -1,3 +1,4 @@',
      ' line 1',
      '+added early',
      ' line 2',
      ' line 3',
      '@@ -50,3 +51,2 @@',
      ' line 50',
      '-removed late',
      ' line 52',
    ].join('\n')

    const files = parseDiff(diff)
    assert.equal(files.length, 1)
    assert.equal(files[0].hunks.length, 2)
    assert.equal(files[0].hunks[0].header, '@@ -1,3 +1,4 @@')
    assert.equal(files[0].hunks[1].header, '@@ -50,3 +51,2 @@')
    assert.equal(files[0].additions, 1)
    assert.equal(files[0].deletions, 1)
  })

  it('handles binary files', () => {
    const diff = [
      'diff --git a/image.png b/image.png',
      'index abc..def 100644',
      'Binary files a/image.png and b/image.png differ',
    ].join('\n')

    const files = parseDiff(diff)
    assert.equal(files.length, 1)
    assert.equal(files[0].path, 'image.png')
    assert.equal(files[0].hunks.length, 1)
    assert.equal(files[0].hunks[0].header, 'Binary file')
  })

  it('handles non-string input gracefully', () => {
    assert.deepEqual(parseDiff(123), [])
    assert.deepEqual(parseDiff({}), [])
    assert.deepEqual(parseDiff(false), [])
  })
})
