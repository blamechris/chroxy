import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseRoster } from '../../../scripts/lib/contributing-roster.mjs'

/**
 * #7503 — /batch-merge's Step 2a is a MERGE-SAFETY gate, and it was vacuous.
 *
 * The step carried `REQUIRED_CHECKS=("Run Tests" "Validate Project")`: two
 * names that exist in neither CONTRIBUTING.md's roster nor any `ci.yml` job.
 * Walked against a real `gh pr checks --json name,state` payload (23 contexts,
 * PR #7530) the filter selected ZERO rows, so "no required check is failing"
 * was true by construction — the gate reported PASS on a payload with
 * `Server Tests=FAILURE` in it. That is the first cause in
 * docs/false-safety-guards.md: a hardcoded list beside a growing set, where
 * success and not-checking are the same observable outcome.
 *
 * WHY THE GUARD IS HERE AND NOT ONLY IN Scripts Tests. `compile-skill-targets
 * --check` already pins artifact == compile(source), but Scripts Tests is NOT
 * one of the 13 required contexts — it cannot block a merge. Server Tests can.
 * So this file asserts the property on the SOURCE and on both COMPILED
 * ARTIFACTS: `.claude/skills/batch-merge/SKILL.md` is what Claude actually
 * loads, and testing the source when the artifact is what ships is #7189.
 *
 * WHAT THIS FILE CANNOT DO is execute the snippet — it is markdown driven by an
 * agent, and running it needs `gh`, `jq` and a live PR. That half was proven by
 * walking the shipped fence against captured fixtures (green / one FAILURE /
 * one context absent) plus a phantom-roster mutant; the transcript is on the
 * PR. What IS checkable here, and is the thing that regresses, is that the
 * fence still derives its roster instead of naming checks.
 */

/**
 * Every line of fenced bash under one `#### Step N` heading, and nothing else.
 *
 * Anchored to the step on purpose. A file-wide search would be satisfied by
 * PROSE elsewhere in the same playbook — and that is not hypothetical: the
 * first draft of this file asserted `text.includes('chroxy main is `strict:
 * false`')` over the whole document, and a mutant that flipped the Step 2e
 * claim to `strict: true` stayed GREEN because Critical Rule 1 repeats the
 * phrase. Step 2a's prose likewise quotes `Run Tests` and `Validate Project`
 * verbatim while explaining why they were removed.
 */
function sliceBash(text, heading) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.startsWith(heading))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{3,4} /.test(lines[i])) { end = i; break }
  }
  const out = []
  let inFence = false
  for (const l of lines.slice(start, end)) {
    if (l.startsWith('```bash')) { inFence = true; continue }
    if (l.startsWith('```')) { inFence = false; continue }
    if (inFence) out.push(l)
  }
  return out.length > 0 ? out.join('\n') : null
}

// The neutral source plus every repo-local compiled target from
// .claude/skill-profile.md's `targets:` line (claude, gemini). Both artifacts
// embed the playbook verbatim, so one slicer reads all three.
const SURFACES = [
  ['source .claude/commands/batch-merge.md', '../../../.claude/commands/batch-merge.md'],
  ['artifact .claude/skills/batch-merge/SKILL.md', '../../../.claude/skills/batch-merge/SKILL.md'],
  ['artifact .gemini/commands/batch-merge.toml', '../../../.gemini/commands/batch-merge.toml'],
]

// The names the vacuous version shipped. Pinned literally so their return is a
// failure and not a judgement call.
const PHANTOMS = ['Run Tests', 'Validate Project']

describe('/batch-merge Step 2a derives its required-check roster (#7503)', () => {
  let roster
  const bash = new Map()

  before(async () => {
    const contributing = await readFile(new URL('../../../CONTRIBUTING.md', import.meta.url), 'utf8')
    roster = parseRoster(contributing)
    for (const [label, rel] of SURFACES) {
      bash.set(label, sliceBash(await readFile(new URL(rel, import.meta.url), 'utf8'), '#### Step 2a'))
    }
  })

  // ---- positive control ----
  // Every rule below quantifies over the sliced fence. If the slicer stops
  // understanding these files it returns null/empty and each rule passes over
  // nothing, reporting a clean green — the cannot-check-as-nothing-to-check
  // failure. This runs first and names the surface that broke.
  it('the slicer finds a non-trivial Step 2a fence on all three surfaces', () => {
    for (const [label] of SURFACES) {
      const block = bash.get(label)
      assert.ok(block, `no Step 2a bash fence found in ${label} — the slicer is broken, not the skill`)
      assert.ok(
        block.length > 200,
        `Step 2a fence in ${label} is only ${block.length} chars — too short to be the gate`
      )
    }
    assert.equal(roster.length, 13, `expected 13 roster entries, got ${roster.length}`)
  })

  it('reads the roster from scripts/lib/contributing-roster.mjs', () => {
    for (const [label] of SURFACES) {
      assert.ok(
        bash.get(label).includes('scripts/lib/contributing-roster.mjs'),
        `${label}: Step 2a must derive REQUIRED_CHECKS from scripts/lib/contributing-roster.mjs`
      )
    }
  })

  it('names no check context of its own — neither a real one nor a phantom', () => {
    for (const [label] of SURFACES) {
      const block = bash.get(label)
      const named = [...roster, ...PHANTOMS].filter(n => block.includes(n))
      assert.deepEqual(
        named,
        [],
        `${label}: Step 2a hardcodes check names ${named.join(', ')} — the roster is derived, not typed ` +
          '(a typed list is what made this gate vacuous in #7503)'
      )
    }
  })

  it('treats a required context that is ABSENT from the payload as a blocker', () => {
    // The second half of the defect, and the one a truthful hardcoded list
    // would still have: filter-then-check-states passes when the filter matches
    // nothing. Proven against the `missing` fixture — the old shape with REAL
    // names still returned PASS with `Server Tests` deleted from the payload.
    for (const [label] of SURFACES) {
      const block = bash.get(label)
      assert.ok(
        block.includes('MISSING'),
        `${label}: Step 2a must classify an absent required context as MISSING, not skip it`
      )
      assert.ok(
        /length\)?\s*==\s*0/.test(block),
        `${label}: Step 2a must branch on a required context having zero check runs`
      )
    }
  })

  it('refuses rather than gating on a guess when an input is unreadable', () => {
    for (const [label] of SURFACES) {
      const block = bash.get(label)
      const refusals = (block.match(/REFUSE:/g) || []).length
      assert.ok(
        refusals >= 2,
        `${label}: expected >=2 REFUSE paths in Step 2a (unreadable roster, empty check payload), found ${refusals}`
      )
    }
  })
})

describe('/batch-merge states chroxy main\'s real strict setting (#7503)', () => {
  const whole = new Map()
  const fence = new Map()

  before(async () => {
    for (const [label, rel] of SURFACES) {
      const text = await readFile(new URL(rel, import.meta.url), 'utf8')
      whole.set(label, text)
      fence.set(label, sliceBash(text, '#### Step 2e'))
    }
  })

  // Live-verified 2026-08-29:
  // `gh api repos/blamechris/chroxy/branches/main/protection --jq
  // '.required_status_checks.strict'` returns `false`, matching
  // docs/decisions/2026-06-02-overnight-marathon.md, where a 12-PR batch
  // skipped Steps 2e/2f on exactly that basis. The playbook asserted
  // `strict: true` in two places and drove 2e/2f off it.

  it('every explicit claim about chroxy main says strict: false', () => {
    // Quantified over ALL claims, not `includes`. The doc states it twice
    // (Step 2e and Critical Rule 1) and an `includes` check is satisfied by
    // either one — so flipping the other stayed green in this guard's own
    // first draft.
    for (const [label] of SURFACES) {
      const claims = [...whole.get(label).matchAll(/chroxy main is `strict: (\w+)`/g)].map(m => m[1])
      assert.ok(
        claims.length >= 2,
        `${label}: expected >=2 explicit "chroxy main is strict: X" claims, found ${claims.length} — ` +
          'the phrasing changed and this guard is no longer reading the claim'
      )
      assert.deepEqual(
        [...new Set(claims)].sort(),
        ['false'],
        `${label}: the playbook claims chroxy main is strict: ${[...new Set(claims)].join('/')}; ` +
          'live protection and docs/decisions/2026-06-02-overnight-marathon.md both say false'
      )
    }
  })

  it('cites the decision record beside the claim', () => {
    for (const [label] of SURFACES) {
      assert.ok(
        whole.get(label).includes('docs/decisions/2026-06-02-overnight-marathon.md'),
        `${label}: must cite the decision record for the strict setting`
      )
    }
  })

  it('Step 2e derives STRICT, and the probe fails CLOSED', () => {
    for (const [label] of SURFACES) {
      const block = fence.get(label)
      // Positive control: without a Step 2e fence the two rules below quantify
      // over nothing and report green.
      assert.ok(block && block.length > 100, `${label}: no usable Step 2e bash fence — the slicer is broken`)
      assert.ok(
        block.includes('.required_status_checks.strict'),
        `${label}: Step 2e must read the live strict setting rather than assume one`
      )
      assert.ok(
        /2>\/dev\/null\)\s*\|\|\s*STRICT=true/.test(block),
        `${label}: an unreadable protection payload must fall back to STRICT=true (fail closed), not false`
      )
      assert.ok(
        /\[ "\$STRICT" = "false" \] \|\| STRICT=true/.test(block),
        `${label}: anything other than a definite "false" must be normalised to strict`
      )
    }
  })
})
