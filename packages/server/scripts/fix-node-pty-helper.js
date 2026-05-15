#!/usr/bin/env node
// node-pty 1.1.0 ships `prebuilds/<platform>/spawn-helper` without the
// executable bit. `pty.fork()` fails with "posix_spawnp failed." Apply +x
// at postinstall so the server can spawn child processes under a PTY.
//
// Idempotent: re-running just re-applies the bit. Safe to invoke from
// non-npm contexts.

import { existsSync, chmodSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// node-pty may be hoisted to the workspace root by npm. Walk up looking for it.
function findPrebuildsDir(start) {
  let dir = start
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'node_modules', 'node-pty', 'prebuilds')
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  return null
}

const ptyDir = findPrebuildsDir(resolve(__dirname, '..'))

if (!ptyDir) {
  process.exit(0)
}

const helpers = [
  join(ptyDir, 'darwin-arm64', 'spawn-helper'),
  join(ptyDir, 'darwin-x64', 'spawn-helper'),
  join(ptyDir, 'linux-arm64', 'spawn-helper'),
  join(ptyDir, 'linux-x64', 'spawn-helper'),
]

for (const helper of helpers) {
  if (!existsSync(helper)) continue
  const mode = statSync(helper).mode
  if ((mode & 0o111) === 0o111) continue
  chmodSync(helper, mode | 0o111)
}
