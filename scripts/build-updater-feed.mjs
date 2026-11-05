#!/usr/bin/env node
/**
 * build-updater-feed.mjs — Write one desktop job's Tauri updater feed
 * fragment (#8917).
 *
 * `cargo tauri build` (tauri-cli v2) writes the updater payload and its
 * `.sig` but never a `latest.json`, so each desktop job builds its own
 * fragment from them. The fragments are folded together by
 * merge-updater-feeds.mjs and gated by verify-updater-feed.mjs.
 *
 * Usage:
 *   node scripts/build-updater-feed.mjs --version 0.11.8 \
 *     --base-url https://github.com/OWNER/REPO/releases/download/v0.11.8 \
 *     --platform windows-x86_64=path/to/Chroxy_0.11.8_x64_en-US.msi \
 *     [--platform key=path ...] [--notes TEXT] [--pub-date ISO] --output latest.json
 *
 * Each payload's `<payload>.sig` must exist and be non-empty. Payload
 * basenames must be [A-Za-z0-9._-] only: GitHub renames other characters on
 * upload, which would make the URL written here a 404.
 */

import {readFileSync, writeFileSync, existsSync} from 'node:fs'
import {basename} from 'node:path'
import {argv, exit, stderr, stdout} from 'node:process'

const SAFE_BASENAME = /^[A-Za-z0-9._-]+$/

function usage(msg) {
  if (msg) stderr.write(`error: ${msg}\n`)
  stderr.write('usage: build-updater-feed.mjs --version V --base-url URL --platform KEY=PAYLOAD [...] [--notes T] [--pub-date ISO] --output PATH\n')
  exit(2)
}

function parseArgs(args) {
  const opts = {platforms: [], notes: null, pubDate: null, version: null, baseUrl: null, output: null}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const value = () => {
      const v = args[++i]
      if (v === undefined) usage(`${a} requires a value`)
      return v
    }
    if (a === '--version') opts.version = value()
    else if (a === '--base-url') opts.baseUrl = value()
    else if (a === '--notes') opts.notes = value()
    else if (a === '--pub-date') opts.pubDate = value()
    else if (a === '--output') opts.output = value()
    else if (a === '--platform') {
      const spec = value()
      const eq = spec.indexOf('=')
      if (eq <= 0 || eq === spec.length - 1) usage(`--platform expects KEY=PATH, got "${spec}"`)
      opts.platforms.push([spec.slice(0, eq), spec.slice(eq + 1)])
    } else if (a === '--help' || a === '-h') {
      stdout.write('see header of scripts/build-updater-feed.mjs\n')
      exit(0)
    } else usage(`unknown argument: ${a}`)
  }
  if (!opts.version) usage('--version is required')
  if (!opts.baseUrl) usage('--base-url is required')
  if (!opts.output) usage('--output is required')
  if (opts.platforms.length === 0) usage('at least one --platform is required')
  return opts
}

function main() {
  const opts = parseArgs(argv.slice(2))
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const platforms = {}
  const problems = []

  for (const [key, payloadPath] of opts.platforms) {
    if (platforms[key]) {
      problems.push(`${key}: platform given more than once`)
      continue
    }
    const name = basename(payloadPath)
    if (!SAFE_BASENAME.test(name)) {
      problems.push(`${key}: payload name "${name}" has characters outside [A-Za-z0-9._-]; GitHub would rename the asset and the URL would 404`)
      continue
    }
    const sigPath = `${payloadPath}.sig`
    if (!existsSync(sigPath)) {
      problems.push(`${key}: signature file ${sigPath} is missing`)
      continue
    }
    const signature = readFileSync(sigPath, 'utf8').trim()
    if (signature === '') {
      problems.push(`${key}: signature file ${sigPath} is empty`)
      continue
    }
    platforms[key] = {signature, url: `${baseUrl}/${name}`}
  }

  if (problems.length > 0) {
    for (const p of problems) stderr.write(`error: ${p}\n`)
    exit(1)
  }

  const feed = {version: opts.version}
  if (opts.notes) feed.notes = opts.notes
  feed.pub_date = opts.pubDate || new Date().toISOString()
  feed.platforms = platforms
  writeFileSync(opts.output, JSON.stringify(feed, null, 2) + '\n')
  stdout.write(`wrote ${opts.output} (${Object.keys(platforms).join(', ')})\n`)
}

main()
