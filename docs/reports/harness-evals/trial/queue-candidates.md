# Trial queue — candidate list

Prepared 2026-10-17 by a read-only exploration subagent of the cloud supervisor session, from the entire open backlog (416 issues scanned, 70 bodies read in full), under the rules in `PROTOCOL.md` §5. Nothing on GitHub was created, edited or commented. The owner picks 8–12 from the primary rows (alternates substitute one-for-one); the final list goes in `scripts/queue.json`.

# Trial queue candidates — blamechris/chroxy (open backlog as of 2026-10-17)

Method: paged `list_issues` (state OPEN, sorted by created desc, perPage 100) through the **entire** backlog (416 open issues, 5 pages); read 70 issue bodies in full plus the comment threads on #8214, #8208, #7847; checked `closed_by_pull_requests` on every read issue; listed all open PRs (only three Renovate dependency bumps: #8009, #8007, #7996 — none references an issue). All selected issues: filed by the owner (blamechris), created before 2026-10-17, `has_parent: false`, `has_children: false`, `closed_by_pull_requests.total_count: 0`, no excluded labels.

## Primary (12)

| # | Title | Labels | Package(s) | Type | Created | Size | Rationale | Risk |
|---|---|---|---|---|---|---|---|---|
| 8233 | cli: chroxy doctor ignores the configured port and checks 8765 | smoke-test: low, type: bug, server, ux | server (`cli/doctor-cmd.js`) | bug | 2026-10-04 | S | Crisp 3-step repro, named file/line, expected = merge port like `start` does (flag > env > config > 8765). | Must mirror `start`'s merge order exactly; the fix is tiny, so differences will show in test quality rather than outcome. |
| 8215 | isLoopbackHost: the ::ffff:7f prefix match accepts non-loopback mapped addresses | bug, complexity: low, priority: low, server | server (`bind-host.js`) | bug | 2026-10-03 | S | Explicit AC with four pinned inputs (`::ffff:7f:1`, `::ffff:7f`, `::ffff:7f00:1`, `::ffff:127.0.0.1`); pure predicate, fully unit-testable. | Four call sites named; an agent could over-reach into `connection-locality.js` / `ws-server.js` `lanBind`. |
| 7771 | fix(server): models.js updateContextWindow admits NaN | enhancement, from-review | server (`models.js`) | bug | 2026-09-12 | S | One-line guard (`Number.isFinite`), a prescribed prove-it-red test, named line range; NaN persists via `saveCache()` so the failure is observable. | Labelled `enhancement` not `bug`; "Part of #7721" (Codex-parity epic) but the fix itself is provider-neutral. |
| 8595 | bug: custom model collision labels repeat pinned descriptors | bug | store-core (`model-display.ts` `modelChoices`) | bug | 2026-10-13 | S | Concrete input rows and the exact wrong output strings; AC = cross-family collision regression through `modelChoices` with one discriminator. | Filed from a Copilot review of PR #8592; verify the formatter on `main` still matches the issue's description before starting. |
| 8364 | app: the lone tool bubble and tool detail modal show no terminated state | from-review, type: bug, app, ux | app (`ToolBubble`, `ToolDetailModal`) | bug | 2026-10-08 | S | Reference implementation exists (`ActivityGroup` on mobile, `ToolBubble` on dashboard); AC = component tests red without the change; keyed on `toolResultTerminatedReason`. | Needs Jest/RN testing library only, but a run that insists on a simulator check will stall. |
| 8282 | feat(server): record the stream kind on history entries so reasoning text is distinguishable from replies | enhancement, complexity: low, priority: medium, server | server (`session-message-history.js`) + protocol (optional field) | feature | 2026-10-05 | S/M | Five explicit ACs incl. backward-compat restore of `-thinking-<n>` ids and a mutation test; "Dependencies: None". | Says "Part of #8280" (epic); protocol schema change may require rebuilding/staging `@chroxy/protocol` `dist`. |
| 8188 | mobile app: honor the server-advertised defaultProvider | enhancement, from-review, app | app (store adapter) + store-core hook `applyServerDefaultProvider` | feature | 2026-10-01 | S | Hook already exists in store-core and is wired in the dashboard; AC: claude-sdk notes shown, older-daemon fallback, Jest red-first. | Cosmetic only (sessions already create correctly), so a run could under-test the fallback branch. |
| 8277 | dashboard: Settings hides a saved provider override the connected server does not offer, and never shows the migration notice | enhancement, from-review, dashboard | dashboard (Settings / New Session persistence) | feature | 2026-10-05 | S/M | Two concrete ACs (dormant override shown; migration notice in Settings with shared dismiss); reference behaviour already exists in New Session. | UI copy/placement is a judgement call; the New Session counterpart (#8611) overlaps on the migration notice. |
| 7612 | killProcessTree: build the POSIX process table from /proc on Linux, fall back to ps | enhancement | server (`platform.js` `listDescendantPids`) | feature | 2026-09-03 | S | Old debt; concrete failing behaviour (no `ps` → silent degrade to direct-child kill) and a concrete fix (read `/proc/*/stat`, fall back, log once); testable on Linux. | No checklist-style AC; a run must infer the test (e.g. mock `/proc` and a failing `ps`). |
| 8567 | notifications: DEFAULT_BYPASS_CATEGORIES is still hand-copied in both clients | from-review, tech-debt | protocol (`notification-categories.ts`) + server + app + dashboard | cross | 2026-10-10 | S/M | Same shape as the just-merged #8566 (single roster in protocol, two-direction check); AC includes a guard proven red by a one-sided mutation. | Touches four packages; a run must rebuild protocol `dist` and keep both clients' consumers in step. |
| 8303 | server,dashboard: Browse is $HOME-only while Create honours workspaceRoots, and a blank cwd inherits a configured directory that explicit Create would refuse | type: bug, server, dashboard, ux | server (`ws-file-ops/browser.js`, `handler-utils.js`, `session-manager.js`) + dashboard (New Session note) | cross | 2026-10-06 | M | Four testable ACs (Browse under `workspaceRoots`, default cwd browsable, startup warning, deny-list still applies); observed repro on a preview daemon. | Largest item in the queue; the issue explicitly defers whether blank-cwd should bypass `validateCwdAllowed` (a run must not decide that). |
| 7815 | test(server): doctor 'accepts custom port' hardcodes 59123 and asserts pass | bug | server tests (`tests/doctor.test.js`) | test | 2026-09-13 | S | Flake with CI evidence; two prescribed fix shapes, prove-it-red instructions, and a second site (59124) to catch; not CI config. | A run may take the weaker option 2 and drop the only `pass`/`warn` coverage, which the issue itself warns about. |

## Alternates (4)

| # | Title | Labels | Package(s) | Type | Created | Size | Rationale | Risk |
|---|---|---|---|---|---|---|---|---|
| 8594 | bug(dashboard): header tooltip resolves colliding model alias twice | bug | dashboard (header tooltip builder) | bug | 2026-10-13 | S | Explicit AC with a two-row overlay fixture and expected tooltip values; no selection-semantics change allowed. | From the same PR #8592 review as #8595 — if both are queued the two fixes could collide in the same files. |
| 8005 | flaky: ws-server 'multiple encrypted messages maintain correct nonce sequence' assumes the next 3 encrypted frames are all pongs | priority: low, type: bug, testing | server tests (`tests/ws-server.test.js`) | test | 2026-09-27 | S | Root cause and fix stated; AC includes two mutations (extra broadcast stays green, skipped nonce goes red). | Reproducing the flake needs a busy machine; verification is by mutation only. |
| 8226 | dashboard: 'Close Session' is offered on the last session, then fails with 'Cannot destroy the last session' | smoke-test: low, dashboard, ux | dashboard (session context menu) | feature | 2026-10-04 | S | Clear repro; expected state is either/or (disable with reason, or allow with empty state) — either is observable. | Either/or AC means runs may diverge in approach; no explicit test requirement stated. |
| 7974 | UI: show a protected-path marker on floored permission prompts (carry floored through store-core) | from-review | store-core (`handlePermissionRequest`) + dashboard `PermissionPrompt` + app `PermissionDetail` | cross | 2026-09-26 | S/M | Field already on the wire since #7971; AC lists store-core handler test and tri-state component tests in both clients. | One AC is "a live visual check on both clients", which a headless run cannot satisfy. |

## Considered and rejected (rule that excluded it)

Read in full:
- #8609 — rule 4 (reserved).
- #8610 server,dashboard Codex request errors — rule 4/3: Codex-domain, example error originates from #8609; reproducing needs a Codex/ChatGPT login.
- #8611 dashboard New Session modal (Codex) — rule 5: five sub-items incl. a rendered Playwright overflow check; Codex-adjacent.
- #8605 SDK checkpoint has no branch point — rule 2: "observed gap, not an established root cause… investigate"; also needs live SDK turns.
- #8599 late join hides Stop for busy native session — rule 3: repro requires a live native Codex session.
- #8596 stopped toast intercepts Send — rule 2 (weak): repro is real but acceptance is layout verification in a real browser at narrow viewport; no test prescribed.
- #8571 scheduler restart forgets task→session — eligible (bug, AC, failing test) but M; not selected for capacity.
- #8561 byok MCP shadowed definition — eligible (AC) but needs a live MCP fleet to verify; not selected.
- #8554 orchestration stopped-turn usage — eligible but M, touches `TurnError` contract; not selected.
- #8551 protocol outbound fields — rule 5/2: per-field producer verification + protocol dist rebuild; "a scan hit is a lead, not a fact".
- #8529 permission-hook timeout wording — eligible (AC) but spans `hooks/permission-hook.sh` + `ws-permissions.js`; not selected.
- #8516 approve-with-edits journal — eligible but cross-client + server, M; not selected.
- #8488 createEmptySessionPanels paths — rule 2: path 1 is "a design decision, not a one-line spread".
- #8449 sdk redact background-shell chip — eligible, S; not selected for capacity (good spare).
- #8435 smoke-test.mjs case floor — eligible test item; not selected (needs a running daemon for the end-to-end half).
- #8415 backfilled tool input vs history cursor — eligible, S/M; not selected.
- #8365 claude-cli intentional-stop flag — rule 3: "run a live claude-cli session on a dedicated host".
- #8354 tmpdir roster scan — eligible test item with measured mutations; not selected (second test slot).
- #8337 editor write_file protected-path floor — rule 5/2: security-floor change with a prompt-vs-refuse decision.
- #8303 — selected.  #8282 — selected.
- #8279 scheduler refusal clause, #8278 doctor Billing copy — eligible S server bugs; not selected for capacity (good spares).
- #8271 empty assistant row — rule 3: repro needs a claude-tui stall or an expired `claude` login.
- #8270 CLAUDE_CONFIG_DIR — rule 2/5: "each call site needs a decision, not a blind rewrite"; ~10 sites.
- #8269 `claude auth status --settings` — rule 3: verification against a live `claude` binary/login.
- #8261 blue activity dot, #8257 lingering thinking bubble — rule 2: "Likely code: Not isolated"; needs simulator to confirm.
- #8238 settings summary cwd/'cli', #8237 MODEL_NOT_APPLIED toast — eligible-ish (clear expected) but only verifiable on a simulator; not selected.
- #8227 Tab accepts suggestion, #8221 restored worktree tick — eligible dashboard S items; not selected for capacity.
- #8222 every disabled control gets a reason — rule 2/5: open-ended audit.
- #8218 agent-control dial error — eligible, but AC offers a comment-only resolution; not selected.
- #8214 app worktree switch reason — eligible; comment widens scope (stale-flag half); not selected.
- #8208 persisted terminalBuffer — rule 2: re-scoped after PR #8212 closed unmerged to "decide what the buffer is for".
- #8207 direct connect() roster — rule 2: options (a)/(b) require a decision and an audit first.
- #8199 mission-control grouping — rule 2: AC #1 is "decide and document (a) vs (b)".
- #8187 git panel outside-cwd rows — eligible cross (4 packages), M; not selected (third cross).
- #8175 mobile expired-permission summary — eligible, M; not selected.
- #8018 ws-file-ops raw err.message — eligible, S/M; not selected.
- #8005 — alternate.  #7997 claude-hooks symlink skip — eligible S test item; not selected.
- #7961 container Grep glob fallback — rule 5/2: glob→`--include` translation design; container verification.
- #7899 negated bracket class — rule 3: macOS/Windows case-insensitive FS required.
- #7847 TUI unknown-resume classifier — eligible (pure text fixture, AC); not selected because it is claude-tui recovery logic a run cannot exercise live.
- #7815 — selected.  #7804 Codex app-server token accounting — rule 4 (Codex-domain; needs codex).
- #7801 duplicated cumulativeUsage overlay — eligible refactor; not selected.
- #7786 clear thinking-level — rule 4-adjacent (CodexAppServerSession) and offers a docs-only resolution (rule 2).
- #7768 set_model trim — eligible, M (two gates); not selected.
- #7739 definition-time throw guard — rule 5: new runner-level guard across every package's test script.
- #7705 encryption-gate factory — eligible S app test item; not selected.
- #7612 — selected.  #7425 mobile PR/CI chip — rule 5 (new mobile surface, three contracts).
- #7314 follow mode — rule 5 (six ACs, roadmap subtask).
- #7007 transcript correlation id — rule 5/2 (protocol frame design, no AC list).
- #6942 thinkingTokens — rule 2: conditional on a provider that does not exist yet; no failing behaviour.
- #8514 rolling thinking window — rule 5: design-heavy, both clients, visual.

Excluded on labels/title without a full read:
- rule 1 (epic/meta): #8306, #8280, #8245, #7820, #7819, #7818, #7817, #7816, #7721, #7304, #7165, #6775, #6691, #6469, #6389, #5982, #5422, #7719 (Renovate Dependency Dashboard).
- rule 1 (blocked on external): #7880 (blocked on Aeolus#15).
- rule 3 (needs-dogfood / owner device / phone build / desktop / Discord / Cloudflare / K8s / Docker daemon): #8250, #8249, #8244, #8243, #8071, #7833, #7805, #6815, #6557, #6479, #6275, #6251, #6175, #6112, #5987, #5972, #5965, #5940, #5692, #3956, #3955, #3954, #3840, #3699, #8471, #8417, #7367, #8104, #7170, #7169, #7168, #7167, #6958, #8078, #8235, #8178, #8027, #8493, #8486, #7223, #7172, #7164, #7163, #7150, #7148, #7158, #7159, #8292, #6981, #6991, #7021, #6870, #6869, #6935, #6899, #6885, #6762, #6758.
- rule 3 (Windows-only or macOS-only host): #8067, #8032, #7999, #7284, #7276, #7274, #7278, #7215, #6670, #6667, #8077, #8095, #8579, #7791.
- rule 3 (`.claude/`, skills, prime-directive, CI workflows): #8580, #8537, #7715, #7714, #7712, #8211, #8195, #8194, #7985, #7491, #7216, #7156, #7113, #7174, #7541, #8056, #8333, #8334, #8332, #6572.
- rule 3 (security-labelled; conservatively treated as advisory-adjacent given #8220's "private-advisory rule" triage): #8220, #8217, #8097, #8081, #8080, #8049, #8019, #8006, #7981, #7977, #7963, #7957, #7598, #7589, #7352, #7350, #7048, #7018, #7005, #7003, #6980, #6979, #6932, #8319, #8316, #8315, #8313, #8311, #8310, #8309, #8307, #8288, #8286, #8246, #7840, #7837, #7322, #7321, #7320, #7316, #7311, #7178.
- rule 4 (Codex model admission / roster / binary): #8552, #7764, #7763, #7755, #7743, #7775, #7790, #7789, #7781, #7779, #7778, #7774, #7772, #7760, #7751, #7750, #7749, #7748, #7746, #7742, #7741, #7785, #7783, #6684, #7826.
- rule 5 (multi-day / epic children / roadmap subtasks / complexity high): #8323, #8329, #8327, #8326, #8322, #8321, #8318, #8317, #8314, #8308, #8305, #8295, #8294, #8293, #8291, #8290, #8289, #8287, #8285, #8284, #8283, #8281, #8248, #8247, #7861, #7860, #7859, #7858, #7857, #7856, #7855, #7839, #7838, #7836, #7832, #7831, #7830, #7829, #7828, #7824, #7823, #7437, #7397, #7369, #7363, #7362, #7348, #7345, #7317, #7315, #7313, #7312, #7310, #7309, #7308, #7307, #7306, #7305, #7287, #6995, #6992, #6976, #6975, #6907, #6866, #6801, #6798, #6797, #6796, #6795, #6789, #6786, #6785, #6783, #6782, #6781, #6779, #6778, #6777, #6776, #6770, #6765, #6763, #6761, #6760, #6759, #6753, #6750, #6743, #6735, #6703, #6478, #6393, #6392, #6391, #7110.
- rule 2 (vague / "consider" / decision-first / unlabeled multi-item follow-up bundles): #8598, #8564, #8548, #8544, #8528, #8524, #8522, #8495, #8479, #8478, #8477, #8469, #8461, #8457, #8452, #8445, #8440, #8439, #8438, #8431, #8428, #8425, #8424, #8416, #8408, #8392, #8391, #8350, #8349, #8341, #8274, #8273, #8262, #8259, #8258, #8256, #8242, #8241, #8236, #8234, #8232, #8231, #8230, #8229, #8228, #8219, #8196, #8055, #7965, #7964, #7962, #7949, #7916, #7881, #7710, #7708, #7706, #7703, #7701, #7700, #7698, #7690, #7108, #7085, #7064, #7041, #7047, #7039, #7007.

Eligible under every rule but not selected (spares if a primary falls through): #8571, #8561, #8554, #8529, #8516, #8449, #8435, #8415, #8354, #8279, #8278, #8238, #8237, #8227, #8221, #8218, #8214, #8187, #8175, #8018, #7997, #7847, #7801, #7768, #7705, #8596.

## Scan count

416 open issues scanned (the entire open backlog, five pages); 70 issue bodies read in full; 3 comment threads read; 3 open PRs listed (all Renovate).
