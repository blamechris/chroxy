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
