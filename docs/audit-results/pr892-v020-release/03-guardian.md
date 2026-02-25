# Guardian Agent Report — PR #892 (v0.2.0 Release)

**Perspective:** Guardian — security, supply chain, protocol correctness, operational risk
**Rating: 3 / 5**

---

## Summary

The PR introduces a release pipeline and makes structural changes to the server. From a security and operational correctness standpoint, there are several concerns: the app still speaks a protocol the server no longer understands, the release workflow uses floating action tags with no SHA pinning, and the GitHub Actions permissions are scoped too broadly. None of these are catastrophic, but they represent real risk surface that should be addressed before v0.2.0 is tagged as stable.

---

## Findings

### 1. App Still Sends Removed WebSocket Messages (Protocol Break)

The mobile app (`packages/app/`) still calls the following WebSocket message types that were removed from the server in this PR:

- `discover_sessions` — sent when the app connects to enumerate available sessions
- `attach_session` — sent when the user selects a session to join
- `resize` — sent when the terminal viewport dimensions change

The server now silently drops these messages (or the handlers were deleted entirely). From the app's perspective, it sends a `discover_sessions` message and waits for a `session_list` response that will never arrive. This is a **protocol break** that will cause the app to hang or behave incorrectly when connecting to a v0.2.0 server.

**Risk:** Any user upgrading the server to v0.2.0 without a matching app update will have a broken connection flow. Since the app sends `discover_sessions` at connection time, the connection will stall at the session selection step.

**Fix:** Remove the dead message sends from the app, or add a protocol version negotiation step so the server can inform the app which message types are supported.

### 2. Floating Action Tags in Release Pipeline (Supply Chain Risk)

In `.github/workflows/release.yml`, third-party actions are referenced by mutable version tags:

```yaml
- uses: actions/checkout@v4
- uses: actions/upload-artifact@v4
- uses: tauri-apps/tauri-action@v0
```

Mutable tags (`@v4`, `@v0`) can be moved by the action author at any time. A compromised action repository could push malicious code to `v4` and have it execute in the release pipeline, which has `contents: write` permission and access to signing secrets.

**Fix:** Pin all third-party actions to a full commit SHA:

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
```

### 3. Workflow-Level permissions Too Broad

In `.github/workflows/release.yml`, the `permissions` block is set at the workflow level:

```yaml
permissions:
  contents: write
  packages: write
```

This grants `contents: write` to every job in the workflow, including jobs that only need to read code (e.g., the build job that compiles the desktop app). The signing secrets are available to all jobs.

**Fix:** Move permissions to the job level. Grant `contents: write` only to the job that creates the GitHub release.

### 4. Empty Keychain Password

In the macOS codesign step of `.github/workflows/release.yml`:

```bash
security create-keychain -p "" build.keychain
```

An empty keychain password (`""`) means any process on the runner can access the keychain without authentication. While GitHub Actions runners are ephemeral and isolated, this is a defense-in-depth failure. If the runner is compromised or shared (e.g., a self-hosted runner), the signing certificate is exposed.

**Fix:** Use a randomly generated password stored as a GitHub secret:

```bash
security create-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
```

### 5. server-cli-child.js Dead Defaults and TMUX_SESSION Env Var

In `packages/server/src/server-cli-child.js`, the configuration handling still includes:

- Dead default values for `tmuxSession` and `resume` config keys that were only relevant to PTY mode
- `process.env.TMUX_SESSION` being read and passed to config

These are not security issues on their own, but they represent dead config surface that could confuse a future developer who reads the code and assumes these options are meaningful.

**Risk:** Low operationally, but it creates ambiguity about which config options are supported.

---

## What Was Done Well

- PTY mode removal eliminates the attack surface of arbitrary tmux command injection through session names.
- The server no longer spawns child processes for terminal emulation in the default path.
- Auth and E2E encryption code in `ws-server.js` appears unchanged (not regressed).

---

## Risk Summary

| Finding | Severity | Likelihood |
|---------|----------|------------|
| App sends removed WS messages | High | High — every new connection triggers this |
| Floating action tags | Medium | Low — requires action compromise |
| Permissions too broad | Low | Low — ephemeral runners |
| Empty keychain password | Low | Low — ephemeral runners |
| Dead cli-child defaults | Low | Low — no runtime impact |

---

## Conclusion

The protocol break between app and server is the most operationally significant finding. A user upgrading only the server (which is easy — just `npm update -g chroxy`) will have a broken app experience immediately. The supply chain findings are lower probability but represent hygiene failures in a release pipeline that handles signing secrets.

**Rating: 3/5** — the security posture is not worse than before, but the release pipeline and protocol break introduce new operational risk.
