#!/usr/bin/env node
/**
 * merge-updater-feeds.mjs — Merge per-platform Tauri updater feeds into a
 * single combined `latest.json` for the release.
 *
 * The Tauri auto-updater expects ONE `latest.json` whose `platforms` map
 * keys (`darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, ...) point at
 * the platform-specific bundle + signature. Each `cargo tauri build` run
 * emits its own `latest.json` containing only the platforms it built, so
 * when both the macOS and Windows desktop jobs run we end up with two
 * fragments that need to be combined before publishing.
 *
 * Top-level fields (`version`, `notes`, `pub_date`) are taken from the
 * first non-empty input (they should be identical across platforms in a
 * coordinated release). `platforms` entries are merged with last-write-wins
 * semantics, so passing the most authoritative feed last is safe.
 *
 * Missing input files are skipped with a warning (the workflow can pass
 * paths that won't exist when updater signing is disabled for that job)
 * but at least one input must contribute platforms or the script exits
 * non-zero so a botched release doesn't ship an empty feed.
 *
 * Usage:
 *   node scripts/merge-updater-feeds.mjs <feed1.json> [<feed2.json> ...]
 *   node scripts/merge-updater-feeds.mjs --output out.json <feed1.json> ...
 */

import {readFileSync, writeFileSync, existsSync} from 'node:fs'
import {argv, exit, stderr, stdout} from 'node:process'

function parseArgs(args) {
  const inputs = []
  let output = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--output' || a === '-o') {
      output = args[++i]
      if (!output) {
        stderr.write('error: --output requires a path argument\n')
        exit(2)
      }
    } else if (a === '--help' || a === '-h') {
      stdout.write('usage: merge-updater-feeds.mjs [--output PATH] <feed.json> [<feed.json> ...]\n')
      exit(0)
    } else if (a.startsWith('-')) {
      stderr.write(`error: unknown flag: ${a}\n`)
      exit(2)
    } else {
      inputs.push(a)
    }
  }
  return {inputs, output}
}

function main() {
  const {inputs, output} = parseArgs(argv.slice(2))

  if (inputs.length === 0) {
    stderr.write('error: at least one input feed path is required\n')
    exit(2)
  }

  const merged = {
    version: null,
    notes: null,
    pub_date: null,
    platforms: {},
  }

  let usedInputs = 0
  for (const path of inputs) {
    if (!existsSync(path)) {
      stderr.write(`warn: skipping missing input ${path}\n`)
      continue
    }
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch (err) {
      stderr.write(`error: could not read ${path}: ${err.message}\n`)
      exit(1)
    }
    let feed
    try {
      feed = JSON.parse(raw)
    } catch (err) {
      stderr.write(`error: could not parse ${path}: ${err.message}\n`)
      exit(1)
    }

    if (merged.version === null && typeof feed.version === 'string') {
      merged.version = feed.version
    }
    if (merged.notes === null && typeof feed.notes === 'string') {
      merged.notes = feed.notes
    }
    if (merged.pub_date === null && typeof feed.pub_date === 'string') {
      merged.pub_date = feed.pub_date
    }
    if (feed.platforms && typeof feed.platforms === 'object') {
      for (const [key, value] of Object.entries(feed.platforms)) {
        merged.platforms[key] = value
      }
    }
    usedInputs++
  }

  if (usedInputs === 0) {
    stderr.write('error: no input feeds existed; refusing to write an empty latest.json\n')
    exit(1)
  }
  if (Object.keys(merged.platforms).length === 0) {
    stderr.write('error: merged feed has no platform entries; refusing to write\n')
    exit(1)
  }

  // Strip nulls so the output matches what a single tauri build would have
  // produced (no surprise extra keys for downstream JSON consumers).
  const out = {}
  if (merged.version !== null) out.version = merged.version
  if (merged.notes !== null) out.notes = merged.notes
  if (merged.pub_date !== null) out.pub_date = merged.pub_date
  out.platforms = merged.platforms

  const serialized = JSON.stringify(out, null, 2) + '\n'

  if (output) {
    writeFileSync(output, serialized)
    stderr.write(`merged ${usedInputs} feed(s) → ${output} (${Object.keys(merged.platforms).length} platforms)\n`)
  } else {
    stdout.write(serialized)
  }
}

main()
