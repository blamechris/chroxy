# The Permission Floor — Protected Paths and Secret Reads

Chroxy's permission engine has one hardcoded **floor**: however lenient the mode or
the rules, a path-carrying tool aimed at a **repo-control / agent-config directory**
or a **secret file** must not be *silently* auto-approved. It falls through to the
interactive prompt instead.

This mirrors Claude Code's own "always ask" behaviour (desktop parity). Introduced in
#6794 (write floor) and #6803 (secret-read floor); extended to the hook-routed
providers in #7004.

> **A floor forces a PROMPT. It is never a deny.** All it does is *remove a
> short-circuit*. A `deny` rule still denies (the floor never widens access), and if
> the prompt path then auto-denies on no-client/timeout, that is the pre-existing
> fail-closed behaviour. Because the cost of a false positive is one prompt — never
> lost access — every ambiguous case resolves toward "floored".

## 1. What is floored

| Target | Read floor (`Read` / `Glob` / `Grep`) | Full floor (every other path-carrying tool) |
|---|---|---|
| `.env`, `.env.*` | floored | floored |
| `id_rsa` / `id_dsa` / `id_ecdsa` / `id_ed25519`, `.npmrc`, `.pgpass`, `.netrc` | floored | floored |
| `*.pem`, `*.key`, `*.p12`, `*.pfx` | floored | floored |
| `.git/config`, `.git/credentials`, `.config/git/{config,credentials}`, `.claude/settings*.json` | floored (credential-dense) | floored |
| Anything else inside `.git/`, `.claude/`, `.vscode/`, `.config/git/` | **not** floored — reading a config file is benign | floored |
| Ordinary project files | not floored | not floored |

Matching is case-insensitive, per path segment, on the target **resolved against the
session cwd** — with a second, symlink-following pass that walks the target
component-by-component the way `open(2)` does, so a symlinked parent or a `..` after
a symlink cannot escape the floor (#6851/#6921/#6928). Any resolution error
(`EACCES`, `ELOOP`, a pathological depth) is treated as **floored**.

A tool's targets are read from `PROTECTED_PATH_INPUT_FIELDS` (`file_path`, `path`,
`notebook_path`) plus each `changes[].path` member (codex `apply_patch`, #6805/#6828).
A tool carrying none of those — `Bash`, `Task`, `WebFetch`, `WebSearch` — cannot be
floored: command-shaped access is out of scope for a *path* floor.

## 2. Precedence — the floor beats every lenient mode

The floor is checked **before** any short-circuit, on **both** pipelines:

| Lenient path | Without the floor | With the floor |
|---|---|---|
| `auto` (SDK `bypassPermissions`) | allow everything | protected/secret target → prompt |
| `acceptEdits` | auto-approve file ops | protected/secret target → prompt |
| a broad `allow` rule (session or persisted project rule) | auto-approve the tool | protected/secret target → prompt |
| a `deny` rule | deny | deny (unchanged — the floor never widens access) |

## 3. Both pipelines, ONE implementation

Chroxy has two permission pipelines, and the floor must be identical on both.

```
IN-PROCESS (SDK / BYOK / codex app-server)
  canUseTool → permission-manager.js handlePermission
                 └─ isFlooredTarget(tool, input, cwd) ──┐
                                                        │
HOOK-ROUTED (claude-tui = the DEFAULT provider, cli-session)
  Claude Code PreToolUse → hooks/permission-hook.sh      │  permission-floor.js
     ├─ approve / plan  → POST /permission (prompt)      │  (single source of truth)
     └─ auto / acceptEdits                               │
          └─ POST /permission-floor ────────────────────┘
               ├─ floor:false → short-circuit (allow), as before
               └─ anything else → POST /permission (prompt)
```

- **`packages/server/src/permission-floor.js`** is the single source of truth: the
  segment matchers, the two-pass resolution, and `isFlooredTarget(tool, input, cwd)`
  — the tool-aware choice between the read floor and the full floor. It is a **leaf
  module** (no logger, no EventEmitter, no rule store) precisely so an HTTP handler
  can import it without pulling in `PermissionManager`.
- **The shell hook holds none of the floor.** It decides `auto`/`acceptEdits` itself
  and therefore never reaches `permission-manager.js` — that gap *was* #7004: on the
  default provider, `auto`/`acceptEdits` read `.env` / `id_rsa` and wrote into
  `.git`/`.claude` with no prompt. The hook now asks the daemon instead of
  re-deriving path rules in bash (a shell copy would be a second source of truth and
  would drift — the #6986/#7001 lesson).

### `POST /permission-floor`

| | |
|---|---|
| Auth | the **per-session hook secret**, same class and same validator as `POST /permission` (see [`bearer-token-authority.md` §5](bearer-token-authority.md#5-per-session-hook-secrets)) |
| Request | the PreToolUse payload the hook already holds (`tool_name`, `tool_input`, `cwd`), capped at 1 MiB (`MAX_FLOOR_BODY` in `ws-permissions.js`) — deliberately much larger than `/permission`'s 64 KB, see §5 |
| Response | `{ "floor": true \| false }` — nothing else; no requestId, no pending request, no broadcast, no push |
| cwd basis | the **owning session's `cwd`** (resolved from the presented hook secret) — identical to what `PermissionManager` is constructed with; the payload's own `cwd` is used only when the session is not resolvable, and there is no `process.cwd()` fallback |
| Rate limit | its own limiter with a much larger budget than `/permission` (600/min, burst 200): this fires once per **tool call**, not once per human decision |

**The hook treats only an explicit `"floor":false` as clearance.** Floored, `4xx`,
`429`, `5xx`, an unparseable body, an unreachable daemon — every other outcome routes
the call to a real prompt. So each failure mode degrades to *"the user is asked"*,
never to *"silently allowed"*. If the prompt itself cannot be delivered, the
pre-existing #5330 fail-closed deny applies.

The server side fails closed too: a non-object payload, a missing `tool_name`, a
missing/non-object `tool_input`, or an unresolvable cwd all answer `floor: true`. This
is deliberately stricter than the in-process path, which receives already-typed
inputs from the SDK rather than parsing an untrusted HTTP body.

## 4. Editing the floor — the anti-drift rules

1. **Change `permission-floor.js` and nothing else.** Both call sites import
   `isFlooredTarget` from it. Never inline a floor check at a call site, and never
   re-derive "which tool gets which floor" (`SECRET_READ_FLOOR_TOOLS`) outside that
   module — `tests/permission-hook-floor.test.js` fails if either happens.
2. **Adding a path-naming field** to `PROTECTED_PATH_INPUT_FIELDS` also requires
   updating the hook's negative pre-filter (the `case "$REQUEST" in *'"field"'*`
   line in `hooks/permission-hook.sh`). That pre-filter exists only so a payload
   naming **no** path field skips the round trip — such an input provably cannot be
   floored, so a path-less tool keeps its exact pre-#7004 behaviour. It is a
   *narrowing* filter, and the same test asserts it covers every field the floor
   scans, so drift fails CI rather than silently under-flooring.
3. **Keep the parity matrix honest.** `tests/permission-hook-floor.test.js` runs a
   `(tool, target)` matrix through both pipelines and asserts they agree.

## 5. Known limits

- **TOCTOU (#6922).** Resolution happens at permission-check time and is not atomic
  with the downstream `open`. A symlink can be swapped between the check and the
  read/write (e.g. via an un-floored `Bash` step), so a benign realpath here does not
  *guarantee* a benign open later. Chroxy does not own the downstream `open` for the
  SDK/TUI/codex providers, so an atomic guard is not achievable at this layer. The
  floor is defence-in-depth and prompt-only.
- **A floored target whose payload exceeds 64 KB is denied, not prompted.** The probe
  accepts up to 1 MiB, but `POST /permission` caps bodies at 64 KB (it *holds* the
  payload for five minutes and broadcasts it to clients), so a `Write` of a >64 KB
  file into a protected path answers the pre-existing 413 deny instead of raising a
  prompt. Ordinary (non-floored) large writes are unaffected — they never leave the
  fast path. This is the pre-#7004 oversize rule, unchanged; a fix belongs with that
  cap, not with the floor.
- **Command-shaped access is out of scope.** `Bash` can read `.env` — the floor
  guards *path fields*, and `Bash` is in `NEVER_AUTO_ALLOW` (never rule-whitelisted)
  but IS auto-approved under `auto`. Flipping a session to `auto` remains a
  host-level privilege escalation, gated accordingly
  (`AUTO_MODE_FORBIDDEN_BOUND_CLIENT`, and `allowAutoPermissionMode` in local config).
