import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { WsServer } from '../src/ws-server.js'
import { CTX_NAMESPACES, CTX_NAMESPACE_NAMES } from '../src/ws-handler-context.js'
import { createMockSession } from './test-helpers.js'

/**
 * The THIRD side of the handler-ctx triangle (#7418).
 *
 * There are three representations of the WS handler-ctx shape, and after #7417
 * two of the three pairings were enforced:
 *
 *   typedef <-> roster        ws-handler-context-typedef-parity.test.js (#7417)
 *   roster  -> production     assertCtxShape(this._handlerCtx, {deep: true})
 *   production -> roster      NOTHING
 *
 * A getter added to one of `ws-server.js`'s five namespace literals but never
 * added to `CTX_NAMESPACES` was invisible to every check in the repo:
 * `assertCtxShape` only walks roster -> ctx, so an EXTRA field on the
 * production ctx is never noticed.
 *
 * Not hypothetical. That is exactly how `tokenManager` drifted for the entire
 * life of #6006, found only because a human compared the typedef by eye — and
 * the drift had consequences: `assertCtxShape({deep: true})` never required the
 * field so a partial mock missing it passed, and `nsCtx()`'s `FIELD_TO_NS`
 * never routed it, so a flat test field was left at the top level instead of
 * landing in `ctx.services`.
 *
 * NO PARSER, AND THAT IS THE DESIGN DECISION.
 * -----------------------------------------
 * #7418 proposes parsing the key names out of the five object literals in
 * `ws-server.js`, and warns — correctly — that such a parser needs a count
 * guard from the start, because #7417's review found its `@property` parser
 * silently dropped lines it could not match. In THIS direction a skipped field
 * is a GREEN PASS, which is the worst version of that hazard.
 *
 * So this reads the CONSTRUCTED OBJECT instead. `new WsServer(...)` builds the
 * real `_handlerCtx`, and `Object.keys()` cannot skip a key it does not
 * recognise — a getter, a spread, a computed name, a shorthand method all
 * appear identically. The hazard the issue warns about is removed rather than
 * guarded, and the acceptance criterion asking for a parser count guard is moot
 * because there is nothing to parse. Stated rather than silently skipped.
 *
 * The cost is that this constructs a server; it binds no port (`port: 0`, and
 * nothing calls `listen`) and is closed in `after`.
 */
describe('the production _handlerCtx carries no field CTX_NAMESPACES does not list (#7418)', () => {
  let ctx
  let server

  before(() => {
    server = new WsServer({
      port: 0,
      apiToken: 'tok-ctx-parity',
      cliSession: createMockSession(),
      authRequired: true,
    })
    ctx = server._handlerCtx
  })

  after(() => {
    server?.close?.()
  })

  it('CONTROL: the constructed ctx is real, so an empty one cannot pass the rules below', () => {
    // Every rule here quantifies over the ctx's own keys. A ctx that came back
    // empty — a constructor that changed shape, a mock that replaced it — would
    // satisfy "no extra fields" trivially. That is the empty-set pass this
    // repo's catalogue calls entry 22, and it is the one way this test could
    // report success while checking nothing.
    assert.ok(ctx && typeof ctx === 'object', 'the constructor must produce a handler ctx')
    assert.deepEqual(
      CTX_NAMESPACE_NAMES.filter(ns => !ctx[ns] || typeof ctx[ns] !== 'object'),
      [],
      'every namespace the roster names must exist on the constructed ctx'
    )
    const liveTotal = CTX_NAMESPACE_NAMES.reduce((n, ns) => n + Object.keys(ctx[ns]).length, 0)
    const rosterTotal = CTX_NAMESPACE_NAMES.reduce((n, ns) => n + CTX_NAMESPACES[ns].length, 0)
    assert.ok(liveTotal >= 40, `expected the ctx to carry many keys, found ${liveTotal}`)
    assert.equal(liveTotal, rosterTotal, 'the two sides must agree in total, not just per namespace')
  })

  for (const ns of CTX_NAMESPACE_NAMES) {
    it(`${ns}: the production namespace and the roster list the same keys`, () => {
      const live = Object.keys(ctx[ns]).sort()
      const roster = [...CTX_NAMESPACES[ns]].sort()

      // BOTH directions, and the second is the one nothing else covers.
      // `assertCtxShape({deep: true})` already fails when the roster names a
      // field the ctx lacks; only this notices a field the ctx has and the
      // roster does not.
      assert.deepEqual(
        live.filter(k => !roster.includes(k)),
        [],
        `${ns} carries a field CTX_NAMESPACES does not list — assertCtxShape walks roster -> ctx ` +
          'and cannot see it, nsCtx() will not route it, and a partial mock missing it still passes'
      )
      assert.deepEqual(
        roster.filter(k => !live.includes(k)),
        [],
        `CTX_NAMESPACES lists a ${ns} field the production ctx does not carry`
      )
    })
  }
})
