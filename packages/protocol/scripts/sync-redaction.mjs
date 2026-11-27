#!/usr/bin/env node
// packages/server/src/redaction.js is the ONE authored source of the redaction rules.
// packages/protocol/src/redaction.js is a byte-identical COPY of it, shipped as
// @chroxy/protocol/redaction so the dashboard can bundle the same rules (#9235).
// The copy exists because the server's import graph must not reach this package: the
// daemon auto-deployer imports the logger (and so redaction.js) before any `npm ci`.
//
//   Edit packages/server/src/redaction.js, then:
//     npm run sync-redaction -w @chroxy/protocol && npm run build -w @chroxy/protocol
//   and commit the server file, the protocol copy and packages/protocol/dist/redaction.*.
//
//   --check   write nothing; exit 1 if the copy differs (the drift gate uses this)
//   --src P / --dest P   override the two paths (the drift test uses temp copies)
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const check = args.includes('--check')
const src = resolve(flag('--src') ?? resolve(here, '../../server/src/redaction.js'))
const dest = resolve(flag('--dest') ?? resolve(here, '../src/redaction.js'))
const SYNC = 'npm run sync-redaction -w @chroxy/protocol && npm run build -w @chroxy/protocol'

if (!existsSync(src)) {
  console.error(`sync-redaction: source not found: ${src}`)
  process.exit(2)
}
const want = readFileSync(src)
const have = existsSync(dest) ? readFileSync(dest) : null
const same = have !== null && want.equals(have)

if (check) {
  if (same) {
    console.log('sync-redaction: protocol copy is byte-identical to the server source')
    process.exit(0)
  }
  console.error(`sync-redaction: DRIFT. ${dest} differs from ${src}.\nEdit the server file only, then run: ${SYNC}`)
  process.exit(1)
}
if (same) {
  console.log(`sync-redaction: already in sync (${want.length} bytes), nothing written`)
} else {
  writeFileSync(dest, want)
  console.log(`sync-redaction: wrote ${dest} from ${src} (${want.length} bytes). Now run: npm run build -w @chroxy/protocol`)
}
