# Skeptic Agent Report — PR #892 (v0.2.0 Release)

**Perspective:** Skeptic — challenge every assumption, look for what was missed or half-done
**Rating: 2.5 / 5**

---

## Summary

The PR claims to remove PTY/tmux as a first-class path and bump the version to v0.2.0. Structurally, the heavy lifting is done. But the cleanup is shallow — references, schemas, docs, and tests were left behind in a way that suggests the author swept the floor and pushed the dirt under the rug.

---

## Findings

### 1. Tauri Signing Config Uses Literal $VAR Strings (Critical — 1/5)

In `packages/desktop/src-tauri/tauri.conf.json`, the signing configuration contains:

```json
"signingIdentity": "$APPLE_SIGNING_IDENTITY",
"certificate": "$APPLE_CERTIFICATE",
"certificatePassword": "$APPLE_CERTIFICATE_PASSWORD"
```

These are **not interpolated by Tauri**. The JSON config is parsed as-is. At build time, Tauri will attempt to use the literal string `$APPLE_SIGNING_IDENTITY` as the identity — which will fail codesign silently or with a confusing error.

Environment variable substitution in `tauri.conf.json` is not a documented Tauri feature. This is a release blocker for signed desktop builds.

### 2. ws-server.js JSDoc Still Documents 8 Removed PTY Messages

The `packages/server/src/ws-server.js` JSDoc block at the top of the file lists the WebSocket protocol. It still documents the following message types that were removed in this PR:

- `start_session`
- `attach_session`
- `resize`
- `discover_sessions`
- `session_list`
- `terminal_output`
- `session_attached`
- `session_error`

This is documentation rot from day one. Anyone reading the protocol comment will implement a client that sends messages the server silently drops.

### 3. dashboard.js Still References --terminal Flag

In `packages/server/src/dashboard.js`, there is a help text block (or similar user-facing string) that tells users:

> "Use `--terminal` flag for PTY mode"

This flag was removed in this PR. Users reading the dashboard will try a flag that no longer exists and get an unhelpful error.

### 4. workflow_dispatch Breaks github-release Job

In `.github/workflows/release.yml`, the workflow trigger includes `workflow_dispatch`. The `github-release` job uses `github.ref` to extract the tag name for the changelog and release title. When triggered via `workflow_dispatch`, `github.ref` is a branch ref (`refs/heads/main`), not a tag ref. The changelog extraction step will produce an empty string and the release job will either fail or create a malformed release.

There is no guard (`if: startsWith(github.ref, 'refs/tags/v')`) on the `github-release` job.

### 5. Three Dead PTY Type Branches in ws-message-handlers.js

In `packages/server/src/ws-message-handlers.js`, there are three `case` branches (or `if` chains) handling message types that were removed:

- `resize`
- `attach_session`
- `discover_sessions`

These branches are now unreachable. They are not tested as removed — they just silently sit there and drop messages. A future developer adding a new message type named `resize` would hit confusing ghost behavior.

### 6. ResizeSchema Ghost in ClientMessageSchema

In `packages/server/src/ws-schemas.js`, `ResizeSchema` is still included in the `ClientMessageSchema` union:

```js
export const ClientMessageSchema = z.discriminatedUnion('type', [
  // ...
  ResizeSchema,
  // ...
])
```

The `resize` message type has no handler. The schema validates it as a legitimate client message, but the handler was deleted. This is a lie at the type boundary — validation passes, then the message is silently dropped.

---

## What Was Done Well

- The structural removal of `server.js`, `pty-manager.js`, and `output-parser.js` appears complete.
- The PTY code path is no longer the default or a supported path in the CLI.
- Version bump in `package.json` files is correct.

---

## Conclusion

This PR is a half-finished cleanup. The bones are right but the connective tissue — schemas, docs, comments, workflow guards — was not updated to match. The Tauri signing config is the most alarming finding because it will cause silent failures in production signing. The `workflow_dispatch` / `github-release` interaction is a practical blocker for the first real release run.

**Rating: 2.5/5** — structural goal achieved, execution incomplete.
