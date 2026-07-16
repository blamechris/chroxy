# Orchestration ("Committee") — Wire Protocol & Dashboard Surface Design

> Provenance: authored 2026-07-15 during epic #6691 design; all cited file:line facts were
> verified against the then-current tree and drift over time — re-verify before load-bearing use.

Scope: client-facing slice only (protocol messages, lint compliance, dashboard panel, session-view integration, HTTP posture, build order). Engine/state-machine internals are referenced only where the wire contract constrains them.

## 0. Verified ground truth (corrections/confirmations to recon)

- `ClientMessageSchema` union confirmed at `packages/protocol/src/schemas/client.ts:1435`; per-message schemas use `z.object` + optional `requestId: z.string().max(128).optional()` correlation (e.g. `SummarizeSessionSchema:1418`).
- Guard-2 confirmed: `packages/store-core/src/contract-fixtures/protocol-type-coverage-lint.test.ts` — `DASHBOARD_ONLY` at :150. Its universe is ALL `type: z.literal(...)` in `packages/protocol/src/schemas/server/**/*.ts` (directory scan, :100-111), so a new schema file auto-enters the lint. Critically, `DASHBOARD_ONLY` entries are cross-checked: entry must be handled by dashboard AND NOT by app AND NOT in the shared dispatch table (:292-304). **Therefore schemas + dashboard handlers + allowlist entries must land atomically.**
- Guard-1 confirmed: `packages/protocol/tests/handler-coverage.test.js` — `PLATFORM_SPECIFIC` at :102; server type universe = regex over the `* Server -> Client:` JSDoc section of `packages/server/src/ws-server.js`, terminated by the `* Encrypted envelope` line (extractor at test :222-235). A doc-block line is what puts a type in the universe — emit-site location is irrelevant.
- Dashboard handler surface = `const HANDLERS: Record<string, Handler>` map in `packages/dashboard/src/store/message-handler.ts:3228` (handler signature `(msg, get, set, ctx) => void`, e.g. `handleSkillsInventorySnapshot:2852`). Extractor (`packages/protocol/src/handler-coverage-extract.ts`) reads `case '...'` + HANDLERS keys.
- Recon correction: **there is no top-level `ViewMode` for Control Room**. `ViewMode` (`ViewSwitcher.tsx:8`) is per-session tabs only; since #5204 the Control Room is a session-independent top-level tab driven by `controlRoomOpen`/`controlRoomActive` in `App.tsx:2100-2211`, rendered via `<ControlRoomView>` with tab registry `CONTROL_ROOM_TABS` (`ControlRoomView.tsx:106`, `survey:true` descriptors requiring `requestType`/`snapshotKey`/`loadingKey`/`requestKey` triples tsc-checked against `ConnectionState`).
- Survey pattern confirmed: fetch-on-activation + 60s staleness (`CONTROL_ROOM_STALENESS_MS:293`), no polling; store action pattern `requestSkillsInventory` (`dashboard/src/store/connection.ts:1244`) flips loading + `wsSend({type})`, returns boolean.
- Live-push precedent confirmed: `repo_events_delta` — server-initiated `this._broadcast(msg, (client) => !client.boundSessionId)` (`ws-server.js:2287-2292`), host-authority filtered, clients without a snapshot ignore it.
- Action-failure channel confirmed: `makeActionError(code, correlate)` in `packages/server/src/control-room/handler-factory.js:131` sends `{type:'session_error', code, message, reason, ...correlate(msg), requestId}`. Survey factory `makeSurveyHandler` gives host-authority gate + per-client in-flight WeakSet + degraded-empty-snapshot-with-`error` for free.
- Server routing confirmed: handler modules export a `<domain>Handlers` object spread into `handlerRegistry` in `ws-message-handlers.js:29-44`; `registeredMessageTypes` feeds a schema-coverage test (every registered type needs a client Zod schema).
- Feature flag precedent confirmed: `isIdeFeatureEnabled` (`config.js:671`), per-call fail-closed gating inside `ide-handlers.js` (each handler early-returns), capability advertisement via `auth_ok.capabilities: z.record(z.string(), z.boolean()).optional()` (`schemas/server/connection.ts:84`), dashboard store field `serverCapabilities: Record<string, boolean>` (`dashboard/src/store/types.ts:1163`), fail-closed hide.
- Deep-link precedent confirmed: `CrossSessionMissionControl` takes `onJumpToSession?: (sessionId) => void`; `ControlRoomView.tsx:366` wires it to `switchSession(sessionId)`.
- `SessionInfo` (`schemas/server/session.ts:136-199`) is `.passthrough()` with many documented optional fields — safe place for run-membership badge fields. `CumulativeUsageSchema` (:105) is reusable for run usage rollups.
- Protocol dist trap confirmed: `.gitignore:13` has `dist/`; 54 files under `packages/protocol/dist` are force-tracked — a NEW schema file's `dist/schemas/server/orchestration.{js,d.ts}` will need `git add -f` (#6333).
- Bearer doc confirmed: HTTP `_validateBearerAuth` (any valid token, incl. pairing-bound) vs `_validatePrimaryBearerAuth` (primary only, 403 `primary_token_required`); WS host-authority = unbound (`!client.boundSessionId`); strict-primary WS gate `client.isPrimaryToken` exists for code-execution-grade capabilities.

---

## 1. Wire protocol

### 1.1 Message family decision: NEW `orchestration_*` family (do not reuse `agent_*`)

Reuse of `agent_spawned`/`agent_completed`/`agent_event` is rejected:

1. **Wrong scope.** `agent_*` are session-scoped, keyed by `toolUseId` inside a parent session's chat stream (`schemas/server/stream.ts:345-385`), reduced into per-session `activeAgents[]` by shared dispatch-table handlers (`store-core/src/handlers/agent.ts`) that BOTH clients run. Runs are host-level, durable, cross-session objects keyed by `runId`/`nodeId` — jamming them through `toolUseId` semantics corrupts both.
2. **Both-client contamination.** `agent_*` live in the shared dispatch table (`dispatch-table.ts` DISPATCH_TABLE_TYPES), so committee traffic would render as chat sub-bubbles in the mobile app today — violating locked decision 1 (dashboard-only v1) with no allowlist able to express it (a dispatch-table type is credited to both clients by guard-2).
3. **Double rendering.** Workers are REAL sessions; their streams already flow via normal `session_event` forwarding. Re-emitting them as `agent_event` duplicates content. The run panel needs *summaries + state transitions*, not a second copy of the stream.
4. Cost of a new family is 4 schema types + 2 allowlist blocks — fully scaffolded by the existing lint machinery.

### 1.2 Snapshot-vs-delta strategy

**Pull snapshots (survey pattern) as source of truth + one thin server-push delta as freshness optimization** — the exact `repo_events_snapshot`/`repo_events_delta` split, plus a `seq` for gap detection:

- Reconnect/late-join needs no replay: opening the Runs tab (or re-activating it after staleness) pulls `orchestration_runs_snapshot`; selecting a run pulls `orchestration_run_snapshot` carrying a `seq` high-water mark. Deltas are merged only when `runId` matches a held snapshot and `seq === held.seq + 1`; any gap ⇒ silently re-request the run snapshot. Clients that never fetched simply ignore deltas (repo-events contract).
- This avoids inventing a subscription protocol (no `subscribe_run`), keeps the engine free to coalesce, and matches how every Control Room tab already behaves (staleness guard comes free from the `CONTROL_ROOM_TABS` registry).

### 1.3 Client → server messages (5 new types, `packages/protocol/src/schemas/client.ts`)

```ts
// Survey: list all runs (active + recent). Host authority (unbound clients only).
export const OrchestrationRunsRequestSchema = z.object({
  type: z.literal('orchestration_runs_request'),
  requestId: z.string().max(128).optional(),
})

// Full detail for one run (tree + gates + timeline + usage + seq cursor).
export const OrchestrationRunDetailRequestSchema = z.object({
  type: z.literal('orchestration_run_detail_request'),
  runId: z.string().min(1).max(128),
  requestId: z.string().max(128).optional(),
})

// Start a run from a preset and/or epic prompt. Host authority; additionally
// STRICT-PRIMARY (client.isPrimaryToken === true): starting a run spawns
// write-capable worker sessions — same escalation class as user-shell creation.
export const OrchestrationRunStartSchema = z.object({
  type: z.literal('orchestration_run_start'),
  preset: z.string().min(1).max(64).optional(),        // e.g. 'repo-audit' (built-in, locked decision 3)
  epicPrompt: z.string().min(1).max(20_000).optional(), // free-form epic; preset may template it
  cwd: z.string().min(1).max(1024),                     // validated server-side against the cwd allowlist
  title: z.string().max(200).optional(),
  budgetUsd: z.number().positive().finite().optional(), // soft cap (locked decision 4)
  roles: z.record(z.string(), z.object({                // optional per-run override of config role→model map
    provider: z.string().min(1).max(64),
    model: z.string().min(1).max(128),
  })).optional(),
  requestId: z.string().max(128).optional(),
}).refine((m) => m.preset || m.epicPrompt, { message: 'preset or epicPrompt required' })

// Resolve a USER gate (epic-plan approval / budget-overrun continuation) or
// drive the run lifecycle. Host authority; strict-primary for gate approvals
// that unblock write-capable work ('approve' on kind 'epic_plan'|'budget_overrun') —
// enforce server-side, not in schema.
export const OrchestrationGateResponseSchema = z.object({
  type: z.literal('orchestration_gate_response'),
  runId: z.string().min(1).max(128),
  gateId: z.string().min(1).max(128),
  decision: z.enum(['approve', 'reject', 'revise']),   // revise requires note
  note: z.string().max(4000).optional(),
  requestId: z.string().max(128).optional(),
})

export const OrchestrationRunActionSchema = z.object({
  type: z.literal('orchestration_run_action'),
  runId: z.string().min(1).max(128),
  action: z.enum(['cancel', 'pause', 'resume']),       // pause/resume = stop/allow NEW delegations; cancel = graceful stop
  requestId: z.string().max(128).optional(),
})
```

All five (…RunsRequest, …RunDetailRequest, …RunStart, …GateResponse, …RunAction) are appended to `ClientMessageSchema` (:1435 union) + `z.infer` type exports.

### 1.4 Server → client messages (4 new types, NEW file `packages/protocol/src/schemas/server/orchestration.ts`)

Shared shapes (exported so the engine slice imports THESE as its canonical enums — protocol is source of truth, preventing enum drift):

```ts
export const RUN_STATUSES = ['created','planning','awaiting_gate','delegating','reviewing','merging',
  'budget_paused','completed','failed','cancelled'] as const
export const RUN_NODE_STATUSES = ['pending','planning','awaiting_plan_review','executing',
  'awaiting_result_review','revising','merged','done','failed','cancelled'] as const
export const RUN_GATE_KINDS = ['epic_plan','worker_plan','worker_result','budget_overrun','merge'] as const
export const RUN_GATE_STATUSES = ['pending','approved','rejected','revise_requested','auto_approved','expired'] as const

export const RunUsageSchema = CumulativeUsageSchema            // import from './session.ts'
export const RunUsageRollupSchema = z.object({
  total: RunUsageSchema,
  byRole: z.record(z.string(), RunUsageSchema),                // 'architect' | 'worker' | future roles
  byModel: z.record(z.string(), RunUsageSchema),               // resolved model id → usage
})

export const RunGateSchema = z.object({
  gateId: z.string(), runId: z.string(),
  nodeId: z.string().nullable(),                               // null for run-level gates (epic_plan, budget_overrun)
  kind: z.enum(RUN_GATE_KINDS),
  status: z.enum(RUN_GATE_STATUSES),
  approver: z.enum(['user','architect']),                      // dashboard renders actionable UI ONLY for 'user'
  summary: z.string(),                                         // what is being approved (plan text / overrun figure)
  detail: z.string().nullable().optional(),                    // full plan-of-attack / review body
  openedAt: z.number(), resolvedAt: z.number().nullable(),
  resolvedBy: z.enum(['user','architect','policy']).nullable(),
  note: z.string().nullable().optional(),                      // revise/reject note
})

export const RunNodeSchema = z.object({
  nodeId: z.string(), runId: z.string(),
  title: z.string(),
  role: z.string(),                                            // config-driven role name (not enum — locked decision 5)
  provider: z.string().nullable(), model: z.string().nullable(),
  status: z.enum(RUN_NODE_STATUSES),
  attempt: z.number().int().nonnegative(),                     // re-delegation counter
  sessionId: z.string().nullable(),                            // deep-link target; null before spawn / after destroy
  worktreePath: z.string().nullable(),
  planSummary: z.string().nullable(),                          // worker plan-of-attack (pre-execution)
  resultSummary: z.string().nullable(),                        // worker result summary (post-execution)
  usage: RunUsageSchema.optional(),
  createdAt: z.number(), updatedAt: z.number(),
})

export const RunTimelineEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  at: z.number(),
  kind: z.string(),   // 'run_created'|'plan_drafted'|'gate_opened'|'gate_resolved'|'node_status'|
                      // 'delegation_sent'|'plan_review'|'result_review'|'budget_warning'|'merge'|'error'|'note'
                      // — z.string() not enum: timeline is display-only, forward-compat by design
  nodeId: z.string().nullable().optional(),
  gateId: z.string().nullable().optional(),
  summary: z.string(),
  detail: z.string().nullable().optional(),
})

export const RunBudgetSchema = z.object({
  capUsd: z.number().positive().finite().nullable(),
  spentUsd: z.number().finite(),                               // signed — refund posture matches costUsd (#4099)
  state: z.enum(['ok','warning','exceeded']),                  // soft-cap ladder (locked decision 4)
})

export const RunSummarySchema = z.object({
  runId: z.string(), title: z.string(),
  preset: z.string().nullable(),
  status: z.enum(RUN_STATUSES),
  cwd: z.string(),
  epicPromptPreview: z.string(),                               // first ~280 chars for the list row
  architect: z.object({ provider: z.string(), model: z.string() }),
  budget: RunBudgetSchema,
  usage: RunUsageSchema,
  nodeCounts: z.object({ total: z.number().int(), running: z.number().int(),
                         done: z.number().int(), failed: z.number().int() }),
  pendingUserGates: z.number().int().nonnegative(),            // drives badges without run detail
  createdAt: z.number(), updatedAt: z.number(),
})

export const RunDetailSchema = RunSummarySchema.extend({
  epicPrompt: z.string(),
  nodes: z.array(RunNodeSchema),
  gates: z.array(RunGateSchema),
  timeline: z.array(RunTimelineEntrySchema),                   // bounded: server sends last 500; full log via export
  usageRollup: RunUsageRollupSchema,
})
```

The four wire messages:

```ts
// Reply to orchestration_runs_request. Degraded-snapshot posture (empty runs + error).
export const ServerOrchestrationRunsSnapshotSchema = z.object({
  type: z.literal('orchestration_runs_snapshot'),
  requestId: z.string().max(128).nullable().optional(),
  generatedAt: z.string().datetime(),                          // REQUIRED — the SnapshotKey tsc constraint keys off it
  runs: z.array(RunSummarySchema),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

// Reply to orchestration_run_detail_request.
export const ServerOrchestrationRunSnapshotSchema = z.object({
  type: z.literal('orchestration_run_snapshot'),
  requestId: z.string().max(128).nullable().optional(),
  generatedAt: z.string().datetime(),
  seq: z.number().int().nonnegative(),                         // delta high-water mark at snapshot time
  run: RunDetailSchema,
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

// Server-INITIATED push (no request). Broadcast to unbound clients only.
// Carries authoritative upserts; a client holding runId's snapshot applies them
// iff seq === held.seq + 1, else re-requests the snapshot. Others update only
// the runs-list row via `run` (if the list snapshot is held) or ignore.
export const ServerOrchestrationRunDeltaSchema = z.object({
  type: z.literal('orchestration_run_delta'),
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
  run: RunSummarySchema.optional(),                            // upsert list row + header (status/usage/budget/pendingUserGates)
  node: RunNodeSchema.optional(),                              // upsert by nodeId
  gate: RunGateSchema.optional(),                              // upsert by gateId
  timeline: RunTimelineEntrySchema.optional(),                 // append
})

// Positive ack for start / gate_response / run_action, echoing correlation.
export const ServerOrchestrationActionAckSchema = z.object({
  type: z.literal('orchestration_action_ack'),
  requestId: z.string().max(128).nullable().optional(),
  action: z.enum(['start','gate_response','cancel','pause','resume']),
  runId: z.string(),                                           // for 'start': the newly-minted runId
  gateId: z.string().optional(),
}).passthrough()
```

Failures: `session_error` with `code: 'ORCHESTRATION_ACTION_FAILED'` via `makeActionError('ORCHESTRATION_ACTION_FAILED', (msg) => ({ runId: msg.runId, gateId: msg.gateId, action: msg.action ?? msg.decision }))` — identical contract to `INTEGRATION_ACTION_FAILED`/`CONTAINER_ACTION_FAILED`, resolved client-side by the clear-pending-on-either-outcome pattern (`message-handler.ts:2858-2921`).

Also: add two optional fields to `ServerSessionListEntrySchema` (`schemas/server/session.ts:136`, already `.passthrough()`):
```ts
orchestrationRunId: z.string().nullable().optional(),   // run membership badge (§4)
orchestrationRole: z.string().nullable().optional(),    // 'architect' | worker role name
```
No new message type, no coverage-guard impact (fields, not types).

### 1.5 Server-side routing & emission

- **New file `packages/server/src/handlers/orchestration-handlers.js`** exporting `orchestrationHandlers = { orchestration_runs_request, orchestration_run_detail_request, orchestration_run_start, orchestration_gate_response, orchestration_run_action }`. Import + spread into `handlerRegistry` in `ws-message-handlers.js` (:29-44). Every handler:
  1. gates per-call on `isOrchestrationEnabled(ctx.services.config)` (new fail-closed helper in `config.js` copying `isIdeFeatureEnabled:671`: `features.orchestration === true || CHROXY_ENABLE_ORCHESTRATION === '1'`) — silent no-op return when off (ide-handlers pattern, so runtime flag flips need no re-registration);
  2. host-authority gate (`client.boundSessionId` ⇒ permission error) — reuse `makeSurveyHandler` from `control-room/handler-factory.js` for the two surveys (in-flight WeakSet + degraded snapshot for free);
  3. strict-primary gate (`client.isPrimaryToken === true`) for `orchestration_run_start` and for `approve` on `epic_plan`/`budget_overrun` gates — these unblock write-capable worker spawns, the same escalation class as user-shell creation (bearer doc §isPrimaryToken table).
- **Delta emission:** a `WsServer._broadcastOrchestrationDelta(delta)` method cloning `_broadcastRepoEvent` (`ws-server.js:2287`): `this._broadcast(delta, (client) => !client.boundSessionId)`. The engine slice calls it via ctx/services. **No `event-normalizer.js` entry is needed** — the normalizer maps per-session provider `session_event`s; run deltas are host-level and never transit that path. (Workers' own chat streams keep flowing through the normalizer untouched.)
- **Capability advertisement:** when the flag is on, include `orchestration: true` in `auth_ok.capabilities` (mechanism at `schemas/server/connection.ts:84`; dashboard fail-closed via `serverCapabilities`).
- **ws-server.js JSDoc:** add 5 lines to the `Client -> Server:` block and 4 lines to the `Server -> Client:` block (the latter is guard-1's type universe; lines must sit before the ` *\n * Encrypted envelope` terminator the extractor regex requires). Do NOT park anything in `SYNTHETIC_TYPES`.

### 1.6 Full lint-compliance checklist (instantiated)

| # | File | Change |
|---|------|--------|
| 1 | `packages/protocol/src/schemas/client.ts` | 5 schemas + 5 entries in `ClientMessageSchema` (:1435) + type exports |
| 2 | `packages/protocol/src/schemas/server/orchestration.ts` | NEW — shapes + 4 message schemas above |
| 3 | `packages/protocol/src/schemas/server.ts` | add `export * from './server/orchestration.ts'` |
| 4 | `packages/server/src/ws-server.js` | +5 doc lines Client→Server; +4 doc lines Server→Client (guard-1 universe); `_broadcastOrchestrationDelta` |
| 5 | `packages/server/src/ws-message-handlers.js` | import + spread `orchestrationHandlers` (this also enrolls the 5 types in the server's registered-types⇒client-schema coverage test — satisfied by #1) |
| 6 | `packages/dashboard/src/store/message-handler.ts` | 4 entries in `HANDLERS` map (:3228): `orchestration_runs_snapshot`, `orchestration_run_snapshot`, `orchestration_run_delta`, `orchestration_action_ack` |
| 7 | `packages/store-core/src/contract-fixtures/protocol-type-coverage-lint.test.ts` | 4 entries in `DASHBOARD_ONLY` (:150) with tracking note "orchestration committee v1 — dashboard-only per locked decision; mobile parity = move to dispatch table" |
| 8 | `packages/protocol/tests/handler-coverage.test.js` | 4 entries in `PLATFORM_SPECIFIC` (:102) as `'dashboard'` |
| 9 | git | `git add -f packages/protocol/dist/schemas/server/orchestration.js packages/protocol/dist/schemas/server/orchestration.d.ts` after protocol build (#6333) |

**Dispatch-table vs dashboard-HANDLERS decision: dashboard HANDLERS.** A dispatch-table entry counts as covered for BOTH clients (guard-2 `clientCoverage()`:126-130), which (a) contradicts locked decision 1, and (b) would make the `DASHBOARD_ONLY` self-check FAIL (`now handled by the app too`, :298). Every Control Room snapshot follows the HANDLERS route — copy it. Mobile parity later = migrate the 4 handlers into the dispatch table and delete the 8 allowlist lines (both guards will force the cleanup, which is exactly what they're for). To make that migration cheap, put the pure merge logic (delta seq-merge, upsert-by-id) in a new `packages/store-core/src/handlers/orchestration.ts` from day one and have the dashboard HANDLERS entries be thin wrappers — coverage is judged on the HANDLERS keys, not where the pure functions live.

---

## 2. Dashboard panel

### 2.1 Placement: Control Room tab (`'runs'`), not a top-level tab

- Runs are host-level cross-session objects — precisely the CR charter (mission-control #6183 is the sibling: cross-session, `survey:false`, lives there). Control Room v2 #5422 already plans mission-control overlap; a second host-level top-level surface would fork that story.
- The `CONTROL_ROOM_TABS` registry gives auto-fetch-on-activation, 60s staleness, persisted tab, in-flight guard, and the tsc-checked store-triple wiring for one descriptor entry. A top-level tab costs `SessionBar` surgery + new `App.tsx` open/active state + its own not-connected/empty states — all for more real estate the run tree doesn't need.
- Trade-off acknowledged: a CR tab is less visible for pending user gates. Mitigation in §2.4 (auto-fetched `pendingUserGates` + badge), not placement.

Registry entry (`ControlRoomView.tsx:106` array, inserted before `mission-control`):

```ts
{
  key: 'runs', label: 'Runs', survey: true,
  requestType: 'orchestration_runs_request',
  snapshotKey: 'orchestrationRuns', loadingKey: 'orchestrationRunsLoading',
  requestKey: 'requestOrchestrationRuns',
}
```

Capability gating: `ControlRoomView` filters the rendered strip and `VALID_TABS` deep-links with `serverCapabilities?.orchestration !== true ⇒ hide 'runs'` (fail-closed, mirrors how feature-gated affordances behave; the auto-fetch effect never fires for a hidden tab).

### 2.2 Store state (`dashboard/src/store/types.ts` + `connection.ts`)

```ts
// types.ts (ConnectionState)
orchestrationRuns: OrchestrationRunsSnapshot | null      // satisfies SnapshotKey (has generatedAt)
orchestrationRunsLoading: boolean                        // satisfies LoadingKey
requestOrchestrationRuns: () => boolean                  // satisfies RequestKey
orchestrationRunDetail: Record<string, { snapshot: OrchestrationRunSnapshot; staleSeq: boolean }>
orchestrationRunDetailLoading: Set<string>               // per-run in-flight
requestOrchestrationRunDetail: (runId: string) => boolean
startOrchestrationRun: (opts: {...}) => boolean          // requestId = `orch-start-${nextMessageId()}`
sendOrchestrationGateResponse: (runId, gateId, decision, note?) => boolean
sendOrchestrationRunAction: (runId, action) => boolean
orchestrationPendingActions: Record<string, { kind: string; at: number }>        // keyed by requestId
orchestrationActionResults: Record<string, { ok: boolean; error: string | null; at: number }>
selectedRunId: string | null                             // Runs-tab selection + deep-link target
```

Request actions clone `requestSkillsInventory` (`connection.ts:1244`; return false when socket closed, no offline queueing — same rationale as `sendRepoMemoryReindex:1262`). Handler behavior:

- `orchestration_runs_snapshot` → replace `orchestrationRuns`, clear loading (3-line CR pattern, `handleSkillsInventorySnapshot:2852`).
- `orchestration_run_snapshot` → upsert `orchestrationRunDetail[runId]`, clear per-run loading.
- `orchestration_run_delta` → pure merge from store-core `handlers/orchestration.ts`: (a) if `run` present and `orchestrationRuns` held, upsert list row; (b) if `orchestrationRunDetail[runId]` held: `seq === held.seq+1` ⇒ apply node/gate upserts + timeline append + bump seq; gap ⇒ mark `staleSeq` and fire `requestOrchestrationRunDetail(runId)` (debounced).
- `orchestration_action_ack` / `session_error{ORCHESTRATION_ACTION_FAILED}` → resolve `orchestrationPendingActions[requestId]` (clear-pending-on-either-outcome, `resolveReindex` pattern).

### 2.3 Component tree (new files under `packages/dashboard/src/components/orchestration/`)

```
OrchestrationRunsSection.tsx        — tab body; header (eyebrow/title/Refresh/staleness — copy SkillsInventorySection.tsx),
                                      "New run" button → NewRunModal; master-detail split
├─ NewRunModal.tsx                  — preset picker (v1: 'repo-audit' + blank), epic prompt textarea, cwd picker,
                                      budget input, role→model override rows (copy CreateSessionModal field idioms)
├─ RunList.tsx                      — RunSummary rows: status pill, preset chip, node counts, budget mini-bar,
                                      pendingUserGates badge, cost via formatCostBadge/formatTokens (@chroxy/store-core,
                                      same imports as SidebarTokenView.tsx)
└─ RunDetailPanel.tsx               — header: status, architect provider/model, cancel/pause/resume buttons (confirm on cancel)
   ├─ RunBudgetMeter.tsx            — spentUsd vs capUsd bar + byRole/byModel table; REUSE store-core cost-format helpers;
                                      no client-side pricing tables — server-computed USD only (SidebarTokenView precedent)
   ├─ RunTree.tsx                   — node rows: status dot (reuse mission-control rollup styling from
                                      CrossSessionMissionControl.tsx), role, model, attempt, per-node tokens/cost,
                                      "Open session" button when sessionId != null → switchSession(sessionId)
                                      (exact ControlRoomView.tsx:366 wiring)
   ├─ CommitteeTimeline.tsx         — chronological RunTimelineEntry list; plan/review entries expandable to `detail`;
                                      elapsed rendering copies AgentMonitorPanel.tsx formatElapsed wall-clock rationale
   └─ GateBanner.tsx                — for each gate with status 'pending' && approver 'user': summary + full detail,
                                      Approve / Request changes (note textarea, maps to 'revise') / Reject buttons;
                                      pending-state + inline result via orchestrationPendingActions
                                      (visual idiom: PermissionPrompt / pair_pending banner)
```

### 2.4 Approval-gate UX

- Actionable gates = `approver === 'user'` only (v1: `epic_plan`, `budget_overrun`). Architect-approver gates render as read-only timeline entries — the committee loop stays visible but not clickable.
- **Visibility without the tab open:** since `orchestration_runs_snapshot` is a cheap in-memory read (unlike git/gh surveys), fire `requestOrchestrationRuns()` once on `auth_ok` when `serverCapabilities.orchestration` is true, and re-fire on any `orchestration_run_delta` whose `run.pendingUserGates > 0` arrives with no list snapshot held. Render `Σ pendingUserGates` as a badge on the Control Room tab button (extend the `controlRoom` prop object on `SessionBar` — `App.tsx:2108-2113` — with `badgeCount?: number`, same visual as the existing `pendingPermissionTotal` jump chip).
- Race handling: approving an already-resolved gate returns `session_error{ORCHESTRATION_ACTION_FAILED, reason:'gate_already_resolved'}`; the banner clears pending and shows the reason; next delta/snapshot reconciles.

### 2.5 store-core vs dashboard-local: dashboard-local wiring, store-core pure logic

Recommended split (rationale in §1.6): state lives in the dashboard Zustand `ConnectionState` (like every CR tab); pure reducers (`applyRunDelta`, `upsertRunSummary`, gate/node merge) live in `packages/store-core/src/handlers/orchestration.ts` with store-core unit tests, imported by the dashboard handlers. Mobile-later migration then only moves wiring, not logic.

---

## 3. Session-view integration

- **Badge:** `ChatView`/session header reads `sessions.find(s => s.sessionId === activeSessionId)?.orchestrationRunId` (new optional `session_list` fields, §1.4). Render chip `⟐ Run: <runTitle?>` (title lazily from `orchestrationRuns` if held, else just "part of a run") + role. Clicking it: `openControlRoom()` + set CR tab to `'runs'` + `set({ selectedRunId })` — reuse the existing `controlRoomInitialTab`/`forceTabNonce` plumbing (`App.tsx:2196-2198`) extended with an `initialTab='runs'` path; `OrchestrationRunsSection` selects `selectedRunId` on mount.
- **Run → session:** `RunTree` "Open session" → `switchSession(sessionId)` (mission-control precedent). Destroyed worker sessions render the button disabled with tooltip "session ended — summary retained" (node keeps `planSummary`/`resultSummary`/usage from the durable run record).
- Worker sessions are otherwise 100% normal sessions — permissions, terminal, diff views all work unchanged; the run surface adds links, never replaces the chat surface.

## 4. HTTP surface

**WS-only in v1.** All panel needs are served by the two snapshots + delta; no polling endpoint is required.

Pinned now for the dogfood fast-follow: `GET /api/orchestration/runs/:runId/export` (JSON: full run record incl. unbounded timeline + per-role/per-model usage for the delegated-vs-monolithic cost comparison). Token class: **primary-only via `_validatePrimaryBearerAuth`** (`ws-server.js`, bearer doc §"HTTP endpoints a bound token must NOT reach"). Justification: run records are host-wide cross-session content (plans, review bodies, repo paths across every worker session); `_validateBearerAuth` accepts pairing-bound tokens, and HTTP has no `boundSessionId` analog short of the primary gate — same reasoning that put `DELETE /api/snapshots/:slug` on primary. The dashboard already holds the primary token (`getAuthToken()`), so no client friction.

## 5. Build order + test strategy

**Rebuild sequencing everywhere:** protocol (`npm run build -w @chroxy/protocol`, then `git add -f` the two new dist files) → store-core → server → dashboard (`npm run build -w @chroxy/dashboard` before the daemon serves UI changes).

- **PR-1 (atomic protocol+guards+stubs):** items #1-3, #6 (handlers may be minimal-but-real: parse + store write), #7, #8 of the §1.6 table, plus store-core `handlers/orchestration.ts` pure reducers and the store state fields. Must be one commit — guard-2's `DASHBOARD_ONLY` self-check fails in every intermediate state. Tests: store-core vitest (pure reducer unit tests: upsert dedup, seq-gap detection, timeline append bound); `node --test` in protocol (guard-1 + schema round-trip parse fixtures for all 9 new messages, valid + malformed); a `dashboard/src/store/dispatch-orchestration-*.test.ts` per handler (copy `dispatch-repo-events.test.ts` naming/structure).
- **PR-2 (server surface):** `config.js` flag helper, `handlers/orchestration-handlers.js` (wired to an engine-slice stub interface: `ctx.services.orchestrator.{listRuns,getRun,startRun,respondGate,runAction}`), `ws-message-handlers.js` registration, `ws-server.js` doc lines + `_broadcastOrchestrationDelta`, `auth_ok` capability. Tests (server `node --test`): flag-off ⇒ silent no-op; bound client ⇒ permission error; non-primary ⇒ start/approve rejected; degraded snapshot on orchestrator error; ack + `ORCHESTRATION_ACTION_FAILED` correlation echo; any test constructing SessionManager passes a temp `stateFilePath` (sandbox guard).
- **PR-3 (dashboard UI):** `CONTROL_ROOM_TABS` entry + capability filter, components of §2.3, `SessionBar` badge, session badge + deep-link plumbing. Tests: vitest+RTL component tests copying `CrossSessionMissionControl.test.tsx` / `SkillsInventorySection` patterns — run list render, gate banner approve/revise flows (pending → ack → cleared; pending → session_error → reason shown), seq-gap triggers re-request, capability-off hides tab, jump-to-session fires `switchSession`.
- **PR-4 (session_list badge fields):** protocol `session.ts` optional fields + server population from the engine + ChatView chip. Isolated because it touches `session_list` snapshot fixtures in both clients' existing tests.

## 6. Open risks & mitigations

1. **Guard atomicity** (schemas/handlers/allowlists must co-land) — enforced by PR-1 packaging; CI runs both guards.
2. **Enum drift engine↔wire** — engine imports `RUN_STATUSES` etc. from `@chroxy/protocol` (protocol is upstream of server already); protocol PR lands first.
3. **Delta fan-out before snapshot fetch** — by-design ignore (repo-events contract); pendingUserGates visibility gap closed by the on-auth cheap list fetch (§2.4).
4. **Timeline growth** — snapshot bounded to last 500 entries server-side; full log only via the (deferred, primary-only) export endpoint; `RunDetailSchema.timeline` documents the bound.
5. **Strict-enum snapshots vs engine evolution** — statuses added later break old dashboards' `safeParse` (handlers drop the message silently, CR shows stale). Mitigation: keep `RunTimelineEntry.kind` as `z.string()`, and treat status-enum additions as protocol-version-bump events; acceptable for a flagged v1.
6. **Gate races / duplicate responses** — engine must be idempotent per gateId; wire contract already carries `reason:'gate_already_resolved'`.
7. **Mobile-later allowlist churn** — deliberate: guards will force removal of the 8 allowlist lines when app cases/dispatch entries appear; pure logic pre-positioned in store-core makes it mechanical.
8. **`orchestration_run_start` cwd** — schema cannot enforce the allowlist; handler MUST call the same `validateCwdAllowed` path as `session-handlers.js:138` (engine-slice contract; flagged to that slice).

### Critical Files for Implementation
- /Users/blamechris/Projects/chroxy/packages/protocol/src/schemas/client.ts
- /Users/blamechris/Projects/chroxy/packages/protocol/src/schemas/server/orchestration.ts (new)
- /Users/blamechris/Projects/chroxy/packages/dashboard/src/store/message-handler.ts
- /Users/blamechris/Projects/chroxy/packages/dashboard/src/components/ControlRoomView.tsx
- /Users/blamechris/Projects/chroxy/packages/server/src/handlers/orchestration-handlers.js (new; registered in /Users/blamechris/Projects/chroxy/packages/server/src/ws-message-handlers.js)