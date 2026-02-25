# Minimalist Agent Report — PR #892 (v0.2.0 Release)

**Perspective:** Minimalist — every line of dead code is a liability; measure what was left behind
**Rating: 3 / 5**

---

## Summary

PTY removal is architecturally complete. The wrong files are gone. But the PR left behind an extensive trail of dead code: 2,583 lines of skipped tests, an entire UI flow in the app that reaches a server endpoint that no longer exists, dead imports, dead config defaults, and a dead event handler. These are not theoretical concerns — they are concrete lines that will be read, confused over, and potentially re-introduced by a future developer who doesn't know they're dead.

A cleanup PR that leaves 2,583 lines of dead code behind is not a cleanup.

---

## Findings

### 1. 2,583 Lines of Dead describe.skip Test Code

In `packages/server/tests/ws-server.test.js`, lines 1388–3971 consist of three `describe.skip` blocks:

- `describe.skip('PTY session management', ...)` — lines 1388–1987 (599 lines)
- `describe.skip('terminal output handling', ...)` — lines 1988–2700 (712 lines)
- `describe.skip('session attach flow', ...)` — lines 2701–3971 (1270 lines)

Total: **2,583 lines** that are never executed, never maintained, and never fail CI. They are not skipped pending a bug fix. They are tombstones for deleted functionality. They exist only to inflate the file and confuse future readers.

**Fix:** Delete lines 1388–3971 entirely. The file will be shorter, cleaner, and fully green.

### 2. Entire tmux Discovery UI in CreateSessionModal.tsx Is Dead

In `packages/app/src/components/CreateSessionModal.tsx`, there is a section that renders:

- A "Discover sessions" button
- A session list picker
- An "Attach to session" confirmation flow

This UI drives the `discover_sessions` → `session_list` → `attach_session` WebSocket flow. That flow was removed from the server in this PR. The UI is now entirely dead — it sends messages that the server drops and waits for responses that never come.

**Estimated size:** approximately 150–200 lines of JSX, state management, and handler code.

**Fix:** Delete the tmux discovery section from `CreateSessionModal.tsx`. The modal should only offer the "new session" path.

### 3. cli.js Version Hardcoded at 0.1.0

In `packages/server/src/cli.js`:

```js
.version('0.1.0')
```

The package is now at `0.2.0`. This is a dead literal that contradicts the `package.json`.

**Fix:** Replace with a dynamic read from `package.json`. This is two lines of code.

### 4. validateAttachments and ALLOWED_PERMISSION_MODE_IDS Are Dead Imports in ws-server.js

In `packages/server/src/ws-server.js`, the import block includes:

```js
import { validateAttachments, ALLOWED_PERMISSION_MODE_IDS } from './ws-schemas.js'
```

Both `validateAttachments` and `ALLOWED_PERMISSION_MODE_IDS` are imported but never referenced in the file body. They were used in PTY session handling that was deleted.

**Fix:** Remove both from the import line.

### 5. server-cli-child.js Dead Config Defaults

In `packages/server/src/server-cli-child.js`, the config destructuring includes defaults for:

```js
const {
  tmuxSession = 'claude',
  resume = false,
  // ...
} = config
```

`tmuxSession` and `resume` are never used downstream. They are dead defaults left over from PTY mode. The file now reads config keys that have no effect.

**Fix:** Remove `tmuxSession` and `resume` from the destructuring.

### 6. Raw Event Handler in EventNormalizer Is Dead Code

In `packages/server/src/event-normalizer.js`, there is a handler:

```js
session.on('raw', (data) => {
  // forward raw terminal output
})
```

The `raw` event is emitted by the PTY session path. The CLI headless session (`cli-session.js`) never emits `raw`. This handler will never fire in any currently supported code path.

**Fix:** Remove the `raw` event handler and its forwarding logic.

---

## Dead Code Inventory Summary

| Location | Dead Lines (approx.) | Type |
|----------|---------------------|------|
| `ws-server.test.js` lines 1388–3971 | 2,583 | describe.skip blocks |
| `CreateSessionModal.tsx` discovery UI | ~175 | Dead UI + handlers |
| `cli.js` version literal | 1 | Wrong constant |
| `ws-server.js` dead imports | 1 | Dead import line |
| `server-cli-child.js` dead defaults | 2 | Dead destructuring |
| `event-normalizer.js` raw handler | ~10 | Dead event handler |
| **Total** | **~2,772** | |

---

## What Was Done Well

- The server entrypoint files for PTY mode (`server.js`, `pty-manager.js`, `output-parser.js`) were deleted entirely.
- `node-pty` was removed from `package.json`.
- The `--terminal` flag is gone from the CLI.

---

## Conclusion

The large-scale deletion was done correctly. The small-scale cleanup was not. 2,583 lines of dead test code alone is enough to flag this PR as incomplete. These are not cosmetic issues — dead test code signals to the next developer that these behaviors are "being tracked" when they are not. Dead UI code in the app will confuse any developer who opens `CreateSessionModal.tsx` and tries to understand the session flow.

**Rating: 3/5** — structurally correct, surface cleanup incomplete.
