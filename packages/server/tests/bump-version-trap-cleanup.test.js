import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '../../..')
const SCRIPT = resolve(ROOT, 'scripts/bump-version.sh')

describe('bump-version.sh trap-cleans orphan .tmp files (#3886)', () => {
  it('script source defines a TMP_FILES tracker and EXIT trap', () => {
    const src = readFileSync(SCRIPT, 'utf-8')
    assert.match(src, /TMP_FILES=\(\)/, 'script should declare TMP_FILES array')
    assert.match(src, /track_tmp\s*\(\)/, 'script should define track_tmp()')
    assert.match(src, /trap\s+cleanup_tmp_files\s+EXIT/, 'script should register EXIT trap')
  })

  it('script registers Cargo.lock .tmp before its awk write', () => {
    const src = readFileSync(SCRIPT, 'utf-8')
    // Look for the track_tmp invocation immediately preceding an awk-into-place
    // pipeline (the Cargo.lock no-cargo fallback). A [\s\S]{0,400} window keeps
    // the assertion forgiving about intermediate whitespace/comments without
    // globally accepting any distance (which would let the registration drift
    // away from the write). The former iOS Info.plist awk block was removed
    // when iOS moved to CNG (#5642) — the native version now comes from
    // app.json at prebuild — so this guards the remaining awk-into-place site.
    const pattern = /track_tmp "\$CARGO_LOCK\.tmp"[\s\S]{0,400}awk[\s\S]{0,400}> "\$CARGO_LOCK\.tmp"/
    assert.match(src, pattern, 'Cargo.lock awk block should call track_tmp before writing the .tmp')
  })

  it('forced awk failure under the same trap pattern leaves no orphan .tmp', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'bump-trap-'))
    try {
      const target = resolve(dir, 'Info.plist')
      writeFileSync(target, '<plist>original</plist>\n', 'utf-8')

      // Mirror the script's trap pattern in a self-contained bash snippet,
      // then force awk to abort mid-write. With set -euo pipefail the script
      // exits before the `mv`, leaving target.tmp behind unless the trap fires.
      const snippet = `
        set -euo pipefail
        TMP_FILES=()
        track_tmp() { TMP_FILES+=("$1"); }
        cleanup_tmp_files() {
          local f
          for f in "\${TMP_FILES[@]:-}"; do
            [ -n "$f" ] && rm -f "$f" 2>/dev/null
          done
          return 0
        }
        trap cleanup_tmp_files EXIT

        TARGET="${target}"
        track_tmp "$TARGET.tmp"
        awk 'BEGIN { print "partial"; exit 1 }' > "$TARGET.tmp" && mv "$TARGET.tmp" "$TARGET"
      `

      const result = spawnSync('bash', ['-c', snippet], { encoding: 'utf-8' })
      assert.notEqual(result.status, 0, 'forced-failure snippet should exit non-zero')
      assert.equal(
        existsSync(`${target}.tmp`),
        false,
        'EXIT trap should have removed the orphan .tmp file',
      )
      assert.equal(
        readFileSync(target, 'utf-8'),
        '<plist>original</plist>\n',
        'original target file should be untouched',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cleanup only deletes paths that were registered (no globbing of pre-existing .tmp)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'bump-trap-'))
    try {
      // A pre-existing .tmp file owned by other tooling. The trap must NOT
      // touch this even though it lives in the same neighborhood.
      const foreign = resolve(dir, 'unrelated.tmp')
      writeFileSync(foreign, 'foreign', 'utf-8')

      const target = resolve(dir, 'Info.plist')
      writeFileSync(target, 'original', 'utf-8')

      const snippet = `
        set -euo pipefail
        TMP_FILES=()
        track_tmp() { TMP_FILES+=("$1"); }
        cleanup_tmp_files() {
          local f
          for f in "\${TMP_FILES[@]:-}"; do
            [ -n "$f" ] && rm -f "$f" 2>/dev/null
          done
          return 0
        }
        trap cleanup_tmp_files EXIT

        TARGET="${target}"
        track_tmp "$TARGET.tmp"
        awk 'BEGIN { exit 1 }' > "$TARGET.tmp"
      `

      spawnSync('bash', ['-c', snippet], { encoding: 'utf-8' })
      assert.equal(
        existsSync(foreign),
        true,
        'pre-existing unrelated .tmp file must not be deleted by the trap',
      )
      assert.equal(readFileSync(foreign, 'utf-8'), 'foreign')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
