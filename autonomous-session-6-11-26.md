- **PR #5589** (#5563 primary semantics, CLOSES #5563) — reviewer died mid-CI-monitor after triaging+fixing 2 Copilot threads (c4eff6609); orchestrator completed the review. D11: found and fixed a real product regression in the agent's design — rejecting adoption on accepted idle input strands a solo user's second device behind input_conflict mid-run (phone↔desktop flow); revised to force-adoption on accepted input, sticky PRIMARY_HELD kept on the explicit claim_primary wire path for #5281 roles (a83b7d72b). 269 tests + 3 lints green w/ CHROXY_WS_INDEX_ASSERT; CI green on head; merged a9bd2f97f; issue #5563 CLOSED; cleaned.
- **PR #5590** (#5555.1 eager key exchange) — review: Approve after adversarial security pass (eager ≡ discrete crypto verified; no plaintext downgrade on any branch; eager stash gated behind isTokenValid; TOFU #5536 unchanged). Reviewer merged main twice into the branch (stale base vs #5588+#5589), caught a genuine merged-state CI failure (leaked pendingKeyPair between app tests, 31ea6339e) + fixed Copilot thread 3 (clear eager stash when encryption disabled, bff24330b); 2 missing-salt threads FALSE POSITIVE; all 3 resolved. CI 15/15 green on final head 4a09e3d09; merged e1c2ac645; cleaned.

**Marathon 4 complete: 3/3.** Cold connect now 1 RTT lighter (every reconnect too); client flush layer unified; shared-session ownership semantics in place ahead of #5281. Also GC'd 5 stale worktrees + 3 merged branches from prior sessions (verified each tip ⊆ merged PR head before deletion).
Follow-up noted (non-blocking, from #5590 review): client eager-receive path could mirror the discrete handler's empty/format guard on serverPublicKey — fold into the next #5555 chunk.

---

## Marathon 5 (user: "Start marathon 5 and after you can rebuild and restart")

| Lane | Issue | Scope | Branch |
|------|-------|-------|--------|
| A | #5555.2 | auth_bootstrap burst coalescing (kill 3-request connect round trip + redundant frames) + serverPublicKey eager-receive guard (#5590 follow-up) | feat/auth-bootstrap-burst |
| B | #5555.3+4 | lastSeq delta replay + newest-first/no-blank-flash replay UX — DISPATCHED AFTER A MERGES (both rework ws-history.js) | (pending) |
| C | #5556.3 | shared dispatch table slice 1 (5-10 pure-delegation cases) | refactor/store-core-dispatch-table |

D12: B serialized behind A rather than parallel — ws-history.js sendPostAuthInfo is the shared hot file; the #5576/#5577-style auto-merge hazard outweighs the wall-clock win. Close-out: rebuild dashboard + Tauri app, reinstall, restart, verify health.

### Marathon 5 ledger (running)
- **PR #5591** (#5556.3 dispatch table slice 1) — review: Approve (all 7 cases re-verified byte-identical against origin/main; no double-handling; parity guard fails on empty parse). Reviewer fixed 7 Copilot threads (wrong epic breadcrumbs, sessionRules typing) in 8a0b6e1; DispatchMessageMap↔protocol drift flagged as FOLLOW-UP (silent but decorative). CI 15/15 green; merged e908d1ef1; cleaned. Epic #5556: registry exists, 7 cases shared, 12 documented-divergent.
- **PR #5592** (#5555.2 auth_bootstrap burst + serverPublicKey guard) — review: Approve. Reviewer merged main (post-#5591) semantically clean; verified bootstrap frame rides the encrypted channel on both eager+discrete paths (no plaintext workspace-info leak); caught 2 real Copilot schema bugs and fixed them itself (a49ae4ed3: availablePermissionModes was z.array(z.string()) vs actual object array — would have rejected real auth_ok; missing .default([])). −3 connect requests / −1 RTT. CI green on final head; merged 4acf646a2; cleaned.
- Lane B dispatched post-#5592: #5555.3 lastSeq delta replay + #5555.4 preserve-then-reconcile replay UX, one PR, branch feat/lastseq-delta-replay.
- **PR #5593** (#5555.3+4 lastSeq delta replay + preserve-then-reconcile UX) — review: Approve after 9-case adversarial trace. Orchestrator-predicted cursor-ahead-of-server bug (post-restart seq reassignment → empty delta + permanently wedged cursor) CONFIRMED REAL and fixed (16346b0: lastSeq > latestSeq forces fullHistory) + regression tests; Copilot independently flagged the same case. 2 more fixes (649b74a: LRU-cap client cursor map at 64; honest ws-auth cursor test). Replay×live dedup refuted-as-regression (pre-existing, handled). Implementation kept ALL backpressure machinery with justification (bounded-but-fat tails still cross the 1MB line) — epic prediction of dead code was wrong, documented. CI 16/16 green on 649b74a; merged 2df17b795; cleaned.

**Marathon 5 code-complete: 3/3 merged** (#5591 dispatch table, #5592 auth_bootstrap, #5593 lastSeq replay). Epic #5555: sub-items 1-4 done, 5-7 remain. Epic #5556: sub-items 1-3(slice 1) done. Proceeding to rebuild+restart.

**Marathon 5 close-out:** Chroxy.app rebuilt from main 2df17b795, installed, relaunched. /health ok 0.9.46. Verified in installed bundle: authBootstrap+historyCursors in server ws-auth.js/ws-history.js; auth_bootstrap+historyCursors strings in dashboard dist. Zero open PRs; main synced; no leftover worktrees/branches.

---

## Marathon 6 (user: "keep going with marathon 6 after the rebuild")

| Lane | Issue | Scope | Branch |
|------|-------|-------|--------|
| A | #5555.5+6 | Reconnect backoff ladder on close/error (reset on auth_ok, banner reads ladder) + keepalive coordination (zombie eviction via departure path) | fix/reconnect-backoff-keepalive |
| B | #5555.7 | tunnel_url_changed client push + tunnelUrl in bootstrap; persisted-URL update so reconnects chase the new URL | feat/tunnel-url-changed-push |
| C | #5556.3 slice 2 | Next byte-identical batch + deliberate reconciliation of 2-4 documented-divergent cases (drift-kill) | refactor/dispatch-table-slice-2 |

All three parallel (disjoint-enough surfaces: connection close-path / tunnel plumbing / dispatch cases). B completes the last open #5555 sub-item — epic close is maintainer's call. Close-out: rebuild+reinstall+restart.

### Marathon 6 ledger (running)
- **PR #5594** (#5555.5+6 backoff ladder + keepalive) — review: Approve, no fixes needed. Both orchestrator-flagged concerns ruled out with evidence (pre-auth sockets bounded by 10s authTimeout independent of frame flooding; cross-host ladder leak bounded ≤8s + self-corrects on auth_ok — logged as cosmetic follow-up). 1 Copilot thread FALSE POSITIVE (node --test per-file isolation), resolved. Zombie detection 60s→15-30s; flap-storm now rides RETRY_DELAYS ladder. CI green; merged 0be7a2fb2; cleaned.
- **PR #5595** (#5556.3 slice 2) — review: Approve. 13/13 byte-identical re-verified from origin/main; notification_prefs reconciliation confirmed failure-mode-parity (fail-closed both paths) → **issue #5488 closed as superseded**. 2 Copilot threads FIXED by reviewer (agent_event tests + hardened drift-guard regex, 1bd2ede5f); 0 unresolved. session_role swallow verified (silent default). Dispatch table now 21 cases. CI green; merged 913dc3822; cleaned.
- **PR #5596** (#5555.7 tunnel_url_changed push) — review: Approve (reviewer hit a transient API error mid-run, then recovered and completed; verdict + 3 FIXed threads: shared asWssUrl() validation on both parsers + legacy-record repoint). Repoint correctly scoped to the connected server's entry only; rides the encrypted path; ws://evil rejected. Gate caught a CI failure the reviewer's monitor missed: event-normalizer adaptive-window flake (passed 114/114 locally at the PR head; rerun green) — merged only after the rerun. Merged e22d01cca; cleaned.
- Follow-up filed: #5597 (inner reconnect ladder re-dials closure-captured URL; adjacent to #5537).
- **Epic #5555 CLOSED — all 7 sub-items landed.** Issue #5488 closed as superseded (via #5595).

**Marathon 6 complete: 3/3 merged** (#5594, #5595, #5596). Rebuild+restart in progress.

**Marathon 6 close-out:** Chroxy.app rebuilt from main e22d01cca, installed, relaunched. /health ok 0.9.46. Verified in installed bundle: broadcastTunnelUrlChanged + 15s keepalive sweep in server ws-server.js; tunnel_url_changed strings in dashboard dist. Zero open PRs; main synced; only the primary worktree remains.

---

## Marathon 7 (user: "keep going with marathon 7")

| Lane | Issue | Scope | Branch |
|------|-------|-------|--------|
| B | #5556.4 | createConnectFlow extraction (shared connect orchestration; per-attempt resolveEndpoint seam designed in for A) | refactor/store-core-connect-flow |
| C | #5559 | claude-tui-session 4435-LOC pure-move 3-way split (PTY driver / form driver / session shell) | refactor/claude-tui-split |
| A | #5597+#5537 | Reconnect endpoint fixes (per-attempt URL re-resolution + LAN→tunnel fast fallback) — AFTER B, plugged into the shared seam | (pending) |

D13: A serialized behind B by design — fixing endpoint selection in the duplicated code means fixing it twice; the extraction lands first with a resolveEndpoint(attempt) seam, then A implements both bug fixes ONCE in shared code. C runs parallel (server-only, fully disjoint). C is high-risk-pure-move: prompt pins all empirical TUI behaviors (paste throttle, hotkey digits, pinned form sequences, monotonic watchdog, #4638 invariant) and demands moved-vs-changed accounting + unmodified test suite.

### Marathon 7 ledger (running)
- **PR #5599** (#5559 claude-tui 3-way split, CLOSES #5559) — review: Approve via independent byte-identity audit (1322/1407 added lines byte-moved; 85 scaffolding; sole difference = path-depth compensation verified to resolve to identical absolute path; reviewer's own audit pipeline initially produced false diffs from shell escape-mangling and it re-verified from disk before concluding). No shadowing; non-enumerable descriptor copy preserved; opt-forwarding lint still parses the class (1 of 8 subclasses). Zero test edits. 4435→~3100 LOC shell + 2 drivers. CI 15/15; merged be3eb8d7c; cleaned.
- **PR #5598** (#5556.4 createConnectFlow) — review: Approve. Pixel-identical trace held per client (incl. the subtle unclamped-vs-clamped RETRY_DELAYS indexing proof); resolveEndpoint(attempt) confirmed per-attempt not memoized; zero-test-edit claim audited true; 1 Copilot thread FIXED (dead scheduler opt removed, a6050261b). Dashboard guard relocation verified verbatim. CI 15/15 on final head; merged d39f1ac45; cleaned. Epic #5556: sub-items 1,2,3(two slices),4 done; 5-6 remain.
- Lane A dispatched into the fresh seam: #5597+#5537 per-attempt endpoint re-resolution + LAN→tunnel fallback, branch fix/reconnect-endpoint-resolution.
- **PR #5600** (#5597+#5537 reconnect endpoint fixes, CLOSES both) — review: Approve after fixing a REAL redirect bug Copilot+reviewer caught: savedConnection-based re-resolution wasn't token-scoped, so a manual connect to a different server could be redirected to the OLD server's tunnel URL mid-ladder (fixed 3c21804c9 + regression test). Worst-case time-to-tunnel computed: ~14-16s (vs ~44s full-budget burn before), dominated by two unavoidable 5s dead-LAN health timeouts — ladders confirmed non-stacking. Post-fallback sticks to tunnel; LAN re-probed by the next connectAuto (deliberate, lanVerified preserved). Dashboard confirmed single-wsUrl (no #5537 equivalent). CI green first try; merged 35dc5b9d4; issues #5597+#5537 both CLOSED; cleaned.

**Marathon 7 complete: 3/3 merged** (#5598 connect flow, #5599 claude-tui split, #5600 reconnect fixes). Issues closed: #5559, #5597, #5537. Close-out: Chroxy.app rebuilt from main 35dc5b9d4, installed, relaunched; /health ok 0.9.46; claude-tui/{pty-driver,form-driver}.js present in installed server; resolveEndpoint plumbing in dashboard dist. Zero open PRs; main synced; only primary worktree remains.

---

## Marathon 8 (user: "keep going with marathon 8 after the rebuild")

| Lane | Issue | Scope | Branch |
|------|-------|-------|--------|
| B | #5560 | App.tsx (~3092 LOC, dashboard) → feature hooks + Shell; #5599 pure-move playbook; hook extraction over component splitting (render semantics) | refactor/dashboard-app-shell |
| C | #5536 | E2E key pinning from pairing (kills pure TOFU); both exchange paths; honesty clause — no crypto theater, stop at largest sound subset | feat/e2e-key-pinning |
| D | #5533 | /qr + /pairing-code primary-token scoping + sibling-endpoint audit per bearer-token-authority checklist | fix/scope-pairing-endpoints |
| A | #5556.5+6 | Behavioral-contract fixtures + encrypted-handshake e2e — AFTER C merges (tests must pin the pinned-key handshake); closes epic #5556 | (pending) |

D14: A serialized behind C so the handshake e2e pins post-pinning behavior. D14b: #5536 prompt carries an explicit anti-theater clause (fingerprint must not ride the channel it authenticates; defer what the primitives can't soundly support, candidly).

### Marathon 8 ledger (running)
- **PR #5601** (#5533 token-class scoping, CLOSES #5533) — review: Approve. **/connect escalation CONFIRMED from pre-PR code**: pairing-bound token → raw primary apiToken in cleartext (redaction only fired when auth disabled). Reviewer's independent full-route classification table matched; 403 oracle assessed acceptable (class-membership check, constant-time compare); callers verified unbroken (dashboard primary token, CLI connection.json, LAN flow never GETs these). Reviewer added Cache-Control: no-store on /connect (856739867) + resolved 1 thread, then died mid-CI-watch; orchestrator finished the watch. CI green; merged ce22f5fc8; cleaned.
- **PR #5602** (#5560 App.tsx → hooks + Shell, CLOSES #5560) — review: Approve with line-number-level invariant proof (seed-effect #5202 ordering preserved L860<L1265 matching base; terminal ancestry byte-identical; AppHeader/AppModals stateless; no widened selectors). 1 thread FIXED (docstring), 1 FALSE-POSITIVE-by-policy (byte-identical moved condition). 3127→2217 LOC; composer + terminal subtree deliberately inline (documented invariants). Merged c60c021c7. NOTE: `Closes #5560` was in backticks → GH didn't auto-close; closed manually with scope rationale. Gotcha for future PR bodies: closing keywords must not be inside code spans.
- Incident (caught at gate): #5603's implementer wrote the regenerated protocol dist into the MAIN checkout's working tree instead of its worktree (cross-worktree leak, known hazard) — and the PR itself shipped src/schemas/server.ts WITHOUT any dist. Stray main-checkout edits discarded (change is deterministic from src); a dedicated agent dispatched to regenerate + commit dist on the PR branch and verify server tests resolve against the committed dist. Merge held until consistent.
- Incident update: dist verified PRESENT on the #5603 branch (dedicated regen commit, byte-identical to fresh build; store-core dist/crypto also verified; server-side serverKeySig writes validate through committed dist). The commit appeared after the orchestrator's file-list check — hold released. Stray main-checkout edits remain correctly discarded (duplicate of committed work).
- **PR #5603** (#5536 E2E key pinning, CLOSES #5536) — review: Approve after adversarial crypto pass. Downgrade matrix code-verified fail-closed in all 9 cells (incl. pinned×old-server REFUSE, eager→discrete fallback re-verifies); pin-overwrite via chroxy:// link ruled out (fresh-entry mint / pin-and-connect only when unpinned); replay = DoS-at-worst (ephemeral DH key never transmitted). 3 on-branch fixes: protocol dist regen (262dbfbeb — explains the earlier stray-dist incident), atomic writeFileRestricted for the 0600 identity secret, exchange-key length validation (aa15be7df). Domain-separation prefix flagged as follow-up. #5601 merge overlap resolved clean (gate + payload coexist). CI green; merged 55837f5c7; cleaned. TOFU is dead for paired clients.
- **PR #5605** (#5556.5+6 contract fixtures + handshake e2e, CLOSES EPIC #5556) — reviewer died mid-CI-wait after triaging+fixing 3 threads (693f32ddd: per-frame send nonces in the test driver, tightened no-op assertion; 1 FALSE POSITIVE documented); orchestrator completed the review incl. THE empirical drift check: injected isIdle drift into dispatchAgentBusy → 3 tests red (incl. the dedicated guard-gap test) → revert green. First mutation attempt was a silent sed no-op (false pass) — lesson: verify the mutation landed before trusting a mutation test. Real-path imports verified (runDispatch from ../dispatch-table). CI green; merged 9532c96d0; **epic #5556 CLOSED — all 6 sub-items landed**. Cleaned.

**Marathon 8 complete: 4/4 merged** (#5601 token scoping + /connect escalation, #5602 App shell, #5603 E2E key pinning, #5605 contract fixtures + handshake e2e). Issues closed: #5533, #5560, #5536, #5556 (EPIC — final audit epic done). Filed: #5604 (domain separation). Close-out: Chroxy.app rebuilt from main 9532c96d0, installed, relaunched; /health ok 0.9.46; verified in bundle: server-identity.js present, serverKeySig in ws-auth+ws-history, primary-gate in http-routes (6 sites), pinnedIdentityKey in dashboard dist. Zero open PRs; main synced; only primary worktree remains.

---

## Marathon 9 (user: "keep going with marathon 9 no rebuild as an agent is working in the current version")

NO REBUILD this marathon — running daemon stays untouched (user agent active on it). Agents are code-only on branches; no process restart, no ~/.chroxy/ writes.

| Lane | Issue | Scope | Branch |
|------|-------|-------|--------|
| A | #5356 | Loopback-by-default for Chroxy.app + auto-tunnel exposure assessment; explicit-exposure toggle preserved | fix/loopback-default |
| B | #5281 | session_role surfacing in both clients (server done in #5589; clients currently ignore it); observer indicator + input_conflict/PRIMARY_HELD UX + claim/hand-off affordance | feat/session-role-ui |
| C | round 3 | swarm-audit 8-lens vs 3.4/3.8 baselines — AFTER A+B merge; local gitignored report | (after merge) |

D15: #5356 lane A leans Option A (Tauri-shell --host 127.0.0.1) per issue's literal "Chroxy.app defaults to loopback" + smallest blast radius; agent to assess auto-tunnel separately (loopback bind is moot if a public tunnel forwards to localhost). Security-default change → close review.

### Marathon 9 ledger (running)
- **PR #5611** (#5356 loopback-by-default, CLOSES #5356) — review: Approve. Fresh-install posture verified DEFINITIVELY safe: new Chroxy.app spawns CHROXY_HOST=127.0.0.1 AND tunnel=none (the "quick" seed in ServerManager::new is overwritten by handle_start reading settings default "none" before every spawn). expose_on_lan toggle round-trips end-to-end (not theater). 3 threads FIXED incl. a real one — omitting CHROXY_HOST ≠ unsetting it, inherited env could defeat the default → env_remove (9ae9f0e65). Command-drift guard consistent across 4 surfaces. Zero binaries. Auto-tunnel was already user-gated (no change needed). CI green; merged bd706fac8; cleaned. NO REBUILD — change ships to users next packaged release; running daemon unaffected.
- **PR #5612** (#5281 session-role surfacing) — review: Approve. clientId id-space verified consistent end-to-end (role not stuck-observer); session_error calm branch scoped to input_conflict only; force-claim behind explicit button; 1 thread FIXED (semicolon). Reconnect role-staleness flagged → filed #5613. Merged f690d286d; cleaned.

### Marathon 9-C: swarm-audit ROUND 3 — **4.19/5** (R1 3.4 → R2 3.8 → R3 4.19)
8-lens workflow (parallel auditors + synthesis). Per-lens: Skeptic 4.3, Builder 4.0, Guardian 4.2 (ONLY down-vote, 4.3→4.2 — pinning re-opened a downgrade cell), Minimalist 3.9 (down-vote reversed), Futurist 4.2, Tunneler 4.4, Operator 4.5, Tester 4.1 (+1.6 over two rounds — biggest climber). Reports: docs/audit-results/.../00-master-assessment-round3.md + r3-*.md (local, gitignored).
Consensus: C1 connect-path RTT cuts real (5 lenses); C2 dispatch migration genuine but incomplete (+968 LOC mid-migration); C3 key-pinning re-opened a downgrade/self-lockout surface (Guardian+Futurist, the round's most important negative); C4 claude-tui split is file-move not boundary; C5 trust-ledger consolidation real.
10 issues filed: #5614/#5615/#5616 (C3 security — pinned-requires-encryption HIGH, keychain-no-silent-rotate HIGH, rotation-handoff MED), #5617 (form-driver collaborator), #5618 (finish dispatch migration), #5619 (contract lint + maestro key_exchange), #5620/#5621 (cleanup), #5622 (eager-derivation concurrency), #5623 (app sessionRole reset).

**Marathon 9 complete: 2 PRs merged (#5611 #5356-closed, #5612) + round-3 audit. NO REBUILD (running daemon preserved for active agent). Issues closed: #5356. Filed: #5613 + 10 audit issues = 11.**

---

## Marathon 10 (user: "go and we have some new gh issues too")

New dogfooding issues #5606-5610 (filed today from v0.9.46 use) + the two HIGH security regressions the round-3 audit surfaced. NO REBUILD assumption carried (running daemon may still host an agent) — rebuild decision deferred to close-out.

| Lane | Issues | Scope | Branch |
|------|--------|-------|--------|
| A | #5614+#5615 | Key-pinning hardening (HIGH): pinned-requires-encryption downgrade cell + keychain-no-silent-rotate. Fixes #5536 regressions from audit C3 | fix/key-pinning-hardening |
| B | #5609 | Gate/defer perm-mode Approve→Auto while busy (CLI _killAndRespawn footgun); preserve #3729/#3735 panic button | fix/perm-mode-switch-busy |
| C | #5606+#5607+#5608 | Dashboard UX trio: New Session Advanced layout, sidebar pairing-action clip, Control Room create-session affordance | fix/dashboard-ux-dogfooding |
| D | #5610 | Push-to-talk hold-Space in dashboard chat input (reuse voice infra; tap still types space) | feat/push-to-talk-space |

D16: paired the user's dogfooding bugs with the audit's 2 HIGH security items (fix-what-we-broke before building further). 4 parallel lanes, disjoint surfaces (crypto / session+dropdown / dashboard modals+sidebar+control-room / chat input). B/C/D all brush dashboard but different components — merge-order conflict triage at gate.

### Marathon 10 ledger (running)
- **PR #5624** (#5606+#5607+#5608 dashboard UX trio, CLOSES all 3) — review: Approve. CSS-scope regression check passed (.advanced-section + .server-discover-item scoped to their modals, no global .form-field shift); #5608 dedicated button fires byte-identical investigate payload {cwd,name,reason}, seed-context preserved end-to-end; badges now pure spans. 0 threads. CI green; merged e1041ac9f; cleaned. (Worktree-inspector hazard recurred — main checkout left on review/5624; restored + pruned review/* branches.)
- **PR #5626** (#5609 perm-mode-switch gating, CLOSES #5609) — review: Approve. Chosen design: provider-accurate warning (rejected defer-until-idle — a wedged turn never goes idle, defeating the #3729 panic button's purpose). #3735 panic-button tests unchanged 3/3; interruptsTurnOnAutoSwitch capability correct across ALL providers incl BYOK/Codex/Gemini/Docker subclasses; one server change fixes both clients (app renders warning verbatim); dashboard helper pure + matches server predicate. Stale-streamingMessageId divergence = cosmetic (confirm is advisory; server warning authoritative). 0 threads. CI green; merged fde8014bc; cleaned.
- **PR #5625** (#5610 push-to-talk hold-Space, CLOSES #5610) — review: Approve after fixing 2 REAL bugs: (1) suffix truncation data-loss (618717c5c — transcript merge dropped everything after the caret anchor; invisible for mic button which anchors at end, but PTT anchors mid-draft → silent tail deletion) + (2) mic leak on unmount-while-recording (1df13dfba — useVoiceInput re-memoizes stop on [engine] selected post-mount, empty-deps cleanup held the stale none-engine no-op). Suppress-then-reinsert disambiguation; fake timers (no real sleeps); Cmd+Space not hijacked. IME-compose-guard deferred (matches existing Enter-to-send pattern). 3 threads FIXED. CI green; merged 00b492527; cleaned.
- **PR #5627** (#5614+#5615 key-pinning hardening, CLOSES both) — review: Approve. Downgrade gate verified runs-before-keying on both paths/both clients; full matrix code+test verified incl. the critical encryption=ABSENT→REFUSE cell (uses !== 'required' not === 'none'); real-crypto handshake-e2e, not always-agree mock. Keychain exit-code mapping fail-safe (unexpected→error→don't-mint); escape hatch CHROXY_ALLOW_UNPINNED_BOOT boots pinning-off without minting. Reviewer found+fixed a REAL CI bug the impl mislabeled environmental (getTokenStatus absent test asserting unconditionally on Linux runner → 5c1a25d0d) + 4 threads. Residual follow-up noted: headless Linux secret-tool-no-backend refuses first boot. CI green; merged 755596e4e; cleaned.

**Marathon 10 complete: 4/4 merged** (#5624 UX trio, #5625 push-to-talk, #5626 perm-mode gating, #5627 key-pinning hardening). Issues closed: #5606 #5607 #5608 #5609 #5610 #5614 #5615 (7). The 2 audit-surfaced HIGH security regressions are CLOSED. NO REBUILD performed (running daemon preserved for active agent) — rebuild deferred to user.

---

## Marathon 11 — Mobile audit findings → PRs (2026-06-12)

Driven from the 2026-06-12 mobile swarm-audit (aggregate 3.6/5). Four consensus findings filed as issues #5632–#5635 and taken through implement → adversarial review → fix-cycle → confirm → squash-merge. Three of four required a real fix-cycle after review caught genuine bugs.

| PR | Issue | Finding | Review arc | Merge SHA |
|----|-------|---------|-----------|-----------|
| #5636 | #5634 | A11y: permission Approve/Deny 44pt + accessibility props (Operator C3) | APPROVE; Copilot flagged contradictory Compact/All label+selected → fixed (label reflects state, action→hint) + Cancel assertion → resolved | `933ecd11e` |
| #5637 | #5633 | Resilience: zombie-socket resume liveness + surfaced dropped/queued input (Guardian C2) | REQUEST CHANGES — Fix 1 inert (connectAuto no-op guard swallowed the reconnect); forced via `{force:true}` + behavioural negative-control test; 3 Copilot threads (queue notice routed to wrong session) → fixed via `updateSession` + action-aware copy; confirm-review APPROVE | `f9fc10b56` |
| #5638 | #5635 | Tests: encryption/identity-refusal gate + offline queue coverage (Tester C3) | APPROVE; reviewer mutation-tested 5/5 controls caught; 1 Copilot thread (spy restore) triaged FALSE POSITIVE + resolved | `c1374c5ee` |
| #5639 | #5632 | Security: reject post-handshake plaintext frames on encrypted socket, app+dashboard (Adversary F1) | REQUEST CHANGES — allow-list incomplete (plaintext `error` via raw ws.send tore down live connections); fixed server-side by routing `sendError` through encrypting transport + dropping late `auth_ok`/`key_exchange_ok`; 2 Copilot threads resolved; confirm-review APPROVE (all sendError sites forward ctx, app/dashboard guards byte-identical, Server Tests green in clean CI) | `131e68b3b` |

All four: full review pipeline clean verdict + all CI green on final head + 0 unresolved threads before squash-merge. No `--auto`/`--admin`. Branches + worktrees cleaned; `main` checkout restored each time.

### Builds
- Android preview APK (EAS `e65ec181`) built — https://expo.dev/artifacts/eas/qJos1c0g9eF1Q0DZR7u9aGk08znSpeu1DlCCHtSo-rM.apk (carries through v0.9.46 + Marathons 9/10; Marathon 11 fixes need a fresh build).
- Desktop: Marathon 9/10 rebuild + restart done mid-session; close-out rebuild for Marathon 11 in progress.

---

## Marathon 12 — OTA pipeline (2026-06-12)

| PR | Issue | What shipped | Review arc | Merge SHA |
|----|-------|-------------|-----------|-----------|
| #5641 | #5640 | EAS Update (OTA): expo-updates ~29.0.18, `runtimeVersion: fingerprint`, per-profile channels | APPROVE (reviewer ran prebuild + inspected generated plist to confirm launch is non-blocking, EXUpdatesLaunchWaitMs=0); iOS native-config follow-up filed #5642 | `57814d75e` |

After one more OTA-capable native build, JS-only changes ship via `eas update --branch preview` with no rebuild. Android ready; iOS needs native-config regen (#5642).

## Marathon 13 — Mobile security hardening (2026-06-12)

Adversary F2–F5 from the mobile audit. 4 lanes; F4 needed a fix-cycle (review caught the originWhitelist would blank Android).

| PR | Issue | What shipped | Review arc | Merge SHA |
|----|-------|-------------|-----------|-----------|
| #5648 | #5643 | F2: biometric lock engages on cold start, gates navigator mount (token not used before unlock) | APPROVE — reviewer traced no token-use-before-unlock + all lockout exits + render-latch safe | `3bf746743` |
| #5649 | #5644 | F3: encrypt at-rest AsyncStorage cache (messages/terminal/session-list) with nacl.secretbox + SecureStore key, graceful legacy migration | APPROVE — reviewer verified PRNG seeding + traced no-transient-miss-data-loss; 33 tests | `314f89d37` |
| #5650 | #5645 | F4: WebView terminal nav allow-list (exact about:blank/'' guard, blocks all real navs) | REQUEST CHANGES — review (ran RN's real whitelist filter) found `['about:*']` would blank Android; fixed (exact guard + originWhitelist reverted to `['*']`, guard is containment) + wrapper-level test; confirm APPROVE | `23356db94` |
| #5647 | #5646 | F5: gate Expo push-token log behind `__DEV__` | APPROVE | `00d51ee8d` |

All four cleared the full gate (clean verdict + CI green + 0 threads). All app-only → no desktop rebuild required.

### Builds
- APK `2b014f7c` (cut post-Marathon-11): carries M11 but NOT OTA (M12) or M13 — predates them. The first OTA-capable build (with expo-updates) must be cut from post-M12 main; after that, M13 + future JS ships OTA.

---

## Marathon 14 — Code quality (2026-06-12)

Audit C1/C4. 4 lanes on 4 different god-files (clean parallel, no conflicts). 3 of 4 needed a fix-cycle.

| PR | Issue | What shipped | Review arc | Merge SHA |
|----|-------|-------------|-----------|-----------|
| #5657 | #5652 | `sendIfOpen()` helper — 33 socket guards collapsed, 13 preserved (incl. the #5637 enqueue-on-closed input paths); connection.ts −95 LOC | APPROVE (Opus); Copilot caught a real `getStore()`-throws-if-unwired crash the Opus review missed → guard + 4 tests added | `4a3d19112` |
| #5659 | #5653 | Dispatch-migration batch: 10 file-ops/git types moved to shared table (app switch 77→67) via decline-adapter; dashboard byte-for-byte unchanged | APPROVE (Opus) — verified CI green incl. cross-workspace store-core build, decline mechanism, 10-type payload preservation, coverage-guard strengthened | `5706c2bfa` |
| #5656 | #5654 | Decompose SessionScreen → `useSessionViewState` + `SessionPanels` | REQUEST CHANGES (hook cohesion: 3 layout-chrome toggles bag-bundled) → moved out → APPROVE | `3ef794176` |
| #5658 | #5655 | Decompose SettingsScreen 1683→601 LOC → NotificationPrefs/VoiceInput/Security sections in new settings/ dir | REQUEST CHANGES (moved const broke a dashboard sync test) → fixed → APPROVE | `c8bb1196e` |

All cleared the full gate. **Process note:** on #5657 hit the merge-then-cleanup hazard ([[feedback_verify_merge_before_cleanup]]) — merge failed on a race-window Copilot thread and chained cleanup deleted the branch + closed the PR; fully recovered (re-push + reopen, head commit survived). Corrected for the rest: merge → verify MERGED → then clean, as separate steps.

---

## Marathon 15 — Dispatch-migration slice 4 (2026-06-12)

Continuation of the #5556 client-dispatch migration (after #5659's slice 3). Serial on shared files (dispatch-table.ts / both message-handlers), so one well-scoped PR, not parallel lanes. Implementation agent did honest scoping — migrated only the 2 genuinely byte-identical cases left and rejected the rest with concrete divergence evidence (the byte-identical store-mutation seam is now essentially exhausted).

| PR | Issue | What shipped | Review arc | Merge SHA |
|----|-------|-------------|-----------|-----------|
| #5662 | #5556 | `web_task_created`/`web_task_updated` → shared table; needed a new minimal `updateState(updater)` adapter primitive (read-modify-write upsert can't use `setState(patch)`). App switch 67→65, table 31→33. | APPROVE — adversarial reviewer refuted all 5 vectors (merge-not-replace Zustand semantics, byte-identical arms, table-hit short-circuit, coverage honesty, no dangling imports) w/ file:line evidence. No Copilot threads. | `fd22f1e47` |

Verified locally pre-merge: store-core tsc+vitest (1485), protocol coverage 9/9, app/dashboard tsc clean, app jest 221, dashboard vitest 343. Clean gate (review APPROVE + all CI pass + 0 threads).

**Rejected candidates (documents real divergence, future-proofing):** `checkpoint_*`/`slash_commands`/`agent_list`/`conversations_list`/`search_results` (app dual-writes useConversationStore), `provider_list` (different transform), `cost_update` (app useCostStore), `budget_*` (RN Alert), `available_models` (dashboard-only field), `web_task_error` (app SESSION_TOKEN_MISMATCH branch), `token_rotated`/`tunnel_url_changed`/`push_token_error` (platform-local). Remaining dispatch migration would need a divergence-tolerant mechanism beyond decline+updateState.

---

## Marathon 16 — Model-metadata foundation (#5631 slice 1) (2026-06-12)

User picked: foundation-first chain (#5631 → #5628 → #5630 → #5629), pricing sourced from SDK-runtime + user overlay (no hardcoded numbers). Plan agent verified the SDK's `supportedModels()` returns `{value,displayName,description}` only — NO pricing/context — so the overlay is the pricing path. Scoped PR to server-only + additive (deferred 0→null cost contract + dashboard pricing-push into #5630).

| PR | Issue | What shipped | Review arc | Merge SHA |
|----|-------|-------------|-----------|-----------|
| #5663 | #5631 | `claude-fable-5` in FALLBACK_MODELS (fixes #5628 trigger); user overlay `~/.chroxy/models.json` (short id/label/full id/context/pricing for what the SDK omits); loadCache prune unions overlay ids; defaultModelId fallback when `/^default\b/i` misses. | Opus adversarial review found 1 real regression → maintainer-decided fix → re-verified | `cc424e310` |

**Adversarial review (Opus) caught a real BYOK cost regression the impl missed:** bumping the `opus` short alias to `claude-opus-4-8` (no pricing row) made pure-BYOK "Opus" picks bill $0 (Claude SDK/CLI unaffected — they emit `total_cost_usd` directly). Asked the user (genuine fork vs their "no hardcoded pricing" choice); they chose **keep FALLBACK opus at 4-7** (priced). A focused agent reverted just the opus bump + its test fallout (event-normalizer + booted-model files fully reverted), kept fable/overlay/prune/defaultModelId-fallback. Net: zero regression, no invented pricing. Verified 407 tests pass, lints + eslint clean, `getModelPricing('opus').output===75` restored. Clean gate (review clean post-decision + all CI + 0 threads).

**Process win:** brought worktree changes onto a main-checkout branch to run the REAL test suites (worktree had no node_modules — the impl agent's tsc/symlink workaround wasn't enough to trust). Don't merge on worktree-only verification for cross-package/SDK-importing code.

**#5618 annotated:** dispatch-migration byte-identical seam is exhausted; remaining cases need a divergence-tolerant mechanism (per-platform side-effect hooks), not more mechanical migration.

### Chain status
- [x] #5631 foundation (fable + overlay + degradation) — **MERGED #5663**
- [ ] #5628 dropdown reads active session model (next)
- [ ] #5630 billing-class flag → cost labels (carries the deferred 0→null + pricing-to-dashboard)
- [ ] #5629 provider copy + docs for June 15 (deadline: 2026-06-15, 3 days)

---

## Marathon 17 — Header dropdown reflects active model (#5628) (2026-06-12)

Chain step 2. Implemented directly (small, fully-understood dashboard fix), sonnet adversarial review, gated self-merge.

| PR | Issue | What shipped | Review arc | Merge SHA |
|----|-------|-------------|-----------|-----------|
| #5664 | #5628 | Header model `<select>` resolves activeModel by id\|\|fullId (like the status bar) so a full-id model ('claude-fable-5') no longer renders as "Default (Sonnet 4.6)"; synthetic option carries the raw id for unlisted models (#5631 degradation spirit) | sonnet review SAFE (collision guard, handleModelChange no-op re-send, default-comparison normalization, common-case no-regression all clean) | `e0a4b7c3f` |

Root cause: native `<select value=fullId>` with `<option value=shortId>` finds no match → renders first option ("Default"). Status bar looked right because it dual-matches before rendering a string. Fix verified: 39 dropdown tests (4 new) + full dashboard suite 3601 pass; tsc clean. **#5628 CLOSED.**

### Chain status
- [x] #5631 foundation — MERGED #5663
- [x] #5628 dropdown — MERGED #5664
- [ ] #5630 cost labels (billing-class flag → labels; carries deferred 0→null + pricing-to-dashboard)
- [ ] #5629 provider copy + docs for June 15 (deadline 2026-06-15)

---

## Marathon 18 — Era-aware billing class: cost labels + June-15 copy (#5630 + #5629) (2026-06-12)

Chain steps 3+4, done as ONE coherent PR (the billing class is the shared seam: it's date-gated for CLI/SDK, so both the cost label AND the provider copy derive from it). Plan agent → Opus impl (worktree) → my docker correction → Opus adversarial review → review-caveat cleanup → gated self-merge. Credit-pool meter deferred to filed issue #5665.

| PR | Issues | What shipped | Review arc | Merge SHA |
|----|--------|-------------|-----------|-----------|
| #5669 | #5630, #5629 | billing class per session (api-key / subscription / programmatic-credit, era-gated for host CLI/SDK on 2026-06-15 UTC); SidebarTokenView per-class cost labels + tooltips; date-gated provider copy (server `resolveAuth` primary + dashboard fallback mirror); computePromptCostUsd 0→null per-turn honesty; docs/providers.md | Opus review SAFE-WITH-CAVEATS (docker bug caught pre-review; caveats fixed); 4 Copilot threads (docker billing comments, unused import, labels) replied+resolved | `b6c7ea8c8` |

**Two bugs caught before merge:**
1. **docker-cli/docker-sdk mis-bucketed as programmatic-credit** (caught via a failing providers.test.js auth-status assertion). They forward ANTHROPIC_API_KEY into the container with NO OAuth fallback → always api-key, era-independent. Fixed mapping + restored "Anthropic API (forwarded to container)" detail. Only the HOST claude-cli/claude-sdk (subscription OAuth) are programmatic-credit.
2. **formatCostBadgeOrNa was dead code** (Opus review): the sidebar hides priced 0-cost rows, and the always-finite cumulativeUsage accumulator already drops null per-turn costs, so "n/a" never reaches a renderer. Removed the helper; kept the 0→null per-turn honesty. #5665 can re-add with a real consumer.

**Process:** worktree had no node_modules → moved to a main-checkout branch to run the REAL dashboard/app tsc + SDK-importing server tests (the cross-package surface the worktree couldn't verify). App tsc clean confirmed the new optional auth.billingClass field is non-breaking (app copies auth verbatim, no strict Zod). Verified: protocol 233, store-core 1485, dashboard 3606, server affected 1013, app tsc clean.

### Chain status — COMPLETE
- [x] #5631 foundation — #5663
- [x] #5628 dropdown — #5664
- [x] #5630 cost labels — #5669
- [x] #5629 June-15 copy — #5669 (date-gated, ships before the deadline)
- [ ] #5665 credit-pool budget meter (deferred, scoping issue filed)

**Closing-keyword gotcha hit again ([[feedback_gh_closing_keywords_list]]):** "Closes #5630 and #5629" auto-closed only #5630; closed #5629 manually with the merge ref. Filed #5665 (credit meter, deferred).

**MODEL/BILLING CHAIN COMPLETE** — #5631→#5628→#5630→#5629 all merged & closed (#5663/#5664/#5669), credit-meter deferred to #5665. June-15 copy ships date-gated 3 days ahead of the deadline.

---

## Marathon 19 — iOS CNG migration / OTA enablement (#5642) (2026-06-13)

User asked me to fix the bare-workflow papercut hit during the OTA push (eas update rejected the runtimeVersion policy). Root cause = committed `packages/app/ios/` → EAS bare workflow → (a) iOS builds shipped OTA-disabled (stale Expo.plist) and (b) eas update needs a manual runtimeVersion string. Only CNG (gitignore ios/) fixes both.

| PR | Issue | What shipped | Review arc | Merge SHA |
|----|-------|-------------|-----------|-----------|
| #5670 | #5642 | gitignore ios/ (CNG, mirrors android/); EAS regenerates it each build with OTA enabled; PrivacyInfo via app.json `ios.privacyManifests`; bump-version.sh + ci.yml integration updates | Opus review SAFE-WITH-CAVEATS (verified ZERO native customization lost — clean prebuild byte-identical) → fixed the 1 defect + 2 CI failures it/CI surfaced | `b6e164293` |

**Verified CNG is loss-free:** clean `expo prebuild -p ios --clean` regenerates every native file byte-identical (LiveActivity Swift is plugin-shipped, not custom — `expo-live-activity` `ios-files/` match), and flips Expo.plist `EXUpdatesEnabled false→true` + runtimeVersion 0.9.46 + URL. PrivacyInfo.xcprivacy preserved via app.json config.

**Three defects caught + fixed before merge:**
1. (review) Dangling `echo "$IOS_INFO_PLIST"` in bump-version.sh summary after removing the var → `set -u` abort.
2. (CI) Same bug failed 10 Scripts Tests on Linux — but PASSED locally on macOS (bash 3.2 doesn't abort on unbound-var-in-echo the way Linux bash 5.x does). **macOS-local green ≠ Linux-CI green for `set -u` scripts.**
3. (CI) A SERVER test (`bump-version-trap-cleanup.test.js`) pinned the removed Info.plist awk block → retargeted to the Cargo.lock awk-into-place site. Non-obvious coupling: server tests audit the bump-version shell script.

### OTA pipeline now fully unblocked
- `eas update` runs with the runtimeVersion policy directly (no manual string dance).
- Next iOS EAS build will be OTA-capable (was shipping OTA-disabled).
- OTA update group `cd8d220e` already live on preview (LAN fix + accumulated app JS) for the dogfood phone.
