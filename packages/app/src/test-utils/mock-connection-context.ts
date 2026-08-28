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
    url: 'wss://test.example.com',
    token: 'test-token',
    isReconnect: false,
    silent: false,
    // A real WebSocket can't be constructed under jest, and the handler only
    // ever touches `readyState` / `send` / `close` on it. This is the one cast
    // in the factory and it is scoped to this single field — everything else
    // is checked against the real type.
    socket: { readyState: 1, send: jest.fn(), close: jest.fn() } as unknown as WebSocket,
  };
  return { ...base, ...(overrides ?? {}) };
}
