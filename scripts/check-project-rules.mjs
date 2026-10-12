#!/usr/bin/env node
// Read-only portable checks. This does not certify a host's runtime discovery.
// Live machine/config validation belongs to fleet-check and fresh-session probes.

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEntryPoint } from './lib/is-entry-point.mjs'

export const DOC_CAP_BYTES = 98304
export const MACHINE_BUDGET_BYTES = 49152
export const MIN_MARGIN_BYTES = 2048
// Same serialization as fleet-check.py; count bytes, including separators.
export const DOC_SEPARATOR = '\n\n--- project-doc ---\n\n'

const PROJECT_SECTIONS = [
  'Project Overview', 'Critical Dev Notes', 'PRIME Compatibility and Authority',
  'Session Start Protocol', 'Git Workflow', 'Code Style', 'Testing Conventions',
  'Architecture', 'Dev Commands', 'UI Verification with Maestro', 'Repo Memory MCP', 'Reference',
]
const ADAPTERS = { 'CLAUDE.md': '@AGENTS.md\n', 'GEMINI.md': '@./AGENTS.md\n' }
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readRule(path) {
  if (!lstatSync(path).isFile()) throw new Error(`${path}: rules must be a regular file, not a symlink or directory`)
  const bytes = readFileSync(path)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!text.trim()) throw new Error(`${path}: rules must not be empty`)
  return { bytes: bytes.length, text }
}

function inventory(root) {
  const run = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
  })
  if (run.error || run.status !== 0) throw new Error(`cannot inventory project rules: ${run.error?.message || run.stderr.trim() || `git exited ${run.status}`}`)
  return [...new Set(run.stdout.split('\0').filter(Boolean))].filter(path => existsSync(join(root, path)))
}

export function checkProjectRules({ root = ROOT, machinePath } = {}) {
  root = resolve(root)
  const paths = inventory(root)
  // Include ignored instruction files in every directory of the project
  // inventory. Gitignore is not an instruction-loading boundary.
  const directories = new Set(['.'])
  for (const path of paths) {
    let directory = dirname(path)
    while (directory !== '.') {
      directories.add(directory)
      directory = dirname(directory)
    }
  }
  const layers = new Set(paths)
  for (const directory of directories) {
    for (const name of ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'GEMINI.md', '.codex/config.toml', '.gemini/settings.json']) {
      const path = join(directory, name)
      if (existsSync(join(root, path))) layers.add(path)
    }
  }
  const source = readRule(join(root, 'AGENTS.md'))
  if (!source.text.startsWith('# Chroxy Development Notes\n') || /AUTO-GENERATED FROM CLAUDE\.md/.test(source.text)) {
    throw new Error('AGENTS.md must be the authored project source, not a generated mirror or import adapter')
  }
  for (const section of PROJECT_SECTIONS) {
    if (!source.text.split('\n').includes(`## ${section}`)) throw new Error(`AGENTS.md is missing project contract section: ${section}`)
  }
  for (const [name, expected] of Object.entries(ADAPTERS)) {
    if (readRule(join(root, name)).text !== expected) throw new Error(`${name} must contain only its project import: ${expected.trim()}`)
  }

  // This portable guard supports the default root adapters plus nested AGENTS
  // files. Overrides or host settings can change precedence and need a deliberate
  // extension of the checker, rather than a green verdict on an unknown chain.
  const unsupported = [...layers].find(path => /(^|\/)(AGENTS\.override\.md|\.codex\/config\.toml|\.gemini\/settings\.json)$/.test(path) ||
    (path.includes('/') && /(^|\/)(CLAUDE|GEMINI)\.md$/.test(path)))
  if (unsupported) throw new Error(`unsupported project instruction layer: ${unsupported}; verify its host precedence before extending this guard`)
  if (!paths.includes('AGENTS.md')) throw new Error('AGENTS.md must be included in the Git project inventory')
  const rules = [...layers].filter(path => /(^|\/)AGENTS\.md$/.test(path))
  const records = rules.map(path => ({ path, ...readRule(join(root, path)) }))
  const machineBytes = machinePath ? readRule(resolve(machinePath)).bytes : MACHINE_BUDGET_BYTES
  if (machineBytes > MACHINE_BUDGET_BYTES) throw new Error(`machine rules use ${machineBytes} bytes, above the supported ${MACHINE_BUDGET_BYTES}-byte machine budget`)
  const chains = records.map(record => {
    const target = dirname(record.path)
    const selected = records.filter(candidate => {
      const directory = dirname(candidate.path)
      return directory === '.' || directory === target || target.startsWith(`${directory}/`)
    })
    const bytes = machineBytes + selected.reduce((sum, rule) => sum + rule.bytes, 0) +
      selected.length * Buffer.byteLength(DOC_SEPARATOR)
    const margin = DOC_CAP_BYTES - bytes
    if (margin < MIN_MARGIN_BYTES) throw new Error(`instruction chain ${target}: ${bytes}/${DOC_CAP_BYTES} bytes including separators; margin ${margin} is below ${MIN_MARGIN_BYTES}`)
    return { directory: target, bytes, margin, files: selected.map(rule => rule.path) }
  })
  return { chains, machineBytes, machineMeasured: Boolean(machinePath) }
}

if (isEntryPoint(import.meta.url)) {
  try {
    const options = {}
    const args = process.argv.slice(2)
    while (args.length) {
      const flag = args.shift()
      if (!['--root', '--machine'].includes(flag) || !args.length || args[0].startsWith('--')) throw new Error(`unknown or incomplete option: ${flag}`)
      const key = flag === '--root' ? 'root' : 'machinePath'
      if (options[key]) throw new Error(`duplicate option: ${flag}`)
      options[key] = args.shift()
    }
    const result = checkProjectRules(options)
    for (const chain of result.chains) console.log(`project-rules: ${chain.directory} ${chain.bytes}/${DOC_CAP_BYTES} bytes; margin=${chain.margin}`)
    console.log(`PROJECT_RULES_OK: authored source and adapters verified; ${result.chains.length} chain(s); machine=${result.machineBytes} bytes (${result.machineMeasured ? 'measured' : 'portable budget'}); separators=${Buffer.byteLength(DOC_SEPARATOR)} bytes`)
  } catch (err) {
    console.error(`::error::project-rules: ${err.message}`)
    process.exitCode = 1
  }
}
