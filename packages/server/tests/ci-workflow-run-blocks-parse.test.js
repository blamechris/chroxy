import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkflows, assertReaderSane, jobShell, stepRun, stepInput, code } from './helpers/workflow-reader.js'

/**
 * Every bash `run:` block in every workflow must PARSE (#7632).
 *
 * ci.yml's own "Shell scripts parse" step runs `bash -n` over `git ls-files
 * '*.sh'` — every tracked shell SCRIPT. A workflow's `run:` blocks are shell
 * too, and nothing has ever parsed them. #7504 found the same shape from the
 * other side (a test suite named by no job); this is the gap one level down.
 *
 * It is not hypothetical. This line went into repo-relay.yml during #7632:
 *
 *     run: echo "::warning::... This does not fail the job — see #7632."
 *
 * In a PLAIN YAML scalar a whitespace-preceded `#` opens a comment, so the
 * value handed to bash ended at `— see`, with the double quote never closed.
 * The step would have died of a shell parse error on the runner — and it was
 * the step whose entire job is to announce that a failure has been TOLERATED,
 * so a green-by-design path would have gone red instead. Review read past it
 * twice; `bash -n` caught it immediately.
 *
 * WHY IT ASSERTS THROUGH THE READER'S VIEW OF YAML
 * -----------------------------------------------
 * `stepRun` reproduces YAML's reading of `run:`, truncation included, rather
 * than a friendlier one. A guard that read the author's intended text would
 * have found that line perfectly well-formed, which is precisely how it got
 * committed. The guard has to see what the runner sees.
 *
 * PowerShell blocks are excluded, and their shell is declared at JOB level in
 * both Windows jobs — see `jobShell`. Excluding by step-level `shell:` alone
 * would have swept all six into `bash -n` and failed on correct config.
 */
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'spawns bash (POSIX-only)' : false }

describe('workflow run: blocks parse under bash -n (#7632)', () => {
  let workflows
  let blocks

  before(async () => {
    workflows = await readWorkflows()
    blocks = []
    for (const w of workflows) {
      for (const job of w.jobs) {
        const jobDefault = jobShell(job.body)
        for (const step of job.steps) {
          const script = stepRun(step)
          if (script === undefined) continue
          // stepInput, NOT a local regex. A hand-rolled one here re-implemented
          // step-key parsing and immediately drifted from the shared reader:
          // it could not see `- shell: bash` written on a step's own dash line,
          // so such a step fell back to its job default, was classified
          // PowerShell in the two Windows jobs, and was SKIPPED — and a block
          // that is never checked is a block that always passes. Found by
          // mutation, in the same PR that taught stepInput that exact spelling.
          const shell = stepInput(step, 'shell') ?? jobDefault ?? 'bash'
          const name = (code(step).map(l => /^\s*-?\s*name:\s*(.*)$/.exec(l)).find(Boolean)?.[1] ?? '(unnamed)').trim()
          blocks.push({ where: `${w.name} ${job.id} · ${name}`, shell, script })
        }
      }
    }
  })

  // ---- positive control ---------------------------------------------------
  // The rule below quantifies over `blocks`. An extractor that finds nothing
  // passes it vacuously and reports a clean green — "cannot check this treated
  // as nothing to check" in docs/false-safety-guards.md. Thresholds are loose:
  // they catch an extractor that has stopped working, not today's block count.
  it('extracts the run: blocks from every workflow', () => {
    assertReaderSane(workflows)
    assert.ok(blocks.length >= 80, `expected >=80 run: blocks across all workflows, found ${blocks.length}`)
    assert.ok(
      blocks.some(b => /powershell|pwsh/.test(b.shell)),
      'expected to find the Windows jobs\' PowerShell run blocks — if none are seen, ' +
        'jobShell has stopped reading job-level defaults and they are being parsed as bash'
    )
    assert.ok(
      blocks.some(b => b.where.startsWith('repo-relay.yml')),
      `expected repo-relay.yml run blocks among: ${[...new Set(blocks.map(b => b.where.split(' ')[0]))].join(', ')}`
    )
  })

  // Spawns bash, which on the Windows runner is WSL with no distro (see
  // EXEMPT_REASONS['posix-shell-spawn'] in scripts/lib/windows-test-set.mjs).
  // Skipped per-test rather than exempting the file — the manifest names that
  // as the preferred fix, and the positive control above runs on Windows fine.
  const scratch = []
  after(() => {
    // Every other mkdtempSync in this suite pairs with an rmSync; without it a
    // run leaves 127 files behind and they accumulate across runs.
    for (const d of scratch) rmSync(d, { recursive: true, force: true })
  })

  it('every bash run: block is syntactically valid shell', POSIX_ONLY, () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-runblocks-'))
    scratch.push(dir)
    const bad = []
    for (const [i, b] of blocks.entries()) {
      if (!/^(bash|sh)$/.test(b.shell)) continue
      const file = join(dir, `block-${i}.sh`)
      writeFileSync(file, `#!/usr/bin/env bash\n${b.script}\n`)
      try {
        // Bounded: a guard that HANGS reads as flake rather than as a finding
        // (docs/false-safety-guards.md entry 17). `bash -n` never executes the
        // script, so this is a backstop, not a mitigation for hostile input.
        execFileSync('bash', ['-n', file], { stdio: 'pipe', timeout: 10_000 })
      } catch (err) {
        // Collapse to the message: the whole script as an assertion payload is
        // the #7340 hazard (docs/false-safety-guards.md entry 17).
        bad.push(`${b.where} — ${String(err.stderr ?? '').trim().split('\n')[0]}`)
      }
    }
    assert.deepEqual(bad, [], `run: blocks that do not parse:\n  ${bad.join('\n  ')}`)
  })
})
