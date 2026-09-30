/**
 * Shared "what counts as publishing" vocabulary for release.yml's guards
 * (#8150 review). Two consumers read this: `release-verify-artifacts-gate
 * .test.js` (JOB-level — does this job publish at all, for the
 * verify-artifacts gate) and `release-docker-smoke-gate.test.js` (STEP-level
 * — does THIS step publish, for the smoke-before-push ordering gate). Both
 * questions need the same underlying command/action vocabulary, and before
 * this file existed each one had its own copy — the copies had already
 * drifted (the step-level one recognised `docker image push`, the job-level
 * one didn't) before anyone noticed, which is the "a hardcoded list beside a
 * growing set" cause docs/false-safety-guards.md catalogues, one level up
 * from usual: here the GROWING SET is the vocabulary itself, and the two
 * copies grew at different rates.
 */
import assert from 'node:assert/strict'
import { stepInput, stepRun } from './workflow-reader.js'

/**
 * Removes YAML comments before matching, QUOTE-AWARE: a `#` inside a single-
 * or double-quoted string is not a comment marker, and a `#` only starts a
 * comment when at line start or preceded by whitespace. A line that is
 * entirely a comment is truncated to (at most) its leading whitespace.
 *
 * Moved here from release-verify-artifacts-gate.test.js unchanged (#8150
 * review, S3) — this repo's own doctrine comments routinely narrate the very
 * actions these guards match on, so a check that read prose as configuration
 * would be satisfiable by prose that no longer matches the steps beneath it.
 */
export function stripYamlComments(bodyLines) {
  return bodyLines.map((line) => {
    let inSingle = false
    let inDouble = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (inSingle) {
        if (c === "'") inSingle = false
        continue
      }
      if (inDouble) {
        if (c === '\\') { i++; continue }
        if (c === '"') inDouble = false
        continue
      }
      if (c === "'") { inSingle = true; continue }
      if (c === '"') { inDouble = true; continue }
      if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
    }
    return line
  })
}

// ---- the publish vocabulary -------------------------------------------------

/** Matched by ACTION/COMMAND, not by job/step id or name (a rename must not
 * silently drop a job out of either check). Widened beyond the two GitHub
 * Actions this repo used originally (#8166 review) and again for #8150's
 * review (C4): `docker image push`, `docker manifest push` and
 * `docker buildx imagetools create` all publish without ever passing
 * `--push` to `docker buildx build`. */
export const PUBLISH_ACTION_RE = /docker\/build-push-action|softprops\/action-gh-release/
export const BUILD_PUSH_ACTION_RE = /docker\/build-push-action/
export const LOGIN_ACTION_RE = /docker\/login-action/

export const PUBLISH_RUN_RE =
  /\bdocker\s+push\b|\bdocker\s+image\s+push\b|\bdocker\s+manifest\s+push\b|\bgh\s+release\s+(?:create|upload|edit)\b|\b(?:npm|pnpm|yarn)\s+publish\b/
export const PUBLISH_BUILDX_PUSH_RE = /\bdocker\s+buildx\b[\s\S]{0,300}?--push\b/
export const PUBLISH_IMAGETOOLS_CREATE_RE = /\bdocker\s+buildx\s+imagetools\s+create\b/
// `docker buildx build --output=type=registry,...` (or `-o type=registry`)
// publishes without `--push` at all; same for an explicit `push=true` inside
// the output spec.
export const PUBLISH_OUTPUT_REGISTRY_RE = /(?:--output|-o)(?:=|\s+)\S*\btype=registry\b/
export const PUBLISH_OUTPUT_PUSH_TRUE_RE = /(?:--output|-o)(?:=|\s+)\S*\bpush=true\b/
// Any `docker build` / `docker buildx build` invocation — used to catch a
// REBUILD after the smoke step (#8150 review, S1), regardless of whether
// that particular invocation pushes.
export const RUN_DOCKER_BUILD_RE = /\bdocker\s+(?:buildx\s+)?build\b/

/** True when `runBody` (a step's `run:` script, as `stepRun()` returns it)
 * matches any raw-CLI publish shape. */
export function runBodyPublishes(runBody) {
  if (typeof runBody !== 'string') return false
  return (
    PUBLISH_RUN_RE.test(runBody) ||
    PUBLISH_BUILDX_PUSH_RE.test(runBody) ||
    PUBLISH_IMAGETOOLS_CREATE_RE.test(runBody) ||
    PUBLISH_OUTPUT_REGISTRY_RE.test(runBody) ||
    PUBLISH_OUTPUT_PUSH_TRUE_RE.test(runBody)
  )
}

// A job whose OWN `permissions:` grants something only a publish-shaped
// action would need is publishing even if its exact command isn't one of the
// ones matched above — least-privilege workflows don't request these for
// anything else on a RELEASE workflow specifically.
export const DANGEROUS_PERMISSION_RE = /^\s*(?:packages|contents|id-token):\s*write\s*$/

/** True when `jobBody` (already comment-stripped) declares one of the
 * publish-shaped permissions above, at the job's own `permissions:` block
 * (4-space indent). */
export function hasPublishingPermissions(jobBody) {
  const at = jobBody.findIndex((l) => /^ {4}permissions:/.test(l))
  if (at === -1) return false
  if (/write-all/.test(jobBody[at])) return true
  for (let i = at + 1; i < jobBody.length; i++) {
    const line = jobBody[i]
    if (/^\s*$/.test(line)) continue
    const indent = /^(\s*)/.exec(line)[1].length
    if (indent <= 4) break
    if (DANGEROUS_PERMISSION_RE.test(line)) return true
  }
  return false
}

/** True when `job`'s real (non-comment) step content invokes a publish-shaped
 * action or command, OR its own permissions grant is publish-shaped.
 * JOB-LEVEL: "does this job ever touch a publish-shaped action at all",
 * irrespective of a particular step's `push:` value — used by
 * release-verify-artifacts-gate.test.js to decide which jobs must
 * transitively need verify-artifacts. */
export function isPublishingJob(job) {
  const code = stripYamlComments(job.body)
  const codeText = code.join('\n')
  return (
    PUBLISH_ACTION_RE.test(codeText) ||
    PUBLISH_RUN_RE.test(codeText) ||
    PUBLISH_BUILDX_PUSH_RE.test(codeText) ||
    PUBLISH_IMAGETOOLS_CREATE_RE.test(codeText) ||
    PUBLISH_OUTPUT_REGISTRY_RE.test(codeText) ||
    PUBLISH_OUTPUT_PUSH_TRUE_RE.test(codeText) ||
    hasPublishingPermissions(code)
  )
}

// ---- the stricter if: rule (#8150 review, C3) ------------------------------

/**
 * GitHub Actions expressions are not case-sensitive, and a status-check
 * function's result depends on OPERAND ORDER in a way a substring-based
 * "contains always()/failure()/cancelled()" check cannot see:
 * `if: X || success()`, `if: !success()`, and `if: true || success()` all
 * pass a check that only looks for the DANGEROUS function names, because the
 * dangerous part here is `success()` itself used unsafely — negated, OR'd
 * after something else, or shadowed by a always-true operand ahead of it.
 *
 * The fix is to require the SAFE form instead of enumerating unsafe ones:
 * absent, or the bare expression `success()` (optionally wrapped in
 * `${{ }}`), is safe. Anything else that contains a status-check function
 * call (`always|failure|cancelled|success` followed by `(`) is reported.
 */
const STATUS_FN_RE = /\b(?:always|failure|cancelled|success)\s*\(/i

/**
 * @param {string|undefined} ifExpr A job's or step's `if:` value, or
 *   undefined when it has none.
 * @returns {string|null} An issue message, or null when `ifExpr` is safe.
 */
export function dangerousIfIssue(ifExpr) {
  if (ifExpr === undefined || ifExpr === null) return null
  const trimmed = String(ifExpr).trim()
  const bare = trimmed.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '').trim()
  if (bare.toLowerCase() === 'success()') return null
  if (STATUS_FN_RE.test(trimmed)) {
    return `dangerous if: (${ifExpr}) — must be absent or exactly success()`
  }
  return null
}

// ---- step-level structural readers (#8150 review, C1/C4) -------------------

const BLOCK_HEAD_RE = /^[|>][+-]?\d*$/

/**
 * A `with:` (or any mapping) input's value, read STRUCTURALLY: handles both
 * a single-line value and a YAML block scalar (`key: |`), with YAML comments
 * stripped first. Unlike `workflow-reader.js`'s `stepInput` (which only ever
 * returns the KEY LINE's own trailing text), this follows a block scalar's
 * body — the shape `tags:` and `outputs:` both use in this job.
 *
 * Returns the value with each line trimmed and blank lines dropped, joined
 * by `\n` — good enough to test membership of an exact tag, or presence of a
 * substring, without pretending to be a general YAML parser.
 *
 * @param {string[]} stepLines
 * @param {string} key
 * @returns {string|undefined}
 */
export function stepWithInput(stepLines, key) {
  const code = stripYamlComments(stepLines)
  const normalised = code.map((l, i) => (i === 0 ? l.replace(/^(\s*)-\s/, (_, sp) => `${sp}  `) : l))
  const keyRe = new RegExp(`^(\\s*)${key}:\\s*(.*)$`)
  const idx = normalised.findIndex((l) => keyRe.test(l))
  if (idx === -1) return undefined
  const m = keyRe.exec(normalised[idx])
  const keyIndent = m[1].length
  const head = m[2].trim()

  if (BLOCK_HEAD_RE.test(head)) {
    const lines = []
    for (let i = idx + 1; i < normalised.length; i++) {
      const line = normalised[i]
      if (/^\s*$/.test(line)) continue // blank lines contribute nothing worth matching
      const indent = /^(\s*)/.exec(line)[1].length
      if (indent <= keyIndent) break
      lines.push(line.trim())
    }
    return lines.join('\n')
  }

  if (head.startsWith("'") || head.startsWith('"')) {
    const q = head[0]
    const close = head.indexOf(q, 1)
    return close === -1 ? head.slice(1) : head.slice(1, close)
  }
  return head
}

/**
 * Does this build-push-action step's `tags:` input contain `tag` as an
 * EXACT, trimmed line?
 *
 * THE DEFECT THIS REPLACES (#8150 review, C1): the original check was
 * `stepLines.some(l => l.includes(tag))` over every raw line of every
 * earlier step — and `workflow-reader.js`'s `parseSteps` attaches the
 * COMMENT LINES immediately above a step to the PRECEDING step (a step
 * begins at its own `- ` dash line, so everything before that dash,
 * including a neighbour's trailing comment, belongs to whichever step came
 * before it). release.yml's own build step is introduced by a comment
 * reading "...chroxy:release-smoke tag the next step smoke-starts", which
 * therefore sits inside the PRECEDING step's (`Extract metadata`) line
 * array — so the naive substring check passed even with the tag deleted
 * from the real `tags:` list, because it was quietly reading a comment
 * instead. Reading the `tags:` key's value STRUCTURALLY (and stripping
 * comments first) cannot be fooled by prose that merely mentions the tag.
 *
 * @param {string[]} stepLines
 * @param {string} tag
 * @returns {boolean}
 */
export function tagsBlockContainsExactTag(stepLines, tag) {
  const val = stepWithInput(stepLines, 'tags')
  if (typeof val !== 'string') return false
  return val.split('\n').includes(tag)
}

/** True when this step's `uses:` names `docker/build-push-action`. */
export function stepUsesBuildPushAction(stepLines) {
  const usesAction = stepInput(stepLines, 'uses')
  return !!(usesAction && BUILD_PUSH_ACTION_RE.test(usesAction))
}

/** True when this step's `uses:` names `docker/login-action`. */
export function stepUsesLoginAction(stepLines) {
  const usesAction = stepInput(stepLines, 'uses')
  return !!(usesAction && LOGIN_ACTION_RE.test(usesAction))
}

/**
 * True when this step actually PUBLISHES the image.
 *
 * FAILS CLOSED (#8150 review, C4): a `build-push-action` step is treated as
 * NON-publishing only when `push:` is the literal string `false` or the key
 * is absent, AND its `outputs:` input (read structurally — it can be a block
 * scalar too) contains neither `type=registry` nor `push=true`, either of
 * which publishes to a registry without ever setting `push: true`. Any other
 * spelling — `push: True` (not the literal lowercase `false`), `push: ${{
 * expr }}`, an `outputs:` line naming a registry destination — counts as
 * publishing. The previous rule only matched the LITERAL string `'true'` for
 * publishing, which is the unsafe direction: it is exactly as easy to miss a
 * real publish as to false-flag a safe one, and missing one is the
 * dangerous failure here.
 *
 * A `run:` step publishes via any of `runBodyPublishes`'s raw-CLI shapes.
 *
 * @param {string[]} stepLines
 * @returns {boolean}
 */
export function stepPublishesImage(stepLines) {
  if (stepUsesBuildPushAction(stepLines)) {
    const pushVal = stepInput(stepLines, 'push')
    const pushIsFalseOrAbsent = pushVal === undefined || pushVal === 'false'
    const outputsVal = stepWithInput(stepLines, 'outputs') || ''
    const outputsPublishes = /\btype=registry\b/.test(outputsVal) || /\bpush=true\b/.test(outputsVal)
    return !(pushIsFalseOrAbsent && !outputsPublishes)
  }
  return runBodyPublishes(stepRun(stepLines))
}

/**
 * True when this step BUILDS the image — a `build-push-action` step
 * (regardless of its `push:`/`load:` values), or a `run:` step invoking
 * `docker build` / `docker buildx build`. Used to catch a REBUILD between
 * the smoke step and the last publishing step (#8150 review, S1): "never
 * rebuilt" is part of the invariant's whole point (what is smoked must be
 * what ships), but nothing in the original rule checked for a second build.
 *
 * @param {string[]} stepLines
 * @returns {boolean}
 */
export function stepIsBuildStep(stepLines) {
  if (stepUsesBuildPushAction(stepLines)) return true
  const runBody = stepRun(stepLines)
  return typeof runBody === 'string' && RUN_DOCKER_BUILD_RE.test(runBody)
}

assert.ok(typeof stepInput === 'function' && typeof stepRun === 'function', 'expected workflow-reader.js to export stepInput and stepRun')
