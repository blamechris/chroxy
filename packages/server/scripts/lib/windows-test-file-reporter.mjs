// A test reporter that records WHICH FILES actually executed (#7270).
//
// The Windows runner asserts that every file in the derived set really ran —
// "did not run" and "passed" must not be the same observable outcome
// (docs/false-safety-guards.md:307). Node's TAP output cannot support that
// assertion: it contains NO file paths at all. Its top-level `ok N - name`
// entries are one per top-level suite, not one per file — measured, two files
// produced five of them — so counting them would have been wrong in a way that
// happened to fail closed, which is luck rather than design.
//
// So the runner attaches this second reporter alongside `tap` and reads the
// file set back. Node supports multiple --test-reporter pairs; this one writes
// a machine-readable list to its own destination and nothing to stdout.
//
// Paths are resolved to absolute before deduping. Node emits BOTH forms —
// measured: the same run yielded `tests/platform.test.js` and the absolute
// path for the same file, which counted as two. That would have inflated the
// count and defeated the equality check.
import { resolve } from 'node:path'

export default async function* windowsTestFileReporter(source) {
  const files = new Set()
  for await (const event of source) {
    const f = event && event.data && event.data.file
    if (typeof f === 'string' && f) files.add(resolve(f))
  }
  for (const f of [...files].sort()) yield `${f}\n`
}
