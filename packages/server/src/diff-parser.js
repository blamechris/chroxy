/**
 * Parse unified diff output from `git diff` into structured data.
 *
 * Handles:
 * - File headers (diff --git a/... b/...)
 * - Hunk headers (@@ -start,count +start,count @@)
 * - Context lines (space prefix), additions (+), deletions (-)
 * - New files (status: 'added'), deleted files (status: 'deleted')
 * - Renamed files (status: 'renamed')
 * - Binary files (skipped with note)
 */

/**
 * @typedef {Object} DiffLine
 * @property {'context'|'addition'|'deletion'} type
 * @property {string} content
 */

/**
 * @typedef {Object} DiffHunk
 * @property {string} header
 * @property {DiffLine[]} lines
 */

/**
 * @typedef {Object} DiffFile
 * @property {string} path
 * @property {'modified'|'added'|'deleted'|'renamed'|'untracked'} status
 * @property {number} additions
 * @property {number} deletions
 * @property {DiffHunk[]} hunks
 */

/**
 * Parse unified diff output into structured file data.
 * @param {string} diffOutput - Raw output from `git diff`
 * @returns {DiffFile[]}
 */
export function parseDiff(diffOutput) {
  if (!diffOutput || typeof diffOutput !== 'string') return []

  const lines = diffOutput.split('\n')
  const files = []
  let currentFile = null
  let currentHunk = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // File header: diff --git a/path b/path
    if (line.startsWith('diff --git ')) {
      // Finalize previous file
      if (currentFile) {
        if (currentHunk) currentFile.hunks.push(currentHunk)
        files.push(currentFile)
      }

      // Extract path from "diff --git a/path b/path"
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/)
      const path = match ? match[2] : 'unknown'

      currentFile = {
        path,
        status: 'modified',
        additions: 0,
        deletions: 0,
        hunks: [],
      }
      currentHunk = null
      continue
    }

    if (!currentFile) continue

    // Detect new file
    if (line.startsWith('new file mode')) {
      currentFile.status = 'added'
      continue
    }

    // Detect deleted file
    if (line.startsWith('deleted file mode')) {
      currentFile.status = 'deleted'
      continue
    }

    // Detect renamed file
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      currentFile.status = 'renamed'
      continue
    }

    // Detect similarity index (rename marker)
    if (line.startsWith('similarity index ')) {
      currentFile.status = 'renamed'
      continue
    }

    // Binary file marker
    if (line.startsWith('Binary files ')) {
      currentFile.status = currentFile.status || 'modified'
      // Add a note hunk for binary files
      currentFile.hunks.push({
        header: 'Binary file',
        lines: [{ type: 'context', content: line }],
      })
      continue
    }

    // Skip --- and +++ file markers
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      // Detect /dev/null for added/deleted files
      if (line === '--- /dev/null') {
        currentFile.status = 'added'
      } else if (line === '+++ /dev/null') {
        currentFile.status = 'deleted'
      }
      continue
    }

    // Skip index lines (index abc..def 100644)
    if (line.startsWith('index ')) continue

    // Hunk header: @@ -start,count +start,count @@ optional context
    if (line.startsWith('@@ ')) {
      if (currentHunk) currentFile.hunks.push(currentHunk)
      currentHunk = {
        header: line,
        lines: [],
      }
      continue
    }

    if (!currentHunk) continue

    // Diff content lines
    if (line.startsWith('+')) {
      currentHunk.lines.push({ type: 'addition', content: line.slice(1) })
      currentFile.additions++
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ type: 'deletion', content: line.slice(1) })
      currentFile.deletions++
    } else if (line.startsWith(' ') || line === '') {
      // Context line (space prefix) or empty line at end of hunk
      currentHunk.lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line })
    }
    // Skip "\ No newline at end of file" and other backslash lines
  }

  // Finalize last file
  if (currentFile) {
    if (currentHunk) currentFile.hunks.push(currentHunk)
    files.push(currentFile)
  }

  return files
}

// git C-quotes a path that holds a special byte (non-ASCII under the default
// core.quotePath, a tab, a quote, a backslash): `"a/caf\303\251.json"`.
const GIT_QUOTE_ESCAPES = { a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b, '\\': 0x5c, '"': 0x22 }

/**
 * Decode the body of a git C-quoted path (the text between the quotes). Walks code
 * points, not UTF-16 units: a character outside the BMP (an emoji) is two units, and
 * encoding each lone surrogate separately yields U+FFFD twice.
 */
function unquoteGitPath(body) {
  const chars = Array.from(body)
  const bytes = []
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b)
      continue
    }
    const next = chars[i + 1]
    if (next >= '0' && next <= '7') {
      let oct = ''
      let j = i + 1
      while (j < chars.length && oct.length < 3 && chars[j] >= '0' && chars[j] <= '7') oct += chars[j++]
      bytes.push(parseInt(oct, 8) & 0xff)
      i = j - 1
    } else if (next in GIT_QUOTE_ESCAPES) {
      bytes.push(GIT_QUOTE_ESCAPES[next])
      i++
    } else {
      bytes.push(0x5c)
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * The path(s) each `diff --git` header names, one array per header, in the order
 * {@link parseDiff} returns its files (it starts a file at exactly those lines), so
 * `diffFileHeaderPaths(text)[i]` belongs to `parseDiff(text)[i]`.
 *
 * parseDiff keeps only the `b/` side and cannot read a C-quoted name, so a caller
 * that must know EVERY path a file entry touches (the source of a rename, a name
 * git quoted) reads it here. Paths are relative to the repository root, as git
 * prints them. A plain name may itself contain spaces, which makes a header with
 * two different plain names ambiguous; every split is returned rather than a guess,
 * so a caller asking "does any of these match" cannot be fooled by the ambiguity.
 *
 * A header with no recognisable `a/` / `b/` path yields `[]` (for example
 * `diff.mnemonicPrefix` or `diff.noprefix` output) and the caller decides what an
 * unplaceable entry means.
 *
 * @param {string} diffOutput - Raw output from `git diff`
 * @returns {string[][]}
 */
export function diffFileHeaderPaths(diffOutput) {
  if (!diffOutput || typeof diffOutput !== 'string') return []
  const headers = []
  for (const line of diffOutput.split('\n')) {
    if (!line.startsWith('diff --git ')) continue
    const found = new Set()
    const add = (p) => { if (p) found.add(p) }
    // Quoted names are unambiguous: lift them out first.
    const plain = line.slice('diff --git '.length)
      .replace(/"((?:[^"\\]|\\.)*)"/g, (_m, body) => {
        const decoded = unquoteGitPath(body)
        if (decoded.startsWith('a/') || decoded.startsWith('b/')) add(decoded.slice(2))
        return '\0'
      })
      .replace(/\0/g, '')
      .trim()
    // What is left is `a/<path> b/<path>` (or one side of it).
    if (plain.startsWith('a/') || plain.startsWith('b/')) {
      let from = 0
      let split = plain.indexOf(' b/', from)
      if (split === -1) add(plain.slice(2))
      while (split !== -1) {
        add(plain.slice(2, split))
        add(plain.slice(split + 3))
        from = split + 1
        split = plain.indexOf(' b/', from)
      }
    }
    headers.push([...found])
  }
  return headers
}
