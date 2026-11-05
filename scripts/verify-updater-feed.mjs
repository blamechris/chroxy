#!/usr/bin/env node
/**
 * verify-updater-feed.mjs — Release gate for the Tauri updater feed (#8917).
 *
 * Checks every `platforms` entry of a `latest.json` the way an installed
 * client would: find the payload its URL names, then verify the embedded
 * signature over those exact bytes against the public key committed in
 * tauri.conf.json. Any entry that fails fails the run, listing every failure.
 *
 * Usage:
 *   node scripts/verify-updater-feed.mjs --feed latest.json \
 *     (--pubkey-from tauri.conf.json | --pubkey BASE64) --assets DIR \
 *     [--expect-version V]
 *
 * Exit: 0 all verified; 1 a platform failed (or the feed is unusable);
 * 2 usage error.
 */

import {readFileSync, readdirSync} from 'node:fs'
import {join} from 'node:path'
import {argv, exit, stderr, stdout} from 'node:process'
import {verifyTauriSignature, trustedCommentVersion} from './lib/minisign-verify.mjs'

function usage(msg) {
  if (msg) stderr.write(`error: ${msg}\n`)
  stderr.write('usage: verify-updater-feed.mjs --feed PATH (--pubkey-from tauri.conf.json | --pubkey B64) --assets DIR [--expect-version V]\n')
  exit(2)
}

function parseArgs(args) {
  const o = {feed: null, pubkeyFrom: null, pubkey: null, assets: null, expectVersion: null}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const value = () => {
      const v = args[++i]
      if (v === undefined) usage(`${a} requires a value`)
      return v
    }
    if (a === '--feed') o.feed = value()
    else if (a === '--pubkey-from') o.pubkeyFrom = value()
    else if (a === '--pubkey') o.pubkey = value()
    else if (a === '--assets') o.assets = value()
    else if (a === '--expect-version') o.expectVersion = value()
    else usage(`unknown argument: ${a}`)
  }
  if (!o.feed) usage('--feed is required')
  if (!o.assets) usage('--assets is required')
  if (!o.pubkeyFrom && !o.pubkey) usage('one of --pubkey-from or --pubkey is required')
  if (o.pubkeyFrom && o.pubkey) usage('--pubkey-from and --pubkey are mutually exclusive')
  return o
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    stderr.write(`error: could not read ${what} ${path}: ${err.message}\n`)
    exit(1)
  }
}

// Returns {path, name} pairs. The name is the directory entry's own name, never
// parsed back out of the joined path: join() uses '\\' on Windows, and the
// desktop-windows job runs this script, so splitting on '/' would find nothing.
function listFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (entry.isFile()) out.push({path: full, name: entry.name})
  }
  return out
}

function urlBasename(url) {
  let path = String(url).split(/[?#]/)[0]
  path = path.replace(/\/+$/, '')
  const name = path.slice(path.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function main() {
  const o = parseArgs(argv.slice(2))
  const feed = readJson(o.feed, 'feed')

  let pubkey = o.pubkey
  if (o.pubkeyFrom) {
    const conf = readJson(o.pubkeyFrom, 'config')
    pubkey = conf && conf.plugins && conf.plugins.updater && conf.plugins.updater.pubkey
    if (typeof pubkey !== 'string' || pubkey === '') {
      stderr.write(`error: ${o.pubkeyFrom} has no plugins.updater.pubkey\n`)
      exit(1)
    }
  }

  const platforms = feed && typeof feed.platforms === 'object' && feed.platforms !== null ? feed.platforms : {}
  const keys = Object.keys(platforms)
  if (keys.length === 0) {
    stderr.write(`error: ${o.feed} has no platform entries; refusing to pass an empty feed\n`)
    exit(1)
  }

  const failures = []
  if (o.expectVersion !== null && feed.version !== o.expectVersion) {
    failures.push(`feed: version "${feed.version}" does not match expected "${o.expectVersion}"`)
  }

  let files
  try {
    files = listFiles(o.assets)
  } catch (err) {
    stderr.write(`error: could not read assets directory ${o.assets}: ${err.message}\n`)
    exit(1)
  }

  for (const key of keys) {
    const entry = platforms[key] || {}
    if (typeof entry.url !== 'string' || entry.url === '') {
      failures.push(`${key}: entry has no url`)
      continue
    }
    if (typeof entry.signature !== 'string' || entry.signature === '') {
      failures.push(`${key}: entry has no signature`)
      continue
    }
    const name = urlBasename(entry.url)
    const matches = files.filter((f) => f.name === name)
    if (matches.length === 0) {
      failures.push(`${key}: no asset named "${name}" under ${o.assets}`)
      continue
    }
    if (matches.length > 1) {
      failures.push(`${key}: ${matches.length} assets named "${name}" under ${o.assets}; expected exactly one`)
      continue
    }
    const result = verifyTauriSignature(pubkey, entry.signature, readFileSync(matches[0].path))
    if (!result.ok) {
      failures.push(`${key}: ${name}: ${result.reason}`)
      continue
    }
    const signedVersion = trustedCommentVersion(result.trustedComment)
    if (signedVersion !== null && signedVersion !== feed.version) {
      failures.push(`${key}: ${name}: signed for version "${signedVersion}" but the feed says "${feed.version}"`)
      continue
    }
    stdout.write(`ok ${key}: ${name}\n`)
  }

  if (failures.length > 0) {
    for (const f of failures) stderr.write(`FAIL ${f}\n`)
    stderr.write(`error: ${failures.length} updater feed check(s) failed\n`)
    exit(1)
  }
  stdout.write(`verified ${keys.length} platform(s) in ${o.feed}\n`)
}

main()
