/**
 * Shared mock for the message handler's injected connection context (#7451).
 *
 * `message-handler.ts` reads its per-connection state off a single injected
 * `ConnectionContext` (`_testMessageHandler.setContext` / `setConnectionContext`),
 * so every store suite that dispatches a message has to hand it one. Four
 * suites used to hand-build that literal independently, which meant a
 * one-field change to the context touched four files (PR #7446) and the copies
 * had already drifted apart.
 *
 * The return type is the REAL `ConnectionContext`, so the object literal below
 * is the compiler backstop the four copies never had: a field removed from the
 * context fails HERE ("Property 'x' is missing"), and a stale field left behind
 * fails HERE too (excess-property check on a typed literal) instead of being
 * silently swallowed by the `as any` at each call site.
 */
import type { ConnectionContext } from '../store/types';

/**
 * Build a `ConnectionContext` for message-handler tests. (Named for the type
 * it actually returns — `MessageHandlerContext` is a DIFFERENT, module-private
 * type in message-handler.ts; review N2 on #7463.)
 *
 * Pass `overrides` for the per-suite differences that are load-bearing (a
 * reconnect context, a socket whose `send` a test asserts against, …) so the
 * intent stays visible at the call site rather than hiding in a private copy.
 *
 * WHICH DEFAULTS GET A PIN, decided in #7696 so the next one is not a fresh
 * discovery: the ones that SELECT A BRANCH, not all of them. A default the
 * handler never branches on has nothing to assert about it — a pin there
 * asserts a string for its own sake, and a test that cannot fail meaningfully
 * is the thing this repo keeps filing.
 *
 * Audited by flipping each default and running the whole app suite:
 *
 *   default       flipped to                 result
 *   url           'ws://mutant.invalid:1'    1 failed,  total 2450   PINNED (#7525)
 *   isReconnect   true                       3 failed,  total 2197   PINNED, see below
 *   silent        true                       2 failed,  total 2450   PINNED (#7696)
 *   token         'MUTANT-token'             0 failed,  total 2450   not a branch selector
 *
 * THE TOTAL IS IN THE TABLE BECAUSE ONE ROW NEEDS IT. The `isReconnect` flip
 * does not merely fail 3 cases: it makes THIS FILE'S pinning suite
 * (__tests__/store/message-handler.test.ts) fail to RUN at all, so 253 tests
 * never execute and the total drops 2450 -> 2197. The 3 failures are in other
 * files (AutoResumeOnReconnect, auth-ok-handler), which is what pins it. The
 * crash is a pre-existing unhandled rejection on the reconnect branch —
 * `TypeError: (0, _persistence.loadLastConversationId) is not a function` at
 * message-handler.ts:2317 — reproducible with this file reverted to base, so it
 * is not this change's doing. Recorded because "3 failed" alone reads as a
 * healthy run, and a suite that CRASHED is different evidence from cases that
 * FAILED (#7704 review).
 *
 * `token` is carried on the context but never branched on — it is a `??`
 * fallback value at message-handler.ts:1995 and :2229 — so it is not pinned,
 * deliberately.
 *
 * `socket` is not pinned either, but NOT for the reason this note first gave.
 * It said "a cast stub whose identity each suite overrides when it matters",
 * and that is measurably false: 47 of the 261 call sites override `socket`, and
 * two that do NOT — both `auth_bootstrap (#5555)` rows — assert against the
 * default's `send` spy, so replacing it with a plain no-op reds them. That is
 * an incidental pin rather than a deliberate one, which is the honest
 * description, and it is why no explicit row is added here.
 *
 * If a handler ever starts branching on one of these, it joins the first three:
 * the test to write is the one that goes RED when the default is flipped, and
 * it must TAKE the default rather than pass the value explicitly.
 */
export function createMockConnectionContext<
  // Review on #7463 (S1): a typed-return factory checks the BASE literal, but
  // a variable-held override could smuggle an unknown field straight onto the
  // returned object — the fossil condition re-entering through the override
  // door. The mapped-`never` constraint rejects any key not on the real type,
  // for inline AND variable-held overrides alike.
  T extends Partial<ConnectionContext>,
>(
  overrides?: T & Record<Exclude<keyof T, keyof ConnectionContext>, never>,
): ConnectionContext {
  const base: ConnectionContext = {
    // PINNED, and the scheme is the load-bearing half (#7525). 230 of the 256
    // call sites across 11 files in this package take this default, and auth_ok
    // reads the scheme to choose the transport — `ws://` -> lan, `wss://` ->
    // tunnel. Flipping it to `ws://` therefore re-points every one of those
    // sites onto the OTHER branch, silently: measured, that change left all 503
    // tests across those files passing, exit 0. The pin is
    // "#7525 — the factory DEFAULT url classifies as tunnel" in
    // __tests__/auth-ok-handler.test.ts. It asserts the classification AND this
    // string, because each catches something the other does not: the string
    // also catches a host change, and the classification is the half that
    // survives someone flipping the scheme and updating the string expectation
    // to match. The measured table is in that test's comment.
    url: 'wss://test.example.com',
    token: 'test-token',
    isReconnect: false,
    // PINNED since #7696, and for the same reason `url` is: it SELECTS A
    // BRANCH. `message-handler.ts` reads it at three sites — the
    // identity-refusal path, `auth_fail` and `pair_fail` — where it gates
    // whether `Alert.alert(...)` fires at all. The pin is
    // "#7696 — the factory DEFAULT silent gates the failure alerts" in
    // __tests__/store/message-handler.test.ts, and it asserts BOTH directions,
    // because rows that only assert an alert FIRES also pass for a handler that
    // alerts unconditionally.
    silent: false,
    // A real WebSocket can't be constructed under jest. This is the one cast in
    // the factory and it is scoped to this single field — everything else is
    // checked against the real type.
    //
    // This said the handler "only ever touches `readyState` / `send` / `close`"
    // on it. `send` and `close` are right; `readyState` is read ZERO times off
    // the CONTEXT's socket — `sendIfOpen` reads the STORE's socket instead — and
    // flipping this `1` to `3` reds nothing (#7704 review). Kept at 1 because a
    // stub that claims to be closed would be a trap for the first handler that
    // does read it.
    socket: { readyState: 1, send: jest.fn(), close: jest.fn() } as unknown as WebSocket,
  };
  return { ...base, ...(overrides ?? {}) };
}
