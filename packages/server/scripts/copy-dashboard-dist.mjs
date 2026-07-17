#!/usr/bin/env node

import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const source = resolve(packageRoot, '..', 'dashboard', 'dist')
const target = resolve(packageRoot, 'src', 'dashboard-next', 'dist')

if (!existsSync(source)) {
  console.error(
    `Dashboard dist not found at ${source}.\n` +
    'Run `npm run build -w @chroxy/dashboard` before packing @chroxy/server.',
  )
  process.exit(1)
}

rmSync(target, { recursive: true, force: true })
cpSync(source, target, { recursive: true })
console.log(`Copied dashboard dist to ${target}`)
