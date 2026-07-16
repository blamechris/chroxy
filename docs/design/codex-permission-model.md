# Codex permission & sandbox model

**Status:** current-state reference + open decisions (#6638). Scopes the Codex
permission/security model deliberately, rather than assuming the Claude-oriented
modes map cleanly, before widening Codex usage.

Everything under **Current state** is grounded in the code as of this writing;
**Open decisions** are surfaced for a maintainer to decide, not decided here.

> Note: this supersedes the "current state" bullets in #6638, which were written
> before #6610 merged. Scope-escalation requests are **surfaced through a prompt
> now**, not safe-denied.

---

## TL;DR

- The **app-server driver** (`CodexAppServerSession`) is the canonical, approval-capable Codex path and the default. The legacy `codex exec` path (`CHROXY_CODEX_APPSERVER=0`) has **no** Chroxy approval surface — treat it as a fallback only.
- Codex surfaces **three** approval families through the same `PermissionManager` the Claude providers use: shell commands, file edits, and (since #6610) sandbox scope-escalations.
- Codex **does not** support Chroxy session rules ("Allow for Session" persisted per-tool). "Always allow" maps to Codex's *own* per-turn/per-session grant vocabulary, not a Chroxy rule.
- **MCP / connector tool calls are not surfaced** in the permission pipeline (the gap behind the missed-GitHub-connector-approval report, #6635).
- The **sandbox** (`read-only` / `workspace-write` / `danger-full-access`) is env-only (`CHROXY_CODEX_SANDBOX`), not per-session in the UI/API.

---

## 1. Canonical path: app-server vs exec

| | `CodexAppServerSession` (default) | `CodexSession` (`codex exec`, `CHROXY_CODEX_APPSERVER=0`) |
|---|---|---|
| Approval surface | Yes — 3 families via `PermissionManager` | **None** — runs under Codex's own sandbox only |
| `permissions` / `inProcessPermissions` / `permissionModeSwitch` caps | `true` / `true` / `true` | `false` / `false` / `false` |
| Attachments (image vision / file refs) | Yes (#6609) | Rejected |
| Intra-session memory | Yes | No (one-shot) |
| Resume | No (neither path) | No |

The app-server path is a strict superset. `getProvider('codex')` returns the
app-server class unless the env var opts out (`providers.js`). Since #6618/#6676
the picker capabilities and the startup label also track the runtime driver, so
"what a live codex session can do" is consistent across the picker and the session.

**Acceptance (#6638): app-server IS the canonical Codex path; exec is a
documented fallback with no approval surface.**

---

## 2. Permission matrix — mode × request class

Permission modes are the shared enum `approve | acceptEdits | auto | plan`.
Codex maps them to a Codex `approvalPolicy` per turn: `auto → never` (Codex never
asks), every other mode → `on-request`. `plan` is **not** a real Codex mode
(Codex has no plan enforcement) — it behaves like `approve`.

| Request class → | `shell` (command exec) | `apply_patch` (file edit) | `request_permissions` (scope-escalation) | MCP / connector call |
|---|---|---|---|---|
| **approve** (default) | Prompt | Prompt | Prompt | **Not surfaced** |
| **acceptEdits** | Prompt | **Auto-approve** | Prompt | **Not surfaced** |
| **auto** | No prompt (Codex `never`) | No prompt | No prompt | Not surfaced |
| **plan** | Prompt (= approve) | Prompt | Prompt | **Not surfaced** |

Why the cells are what they are:
- `apply_patch` is in `ACCEPT_EDITS_TOOLS`, so `acceptEdits` auto-approves Codex edits (the analogue of auto-approving Claude Write/Edit).
- `shell` and `request_permissions` are in `NEVER_AUTO_ALLOW` — they always prompt (except under `auto`, where Codex's `approvalPolicy: never` means it doesn't send an approval request at all).
- Under `auto`, `PermissionManager.handlePermission` also short-circuits to allow, so even a stray request is drained without a prompt.

---

## 3. Decision vocabularies (server → Codex response)

Each family answers Codex in **its own** vocabulary — the `PermissionManager`
`allow` / `allow-always` / `deny` result is mapped per family:

| Family / method | allow | allow-always (session) | deny |
|---|---|---|---|
| `item/commandExecution/requestApproval` | `accept` | `acceptForSession` | `decline` |
| `item/fileChange/requestApproval` | `approved` | `approved_for_session` | `denied` |
| `item/permissions/requestApproval` (#6610) | `{ permissions: <requested>, scope: 'turn' }` | `{ permissions: <requested>, scope: 'session' }` | `{ permissions: {} }` (scope omitted) |

The escalation grant is reconstructed from the two `GrantedPermissionProfile`
fields (`fileSystem`, `network`) the request carried — never an echo of the raw
frame — so a malformed request can't wedge the turn (a bad response to a
server→client request stalls Codex; see #6612).

A "session" grant is detected via a sentinel `suggestions` marker on the
`allow-always` result (`respondToPermission` only echoes `updatedPermissions`
when suggestions were provided). This is a **local marker**, not a persisted
Chroxy rule (see §4).

---

## 4. Session grants vs Chroxy rules — the key semantic difference

Chroxy's Claude providers (SDK/BYOK) support **session rules**: "Allow for
Session" persists a per-tool auto-allow rule in the `PermissionManager` rule
engine (`setPermissionRules`, gated on the `sessionRules` capability).

**Codex does not implement `setPermissionRules`**, so `sessionRules` is `false`
for both Codex classes. "Always allow" on a Codex prompt therefore does **not**
create a Chroxy rule — it maps to Codex's *own* session-scoped grant
(`acceptForSession` / `approved_for_session` / `scope: 'session'`), enforced by
Codex, for that family, for the rest of the session.

Consequences:
- `shell` and `request_permissions` are additionally in `NEVER_AUTO_ALLOW`, so they can never be rule-whitelisted even if a rule engine existed — a deliberate safety posture (arbitrary command execution / sandbox broadening must always prompt).
- `apply_patch` is in `ELIGIBLE_TOOLS`, but with no `setPermissionRules` on the Codex classes there is no rule to set — `acceptEdits` mode is the only auto-approve lever for Codex edits.

---

## 5. Sandbox model

`CHROXY_CODEX_SANDBOX` selects one of `CODEX_SANDBOX_MODES` =
`read-only` | `workspace-write` | `danger-full-access`, default
`workspace-write` (`CODEX_DEFAULT_SANDBOX`; the #3846 stopgop so fresh sessions
can edit files). Applied at thread start and per-turn.

This is a **Codex-only concept** with no Claude equivalent, and it is
**env-only** — not exposed per-session in the UI or the `create_session` API.
Scope-escalation (`request_permissions`) is how Codex asks, mid-turn, to broaden
beyond its sandbox; approving it grants the requested filesystem/network scope
for the turn or session (§3).

---

## 6. Approval prompt content

| Family | `tool` | prompt input |
|---|---|---|
| command exec | `shell` | `{ command, cwd, description: reason \|\| command \|\| 'Run a shell command' }` |
| file edit | `apply_patch` | `{ description: reason \|\| 'Apply file changes', file_path: grantRoot }` |
| escalation | `request_permissions` | `{ description: <human-readable scope summary>, requestedPermissions }` |

Descriptions are redacted and capped at ≤200 chars downstream. The escalation
summary caps long filesystem lists with a `+N more` tail so the trailing network
scope isn't truncated out (#6610).

Both clients render these via the existing `PermissionPrompt` (`<tool>:
<description>`), which is why #6610 needed no client change.

---

## 7. Timeout / interrupt / mode-switch behavior

- **Timeout:** a pending approval times out after the `PermissionManager` default (5 min) → resolved as deny → Codex answered with the family's deny value.
- **Interrupt / Stop / destroy:** aborting the turn (`_turnAbort`) resolves every pending approval as deny, so Codex is always answered (never left waiting) and the turn unblocks.
- **Switch to `auto` mid-turn:** drains pending prompts as accept (the panic-button drain).
- **Switch to `acceptEdits` mid-turn:** applies to *subsequent* requests; an already-pending `apply_patch` prompt is not retroactively auto-approved.

---

## 8. Known gaps vs the Claude model

| Gap | Detail | Related |
|---|---|---|
| **MCP / connector approvals unsurfaced** | `mcpToolCall` items are not mapped to a `tool_start` or an approval — only `commandExecution` + `fileChange` are. Connector calls (e.g. GitHub) run under Codex's sandbox/`approvalPolicy` and never reach Chroxy's prompt. | #6635 |
| **No session rules** | "Allow for Session" persists a rule for Claude SDK/BYOK; for Codex it's a Codex-side grant only (§4). | — |
| **Provider-generic mode copy** | Mode labels/descriptions and `skipPermissions` (= `--dangerously-skip-permissions`) are Claude/TUI-oriented; `skipPermissions` is a no-op for Codex, and `plan` is a no-op alias for `approve`. | — |
| **Sandbox not per-session** | `CHROXY_CODEX_SANDBOX` is env-only; a per-session selector would need protocol + UI. | — |

---

## 9. Open decisions (surfaced for a maintainer — not decided here)

Each carries a recommendation, but the call is yours.

1. **Provider-specific mode labels/descriptions for Codex?**
   *Recommendation:* yes, low-effort — make the mode copy provider-aware so Codex doesn't show `--dangerously-skip-permissions`/plan-mode language that doesn't apply. At minimum, note in the copy that `plan` ≈ `approve` and `skipPermissions` is a no-op for Codex.

2. **Expose sandbox mode per session (UI/API) instead of env-only?**
   *Recommendation:* yes, but as its own slice — add `sandbox` to `create_session` for Codex + a session control, defaulting to `workspace-write`. It's the most operator-visible Codex-specific lever. Bigger than a copy tweak (protocol + both clients).

3. **Should scope-escalation requests remain prompts (post-#6610), and be visible in history?**
   *Recommendation:* keep the prompt (shipped in #6610). Separately decide whether a *resolved* escalation leaves a compact audit line in the transcript — recommend yes, for auditability, tracked with the general "resolved permissions in history" UX (relates to #6626/#6627).

4. **What should `allowAlways`/session grants mean for Codex, given `shell` is never-auto-allow?**
   *Recommendation:* keep current semantics — `allowAlways` maps to Codex's session grant per family; `shell`/`request_permissions` never auto-allow (always prompt). Document this so the "Allow for Session" button's meaning on a Codex `shell` prompt is clear (it's a Codex session grant, not a Chroxy rule) — or hide "Allow for Session" on never-auto-allow Codex tools to avoid implying a persisted rule.

5. **Required approval-UI detail for Codex** (full command, cwd, env, patch/diff preview, redaction, drilldown)?
   *Recommendation:* command + cwd ship today; add a **diff/patch preview** for `apply_patch` (currently only `reason` + `grantRoot`) and a scope drilldown for escalations. Env is sensitive — keep redacted/omitted by default.

6. **MCP / connector approval path (the #6635 gap).**
   *Recommendation:* the highest-value fix here — map `mcpToolCall` items to a `tool_start` and, where Codex requests approval for them, into the permission pipeline (a `mcp`/connector tool class). Needs confirming which Codex app-server events carry connector approvals. Track as a dedicated issue.

7. **How should timeout/interrupt/auto-switch appear to the user?**
   *Recommendation:* surface a resolved state on the prompt (timed-out / cancelled / auto-approved) rather than silently dropping it — same UX work as #6627 (queued/permission resolved-state rendering).

---

## 10. Test coverage status

- **Shipped:** command/file/escalation approval prompts, decision-vocabulary mapping per family, `acceptEdits` auto-approve of `apply_patch`, `NEVER_AUTO_ALLOW` for `shell`/`request_permissions`, abort/interrupt/timeout → deny, and the #6610 escalation surfacing (grant shape, turn/session scope, deny, malformed-frame safety). See `codex-app-server-session.test.js` and `permission-manager.test.js`.
- **Not yet covered (would follow the decisions above):** per-session sandbox selection, MCP/connector approval surfacing, and resolved-state rendering for timed-out/cancelled prompts.

---

*Related: #6610 (escalation surfacing), #6618/#6676 (runtime-driver parity), #6635 (connector approval gap), #6626/#6627 (permission/queued resolved-state UX).*
