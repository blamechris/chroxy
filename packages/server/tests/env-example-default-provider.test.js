import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PROVIDER } from '@chroxy/protocol'

/**
 * #7125 — `.env.example` advertised `CHROXY_PROVIDER=claude-sdk` as the
 * `(default)` provider. The real default, single-sourced as `DEFAULT_PROVIDER`
 * in `@chroxy/protocol`, has been `claude-tui` since #5819/#5822.
 *
 * `.env.example` values are meant to be uncommented verbatim, so the stale
 * line was a behaviour change disguised as a no-op: an operator "keeping the
 * default" would silently switch off the subscription-billed `claude-tui`
 * provider and onto `claude-sdk`, which meters against a separate
 * programmatic-credit pool. Same defect shape as the `CHROXY_MAX_PAYLOAD`
 * line fixed in #7011/#7117 (see `cli-max-payload-help-default.test.js`).
 *
 * The extraction below is deliberately strict: a `CHROXY_PROVIDER` line with
 * zero `(default)` markers or more than one is a parse FAILURE, not a pass.
 * A parser that matches nothing and silently compares `undefined`, or picks
 * the first/last of several matches, is exactly the false-safety shape this
 * repo's test catalogue tracks (`docs/false-safety-guards.md`) — so the
 * strictness itself is pinned by the last two tests below, independent of
 * whatever `.env.example` currently says.
 */

function envExampleText() {
  const path = fileURLToPath(new URL('../.env.example', import.meta.url))
  return readFileSync(path, 'utf8')
}

/**
 * The single line documenting `CHROXY_PROVIDER`. Throws unless there is
 * EXACTLY ONE — a second `CHROXY_PROVIDER=` line (an edit or a merge) must
 * fail, not be resolved by silently taking the first match.
 */
function providerLine(text) {
  const lines = text.split('\n').filter((l) => l.includes('CHROXY_PROVIDER='))
  if (lines.length !== 1) {
    throw new Error(`expected exactly one CHROXY_PROVIDER= line in .env.example, found ${lines.length}`)
  }
  return lines[0]
}

/**
 * The provider ASSIGNED on the line — the part an operator uncomments
 * verbatim, which is what #7125 was actually about. Throws rather than
 * returning `undefined` when no value can be read.
 */
function assignedProvider(line) {
  const match = /CHROXY_PROVIDER=([a-z][a-z0-9-]*)/.exec(line)
  if (!match) {
    throw new Error(`could not read the value assigned on the CHROXY_PROVIDER line: ${line}`)
  }
  return match[1]
}

/**
 * Extracts the provider name marked `(default)` on a `CHROXY_PROVIDER` line.
 * Throws — never returns `undefined` or a guess — unless the line carries
 * EXACTLY ONE `(default)` marker immediately after a provider name. Zero
 * markers or several must fail loudly, not pass silently.
 */
function extractDefaultProvider(line) {
  const markers = line.match(/\(default\)/g) || []
  if (markers.length !== 1) {
    throw new Error(
      `expected exactly one "(default)" marker on the CHROXY_PROVIDER line, found ${markers.length}: ${line}`,
    )
  }
  const match = /([a-z][a-z0-9-]*)\s*\(default\)/.exec(line)
  if (!match) {
    throw new Error(`could not find a provider name immediately before the "(default)" marker: ${line}`)
  }
  return match[1]
}

describe('.env.example default provider (#7125)', () => {
  it('documents a CHROXY_PROVIDER line', () => {
    providerLine(envExampleText())
  })

  it('names exactly one provider as the default', () => {
    // Throws (fails the test) unless exactly one "(default)" marker is present.
    extractDefaultProvider(providerLine(envExampleText()))
  })

  it('the named default equals DEFAULT_PROVIDER from @chroxy/protocol', () => {
    const line = providerLine(envExampleText())
    const named = extractDefaultProvider(line)
    assert.equal(
      named,
      DEFAULT_PROVIDER,
      `.env.example names "${named}" as the default provider but DEFAULT_PROVIDER is "${DEFAULT_PROVIDER}": ${line}`,
    )
  })

  it('the assigned example value equals DEFAULT_PROVIDER (it is uncommented verbatim)', () => {
    // The "(default)" marker lives in a trailing comment; the VALUE is what an
    // operator actually gets. Pin both, so a stale value behind a correct
    // comment still fails.
    const line = providerLine(envExampleText())
    assert.equal(
      assignedProvider(line),
      DEFAULT_PROVIDER,
      `.env.example assigns "${assignedProvider(line)}" but DEFAULT_PROVIDER is "${DEFAULT_PROVIDER}": ${line}`,
    )
  })

  it('line lookup fails loudly on two CHROXY_PROVIDER= lines, not by taking the first', () => {
    assert.throws(
      () => providerLine('# CHROXY_PROVIDER=claude-tui  # claude-tui (default)\n# CHROXY_PROVIDER=claude-sdk\n'),
      /found 2/,
    )
    assert.throws(() => providerLine('# nothing here\n'), /found 0/)
  })

  it('extraction fails loudly on zero "(default)" markers, not silently', () => {
    // Positive control on the strictness itself: a line naming no default at
    // all must not be read as "nothing to check" — it must throw.
    assert.throws(
      () => extractDefaultProvider('# CHROXY_PROVIDER=claude-tui       # Session backend'),
      /found 0/,
    )
  })

  it('extraction fails loudly on more than one "(default)" marker, not by guessing', () => {
    // Positive control: an ambiguous line (two markers) must not be resolved
    // by silently picking the first or last match.
    assert.throws(
      () =>
        extractDefaultProvider(
          '# CHROXY_PROVIDER=claude-tui       # claude-tui (default) or claude-sdk (default)',
        ),
      /found 2/,
    )
  })
})
