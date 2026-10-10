/**
 * #7429 — the server's notification category roster is pinned, in BOTH
 * directions, to the roster the two clients render.
 *
 * `ALL_CATEGORIES` (notification-prefs.js) and `RATE_LIMITS` (push.js) name
 * what the daemon can fire. The mobile app and the dashboard used to keep a
 * hand-written copy of the labels + render order each, and nothing compared
 * either to the server: a category added server-side rendered as a raw key
 * (`ci_complete`) on both clients, with every test still green. Both clients
 * now import ONE roster from `@chroxy/protocol`
 * (`src/notification-categories.ts`); this file holds the server to it.
 *
 * Why this can go red (docs/false-safety-guards.md entry 21 / 28): the two
 * sides are real exports from two different packages, and neither is derived
 * from the other. `ALL_CATEGORIES` is a literal in notification-prefs.js; the
 * client roster is a literal in the protocol package. Break either file and
 * the comparison dies:
 *   - add a category to ALL_CATEGORIES only  -> "no client label" (server -> client)
 *   - add one to the protocol roster only    -> "server cannot fire it" (client -> server)
 *   - delete one from either                 -> the same two messages, mirrored
 * Reordering the protocol roster is NOT caught here, deliberately: the render
 * order is a presentation choice with a single definition (the array order),
 * so there is no second copy of it to disagree with. It is pinned where it is
 * observable — the dashboard render test and the app constants test.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABELS,
  NOTIFICATION_CATEGORY_ORDER,
} from '@chroxy/protocol'
import { ALL_CATEGORIES } from '../src/notification-prefs.js'
import { RATE_LIMITS } from '../src/push.js'

const PROTOCOL_FILE = 'packages/protocol/src/notification-categories.ts'
const SERVER_FILE = 'packages/server/src/notification-prefs.js'

describe('notification category roster: server <-> clients (#7429)', () => {
  it('refuses to compare empty rosters (an empty list would satisfy any containment check)', () => {
    assert.ok(ALL_CATEGORIES.length >= 1, 'ALL_CATEGORIES is empty — the server roster did not load')
    assert.ok(Object.keys(RATE_LIMITS).length >= 1, 'RATE_LIMITS is empty')
    assert.ok(
      NOTIFICATION_CATEGORIES.length >= 1,
      `NOTIFICATION_CATEGORIES is empty — the client roster did not load (${PROTOCOL_FILE}). ` +
        'Is packages/protocol built (npm run build -w packages/protocol)?',
    )
    assert.ok(NOTIFICATION_CATEGORY_ORDER.length >= 1, 'NOTIFICATION_CATEGORY_ORDER is empty')
    assert.ok(Object.keys(NOTIFICATION_CATEGORY_LABELS).length >= 1, 'NOTIFICATION_CATEGORY_LABELS is empty')
  })

  it('every server category has a client label and a render slot', () => {
    const clientKeys = new Set(NOTIFICATION_CATEGORIES.map((c) => c.key))
    const missing = ALL_CATEGORIES.filter((k) => !clientKeys.has(k))
    assert.deepEqual(
      missing,
      [],
      `server categories with no label/order entry in ${PROTOCOL_FILE} (both clients would render the raw key): ${missing.join(', ')}`,
    )
  })

  it('every client category is one the server can fire (and mute)', () => {
    const serverKeys = new Set(ALL_CATEGORIES)
    const orphans = NOTIFICATION_CATEGORIES.map((c) => c.key).filter((k) => !serverKeys.has(k))
    assert.deepEqual(
      orphans,
      [],
      `client categories missing from ALL_CATEGORIES in ${SERVER_FILE} (a toggle the server strips as unknown, so it does nothing): ${orphans.join(', ')}`,
    )
  })

  it('the three server/client rosters carry exactly the same set', () => {
    assert.deepEqual([...ALL_CATEGORIES].sort(), Object.keys(RATE_LIMITS).sort())
    assert.deepEqual([...ALL_CATEGORIES].sort(), [...NOTIFICATION_CATEGORY_ORDER].sort())
    assert.deepEqual([...ALL_CATEGORIES].sort(), Object.keys(NOTIFICATION_CATEGORY_LABELS).sort())
  })

  it('every category carries a non-empty label and hint, and no key repeats', () => {
    const seen = new Set()
    for (const c of NOTIFICATION_CATEGORIES) {
      assert.ok(typeof c.label === 'string' && c.label.trim().length > 0, `${c.key}: empty label`)
      assert.ok(typeof c.hint === 'string' && c.hint.trim().length > 0, `${c.key}: empty hint`)
      assert.ok(c.label !== c.key, `${c.key}: label is the raw key`)
      assert.ok(!seen.has(c.key), `${c.key}: listed twice in ${PROTOCOL_FILE}`)
      seen.add(c.key)
    }
  })
})
