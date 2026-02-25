# Tester Agent Report — PR #892 (v0.2.0 Release)

**Perspective:** Tester — what does the test suite actually verify, what is it lying about, what gaps exist
**Rating: 2.5 / 5**

---

## Summary

The test suite has a structural integrity problem after this PR. Large blocks of tests were disabled with `describe.skip` instead of deleted, creating false confidence about test coverage. Meanwhile, tests that still run contain misleading fixtures from the PTY era. New behavior introduced by the PTY removal (protocol messages now silently dropped, new message types added) has zero negative test coverage. The `no-unused-vars` ESLint rule is set to `warn`, not `error`, so PTY-era dead imports pass CI without complaint.

---

## Findings

### 1. 835 Lines of Dead describe.skip Test Code

In `packages/server/tests/ws-server.test.js`, three `describe.skip` blocks cover PTY-era behavior:

- `describe.skip('PTY session management', ...)` — ~300 lines
- `describe.skip('terminal output handling', ...)` — ~285 lines
- `describe.skip('session attach flow', ...)` — ~250 lines

**Total counted by this report: 835 lines** (note: the Minimalist agent counted 2,583 lines; discrepancy is likely due to scope — this count covers the test bodies only, not including leading comments and blank lines).

Regardless of the exact count, these blocks:

1. Never run in CI — `describe.skip` silently skips
2. Never fail — they cannot catch regressions
3. Create an illusion that PTY behavior is "still being tracked"
4. Will confuse the next developer who runs `npm test -- --verbose` and sees a wall of skipped tests

**Fix:** Delete the blocks. They are not coming back.

### 2. ResizeSchema Ghost Passes Validation, Handler Silently Drops

In `packages/server/src/ws-schemas.js`, `ResizeSchema` is still included in the `ClientMessageSchema` discriminated union. This means:

1. A client sending `{ type: 'resize', cols: 80, rows: 24 }` passes schema validation
2. The validated message reaches the dispatch layer
3. There is no handler for `resize`
4. The message is silently dropped

From a testing perspective, there is **no test** that verifies `resize` messages are properly rejected or that the server sends an error response. The behavior (silent drop) is untested and invisible.

**Fix:** Remove `ResizeSchema` from `ClientMessageSchema`. Add a test that confirms unknown message types receive an error response (if that is the intended behavior).

### 3. Eight Live Tests in POST /permission-response Still Construct WsServer with ptyManager

In `packages/server/tests/ws-server.test.js`, the live (non-skipped) test block for `POST /permission-response` constructs `WsServer` with a `ptyManager` fixture:

```js
const server = new WsServer({
  ptyManager: mockPtyManager,
  sessionManager: mockSessionManager,
  // ...
})
```

`WsServer` no longer accepts or uses `ptyManager`. This constructor argument is silently ignored. The test passes — but it is testing against a fixture that does not reflect the real constructor interface. If a future developer looks at this test to understand how to construct `WsServer`, they will include `ptyManager` and be confused when it has no effect.

**Fix:** Remove `ptyManager` from the test fixtures for all live tests. The test file should model the real API.

### 4. no-unused-vars Is warn, Not error — PTY Leftovers Pass CI Silently

In `packages/server/.eslintrc.cjs` (or equivalent):

```js
'no-unused-vars': 'warn'
```

This means the dead imports identified by the Minimalist agent (`validateAttachments`, `ALLOWED_PERMISSION_MODE_IDS` in `ws-server.js`) generate warnings in the lint output but do not fail CI. The PTY cleanup left dead imports that are invisible in CI.

**Fix for testing purposes:** Either elevate `no-unused-vars` to `error`, or add an explicit lint step that fails on warnings. At minimum, the dead imports should be removed.

### 5. raw Event in EventNormalizer Has Tests but No Emitter — False Coverage

In `packages/server/tests/event-normalizer.test.js`, there are tests that verify the `raw` event is forwarded:

```js
it('should forward raw terminal output', () => {
  mockSession.emit('raw', Buffer.from('test data'))
  expect(mockWs.send).toHaveBeenCalledWith(...)
})
```

These tests pass because the test manually emits the `raw` event on a mock session. But in production, `raw` is only emitted by the PTY session path, which no longer exists. The coverage number is real but the coverage is meaningless — the test proves behavior that is unreachable in production.

**Fix:** Delete the `raw` forwarding tests alongside the `raw` handler code.

### 6. Zero Negative Tests for Removed Message Types

The test suite has no tests that verify removed message types are properly handled (rejected, ignored, or responded to with an error). Specifically:

- No test that sends `discover_sessions` and verifies the server response
- No test that sends `attach_session` and verifies the server response
- No test that sends `resize` and verifies the server response

This is a testing gap. If a future PR accidentally re-adds a handler for one of these types (perhaps by naming a new feature `resize`), CI would not catch the behavioral change.

**Fix:** Add three negative tests:

```js
describe('removed message types are handled safely', () => {
  it('should not crash on discover_sessions', ...)
  it('should not crash on attach_session', ...)
  it('should not crash on resize', ...)
})
```

---

## Test Suite Health Summary

| Category | Status |
|----------|--------|
| Live tests for core CLI flow | Pass |
| Live tests use correct fixtures | Partial — ptyManager ghost in 8 tests |
| Removed behavior has negative coverage | No |
| Skipped tests are clearly tombstones | No — described.skip without explanation |
| ESLint catches dead code | No — warn only |

---

## Conclusion

The test suite passes CI but is telling lies: fixtures reference removed constructor arguments, skipped blocks imply tracked-but-pending behavior, and dead event handlers have tests that prove nothing about production behavior. The ResizeSchema ghost is the most subtle — it looks like valid schema coverage but the tested behavior (silent drop) is unintentional and untested as such.

**Rating: 2.5/5** — CI is green but the test suite's signal-to-noise ratio decreased with this PR.
