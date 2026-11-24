/**
 * The example timer definitions in docs/guides/freshness-runner.md: each runs
 * the tick from a pinned install (a `node_modules` path, never a checkout),
 * keeps the ledger outside the daemon's state directory and fires once per
 * cadence. The examples are documentation; nothing installs them. Each rule has
 * a mutant (an edit to the guide's text) that must fail it.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SRC } from '../freshness-core/helpers/harness.js'

const GUIDE = path.resolve(SRC, '..', '..', '..', 'docs', 'guides', 'freshness-runner.md')
const REAL = fs.readFileSync(GUIDE, 'utf8')
const RUNNER = 'node_modules/@chroxy/server/src/freshness-runner/cli.js'

const fenced = (text, lang, containing) => {
  const blocks = [...text.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1])
  const hit = blocks.filter((b) => b.includes(containing))
  assert.equal(hit.length, 1, `exactly one ${lang} block containing ${containing}, found ${hit.length}`)
  return hit[0]
}

/** The rules every timer example must meet; throws an assertion when one is broken. */
export function checkTimerExamples(text) {
  const plist = fenced(text, 'xml', 'StartInterval')
  const service = fenced(text, 'ini', 'ExecStart')
  const timer = fenced(text, 'ini', 'OnUnitActiveSec')
  const argsOf = (block) => block.match(/<string>[^<]*<\/string>/g)?.map((s) => s.slice(8, -9)) ?? []
  const plistArgs = argsOf(plist)
  const serviceArgs = service.match(/^ExecStart=(.*)$/m)[1].split(' ')
  for (const [name, args] of [['plist', plistArgs], ['service', serviceArgs]]) {
    assert.ok(args.some((a) => a.includes(RUNNER)), `${name} runs the runner from a pinned install`)
    assert.ok(!args.some((a) => /packages[\\/]server/.test(a)), `${name} does not run a development checkout`)
    assert.ok(args.includes('tick'), `${name} runs one tick`)
    const ledger = args[args.indexOf('--ledger-dir') + 1]
    assert.ok(args.includes('--ledger-dir') && ledger && !/[\\/]\.chroxy([\\/]|$)/.test(ledger), `${name} keeps the ledger out of the daemon state directory`)
    assert.ok(!args.includes('--allow-dev-checkout'), `${name} does not allow a development checkout`)
    assert.ok(!args.includes('--mode') || args[args.indexOf('--mode') + 1] === 'read-only', `${name} is read-only`)
  }
  const cadence = (args) => Number(args[args.indexOf('--cadence-minutes') + 1])
  assert.equal(cadence(plistArgs), cadence(serviceArgs), 'both examples use one cadence')
  const minutes = cadence(plistArgs)
  assert.ok(Number.isFinite(minutes) && minutes > 0)
  assert.equal(Number(plist.match(/StartInterval<\/key><integer>(\d+)</)[1]), minutes * 60, 'launchd fires once per cadence')
  assert.equal(timer.match(/^OnUnitActiveSec=(\d+)min$/m)?.[1], String(minutes), 'systemd fires once per cadence')
  assert.match(service, /Type=oneshot/, 'the service runs once and exits')
}

const edit = (from, to) => (text) => {
  assert.equal(text.split(from).length - 1, 1, `mutant edit must match once: ${from}`)
  return text.replace(from, () => to)
}

describe('the timer examples in the runner guide', () => {
  it('meet the rules', () => checkTimerExamples(REAL))
  const mutants = {
    'the plist runs a checkout': edit('/node_modules/@chroxy/server/src/freshness-runner/cli.js</string>', '/packages/server/src/freshness-runner/cli.js</string>'),
    'the service runs a checkout': edit('COMMIT/node_modules/@chroxy/server/src/freshness-runner/cli.js tick', 'chroxy/packages/server/src/freshness-runner/cli.js tick'),
    'the plist ledger is in the daemon state directory': edit('/Users/example/.local/state/chroxy-freshness/ledger</string>', '/Users/example/.chroxy/freshness</string>'),
    'the service ledger is in the daemon state directory': edit('--ledger-dir %h/.local/state/chroxy-freshness/ledger', '--ledger-dir %h/.chroxy/freshness'),
    'launchd fires faster than the cadence': edit('<integer>1800</integer>', '<integer>600</integer>'),
    'systemd fires slower than the cadence': edit('OnUnitActiveSec=30min', 'OnUnitActiveSec=60min'),
    'the service stays running': edit('Type=oneshot', 'Type=simple'),
    'the plist allows a checkout': edit('<string>--cadence-minutes</string>', '<string>--allow-dev-checkout</string>\n    <string>--cadence-minutes</string>'),
    'the cadences differ': edit('--cadence-minutes 30', '--cadence-minutes 45'),
    'the plist does not tick': edit('<string>tick</string>', '<string>stamp</string>'),
  }
  for (const [label, mutate] of Object.entries(mutants)) {
    it(`mutant "${label}" fails them`, () => {
      assert.throws(() => checkTimerExamples(mutate(REAL)), (e) => e instanceof assert.AssertionError, `the "${label}" mutant survived`)
    })
  }
})
