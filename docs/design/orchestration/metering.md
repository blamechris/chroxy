All load-bearing recon facts for this slice are now verified against source. Producing the design document.

# Design: Orchestration Metering, Token Ledger & Data Capture

All facts below verified against source at the cited lines on branch `codex/fix-voice-control-hotkey`.

## 0. Verified ground truth (corrections/refinements to recon)

- **Pinned SDK shape confirmed** (`packages/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1048`): `ModelUsage = { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens }`. `SDKResultSuccess` (:2899) additionally carries `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage: NonNullableUsage` (snake_case), `modelUsage: Record<string, ModelUsage>`, `result: string`. `sdk-session.js:929` currently emits only `{sessionId, cost, duration, usage}` — `modelUsage` tokens/cost, `num_turns`, `duration_api_ms` are all discarded (only `contextWindow` is consumed at :890-916).
- **Codex cache-token loss confirmed**: `codex-app-server-session.js:341` `_mapUsage` emits `cached_input_tokens`; `session-manager.js:3032` `_trackUsage` reads `u.cache_read_input_tokens`. Codex `cost` is hardcoded `null` (:356).
- **Gemini** emits `usage: {input_tokens, output_tokens}` only, `cost: null`, `duration: null` (gemini-session.js:414).
- **byok** computes per-round cost via `computePromptCostUsd` and emits summed snake_case `usage` incl. both cache fields + signed-capable `cost` (byok-session.js:705-715, :887-896). Single model per session.
- **claude-cli** forwards `total_cost_usd`/`duration_ms`/`usage` verbatim from stream-json (cli-session.js:1202-1215); does not forward `modelUsage` even if present in the CLI's result line.
- **Fold point**: `session-manager.js:2829-2848` — on `result` OR `error` session events, gates `hasFiniteCost` → `_trackCost(sessionId, data.cost, model)` and `hasFiniteCost || hasFiniteTokens` → `_trackUsage(sessionId, data)`. `_trackUsage` (:3004) reads ONLY `data.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}` and `data.cost` — **additive fields on the result payload are ignored by all existing consumers**, so extending the payload is non-breaking. Token deltas clamped nonneg-finite (:3028), `costUsd` signed-finite (:3029, refunds #4099).
- **Attribution today**: `session.currentModel` (session-manager.js:2834) doesn't exist on `BaseSession` (only `this.model`, base-session.js:1048) — the fallback `sessionEntry?.model` is what actually resolves. `setModel` is blocked mid-turn (:1041) but allowed between turns → mid-run switch is possible for user-driven sessions.
- **Pricing seams**: `getModelPricing(modelId)` (Claude static table + `~/.chroxy/models.json` overlay, models.js:70) and per-provider `registry.getOverlayPricing(model)` (overlay-only, models.js:928, hot-reloads per #6381) → `computePromptCostUsd(usage /* snake_case */, pricing) -> number|null` (models.js:141, handles `[1m]` long-context tier).
- **Store precedents**: `json-state-file.js` `loadJsonState`/`saveJsonState` (atomic 0600, per-pid tmp suffix, opt-in `fsync:true` durable variant #5620); `skills-usage.js` `SkillsUsageRecorder` (load-once / record-many / 1s-debounced save / sync `flush()`, ring buffer + durable aggregates + LRU eviction); `session-state-persistence.js` (`schedulePersist` 2s debounce for high-frequency appends, `flushPersist` for lifecycle mutations — the #5309 durability boundary).
- **Budget precedents**: `CostBudgetManager` (per-session cap, 80% warn latch, exceeded/paused sets, `serialize`/`restore`); `MonthlyProgrammaticBudgetManager` (billing-budget.js: config-derived cap, `recordSpend -> {status, justWarned, justExceeded}` one-shot flags, injectable `statePath`, "chroxy-observed, not authoritative" caveat).
- **Wire precedent**: `session_usage` = protocol `ServerSessionUsageSchema` (billing.ts:203, flat `CumulativeUsageSchema` session.ts:105) + event-normalizer.js:481 mapper. `passthrough()` tolerance exists on session-list entries but CumulativeUsage itself is a closed object — per-model additions must be new optional fields, not shoved into that object.
- Feature flag pattern verified: `isIdeFeatureEnabled` (config.js:671) — env `=== '1'` OR `config.features.x === true`, fail-closed.
- No existing `orchestration/` code in `packages/server/src/` (grep hits are unrelated Control Room strings).

---

## 1. Per-model usage capture at the source

### 1.1 Normalized per-turn usage contract (no new event)

Extend the existing provider `result` (and byok `error`-with-partial-spend) payload **additively**. Every field optional; absent ⇒ provider can't produce it.

```js
// provider 'result' event payload — existing + NEW fields
{
  sessionId: string|null,
  cost: number|null,            // existing; signed USD; null = unknown
  duration: number|null,        // existing; wall ms
  usage: { input_tokens, output_tokens,
           cache_read_input_tokens, cache_creation_input_tokens },  // existing snake_case
  // NEW:
  numTurns: number|null,        // SDK num_turns (API round-trips inside the turn)
  apiDurationMs: number|null,   // SDK duration_api_ms
  modelUsage: {                 // per-model split, snake_case token keys so a cell
    [modelIdRaw: string]: {     // can be passed straight to computePromptCostUsd
      input_tokens: int, output_tokens: int,
      cache_read_input_tokens: int, cache_creation_input_tokens: int,
      web_search_requests: int,
      cost_usd: number|null     // provider-reported (SDK costUSD); null when unknown
    }
  } | null
}
```

**Why the result payload, not a new event**: it rides the existing single-counting invariant (session-manager.js:2807-2824 — exactly one terminal event per turn carries finite cost/tokens, including the #5037 error path and the stream-stall both-null synthetic that both gates filter). The orchestrator subscribes to the same `session_event {event:'result'|'error'}` stream `_trackUsage` uses; zero changes to gate logic; `_trackUsage` ignores the new keys.

### 1.2 New shared module: `packages/server/src/usage-normalize.js`

```js
export function normalizeSdkModelUsage(raw)          // Record<string, SDK ModelUsage> -> contract shape | null
export function synthesizeModelUsage(model, usage, costUsd)  // single-model providers -> contract shape | null
export function nonNegInt(x)                          // clamp helper, mirrors _trackUsage tokenDelta
```
`normalizeSdkModelUsage`: camelCase→snake_case, `nonNegInt` every token field, `Number.isFinite(u.costUSD) ? u.costUSD : null`, drop empty result to `null`. Debug-log a drift sample when an entry lacks numeric `inputTokens` (mirrors the sdk-session.js:908 contextWindow drift guard).

### 1.3 Modified files (capture fixes)

- **`packages/server/src/sdk-session.js`** (`case 'result'`, :877-938): keep the contextWindow ratchet loop untouched; extend the `_emitResult` payload (:929) with `numTurns: Number.isFinite(msg.num_turns) ? msg.num_turns : null`, `apiDurationMs: Number.isFinite(msg.duration_api_ms) ? msg.duration_api_ms : null`, `modelUsage: normalizeSdkModelUsage(msg.modelUsage)`.
- **`packages/server/src/cli-session.js`** (:1202): same three fields, opportunistically — claude-cli stream-json result is produced by the same runtime and carries `modelUsage`/`num_turns` in current CLI builds; normalize via the same helper, `null` when absent. (Phase-0 fixture confirms; degrades gracefully either way.)
- **`packages/server/src/codex-app-server-session.js`** (`_mapUsage` :341): emit `cache_read_input_tokens` (keep `cached_input_tokens` as a deprecated duplicate for one release; no in-repo consumer reads it). Also stamp `modelUsage: synthesizeModelUsage(this.model, usage, null)` and carry `duration` (already does).
- **`packages/server/src/byok-session.js`** (:887): add `modelUsage: synthesizeModelUsage(this.model, turnUsage, turnCostKnown ? turnCost : null)`. Caveat: `_executeTaskTool` child usage folds into parent `turnUsage` under the parent's model — currently *correct* because the child model is hardcoded to the parent's (byok-session.js:1367); when #5018 lands per-profile model override, that PR must split the synthesized map. Leave a comment cross-referencing #5018/#5020.
- **`packages/server/src/gemini-session.js`** (:414): add `modelUsage: synthesizeModelUsage(this.model, usage, null)`.

**Fold-side attribution helper** (used by the run ledger, and by the optional per-model cumulative in 1.4): if `data.modelUsage` present use it; else attribute the whole `data.usage` to `resolveModelId(entry.model)` or `'unknown'`. Keeps providers minimal — only SDK/CLI produce true multi-model splits.

### 1.4 Optional-but-recommended: per-model cumulative for ALL sessions (own PR, ungated)

- `session-manager.js _trackUsage`: fold `data.modelUsage` (or attributed fallback) into a new `entry.perModelUsage: { [resolvedModelId]: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, webSearchRequests, costUsd, turns } }`, same clamps as the flat accumulator. Emit additively on the existing `session_usage` event: `data: { cumulativeUsage, billingClass, perModel }`.
- Protocol: `ServerSessionUsageSchema` (billing.ts:203) gains `perModel: z.record(z.string(), PerModelUsageSchema).optional()`; `event-normalizer.js:481` mapper forwards it. Schema-additive; older clients ignore it. (Protocol agent owns the lint checklist; flag the #6333 `git add -f dist` gotcha.)
- Persist in the session-state entry next to `cumulativeUsage` (:2120-2127 serialize, :2262-2280 tolerant restore — same nonNegFinite clamp pattern).

---

## 2. Run record store

### 2.1 New files

```
packages/server/src/orchestration/run-ledger.js       — RunLedger class (EventEmitter)
packages/server/src/orchestration/run-record.js       — pure schema builders/normalizers/folds (unit-testable, no I/O)
packages/server/src/orchestration/run-report.js       — report.json derivation + report.md renderer (pure)
packages/server/src/orchestration/run-budget.js       — budget evaluator (pure) 
```
All plain ESM, no semicolons, single quotes. I/O exclusively through `json-state-file.js` + `fs.appendFileSync` behind an injectable `baseDir` (test-sandbox rule: tests always pass a temp `baseDir`, same discipline as `stateFilePath`).

### 2.2 On-disk layout (`CHROXY_CONFIG_DIR || ~/.chroxy`, matching models.js:166)

```
~/.chroxy/orchestration/
  runs-index.json               — {version:1, runs:[{runId,title,preset,status,startedAt,endedAt,effectiveUsd}]} (bounded)
  runs/<runId>/
    run.json                    — debounced atomic snapshot (authoritative)
    events.jsonl                — append-only journal (ground truth + crash replay)
    report.json / report.md     — written once at terminal state (fsync:true)
```

### 2.3 `run.json` schema (version 1)

```jsonc
{
  "version": 1, "runId": "run_<ts>_<rand>", "title": "...", "preset": "repo-audit"|null,
  "status": "<engine-owned state string>",           // ledger stores verbatim, plus terminal flag
  "createdAt": ms, "startedAt": ms|null, "endedAt": ms|null, "lastSeq": int,
  "configSnapshot": {                                 // FROZEN at createRun
    "roleModels": { "<role>": { "provider": "claude-sdk", "model": "<fullId>" } },
    "budget": { /* §3 */ }, "cwd": "/abs/repo",
    "allowUnmeterable": false, "pricingOverlayHash": "<canonicalStringify hash>"  // provenance
  },
  "budgetState": { "warnedAt": ms|null, "capReachedAt": ms|null, "capLiftedAt": ms|null,
                   "perRole": { "<role>": { "warnedAt": ms|null, "capReachedAt": ms|null } } },
  "subtasks": [{
    "subtaskId": "st_...", "parentId": null, "role": "worker.audit", "title": "...",
    "sessionId": string|null, "provider": "...", "model": "<fullId>", "meterable": true,
    "status": "<engine-owned>", "createdAt": ms, "startedAt": ms|null, "endedAt": ms|null,
    "wallClockMs": int|null, "apiDurationMs": int, "numTurns": int, "modelDrift": false,
    "usage": UsageCell,
    "committee": [{ "phase": "plan"|"result", "verdict": "approve"|"revise"|"redelegate",
                    "reviewerSessionId": "...", "notesSeq": int, "ts": ms }]   // notes body in journal
  }],
  "usageTotals": {
    "overall": UsageCell,
    "byRole":    { "<role>": UsageCell },
    "byModel":   { "<resolvedModelId>": UsageCell },
    "bySession": { "<sessionId>": { "role", "model", "meterable", ...UsageCell } }
  },
  "meteringGaps": ["<sessionId>"],                    // unmeterable sessions that ran anyway
  "notes": { "verdictQuality": string|null },
  "baseline": { "label": "...", "sessionId": "...", "usage": UsageCell }|null   // §5
}
```

**UsageCell** (the one shape used everywhere):
```jsonc
{ "inputTokens": int, "outputTokens": int, "cacheReadTokens": int, "cacheCreationTokens": int,
  "webSearchRequests": int, "turns": int,
  "costUsd": number,          // sum of provider-reported finite costs (SIGNED — refunds subtract)
  "costKnownTurns": int, "unknownCostTurns": int,
  "pricedCostUsd": number,    // server-derived fallback for unknown-cost turns only (computePromptCostUsd)
  "effectiveUsd": number      // costUsd + pricedCostUsd — the display/budget number
}
```
Provenance rule: derived cost NEVER contaminates `costUsd`. `effectiveUsd` is recomputed on fold, not stored authoritatively (stored for convenience, rebuilt on recovery).

### 2.4 `events.jsonl` journal

One object per line: `{seq, ts, type, ...}`. Types:
`run_created, run_status_changed, subtask_created, subtask_updated, session_attached, turn_usage, committee_review, budget_warning, budget_cap_reached, budget_updated, delegation_blocked_budget, run_note, baseline_attached, run_completed`.

The ground-truth line:
```jsonc
{ "seq": n, "ts": ms, "type": "turn_usage", "runId", "subtaskId", "sessionId",
  "role", "model": "<resolvedId>", "modelRaw": "<provider key verbatim>",
  "terminalEvent": "result"|"error",
  "cost": number|null, "pricedCostUsd": number|null, "usage": {snake_case}, 
  "modelUsage": {…}|null, "numTurns": int|null, "durationMs": int|null, "apiDurationMs": int|null }
```
`committee_review` lines carry the plan-of-attack / result-summary / reviewer-rationale text bodies, capped at 32KB/line with a `truncated: true` flag; `run.json` holds only `notesSeq` pointers so the snapshot stays small.

**Write cadence** (mirrors the #5309 durability boundary):
- Journal: synchronous append per event (single writer, O_APPEND). Never debounced — it IS the crash record.
- `run.json`: debounced 2000ms for high-frequency `turn_usage` folds; immediate flush for lifecycle mutations (`run_created`, status changes, subtask create/terminal, budget crossings) — copy `SkillsUsageRecorder`'s `_scheduleSave`/`flush` shape with an added `flushNow()` path.
- Terminal writes (`report.json`, final `run.json`, `runs-index.json` update): `saveJsonState(path, value, { fsync: true })` (#5620 durable variant).

**Crash recovery** — `recoverRuns()` at daemon boot: for each `runs/<id>/run.json` with non-terminal status, replay `events.jsonl` lines with `seq > run.json.lastSeq` through the pure fold functions in `run-record.js`, then hand the reconciled record to the engine (which decides `failed(daemon_restart)` vs resumable). Idempotence: folds are keyed by seq; a replayed line never double-folds because `lastSeq` advances atomically with the snapshot.

**Retention/GC** (config `orchestration.retention`, defaults): `maxRuns: 200` — `runs-index.json` LRU-evicts terminal runs and `rmSync`s their directory (skills-usage MAX_SKILLS eviction pattern); `maxJournalMb: 50` per run — past cap, `committee_review` bodies stop journaling (usage lines always kept) and the snapshot increments `droppedEvents`.

### 2.5 RunLedger API (engine-facing; other agents own engine internals)

```js
class RunLedger extends EventEmitter {
  constructor({ baseDir, saveDebounceMs = 2000, now = Date.now, sessionManager = null })
  createRun({ title, preset, configSnapshot }) -> runRecord
  setStatus(runId, status, reason)
  createSubtask(runId, { subtaskId, parentId, role, title })
  attachSession(runId, subtaskId, { sessionId, provider, model, meterable })
  recordTurnUsage(runId, { sessionId, terminalEvent, data })  // data = the result/error payload
      -> { cell, budget }                                     // folded subtask cell + §3 evaluation
  recordCommitteeReview(runId, subtaskId, { phase, verdict, reviewerSessionId, notes })
  evaluateBudget(runId, { role } = {}) -> BudgetEval           // pure read; engine calls pre-delegation
  setBudget(runId, patch) -> BudgetEval                        // mid-run raise/lower
  attachBaseline(runId, { sessionId, label })                  // pulls cumulativeUsage+perModel via sessionManager
  note(runId, patch)                                           // verdictQuality etc.
  finalizeRun(runId) -> { reportJsonPath, reportMdPath }
  getRun(runId) / listRuns() / getReport(runId) -> { json, markdown }
  recoverRuns() / flush() / dispose()
}
```
Wiring: the ENGINE (not the ledger) subscribes to `sessionManager.on('session_event')`, filters `event === 'result' || event === 'error'` for sessionIds attached to a live run, applies the **same two gates** as session-manager.js:2830-2831 (finite cost OR finite `usage.input_tokens`; both-null synthetics filtered), and calls `recordTurnUsage`. This preserves the single-counting invariant verbatim and captures #5037 error-path partial spend. `_trackUsage` still runs independently — different scope (per-session vs per-run), not double-billing.

In-process events the ledger emits (engine relays; suggested wire names for the protocol agent — all run-scoped, broadcast directly, NOT via `session_event`, so they need `orchestration.ts` schemas + dispatch-table entries but no event-normalizer mapping):
- `run_usage_updated` → wire `orch_run_usage { runId, usageTotals, budgetEval }` (coalesce ≤1/s)
- `run_budget_warning` → `orch_budget_warning { runId, role|null, ...BudgetEval, justWarned: true }`
- `run_budget_cap_reached` → `orch_budget_cap { runId, role|null, ...BudgetEval, justCapped: true }`
- `run_updated` → `orch_run_updated { runId, run }` (snapshot for the dashboard run tree)

---

## 3. Soft budget caps

**Shape** (in `configSnapshot.budget`; defaults from `config.orchestration.defaultBudget`, per-run override at creation):
```jsonc
{ "maxUsd": 25.0|null, "maxTokens": null|int,      // billableTokens = input+output+cacheCreation (cacheRead reported separately, excluded from the token cap)
  "warnPercent": 80,
  "perRole": { "<role>": { "maxUsd": 10|null, "maxTokens": null } } }
```

**BudgetEval** return:
```jsonc
{ "ok": bool,                       // false ⇔ level === 'capped'
  "level": "ok"|"warned"|"capped",
  "spentUsd", "pricedUsd", "effectiveUsd", "spentTokens",
  "percentUsd": number|null, "percentTokens": number|null,
  "role": string|null, "roleLevel": "ok"|"warned"|"capped"|null,
  "unknownCostTurns": int, "meteringGaps": ["<sessionId>"],
  "justWarned": bool, "justExceeded": bool }        // one-shot, latched via budgetState.warnedAt/capReachedAt (billing-budget.js contract)
```

**Evaluation points**: (a) engine calls `evaluateBudget(runId, {role})` immediately before every new delegation (before `createSession`) — `ok:false` ⇒ do not delegate, journal `delegation_blocked_budget`; (b) after every `recordTurnUsage` fold — crossings emit the one-shot events above.

**Soft semantics** (locked decision #4): `capped` on any configured axis (run-level, or the candidate subtask's role) blocks NEW delegations only. In-flight sessions run to completion; their usage keeps folding and `effectiveUsd` may exceed the cap — recorded honestly, never clamped, never interrupts. The run-state consequence is engine-owned: ledger just reports; the engine transitions to its `paused_budget`-equivalent state when pending subtasks exist and eval is capped. `setBudget` mid-run re-evaluates; a raise past the cap records `capLiftedAt` (history preserved, `capReachedAt` kept).

**Unknown-cost handling**: budget math uses `effectiveUsd` (known + priced fallback). Turns with neither provider cost nor resolvable pricing increment `unknownCostTurns`; unmeterable sessions appear in `meteringGaps` so the dashboard token meter can caveat "observed spend ≥ shown" (billing-budget.js's "chroxy-observed, not authoritative" precedent).

**Signed-cost edge**: refunds (#4099) legitimately reduce `effectiveUsd`; latches don't un-fire (no warning spam) but `level` re-computes, so a run capped then refunded can resume delegating.

---

## 4. Cost attribution rules

1. **One model per worker session — the invariant.** Enforced by the engine (orchestrator never calls `setModel` on run-owned sessions); the ledger *verifies* rather than trusts: `recordTurnUsage` compares fold-time models against the attached `model`. A foreign model id in `modelUsage` (user manually flipped the model in the dashboard, or an SDK Task subagent used a sub-model) does NOT corrupt totals — the per-turn journal line and `byModel` cells split exactly by actual model — but sets `subtask.modelDrift = true` and journals it. So: **forbid at the engine, ledger-split as the honest fallback**. Rationale to document in code: the flat `cumulativeUsage` cannot split a mid-run switch, but per-turn journal lines each carry that turn's model, so attribution is exact even under drift; the invariant exists so the role→model *comparison* (the dogfood's point) stays clean. Note: SDK sessions legitimately report multiple models when Task subagents run — by-model split absorbs it; by-role attribution assigns all of it to the session's role (correct: that role spent it).
2. **Unmeterable providers** (claude-tui / claude-channel: `usage:null, cost:null`): metered runs **refuse by default** at run creation — engine validates the role→model mapping against `isMeterableProvider(provider)` (new export in `usage-normalize.js`: sdk/cli/byok-family/codex/gemini true; tui/channel false). Escape hatch `configSnapshot.allowUnmeterable: true` ⇒ session attached with `meterable:false`, lands in `meteringGaps`, report carries a "metering incomplete" banner. Default-refuse because the dogfood is a cost comparison.
3. **Pricing fallback** for `cost:null` turns: `pricing = isClaudeProvider(provider) ? getModelPricing(model) : getRegistryForProvider(provider).getOverlayPricing(model)`; `pricedCostUsd = computePromptCostUsd(usage, pricing)` (null ⇒ unknown-cost turn). Overlay (`~/.chroxy/models.json`) hot-reloads, so the operator can price codex/gemini models with no release; `configSnapshot.pricingOverlayHash` records which pricing produced the derived numbers.
4. **Signed costUsd**: fold with the exact `_trackUsage` coercions (nonneg-finite tokens, finite-signed cost, session-manager.js:3028-3029).
5. **Reconciliation**: when SDK per-model `cost_usd` sums diverge from `total_cost_usd`, trust the total for run/role totals and the per-model values for the split; record `costReconciliationDeltaUsd` on the turn line when |delta| > $0.0001.

---

## 5. Dogfood measurement story (repo-audit preset)

Everything needed is already in the schema; the preset just guarantees role tagging: `architect`, `architect.review` (committee turns), `worker.audit.*`. Derived at `finalizeRun` by `run-report.js` (pure):

```jsonc
"derived": {
  "totalEffectiveUsd", "wallClockMs", "sumApiDurationMs",
  "byRole": { "<role>": { "effectiveUsd", "billableTokens", "cacheHitRatio",  // cacheRead/(input+cacheRead)
                           "wallClockMs", "turns", "subtasks": int } },
  "bySubtask": [ { "subtaskId", "title", "role", "model", "effectiveUsd", "cacheHitRatio",
                   "wallClockMs", "committeeRounds": int, "verdictPath": ["revise","approve"] } ],
  "committeeOverheadUsd",                     // architect.review role total
  "delegatedVsBaseline": { "baselineLabel", "baselineEffectiveUsd", "deltaUsd", "deltaPct" } | null,
  "unknownCostTurns", "meteringGaps", "modelDriftSubtasks": []
}
```
**Baseline capture**: the monolithic frontier session runs as a normal Chroxy session; `attachBaseline(runId, {sessionId, label})` copies its `cumulativeUsage` + `perModelUsage` (via `sessionManager.getSessionUsage`-style accessor, :3209) into `run.baseline` and journals `baseline_attached`. Exposed to the wire as an engine command (suggested client→server msg `orch_attach_baseline {runId, sessionId}`).

**Verdict quality**: free-text `notes.verdictQuality` (set via `note()`, prompted by the dashboard at finalize) + per-review `notes` bodies in the journal — deliberately human-judgment, not auto-scored in v1.

**Rendering**: `report.md` is a template-literal markdown table set (per-role, per-subtask, baseline delta) written next to `report.json`; dashboard fetches via `getReport(runId)` surfaced over a snapshot wire message (`orch_run_report { runId, report, markdown }`) or `GET /api/orchestration/runs/:runId/report` (read-only ⇒ PRIMARY bearer per docs/security/bearer-token-authority.md; transport decision belongs to the protocol agent).

---

## 6. Phasing, independent PRs, tests

**PR-1 — "per-model usage capture" (independently valuable, ungated, ships first):**
`usage-normalize.js` + sdk/cli/codex/byok/gemini source fixes (§1.2-1.3) + optional §1.4 per-model cumulative & `session_usage.perModel`.
Tests: fixture-driven unit tests per provider session class (feed a canned `result` msg, assert emitted payload); `_trackUsage` regression suite untouched proves non-breakage; new test that codex cache tokens now accumulate; SessionManager tests pass temp `stateFilePath` (sandbox guard). **Phase-0 spikes inside this PR**: (a) capture a real codex `thread/tokenUsage/updated` fixture to answer whether `inputTokens` is inclusive of `cachedInputTokens` (double-count risk — if inclusive, emit `input_tokens = total - cached`); (b) confirm claude-cli stream-json result carries `modelUsage`.

**PR-2 — run record store:** `run-record.js` (pure folds) + `run-ledger.js` (I/O, journal, snapshot, recovery, GC). No engine dependency — tests drive it with synthetic result payloads and temp `baseDir`; crash-recovery test = write journal, truncate snapshot `lastSeq`, replay, assert folds; concurrency test = burst of `recordTurnUsage` collapses to one debounced snapshot write.

**PR-3 — budget:** `run-budget.js` + `evaluateBudget`/`setBudget` + one-shot latch events. Pure-function tests over crafted budgetState/usageTotals; latch-persistence test across a simulated restart; signed-cost (refund un-caps level but not latch) test.

**PR-4 — report + baseline:** `run-report.js`, `finalizeRun`, `attachBaseline`. Golden-file tests for report.json derived math (cache-hit ratio, baseline delta) and report.md rendering.

Gating: PR-1 is core telemetry, ungated. PR-2..4 surfaces are gated by `isOrchestrationEnabled(config)` = `CHROXY_ENABLE_ORCHESTRATION === '1' || config.features.orchestration === true` (copy config.js:671, fail-closed) — gate applies to handler registration/capability advertisement (protocol agent's slice); the ledger module itself is inert unless the engine instantiates it.

---

## 7. Open risks & mitigations

1. **Codex token inclusivity** (cached ⊆ input?) → Phase-0 fixture before the fix ships; adjust mapping accordingly. (CONFIRMED unknown; highest-priority verification.)
2. **SDK modelUsage keys vs registry ids** (dated full ids vs aliases) → fold through `resolveModelId` for `byModel` keys; preserve `modelRaw` on journal lines.
3. **Per-model costUSD sum ≠ total_cost_usd** → reconciliation rule §4.5.
4. **Journal growth on long runs** → 50MB cap, committee-body shedding, `droppedEvents` counter.
5. **Daemon crash mid-run** → journal-first writes + `recoverRuns()` replay from `lastSeq`; run marked failed/paused by engine, never re-folds.
6. **#5018/#5020 byok subagent model override** will invalidate the synthesized single-model map → comment cross-refs; that PR must split.
7. **Unmeterable TUI workers undermine the comparison** → refuse-by-default + `meteringGaps` banner.
8. **Two daemons on one config dir** → per-pid tmp suffix protects snapshots; interleaved journal appends accepted (same risk class as existing stores); optional future lockfile noted in code.
9. **Wire/lint checklist** (dispatch-table, DASHBOARD_ONLY, ws-server.js doc block, `git add -f` for new protocol dist per #6333) — protocol agent's slice; this design only names messages/payloads (`orch_run_usage`, `orch_budget_warning`, `orch_budget_cap`, `orch_run_updated`, `orch_run_report`, client→server `orch_attach_baseline`).
10. **Refund-driven un-capping oscillation** → latches one-shot, level recomputed; documented in §3.

### Critical Files for Implementation
- /Users/blamechris/Projects/chroxy/packages/server/src/sdk-session.js
- /Users/blamechris/Projects/chroxy/packages/server/src/session-manager.js
- /Users/blamechris/Projects/chroxy/packages/server/src/codex-app-server-session.js
- /Users/blamechris/Projects/chroxy/packages/server/src/models.js
- /Users/blamechris/Projects/chroxy/packages/server/src/json-state-file.js