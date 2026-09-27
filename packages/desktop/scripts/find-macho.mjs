#!/usr/bin/env node
/**
 * find-macho.mjs — find Mach-O binaries by MAGIC BYTES, not by filename.
 *
 * WHY THIS EXISTS (#7986)
 * ------------------------
 * bundle-server.sh's unsigned-native-binary guard (further down this
 * directory) matches by EXTENSION — `.node`, `.dylib`, `.bare`, `.so*`,
 * `.framework`, `.bundle` — because that is how every native binary this repo
 * had ever shipped was named. `@anthropic-ai/claude-agent-sdk-darwin-arm64`
 * ships `claude`: an unsigned ~207 MB Mach-O executable with NO extension at
 * all. The extension guard cannot see it, and Apple notarization would reject
 * it exactly the way the guard exists to catch early (#3825).
 *
 * This module answers one question — "is this file a Mach-O binary?" — by
 * reading its magic bytes, independent of what it's named.
 *
 * MAGIC BYTES
 * -----------
 * Thin (single-architecture) Mach-O, as the four bytes sit ON DISK:
 *   feedface — MH_MAGIC     (32-bit, native byte order)
 *   cefaedfe — MH_CIGAM     (32-bit, byte-swapped)
 *   feedfacf — MH_MAGIC_64  (64-bit, native byte order)
 *   cffaedfe — MH_CIGAM_64  (64-bit, byte-swapped)
 *
 * Fat (multi-architecture) Mach-O is always big-endian ON DISK regardless of
 * host byte order:
 *   cafebabe — FAT_MAGIC
 *   cafebabf — FAT_MAGIC_64
 *
 * THE JAVA CLASS AMBIGUITY
 * -------------------------
 * `cafebabe` is ALSO the Java class file magic. The disambiguation — the same
 * one `file(1)` uses — is the next 4 bytes on disk, read as a big-endian
 * uint32. For a real fat Mach-O this is `nfat_arch`, the number of
 * architecture slices, which is always small (this repo has never shipped
 * more than a handful). For a Java class file the same bytes are
 * `minor_version` (high 16 bits) + `major_version` (low 16 bits); real-world
 * major versions (45 for Java 1.1 through the 60s today) make that 32-bit
 * value land far outside a plausible architecture count. So: treat `cafebabe`
 * / `cafebabf` as fat Mach-O only when the next big-endian uint32 is in
 * `1..29` — otherwise it's something else (most likely a Java class file) and
 * `machOKind` returns null.
 *
 * `findMachOFiles` deliberately does NOT follow symlinks — `fs.Dirent`'s
 * `isSymbolicLink()`/`isDirectory()`/`isFile()` report the type of the
 * directory ENTRY itself (from readdir), never the type of whatever it
 * resolves to — so a symlink is neither descended into nor read as a file.
 * That is what keeps a directory-symlink cycle from looping: the entry is
 * skipped outright, its target never visited.
 *
 * CLI:
 *   node find-macho.mjs <root> [--exclude-regex <re>]
 *
 * Prints one absolute path per line for every Mach-O file found under <root>,
 * and exits 0 whether or not any were found — "ran a clean scan and found
 * nothing" and "the scan itself failed" must never be the same exit code, so
 * every other outcome (a missing root, a non-directory root, a mid-walk
 * error, a malformed --exclude-regex) exits NON-ZERO instead. A scan that
 * silently reported nothing found on a broken run would be exactly the
 * "found nothing to check" == "nothing wrong" failure this file exists to
 * prevent (see docs/false-safety-guards.md).
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { isEntryPoint } from '../../../scripts/lib/is-entry-point.mjs'

// The literal on-disk byte sequences for each magic, keyed by the kind
// `machOKind` reports for a plain (non-fat) match.
const THIN32 = [
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]), // MH_MAGIC
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]), // MH_CIGAM
]
const THIN64 = [
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), // MH_MAGIC_64
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), // MH_CIGAM_64
]
const FAT_MAGIC = Buffer.from([0xca, 0xfe, 0xba, 0xbe])
const FAT_MAGIC_64 = Buffer.from([0xca, 0xfe, 0xba, 0xbf])

// file(1)'s heuristic for disambiguating a fat Mach-O from a Java class file
// sharing the same first four bytes: nfat_arch must be a plausible small
// architecture count.
const MIN_PLAUSIBLE_NFAT_ARCH = 1
const MAX_PLAUSIBLE_NFAT_ARCH = 29

/**
 * Classify a buffer's leading bytes as a Mach-O magic.
 *
 * @param {Buffer} buf - at least the first 8 bytes of a file (4 suffice for
 *   a thin match; 8 are needed to disambiguate a fat/Java-class `cafebabe`).
 * @returns {'thin32'|'thin64'|'fat'|'fat64'|null}
 */
export function machOKind(buf) {
  if (!buf || buf.length < 4) return null

  const magic = buf.subarray(0, 4)

  if (THIN32.some((m) => magic.equals(m))) return 'thin32'
  if (THIN64.some((m) => magic.equals(m))) return 'thin64'

  if (magic.equals(FAT_MAGIC) || magic.equals(FAT_MAGIC_64)) {
    // Not enough bytes to read nfat_arch — undecidable, so don't flag it.
    if (buf.length < 8) return null
    const nfatArch = buf.readUInt32BE(4)
    if (nfatArch < MIN_PLAUSIBLE_NFAT_ARCH || nfatArch > MAX_PLAUSIBLE_NFAT_ARCH) return null
    return magic.equals(FAT_MAGIC_64) ? 'fat64' : 'fat'
  }

  return null
}

const MAGIC_BYTES_TO_READ = 8

function readLeadingBytes(path, n) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(n)
    const bytesRead = readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

function toForwardSlashPath(p) {
  return sep === '/' ? p : p.split(sep).join('/')
}

/**
 * Recursively find Mach-O files under `root` by magic bytes.
 *
 * Walks using `fs.Dirent` types from `readdirSync(..., { withFileTypes: true
 * })` so a symlink (to a file OR a directory) is identified from the
 * directory entry itself, without ever being stat'd or followed — a
 * directory-symlink cycle therefore cannot loop, because the cycle-forming
 * entry is simply skipped.
 *
 * @param {string} root
 * @param {{ excludeRegex?: RegExp }} [opts] - when given, tested against the
 *   forward-slash absolute path of every entry (file or directory); a match
 *   prunes a directory (it is not descended into) or drops a file (it is not
 *   included in the result).
 * @returns {string[]} absolute paths of every Mach-O file found.
 */
export function findMachOFiles(root, opts = {}) {
  const { excludeRegex } = opts
  const absRoot = resolve(root)
  const results = []

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (excludeRegex && excludeRegex.test(toForwardSlashPath(full))) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        const head = readLeadingBytes(full, MAGIC_BYTES_TO_READ)
        if (machOKind(head) !== null) results.push(full)
      }
    }
  }

  walk(absRoot)
  return results
}

function parseCliArgs(argv) {
  const out = { root: null, excludeRegex: null }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--exclude-regex') {
      if (i + 1 >= argv.length) throw new Error('--exclude-regex requires a value')
      out.excludeRegex = argv[i + 1]
      i += 1
    } else {
      positional.push(arg)
    }
  }
  if (positional.length !== 1) {
    throw new Error('Usage: find-macho.mjs <root> [--exclude-regex <re>]')
  }
  out.root = positional[0]
  return out
}

function main() {
  let args
  try {
    args = parseCliArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[find-macho] ${err.message}`)
    process.exit(1)
  }

  let rootStat
  try {
    rootStat = statSync(args.root)
  } catch (err) {
    console.error(`[find-macho] cannot access root "${args.root}": ${err.message}`)
    process.exit(1)
  }
  if (!rootStat.isDirectory()) {
    console.error(`[find-macho] root "${args.root}" is not a directory`)
    process.exit(1)
  }

  let excludeRegex = null
  if (args.excludeRegex !== null) {
    try {
      excludeRegex = new RegExp(args.excludeRegex)
    } catch (err) {
      console.error(`[find-macho] invalid --exclude-regex "${args.excludeRegex}": ${err.message}`)
      process.exit(1)
    }
  }

  try {
    const found = findMachOFiles(args.root, { excludeRegex })
    for (const path of found) console.log(path)
    process.exit(0)
  } catch (err) {
    console.error(`[find-macho] scan failed: ${err.message}`)
    process.exit(1)
  }
}

if (isEntryPoint(import.meta.url)) {
  main()
}
