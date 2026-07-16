> Provenance: authored 2026-07-15 during epic #6691 design; all cited file:line facts were
> verified against the then-current tree and drift over time — re-verify before load-bearing use.

Key confirmations/corrections found while verifying: `PermissionManager` rules API is `setRules()` (exposed per-session as `session.setPermissionRules(rules)`, wire precedent in `settings-handlers.js:715`); `ELIGIBLE_TOOLS` excludes Bash (`NEVER_AUTO_ALLOW = Bash/Task/WebFetch/WebSearch/shell`); `permissionMode:'auto'` short-circuit-approves everything (permission-manager.js:220); streamed SDK text arrives ONLY via `stream_delta` (sdk-session.js:832 — `message {type:'response'}` is the non-streamed fallback at :848); history ring buffer coalesces deltas into a `message` entry at `stream_end` but truncates over `_maxPendingStreamSize`; `restoreState()` recreates sessions idle (no turn resumes); `destroySession` removes worker worktrees (branch refs survive); `~/.chroxy` is NOT in `FORBIDDEN_HOME_SUBDIRS`; server package has zod ^4.3.6.

---

# OrchestrationManager — Server Core Design (committee/delegation engine)

## 0. Corrections to shared recon (verified by reading source)

1. **Permission rules**: API is `PermissionManager.setRules(rules)` / per-session `entry.session.setPermissionRules(rules)` (sdk-session.js:1335), not `addSessionRule`. Rules are limited to `ELIGIBLE_TOOLS = {Read, Write, Edit, NotebookEdit, Glob, Grep, apply_patch}`; **Bash can never be rule-allowed** (`NEVER_AUTO_ALLOW`, permission-manager.js:22). This constrains the auto-approver design (§8).
2. **A headless full-auto approver *does* exist**: `permissionMode:'auto'` resolves every tool `allow` without prompting (permission-manager.js:220). It is too broad (approves Bash unconditionally) — we deliberately do NOT use it for workers; we use `approve`/`acceptEdits` + a scoped gate (§8).
3. **Streamed text**: for sdk-session, streamed replies never produce a full-text `message` event — only `stream_delta` per messageId; `message {type:'response'}` fires only for non-streamed text (sdk-session.js:840–853). Text capture must accumulate deltas (§4).
4. **Permission requests reach the orchestrator in-process**: `permission_request` is re-emitted through `session_event` (transient list, session-manager.js:2884), and answered via `entry.session.respondToPermission(requestId, decision, editedInput)` (sdk-session.js:1295). No new plumbing needed for the gate.
5. **Worktrees are `--detach` at HEAD** (session-manager.js:960) — write workers start on detached HEAD; the orchestrator must create the branch itself (§7).

---

## 1. Module layout

### New files (all plain ESM JS, no semicolons, single quotes)

| Path | Purpose |
|---|---|
| `packages/server/src/orchestration/orchestration-manager.js` | `OrchestrationManager extends EventEmitter` — run lifecycle, scheduler, reconcile, cancel, budget enforcement |
| `packages/server/src/orchestration/run-model.js` | Pure state-machine constants + `assertTransition(kind, from, to)` guards + record factories |
| `packages/server/src/orchestration/turn-driver.js` | `TurnDriver` — the one primitive that sends a prompt to a session and resolves with final text + result usage |
| `packages/server/src/orchestration/decision-contract.js` | Zod schemas for committee decisions, fenced-block extraction, tolerant parse, repair/re-prompt policy |
| `packages/server/src/orchestration/role-prompts.js` | Role preambles (≤4000 chars — `SESSION_PREAMBLE_MAX_LENGTH` cap is silent), per-turn prompt builders, built-in `repo-audit` preset |
| `packages/server/src/orchestration/permission-gate.js` | Orchestration-scoped headless approver (answers `permission_request` for owned sessions only) |
| `packages/server/src/orchestration/git-ops.js` | `execFile` git helpers: branch create, capped diff, auto-commit, integration worktree, sequential merge, abort |
| `packages/server/src/handlers/orchestration-handlers.js` | WS routing (thin; protocol slice owns schemas) |
| `packages/server/src/orchestration/run-store.js` | **Ledger agent's slice** — I define only the interface I consume (§1.2) |

### Modified files

| Path | Change |
|---|---|
| `packages/server/src/config.js` | `isOrchestrationEnabled(config)` (copy `isIdeFeatureEnabled` at :671: `features.orchestration === true \|\| CHROXY_ENABLE_ORCHESTRATION === '1'`, fail-closed) + `validateOrchestrationBlock()` + defaults (§2) |
| `packages/server/src/server-cli.js` | Construct manager after `sessionManager.restoreState()` (~line 726), wire events, shutdown hook, pass into handler ctx (§12) |
| `packages/server/src/ws-message-handlers.js` | `import { orchestrationHandlers }` + spread into `handlerRegistry` (registry pattern at :29–44) |
| `packages/server/src/ws-handler-context.js` | Add `'orchestrationManager'` to `CTX_NAMESPACES.services` (:126) — also update the deep-asserted test ctx builder |
| `packages/server/src/ws-forwarding.js` | Forward `orchestration_event` emissions to subscribed clients (event names §12; payload schemas are the protocol slice) |

### 1.2 Run-store interface consumed (ledger agent owns internals)

```js
// orchestration/run-store.js — separate file ~/.chroxy/orchestration-runs.json
// (session-state.json is an overwrite snapshot; runs need their own store —
// follow skills-usage.js: durable aggregates + debounced atomic save via json-state-file.js)
createRunStore({ filePath }) -> {
  loadAll() -> RunRecord[],                 // called once at boot reconcile
  get(runId) -> RunRecord | null,
  upsert(runRecord) -> void,                // debounced save; flushSync() for terminal transitions
  appendTimeline(runId, timelineEvent) -> void,  // bounded ring per run
  recordUsage(usageEntry) -> void,          // per-role/per-model ledger row (shape §11)
  flushSync() -> void,                      // shutdown path
}
```

---

## 2. Config shape (`~/.chroxy/config.json`, validated in `validateConfig`)

```jsonc
"features": { "orchestration": true },
"orchestration": {
  "roles": {                       // config-driven, multi-provider — NEVER hardcode Anthropic
    "architect":  { "provider": "claude-sdk", "model": "opus" },
    "worker":     { "provider": "codex",      "model": "gpt-5.1-codex" },
    "auditWorker":{ "provider": "byok",       "model": "..." },   // optional; falls back to worker
    "fixup":      { "provider": null }                            // optional; falls back to worker
  },
  "maxParallelWorkers": 2,
  "reserveSessions": 1,            // headroom under sessionManager.maxSessions kept free for the user
  "maxCommitteeIterations": 4,     // total revise+redelegate actions per subtask before forced user escalation
  "maxParseRetries": 2,            // structured-output repair re-prompts per decision turn
  "turnTimeoutMs": 1800000,        // 30 min watchdog per driven turn
  "defaultBudgetUsd": null,        // soft cap per run (null = uncapped)
  "budgetWarnRatio": 0.8,
  "autoApprovePlan": false,        // v1 default: user approves epic plan before delegation spend
  "autoResumeAfterRestart": false, // fail-closed: suspended runs need explicit user resume
  "bash": {
    "implementAllowlist": ["^git (status|diff|log|add|commit|show)( |$)", "^(npm|pnpm|yarn) (test|run lint|run build)( |$)"],
    "auditAllowlist": []           // default: audit workers get NO Bash (Read/Grep/Glob suffice)
  },
  "gateEscalationTimeoutMs": 600000,  // unanswered user gate -> deny
  "diff": { "maxBytes": 65536, "maxFileBytes": 8192 },
  "allowUnmeteredRoles": false     // reject claude-tui/claude-channel role mappings (usage:null) unless true
}
```

Validation rules: each role's `provider` must exist in `getProvider()` registry; model resolved via `resolveModelId()`; if the provider is telemetry-null (claude-tui / claude-channel) fail validation unless `allowUnmeteredRoles` (dogfood requires token accounting). Secrets never appear here.

---

## 3. Run model and state machines

### 3.1 RunRecord (persisted)

```js
{
  runId: string,              // randomBytes(8).toString('hex')
  title: string,
  goal: string,               // epic prompt from user
  preset: 'repo-audit' | 'custom',
  cwd: string,                // validated ONCE at createRun via validateCwdAllowed(cwd, config) — replicated
                              // in-process because the WS-handler layer check (session-handlers.js:139)
                              // does not cover programmatic createSession
  state: RunState,
  mode: { autoApprovePlan: bool, autoResume: bool },
  roles: {...resolved role→{provider, model}},   // frozen at creation (config snapshot)
  budget: { capUsd: number|null, warnRatio: number, spentUsd: number, estimatedUsd: number,
            warned: bool, exceeded: bool },
  architect: { sessionId: string|null, spawnAttempts: number },
  subtasks: SubtaskRecord[],
  integration: { branch: string|null, worktreePath: string|null, mergedSubtaskIds: string[] },
  plan: { raw: string|null, decision: EpicPlanDecision|null, approvedAt: number|null, approvedBy: 'user'|'auto'|null },
  synthesis: { reportMarkdown: string|null, decision: object|null },
  createdAt, updatedAt, endedAt: number|null,
  endReason: string|null,     // 'completed'|'failed:<code>'|'cancelled:<reason>'|'suspended:restart'
}
```

### 3.2 Run state machine (`run-model.js`)

```
created ──start──▶ planning ──plan parsed──▶ plan_review ──approve──▶ executing
   │                  │                          │  reject                │
   │                  │ parse-fail exhausted     ▼                        │ all subtasks terminal
   │                  └──────────▶ failed    cancelled                    ▼
   │                                                              synthesizing ──▶ completed
   └────────────────────────── any state ──cancelRun──▶ cancelling ──▶ cancelled
                               any active state ──daemon restart──▶ suspended ──resume──▶ (prior state)
                               executing ──budget cap hit──▶ budget_paused ──user: raise/synthesize/cancel──▶ ...
                               planning/executing/synthesizing ──unrecoverable──▶ failed
```

- `plan_review` is skipped (auto-approved, `approvedBy:'auto'`) when `mode.autoApprovePlan`. **The v1 user gate sits here — after the architect's (cheap, single-session) planning turn, before any worker spend.** A second implicit user surface exists at `escalated` subtasks and permission-gate escalations; no other approvals block auto flow.
- `budget_paused` (§11): in-flight turns complete; no new spawns/committee turns start.
- Terminal states: `completed`, `failed`, `cancelled`. `suspended` is non-terminal, persisted.

### 3.3 Subtask state machine (committee gates)

```js
SubtaskRecord = {
  subtaskId, title, goal, role: 'audit'|'implement',
  dependsOn: string[], successCriteria: string, filesHint: string[],
  state: SubtaskState,
  workerSessionId: string|null, spawnAttempts: number,
  branch: string|null, worktreePath: string|null,        // implement only
  committee: { iterations: number,                        // revise+redelegate count
               history: [{gate:'poa'|'result', verdict, feedback, at}] },
  poa: { raw, decision }|null,
  result: { raw, decision }|null,
  diff: { stat, patchTruncated: bool }|null,
  escalation: { reason, options, resolvedBy, decision }|null,
  endReason: string|null
}
```

```
pending ─deps met + slot free + budget ok─▶ spawning ─session ready─▶ briefing
  briefing (worker turn: propose plan-of-attack) ─▶ poa_review (architect turn)
    poa_review ── approve ──▶ executing
    poa_review ── revise ───▶ briefing            (iterations++, architect feedback attached)
    poa_review ── redelegate ▶ respawning ─▶ briefing   (destroy worker+worktree after auto-commit; iterations++)
  executing (worker turn: do work, end with work_result block) ─▶ result_review (architect turn, + diff for implement)
    result_review ── accept ──▶ merging (implement) | done (audit)
    result_review ── revise ──▶ executing           (iterations++, same session, feedback turn)
    result_review ── redelegate ▶ respawning ─▶ briefing (iterations++)
    result_review ── escalate ─▶ escalated
  merging ── clean ──▶ done
  merging ── conflict ─▶ conflict_fixup (one fixup worker turn in integration worktree) ─▶ merging retry
  conflict_fixup ── fixup failed once ──▶ escalated
  iterations > maxCommitteeIterations at ANY gate ──▶ escalated   (forced; never loops silently)
  escalated ── user: accept-as-is | retry-with-note | skip | fail-run ──▶ done|briefing|skipped|(run failed)
  any ── cancel/restart-unresumed ──▶ cancelled / interrupted
Terminal: done | skipped | failed | cancelled
```

**Committee iteration budget**: `committee.iterations` counts every `revise` and `redelegate` across both gates for that subtask. Default cap 4. Exceeding forces `escalated` — the architect can never spin unbounded worker spend.

---

## 4. Sessions per role and turn driving

### 4.1 createSession opts per role (all in-process — orchestrator replicates `validateCwdAllowed` once at run creation on `run.cwd`; orchestrator-derived worktree paths are exempt by the same logic createSession itself uses when rewriting `resolvedCwd` to the worktree)

```js
// Architect — read-only, lives whole run
sessionManager.createSession({
  name: `orch:${runId}:architect`,
  cwd: run.cwd,
  provider: roles.architect.provider, model: roles.architect.model,
  permissionMode: 'approve',
  sessionPreamble: architectPreamble(),      // <4000 chars, role framing only
})
// then: entry.session.setPermissionRules?.([{tool:'Read',decision:'allow'},{tool:'Glob',decision:'allow'},{tool:'Grep',decision:'allow'},
//                                            {tool:'Write',decision:'deny'},{tool:'Edit',decision:'deny'},{tool:'NotebookEdit',decision:'deny'},{tool:'apply_patch',decision:'deny'}])
// Bash prompts fall through to the permission gate (§8), default deny for architect.

// Audit worker — read-only, no worktree (it writes nothing)
createSession({ name:`orch:${runId}:w:${subtaskId}`, cwd: run.cwd, provider/model: roles.auditWorker||roles.worker,
                permissionMode:'approve', sessionPreamble: auditWorkerPreamble() })
// + same read-allow/write-deny rules

// Implement worker — worktree-isolated, write-capable
createSession({ name:`orch:${runId}:w:${subtaskId}`, cwd: run.cwd, worktree: true,
                provider/model: roles.worker, permissionMode:'acceptEdits',
                sessionPreamble: implementWorkerPreamble() })
// worktree is created --detach at HEAD; immediately after 'ready':
//   gitOps.createBranch(entry.worktreePath, `chroxy/orch/${runId}/${subtaskId}`)

// Fixup worker — cwd = integration worktree (no worktree flag), acceptEdits + gate
```

`createSession` is SYNC and throws (`SessionLimitError`, `WorktreeError`); async start failures arrive as the `session_create_failed` event (session-manager.js:1426) — the manager listens for it and matches `sessionId` against owned sessions.

### 4.2 TurnDriver (`turn-driver.js`) — the single driving primitive

```js
class TurnDriver {
  constructor({ sessionManager, log })   // installs ONE sessionManager.on('session_event') listener
  // Per-session FIFO mutex: at most one driven turn per session; committee reviews
  // naturally serialize on the architect session.
  async driveTurn(sessionId, prompt, { label, timeoutMs }) 
    -> { text: string, result: { cost, duration, usage } }   // resolves on 'result'
    -> throws TurnError { code: 'TURN_ERROR'|'TURN_TIMEOUT'|'SESSION_GONE'|'SEND_FAILED', partialText }
}
```

Mechanics per driven turn:
- `entry.session.sendMessage(prompt, [], { clientMessageId })` — **always capture the return and `.catch`** (fire-and-forget; unhandled rejection kills the daemon — input-handlers.js:502–520). A rejection → `SEND_FAILED`.
- Accumulate from `session_event` for that sessionId, only while a driven turn is active (epoch guard: events before our send are ignored; a stray `result` with no active turn is dropped):
  - `stream_delta` → append `data.delta` into a per-`messageId` buffer,
  - `message` with `data.type === 'response'` → append `data.content` (ordered),
  - `result` → finalize: text = concatenation of completed buffers + response messages in arrival order; resolve with `data.{cost,duration,usage}`.
  - `error` → reject `TURN_ERROR` (error is turn-terminal — usage on it still folds into `_trackUsage` upstream).
- Watchdog `timeoutMs` (default from config): on fire → `entry.session.interrupt()` → reject `TURN_TIMEOUT`. We key completion **only off `result`** — `isRunning` can stay true on pending background shells.
- `session_destroyed` for the session mid-turn → reject `SESSION_GONE`.

### 4.3 Text-capture decision (chosen: live event accumulation)

**Chosen**: accumulate `stream_delta`/`message` events between send and `result`, as above. **Rejected alternatives**:
- `getFullHistoryAsync` (session-manager.js:2560): depends on a claude-family JSONL file resolved from `resumeSessionId` — not provider-agnostic (codex/gemini/byok fall back to ring buffer), and races the persist debounce.
- Ring buffer `getHistory()`: coalesced entries exist only after `stream_end`, are capped by `_maxPendingStreamSize` (oversize deltas silently dropped — session-message-history.js:305) and `maxMessages` eviction — a long audit report could be truncated exactly where the fenced decision block sits.
Live accumulation is uniform across every provider (all emit through `PROXIED_EVENTS`), bounded by us (we cap the accumulator at 2MB with explicit truncation marker + parse-from-tail strategy §5), and has no persistence race. Fallback: if the accumulator is empty at `result` (pathological provider), read `getHistory()` last `response` entries.

---

## 5. Structured decision contract (highest-risk piece)

### 5.1 Wire format in model output

Role prompts (per-turn, NOT in the capped preamble) instruct: *"End your reply with exactly one fenced code block tagged `chroxy-decision` containing only JSON matching this schema: …example…. The block must be the last thing in your message."*

### 5.2 Extraction + parse (`decision-contract.js`)

```js
extractDecision(text, expectedKind) -> { decision, warnings } | throws DecisionParseError { stage, detail }
```
Layered, scanning **from the end of the text**:
1. Last fenced block tagged `chroxy-decision`; else last fenced block tagged `json`; else last untagged fenced block; else last balanced `{…}` brace-scan from tail (bounded to final 32KB).
2. `JSON.parse` strict; on failure one tolerant retry (strip `//`/`/* */` comments, trailing commas, smart quotes).
3. Validate with a per-kind **zod schema** (zod ^4.3.6 already in the server package). Schemas: `EpicPlanDecision`, `PoaDecision`, `PoaReviewDecision`, `WorkResultDecision`, `ResultReviewDecision`, `SynthesisDecision` (fields as in §3). Enum verdicts are `z.enum`; unknown keys stripped, not fatal.
4. `kind` mismatch or schema failure → `DecisionParseError` with a human-readable diff of what failed.

### 5.3 Failure policy (fail-closed, never guess approval)

- **Repair re-prompt**: on parse failure, send the SAME session a short corrective turn: the zod error + the schema example + *"Reply with ONLY the corrected chroxy-decision block."* Max `maxParseRetries` (2). Cheap (context is cached).
- **Architect salvage** (worker decisions only): if a worker's PoA/work_result is still unparseable after retries, hand the worker's raw text to the architect with *"produce the structured block on the worker's behalf, or verdict `redelegate`"* — the expensive model is the natural repair engine. Counts as one committee iteration.
- **Architect decisions unparseable** after retries → run-level `escalated` gate to the user with raw text attached (`orchestration_gate_escalation`). Planning-phase exhaustion → run `failed:PLAN_PARSE`.
- Absence of a decision block is NEVER treated as approve/accept.

---

## 6. (folded into §4.3 — decision recorded there)

## 7. Write-capable workers: branches, diff review, merge-back

- **Branch naming**: `chroxy/orch/<runId>/<subtaskId>` created by the orchestrator (`git -C <worktree> switch -c …`) right after session `ready` — worktrees start detached at HEAD (session-manager.js:960).
- **Commit discipline**: worker is instructed to commit its work. Safety net after every worker `result`: `git status --porcelain`; if dirty, orchestrator auto-commits (`git add -A && git commit -m "chroxy-orch(<subtaskId>): auto-commit"`). **Invariant: auto-commit always runs before `destroySession`** (destroy removes the worktree; commits survive in repo refs, uncommitted work would not).
- **Architect diff review**: orchestrator (not the model) computes `git diff <baseSha>..HEAD --stat` plus the patch capped at `diff.maxBytes` (per-file cap `maxFileBytes`, truncation markers listing omitted files) and embeds it in the `result_review` prompt. The architect never needs Bash.
- **Merge-back (accepted work)**: one **integration branch** `chroxy/orch/<runId>/integration` created from run-start HEAD, checked out in an orchestrator-owned worktree `~/.chroxy/orchestration/<runId>/integration` (`git worktree add`). Accepted subtask branches merge **sequentially in acceptance order** (`git merge --no-ff <branch>`); sequential merging keeps conflicts local to one subtask.
- **Conflict policy**: on conflict → `git merge --abort`, subtask → `conflict_fixup`: spawn one fixup worker (`cwd` = integration worktree, `acceptEdits` + gate) with the conflict file list + both branch summaries; it resolves and commits; orchestrator retries verification (`git status` clean). Merges are strictly sequential, so only one session ever occupies the integration worktree. **One fixup attempt**; failure → `escalated` (user chooses: skip merge of this subtask [branch preserved for manual merge] / retry / fail run).
- **Hard boundary**: the orchestrator never merges into, rebases, or checks out the user's working branch, and never pushes. Run output = the integration branch + per-subtask branches; landing them is a human action (dashboard shows the branch name in the completed-run record). Integration worktree is removed at run terminal state (`git worktree remove --force` with `rm -rf` fallback, mirroring `_removeWorktree`); branches are kept.
- **Audit preset**: workers created read-only (§4.1) — no worktree, write-deny rules, no Bash. Capability for write workers still ships; the preset simply maps every subtask to `role:'audit'`.

## 8. Permission posture + orchestration permission gate

`permission-gate.js` — the scoped headless approver:

```js
class OrchestrationPermissionGate {
  constructor({ sessionManager, isOwnedSession, policyForSession, permissionAudit, config, emitEscalation })
  // subscribes to sessionManager 'session_event'; acts ONLY when
  //   event === 'permission_request' && isOwnedSession(sessionId)
  // decision = policy(toolName, input):
  //   'allow' | 'deny' | 'escalate'
  // answers via entry.session.respondToPermission(requestId, decision === 'allow' ? 'allow' : 'deny')
}
```

Policy per role:
- File tools are already settled *before* the gate: read-allow/write-deny via `setPermissionRules` (audit/architect) or `acceptEdits` (implement workers) — both are existing, tested mechanisms.
- **Bash** (never rule-eligible): matched against the role's regex allowlist (`orchestration.bash.*`), evaluated against `input.command`. Non-match → `escalate` for implement workers (emit `orchestration_gate_escalation` with redacted command; unanswered after `gateEscalationTimeoutMs` → deny — PermissionManager's own 5-min timeout will usually deny first, so the gate re-answers deny immediately at timeout to be deterministic), plain `deny` for audit workers/architect.
- `WebFetch`/`WebSearch`/`Task`: deny (workers must not sub-delegate — committee owns the tree; keeps cost attribution flat).

**Security rationale**: (a) scope — the gate answers only for sessions in the run's owned-session map, never user sessions; (b) it occupies the same trust position as a human clicking Allow (per-request `respondToPermission`), so `NEVER_AUTO_ALLOW`'s "no standing Bash whitelist" invariant is preserved — every approval is individual, matched against operator-configured regexes, and logged via `permissionAudit.logWhitelistChange`-adjacent entries (new `source:'orchestration-gate'` audit rows); (c) fail-closed — no policy match ⇒ deny/escalate, gate disabled ⇒ everything falls through to normal client prompting; (d) `skipPermissions` / `permissionMode:'auto'` are never used for workers; (e) blast radius of a malicious/buggy worker is its detached worktree plus allowlisted commands.

## 9. Failure and robustness matrix

| Failure | Detection | Handling |
|---|---|---|
| `SessionLimitError` on spawn | sync throw from `createSession` | Subtask stays `pending` (backpressure). Scheduler re-evaluates on every `session_destroyed` + 30s poll. Never busy-loops. |
| Async start failure | `session_create_failed` event matched to owned sessionId | `spawnAttempts++`; ≤2 → respawn; else subtask `failed:SPAWN`, architect informed in next review turn (may re-plan), or escalate |
| Worker/architect turn `error` | TurnDriver reject `TURN_ERROR` | One same-session retry for transient codes (stream stall emits `result` with null cost — sdk-session.js:1631 — treated as empty-text turn → retry); else counts as committee iteration → revise/redelegate path |
| Turn watchdog | `TURN_TIMEOUT` | `session.interrupt()`, mark turn failed, same retry ladder |
| Daemon restart mid-run | boot reconcile: `runStore.loadAll()` after `sessionManager.restoreState()` | Sessions restore **idle** (no turn resumes — verified). Any run in active state → `suspended`; subtasks that were mid-turn → `interrupted`. Owned sessionIds are re-validated against the restored session map (restore preserves ids via `preserveId`); missing sessions marked for respawn. `autoResumeAfterRestart:false` (default) ⇒ user must resume (no silent spend after restart). Resume: re-drive interrupted turns — claude-family sessions carry `resumeSessionId` context; the re-prompt says "repeat your last chroxy-decision block" (idempotent); non-resumable providers get a fresh worker (redelegate, iteration NOT counted). |
| Cancel run | `cancelRun(runId, {reason})` | state `cancelling`: stop scheduler; `interrupt()` every in-flight owned session; wait ≤10s for `result`/quiesce; **auto-commit dirty implement worktrees**; `destroySession` all owned sessions (worktrees removed, branches survive); integration worktree removed; run `cancelled`, `flushSync()` |
| Orphaned sessions/worktrees | boot reconcile | Owned sessions whose run is terminal/unknown → destroy. `~/.chroxy/orchestration/<runId>/` dirs with no active run → remove. Complements existing worktree GC (`sweepOrphanChroxyWorktrees`) which already covers `~/.chroxy/worktrees/<sessionId>`. |
| Budget cap crossed | §11 | `budget_paused`, no kills |
| Store corruption | run-store load error | Runs unrecoverable → log + start empty; orphan sweep still runs off session-name prefix `orch:` as best-effort hint (name prefix is a debugging aid; the persisted owned-session map is the authority) |

## 10. Concurrency policy

- Scheduler loop (event-driven, re-entered on: subtask transition, `session_destroyed`, budget change, gate resolution, 30s tick): pick `pending` subtasks whose `dependsOn` are all `done`, while `activeWorkerCount < maxParallelWorkers` AND `sessionManager` headroom `(_sessions.size ≤ maxSessions − reserveSessions − 1)` (−1 keeps the architect's slot safe) AND budget allows.
- Per-session serialization is TurnDriver's FIFO mutex; committee review turns queue FIFO on the single architect session (a deliberate throughput bound — one architect brain, matching the committee metaphor and capping expensive-model concurrency at 1).
- One run at a time in v1 (`createRun` rejects while another run is active) — removes cross-run maxSessions contention; multi-run is a v2 lift.

## 11. User approval gates + soft budget caps

Gates in v1 (all surfaced as run events; resolved via public API):
1. **Epic plan approval** (`plan_review`) — the spend gate; skippable via `autoApprovePlan` per run.
2. **Escalated subtasks** (committee cap exceeded, architect `escalate` verdict, fixup failure).
3. **Permission-gate escalations** (non-allowlisted Bash from implement workers).
4. **Budget-paused decision** (raise cap / synthesize now with partials / cancel).

Soft caps (locked decision 4): per-run `budget.capUsd`. Spend accounting: on every owned-session `result`/`error`, fold `cost` when finite; when `cost:null` but usage present (codex/gemini; note codex cache tokens are currently dropped by `_trackUsage` — ledger slice fixes that; the orchestrator computes its own row from the RAW result event, so it can apply `cached_input_tokens` correctly), estimate via `computePromptCostUsd(usage, getModelPricing(resolvedModel))`, flagged `estimated:true`. At `warnRatio` → `orchestration_budget` warning event (once). At cap → stop NEW delegations and NEW committee cycles; in-flight turns always complete; closing review turns for already-finished workers are permitted (bounded: one per in-flight subtask) → then `budget_paused`.

Usage ledger row I emit per driven turn (+ per stray owned-session turn) to `runStore.recordUsage`:

```js
{ runId, subtaskId|null, role: 'architect'|'worker'|'fixup', sessionId, provider, model,
  turnLabel: 'plan'|'poa'|'poa_review'|'execute'|'result_review'|'synthesis'|'repair'|'fixup',
  usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
  costUsd: number|null, estimated: bool, durationMs, at }
```
This is what makes the dogfood comparison (delegation cost vs monolithic frontier session) queryable per role/model/gate.

## 12. Wiring, events, feature flag, public API

**Instantiation** (server-cli.js, after `restoreState()` ~:726, gated):

```js
if (isOrchestrationEnabled(config)) {
  const orchestrationManager = new OrchestrationManager({
    sessionManager, config,
    runStore: createRunStore({ filePath: join(homedir(), '.chroxy', 'orchestration-runs.json') }),
    validateCwd: (cwd) => validateCwdAllowed(cwd, config),
    log,
  })
  orchestrationManager.reconcile()            // suspend/cleanup pass
  orchestrationManager.on('orchestration_event', (evt) => wsServer?.broadcast(evt))  // lazy wsServer ref, session_warning pattern
  // shutdown: orchestrationManager.shutdown() -> flushSync(); sessions preserved (destroyAll preserves worktrees)
}
```
Handlers are registered unconditionally (registry import) but each checks `isOrchestrationEnabled` per call — the IDE fail-closed pattern; capability `orchestration` advertised only when enabled (protocol slice allowlists dashboard-only).

**Public API** (consumed by `handlers/orchestration-handlers.js`):

```js
createRun({ title, goal, cwd, preset, roleOverrides, budgetUsd, autoApprovePlan }) -> RunRecord  // throws on validation
startRun(runId)                       // created -> planning
approvePlan(runId, { editedSubtasks }) ; rejectPlan(runId, reason)
resolveEscalation(runId, subtaskId, { decision, note })
resolveGate(runId, gateId, { decision })          // permission escalations
setRunBudget(runId, capUsd)
resumeRun(runId) ; cancelRun(runId, { reason })
getRunSnapshot(runId) ; listRunSummaries()        // survey pattern (1 request + 1 snapshot msg)
```

**Events emitted** (names only; protocol slice owns payload schemas, event-normalizer mapping, ws-server doc block, dist `git add -f`): `orchestration_run_updated`, `orchestration_subtask_updated`, `orchestration_committee_event` (gate verdicts + feedback for the run-tree UI), `orchestration_usage`, `orchestration_budget`, `orchestration_gate_escalation`, `orchestration_run_snapshot`. **Consumed**: SessionManager `session_event` (`stream_delta`, `message`, `result`, `error`, `permission_request`, `cost_update`), `session_created`, `session_destroyed`, `session_create_failed`.

## 13. Repo-audit preset (v1 dogfood, `role-prompts.js`)

`preset: 'repo-audit'` provides: a canned epic goal template ("full self-audit: correctness, security, dead code, test gaps, docs drift"), forces `role:'audit'` on all subtasks (architect's plan is coerced — an `implement` subtask in an audit run is rewritten to audit with a warning), seeds the architect plan prompt with a repo map (orchestrator runs `git ls-files | head` + top-level dir listing itself), and sets worker posture read-only. Synthesis output is the audit report (`synthesis.reportMarkdown` persisted on the run). Instrumentation for the cost comparison comes free from §11 rows.

## 14. Phased build order + test strategy

Every test constructing a `SessionManager` passes a temp `stateFilePath` (sandbox guard throws otherwise).

- **P1 — Foundations (no SessionManager)**: `run-model.js`, `decision-contract.js`. Unit tests: transition-guard table; parse fixtures (clean block, prose-wrapped, tolerant-JSON, missing block, wrong kind, truncated tail) incl. repair-prompt text generation.
- **P2 — TurnDriver**: against a stub EventEmitter mimicking SessionManager `session_event` (streamed, non-streamed `message` fallback, error-terminal, timeout→interrupt spy, epoch guard against pre-send events, per-session mutex).
- **P3 — Manager core, read-only path**: createRun→plan→plan_review→audit subtasks→committee loop→synthesis with a scripted fake provider session (register a mock via the existing provider registry seam, or inject a TurnDriver test double — the manager takes `turnDriver` as a constructor seam). Tests: iteration cap → escalation; parse-fail → architect salvage; SessionLimitError backpressure; budget warn/pause.
- **P4 — Write path**: `git-ops.js` against temp git repos (branch create on detached worktree, capped diff, auto-commit-before-destroy invariant, sequential merge, conflict→fixup→retry, abort). Integration: full implement-subtask lifecycle with real `SessionManager` worktrees + fake provider.
- **P5 — Robustness**: restart reconcile (serialize run store, rebuild manager, assert suspended/interrupted marking + orphan sweep), cancel semantics (interrupt→commit→destroy ordering spy), gate escalation timeout deny.
- **P6 — Wiring**: handlers module + ctx namespace addition (deep ctx assert updates), feature-flag fail-closed tests, capability advertisement; protocol/dashboard slices land in parallel; e2e dogfood = repo-audit run against chroxy itself.

## 15. Open risks + mitigations

1. **Structured-output compliance varies by provider/model** (esp. small workers). Mitigation: layered parser + repair re-prompts + architect salvage (§5.3); dogfood metrics record parse-retry counts per model in the usage ledger to tune role mappings.
2. **Preamble cap silently truncates** (4000 chars, verified). Mitigation: preambles are role framing only; the JSON contract travels in per-turn prompts; unit test asserts every preamble < cap (mirrors `byok-subagent-profiles` test).
3. **User interference with owned sessions** (visible in dashboard; user can type into a worker). Mitigation: TurnDriver epoch guard drops alien results; v1 documents "don't drive orch sessions"; protocol slice should mark them in `session_list` metadata (flagged to that agent).
4. **`acceptEdits` lets implement workers edit files outside the worktree** (Write/Edit are auto-approved by path-agnostic tool name). Mitigation v1: fail-closed gate can't intercept (no prompt fires); rely on worktree cwd + role prompt; flag as fast-follow: a path-scoped rule predicate in PermissionManager (`{tool:'Write', pathPrefix}`) — small, backwards-compatible extension.
5. **Bash escalation latency** stalls workers up to the gate timeout. Mitigation: escalations broadcast immediately + push-notification path already exists (`PushNotificationHandler`); allowlists tuned per preset.
6. **maxSessions default 5** is tight (architect + 2 workers + user Default ≈ full). Mitigation: `reserveSessions` + docs advising `maxSessions` bump; scheduler degrades to serial rather than failing.
7. **Cost estimation gaps** (pricing overlay missing a model ⇒ `costUsd:null`). Mitigation: `estimated`/null rows surface in the token meter as "unpriced tokens"; budget enforcement then falls back to token-count cap? — v1: budget only counts priced+estimated USD and warns when unpriced tokens exceed 20% of run volume.
8. **Restart resume fidelity** for non-claude providers (no `resumeSessionId` context). Mitigation: resume = redelegate for those roles (iteration-free); documented.
9. **Two agents touching usage plumbing** (ledger slice fixing `_trackUsage`/codex cache keys vs my raw-event computation). Mitigation: I consume RAW `result` event data and do my own fold in the run ledger — no dependency on `_trackUsage` fixes; dedupe is by (sessionId, result-event) so the two ledgers can't double count each other.

### Critical Files for Implementation
- /Users/blamechris/Projects/chroxy/packages/server/src/session-manager.js
- /Users/blamechris/Projects/chroxy/packages/server/src/permission-manager.js
- /Users/blamechris/Projects/chroxy/packages/server/src/orchestration/orchestration-manager.js (new — engine core)
- /Users/blamechris/Projects/chroxy/packages/server/src/orchestration/turn-driver.js (new — turn primitive)
- /Users/blamechris/Projects/chroxy/packages/server/src/server-cli.js