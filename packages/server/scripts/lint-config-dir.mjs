#!/usr/bin/env node
/**
 * Lint: `~/.chroxy` has exactly one resolver — `src/config-dir.js`.
 *
 * `CHROXY_CONFIG_DIR` is supposed to relocate the daemon's entire config/state
 * root. For a long time it relocated only half of it (#7052), and the reason is
 * visible in the two shapes this lint bans:
 *
 *   1. `join(homedir(), '.chroxy', …)` — a hardcoded home-rooted path that
 *      ignores the override outright. Sixteen module-scope constants and
 *      twenty-seven in-function sites had this.
 *
 *   2. `process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')` — an
 *      inline copy of the resolver. Sixteen modules grew one independently,
 *      *because* the shared constant could not be made to honor the env (a
 *      `const` freezes at import). Each copy is correct in isolation and each
 *      one is a place the convention can silently drift.
 *
 * Both are replaced by `configDir()` / `configPath(...segments)`, which read
 * the environment per call.
 *
 * NOT matched (and deliberately so):
 *   - `join(homedir(), 'AppData', 'Local')` in keychain.js — a Windows
 *     credential path, not chroxy state.
 *   - `join(homedir(), '.claude.json')` in byok-mcp-config.js — Claude Code's
 *     own config file, which chroxy reads but does not own.
 *   - anything inside a `//` line comment or a `/* *\/` block comment. This
 *     matters: `cli/schedule-cmd.js`'s doc block quotes the banned pattern in
 *     prose while explaining the migration.
 *
 * Allow-list / opt-out:
 *   - `config-dir.js` — the OWNER of the resolution, exempt wholesale.
 *   - the baseline file (`lint-config-dir-baseline.txt`), one repo-relative
 *     path per line, exempts a file that has not been migrated yet. The
 *     ratchet: a file may leave the baseline, never join it. Mirrors
 *     `scripts/no-raw-color-literals-baseline.txt`.
 *   - `// lint-ignore-config-dir` on the line immediately above an offending
 *     line whitelists that one site.
 *
 * Issue: #7052.
 *
 * Exit codes:
 *   0 — no un-baselined offenders, and no stale baseline entries
 *   1 — at least one offender, or a baseline entry that is now clean
 *
 * Flags:
 *   --src-dir <path>    Override the src directory (used by the golden test
 *                       against fixture trees). Defaults to `../src`.
 *   --baseline <path>   Override the baseline file. Defaults to
 *                       `./lint-config-dir-baseline.txt`.
 *   --write-baseline    Rewrite the baseline from what is currently on disk.
 *   --dry-run           Print offenders without failing the exit code.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative, sep as pathSep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const OWNER = 'config-dir.js'
const IGNORE_MARKER = 'lint-ignore-config-dir'

function parseArgs(argv) {
  const out = { srcDir: null, baseline: null, writeBaseline: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src-dir') out.srcDir = argv[++i]
    else if (argv[i] === '--baseline') out.baseline = argv[++i]
    else if (argv[i] === '--write-baseline') out.writeBaseline = true
    else if (argv[i] === '--dry-run') out.dryRun = true
  }
  return out
}

function listJsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listJsFiles(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out.sort()
}

/**
 * Blank out comment spans so a doc block that *quotes* the banned pattern is
 * not itself an offender. Returns a line array of the same length, with
 * commented regions replaced by spaces (line numbers stay accurate).
 */
function stripComments(source) {
  const out = []
  let inBlock = false
  for (const line of source.split('\n')) {
    let kept = ''
    let i = 0
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i)
        if (end === -1) { i = line.length } else { inBlock = false; i = end + 2 }
        continue
      }
      if (line.startsWith('//', i)) break
      if (line.startsWith('/*', i)) { inBlock = true; i += 2; continue }
      kept += line[i]
      i++
    }
    out.push(kept)
  }
  return out
}

// A home-rooted chroxy path: `homedir()` and `.chroxy` on the same statement.
const RAW_HOME_ROOTED = /homedir\s*\(\s*\)/
const CHROXY_SEGMENT = /['"`]\.chroxy['"`]/

function findOffenders(srcDir) {
  const offenders = []
  for (const file of listJsFiles(srcDir)) {
    const rel = relative(srcDir, file).split(pathSep).join('/')
    if (rel === OWNER) continue

    const source = readFileSync(file, 'utf8')
    const rawLines = source.split('\n')
    const code = stripComments(source)

    code.forEach((line, idx) => {
      if (!RAW_HOME_ROOTED.test(line) || !CHROXY_SEGMENT.test(line)) return
      const prev = idx > 0 ? rawLines[idx - 1] : ''
      if (prev.includes(IGNORE_MARKER)) return
      // `env.CHROXY_CONFIG_DIR` too, not just `process.env.…` — cli/tokens-cmd.js
      // destructures `env` from its opts, and it is an inline copy all the same.
      const inlineResolver = /\benv\.CHROXY_CONFIG_DIR/.test(line)
      offenders.push({
        file: rel,
        line: idx + 1,
        kind: inlineResolver ? 'inline-resolver-copy' : 'hardcoded-home-path',
        text: rawLines[idx].trim(),
      })
    })
  }
  return offenders
}

function readBaseline(path) {
  if (!existsSync(path)) return new Set()
  return new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  )
}

const args = parseArgs(process.argv.slice(2))
const srcDir = resolve(args.srcDir ?? join(__dirname, '..', 'src'))
const baselinePath = resolve(args.baseline ?? join(__dirname, 'lint-config-dir-baseline.txt'))

const offenders = findOffenders(srcDir)
const offendingFiles = new Set(offenders.map((o) => o.file))

if (args.writeBaseline) {
  const header = [
    '# Files that still resolve ~/.chroxy without going through src/config-dir.js.',
    '# Ratchet (#7052): a file may LEAVE this list, never join it.',
    '# Regenerate with: node scripts/lint-config-dir.mjs --write-baseline',
    '',
  ].join('\n')
  writeFileSync(baselinePath, header + [...offendingFiles].sort().join('\n') + '\n')
  console.log(`Wrote ${offendingFiles.size} file(s) to ${relative(process.cwd(), baselinePath)}`)
  process.exit(0)
}

const baseline = readBaseline(baselinePath)
const newOffenders = offenders.filter((o) => !baseline.has(o.file))
// A baselined file that is now clean must be removed, or the ratchet slips
// back: the entry would keep granting an exemption nothing needs, and the next
// regression in that file would land silently.
const staleBaseline = [...baseline].filter((f) => !offendingFiles.has(f)).sort()

for (const o of newOffenders) {
  console.error(`${o.file}:${o.line}  [${o.kind}]  ${o.text}`)
}
if (newOffenders.length) {
  console.error('')
  console.error(`${newOffenders.length} un-baselined site(s) resolve ~/.chroxy outside src/config-dir.js.`)
  console.error("Use configDir() / configPath(...) from './config-dir.js' — they read CHROXY_CONFIG_DIR per call.")
}

for (const f of staleBaseline) {
  console.error(`${f}: listed in the baseline but now clean — remove the entry.`)
}

const failed = newOffenders.length > 0 || staleBaseline.length > 0
if (!failed) {
  const exempt = baseline.size ? ` (${baseline.size} file(s) still baselined)` : ''
  console.log(`OK: ~/.chroxy resolves through src/config-dir.js${exempt}.`)
}
process.exit(failed && !args.dryRun ? 1 : 0)
