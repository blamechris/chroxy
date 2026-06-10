# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.45] - 2026-06-10

The notifications release. Epic #5413 lands in full: chroxy now maintains a live per-project **Discord status embed** for any Claude Code session on the machine — not just chroxy-managed ones — via the new `@chroxy/claude-hooks` package (stateless hook emitters + idempotent installer), a `POST /api/events` ingest endpoint with its own daemon-level token class, and server-side subagent counting. Alongside it: a deep **claude-tui reliability wave** (~30 fixes off the failure-readiness audit, from crash containment to PTY redaction to restart-resume), **provider expansion** (local Ollama models with auto-discovery, plus any Anthropic-compatible endpoint via config), and the desktop app finally **surfaces server-startup failures** on the loading screen instead of spinning forever.

### Added

- **Notifications epic #5413 — Discord status embed + external-session ingest (complete):**
  - **`NotificationSink` registry (#5425):** notification delivery extracted behind a sink interface; Expo push becomes `ExpoPushSink`.
  - **`DiscordWebhookSink` (#5427):** per-project status embed ported from `claude-code-notify` — ready/approval states delete + re-post (so Discord pings), routine updates edit in place; shared pipeline preferences, quiet hours, and rate limits apply. See `docs/guides/discord-notifications.md`.
  - **`POST /api/events` ingest (#5432):** external session events enter the notification pipeline, authenticated by a generated daemon-level **ingest secret** (`~/.chroxy/ingest-secret`, 0600) — a fourth token class alongside primary/pairing/hook-secret.
  - **`@chroxy/claude-hooks` (#5447):** six stateless hook emitters (<100ms, silent-fail) plus a `chroxy-hooks install|uninstall|emit` CLI that idempotently registers them in Claude Code settings; server-side per-`(source, sessionId)` subagent counting (2h TTL, LRU-bounded).
  - **Parity gaps closed before cutover (#5465):** idle prompts map to activity updates, worktree/tmp/home cwds don't mint their own project embeds, an idle-armed embed re-pings when the last subagent finishes, and a hand-deleted embed message is re-posted instead of 404-looping offline.
  - **`~/.chroxy/worktrees` remap (#5481):** sessions in chroxy's own session worktrees attribute to the parent project (recovered from the worktree `.git` gitdir), like `.claude/worktrees` agents already did.
  - **Ready-for-input notifications carry the background-task snapshot (#5436, #5452):** "ready" pushes enumerate still-running agents/shells so you know whether ready means *done*.
  - **Embed-state hygiene (#5456):** stale per-project webhook-state entries are pruned (24h default) and the footer-refresh heartbeat is bounded to live projects.
  - **Client preference surfaces:** `session_online` / `session_offline` / `session_activity` categories in mobile notification prefs (#5443) and labeled in the dashboard prefs panel (#5477).
- **Providers:**
  - **Ollama (#5418):** local models via Ollama's Anthropic-compatible API, with installed-model discovery through `GET /api/tags` (#5445).
  - **Config-driven Anthropic-compatible endpoints (#5458):** point a provider at any Anthropic-compatible server (LM Studio ≥0.4.1, llama.cpp, vLLM, OpenRouter, …) via `providers.anthropicCompatible` config — BYOK seams, per-endpoint model validation, inline secrets rejected.
- **Security & operations:**
  - **Exposure warnings (#5459):** startup log + dashboard banner when the daemon binds non-loopback or a public quick tunnel comes up.
  - **Subscription auth-failure detection (#5355):** a dead subscription surfaces immediately instead of a 90-second silent hang.
  - **Configurable background-shell hard-quiesce window (#5303)** and a **periodic worktree auto-reaper (#5363)** (no longer boot-only).
- **Desktop:**
  - **Startup failures are visible (#5494):** a dead server child (e.g. `EADDRINUSE` port conflict) turns the loading screen into a classified error + last server log lines + Retry button, with a 30s "still starting" fallback; startup health-poll races closed so a foreign server answering on the port can't mask the dead child (#5495).
  - **Editable summon hotkey (#5301)** with live re-registration.
  - **Windows MSI is Authenticode-signed** via Azure Trusted Signing (#5299).

### Fixed

- **claude-tui reliability wave** (from the failure-readiness audit, `docs/audit/`, #5306):
  - **Restart durability:** conversations persist and `--resume` across daemon restart (#5339); session state flushes on every supervised shutdown/crash path (#5340) with per-pid temp files (#5341); worktree bindings rebind after restart (#5342); retry-FRESH fallback when every `--resume` respawn dies in warmup (#5415), with PTY-tail failure classification gating eligibility (#5449).
  - **Crash containment:** daemon survives PTY socket faults (#5343), route handler throws (#5344), fire-and-forget rejections and listener/broadcast throws (#5345); supervisor crash safety + cloudflared boot-leak (#5346); bounded per-session PTY auto-respawn (#5347) under a rolling-window rate cap shared by both providers (#5411).
  - **Lifecycle:** `start()` rejects on PTY spawn failure and restore preserves history (#5350); `destroy()` escalates to SIGKILL so no orphan `claude`/tool children outlive the session (#5351); SIGHUP routes through graceful shutdown (#5406); watchdog timing moved to a monotonic clock (#5414).
  - **AskUserQuestion:** silence backstops suspend while a human is answering (#5352); per-`toolUseId` stall watchdogs (#5353); recovery arms on every respond path (#5354).
  - **Redaction:** credentials scrubbed from PTY hex/tail diagnostics (#5357); ANSI-split tokens + JWTs caught in PTY dumps (#5412); ANSI stripped from the concatenated tail, not per-chunk (#5362).
  - **Hooks/permissions:** hook sink recovers if it vanishes mid-turn (#5410); hook-sink files bounded + stale dirs boot-swept (#5359); permission hook fails closed when it can't reach the user (#5409); atomic permission-mode sidecar writes (#5407); checkpoint-restore failures preserve pending changes and orphan refs are pruned (#5408).
  - **Streams/observability:** error listeners on subprocess stdout/stderr (#5360, #5397); swallowed observability errors surfaced (#5366); WebTaskManager poll completes healthy tasks and unrefs its timer (#5364).
- **Server:** oversize request bodies get their 413 before teardown (#5442); unknown `contextWindow` no longer assumed to be 200k (#5444); dashboard auth path caches the credentials.json read (#5484); supervisor-sent notifications honor `notifications.discord` config (#5451).
- **App:** `chroxy://` QR pairing infers ws/wss by port so LAN pairing connects (#5302).
- **CI/tests:** Windows ACL tests pinned against runner-image default drift (#5478); GAP B cwd-filter tests hermetic to the OS temp dir (#5470); all Maestro flows migrated to the dev client (#5395, #5466); coverage for provider-models refresh scheduling (#5482), respawn exhaustion, Rancher config validation, and permission-guard branches (#5384–#5387, #5391).

### Changed

- **`startCliServer` decomposed** into `PushNotificationHandler`, `StartupDisplay`, `TunnelLifecycleHandler`, and `ServerOrchestrator` (#5400–#5403), with shared emergency-cleanup helpers (#5393) and a shared sleep-with-abort/backoff helper (#5405).
- **`BaseSession` opt forwarding** now goes through the `buildBaseSessionOpts` picker, single-sourced from `BASE_SESSION_OPT_KEYS`, with the CI lint inverted to catch drift (#5398); `SkillsManager` + `BackgroundShellTracker` extracted (#5399); `_intentionalStop` hoisted (#5392); setter guards centralized (#5394); session-scoped logger selection centralized (#5390).
- **Permission resolution single-sourced** across WS and hook transports (#5404); JSON responses centralized in `ws-permissions` handlers (#5389).
- **Dashboard adopts shared store-core handlers** for the remaining duplicated message types (#5487).
- **Docs:** Unattended Merge Authority codified for autonomous sessions (#5485); provider docs cover the BYOK family, DeepSeek, and Ollama in the capability matrix (#5440, #5476); claude-tui failure-readiness audit published (#5306).

## [0.9.44] - 2026-06-07

Big-feature consolidation plus a fleet-management push: the docker-byok / Task-subagent arc lands its final round of follow-ups, two cloud backends arrive (config-driven K8s/Rancher with per-tenant namespace isolation + resource quotas), the dashboard becomes a multi-host LAN client (epic #5281) able to join shared sessions on remote daemons, Control Room graduates to v2 with a navigable host/repo status section + self-hosted-runner page, a `cancel_activity` request/response chain lets the operator stop in-flight agents/subagents from the Control Room tree, and credentials.json is now encrypted at rest behind an OS-keychain data key (with a rotation path) on keychain-capable hosts — falling back to the prior 0600 plaintext store where no keychain is available. Rounded out by worktree-gc safety hardening, background-shell reap fixes, and the dashboard Provider Credentials pane.

### Added

- **LAN-client epic — desktop/dashboard as a multi-host client (#5281):** the dashboard can now connect to and join sessions on a remote chroxy daemon over the LAN, not just the local one.
  - **`--host` bind-address override (#5279):** new `bind-host.js` + config/CLI plumbing lets the daemon bind a chosen interface (e.g. a LAN IP) while preserving the loopback auth posture — auth is required for any non-loopback bind.
  - **CSP unlock for remote daemon connect (#5282):** `http-routes.js` widens the dashboard Content-Security-Policy so a dashboard served by one daemon can open a WS to a remote LAN daemon; covered by `csp-hardening.test.js`.
  - **"This machine" local entry pinned in the ServerPicker (#5283):** a stable local server row plus a server-registry store so the picker lists known daemons.
  - **Shared-session presence indicator in the sidebar footer (#5291)** — shows who else is attached to a shared session.
  - **`input_conflict` UX (#5292):** legible feedback when two clients contend for input on a shared session.
  - **Summon hotkey + "Show Chroxy" tray item (#5293)** — bring the desktop window forward quickly.
  - **mDNS LAN discovery in the ServerPicker (#5296):** discover chroxy daemons on the LAN instead of typing a URL; integration coverage for `--host` bind + mDNS suppression (#5290).
  - **Pair-by-pairing-URL (#5297):** desktops can't scan a QR, so the parity auth path is pasting the `chroxy://…?pair=<id>` URL a daemon shows.
- **`cancel_activity` request/response chain (#5269–#5286):** stop in-flight agents and subagents from the Control Room activity tree. (Background shells and individual tool calls have no per-node cancel surface; the UI marks them as not-cancellable.)
  - Capture SDK `task_id` + `cancelActivity()` for subagents (#5269 → #5273); `activity-registry` + `base-session` plumbing.
  - `cancel_activity` client→server protocol message (#5270 → #5275); server WS handler + auth gating (#5271 → #5276).
  - Cancel affordances on the Control Room activity tree (#5272 → #5278).
  - `cancelActivity` parity for `ClaudeByokSession` subagents (#5285).
  - Request/response correlation + positive ack (#5286): a cancel now round-trips a correlated acknowledgement to the dashboard rather than firing blind.
- **Control Room section — v2 (epic #5159 / #5170):** a new main-content view that surveys every managed repo (config `repos` ∪ auto-discovered git repos under a configurable root, default `~/Projects`) and renders a host/fleet status table — triage verdict (live / investigate / likely-abandoned / recent / onboarded), tree state, worktree count, open PRs, attribution, last-touched, and live-agent detection (a chroxy session bound to the repo, or a dirty-tree + recently-touched heuristic). On-demand Refresh snapshot over a new `host_status_request` / `host_status_snapshot` WS contract (#5171–#5175). Per-session activity (running agents/shells/tools) folds in as a per-repo drill-down (#5176), replacing the v1 sidebar panel. Subsequent follow-ups landed:
  - Live read-only activity tree panel + platform-agnostic activity reducer + per-session activity registry (#5161–#5169).
  - Control Room promoted to a session-independent top-level tab (#5204 → #5209), then refined (#5208 / #5198 / #5215).
  - Clickable Investigate verdict launches a pre-seeded session (#5202 → #5213); single `openCreateSession` opener (#5217 → #5222); Investigate-seed no-leak lock-in (#5218 → #5238).
  - Sort + filter the repo table (#5216 → #5225), persisted across reloads (#5226 → #5232).
  - Branch ahead/behind upstream (#5216 → #5233); per-repo PR CI + review-state rollup (#5216 → #5235); safe per-repo row actions — View PRs + Copy path (#5216 → #5236).
- **Self-hosted runner status dashboard page (#5253 → #5254):** `runner_status_request` / `runner_status_snapshot` protocol contract + survey core + a Control Room page surfacing self-hosted CI runner status.
- **Config-driven K8s / Rancher environment backend (#5144 epic):** K8s git-clone workspace strategy (#5139), per-user/project namespace isolation (#5140), CPU/mem resource quotas (#5141), namespace-level ResourceQuota / LimitRange ensure (#5150), a Rancher API adapter on top of the K8s backend (#5143), and config-driven backend selection between k8s/rancher (#5148).
- **`claude-channel` provider scaffold (#3951 spike):** spike findings (#5145), a standalone `chroxy-channel` MCP server prototype (#5146), provider registration scaffold (#5147), and provider + plugin-packaging plan docs (#5164).
- **Provider Credentials pane (#5153):** manage BYOK API keys + OAuth tokens directly from the dashboard.
- **React Native MultiQuestionForm for multi-question AskUserQuestion (#5156):** mobile parity for the multi-question approval form.
- **Audible intervention ping + all-device alert consistency (#4891 → #5157):** intervention alerts now ring audibly and stay consistent across devices.
- **Render Task subagent `agent_event` nested sub-bubbles on mobile (#5060 → #5135)** — mobile parity for the dashboard nested-child rendering from #5059.
- **Render child `permission_request` as a nested sub-bubble (#5137); relay Task subagent `permission_request` to the dashboard (#5056 → #5120)** — child agents that need MCP approval now surface in the parent's nested bubble.
- **docker-byok pool observability panel (#5128):** stats endpoint + dashboard panel (count, hit rate, recent evictions); `pool.inspect()` per-key bucket snapshots (#5052 → #5117).
- **docker-byok devcontainer/compose breadth (#5070 tail):** multi-file `dockerComposeFile` overlay merge (#5134); devcontainer `build` / `dockerFile` / `dockerComposeFile` support (#5123); stream `postCreateCommand` output to the session log (#5125); reconcile orphaned snapshots (#5075 → #5119); persist compose project ids for crash cleanup (#5081 → #5118); canonicalize (sort-keys) the devcontainer fingerprint input (#5103 → #5116).
- **Sidebar token-usage view: cache-hit ratio + per-session breakdown (#4303 → #5138):** the bottom sidebar panel's token view now surfaces a cache-hit ratio in the aggregate strip (`cacheRead / (input + cacheRead + cacheCreation)`, hidden when there's no input surface) and a per-session breakdown sorted by total tokens. Per-session rows are click-to-activate (parity with the sidebar tree) and float the active session to the top with `aria-current`. claude-tui sessions stay excluded since they expose no token counts. Pure helper `cacheHitRatio(usage)` is unit-tested independently of React.
- **`chroxy worktree gc` CLI (#5158 → #5220):** reclaim orphaned, dead-pid-locked agent worktrees (e.g. `.claude/worktrees/agent-XXX` locked by a since-exited `claude agent`), with config-discovered repo-set coverage (#5221 → #5223). Opt-in startup auto-reaper added on top (#5158 → #5224).
- **Configurable header cost badge (#5184 → #5188):** badge display chosen in Settings — provider/model (default), cost, tokens, % context used, or session-type — persisted locally.
- **Running indicator on the projects/explorer header (#5183 → #5192).**
- **Tab close UX (#5205 / #5206 → #5212):** hover/focus × on session tabs + a close-confirm dialog gated by a Settings toggle.
- **Credentials encrypted at rest (#5154 → #5227):** `credentials.json` (BYOK provider API keys + the Claude Code OAuth token) is now encrypted with a random 32-byte data key held in the OS keychain — not beside the file — so a stolen disk image / backup / errant `cat` no longer exposes plaintext. On no-keychain platforms (Windows / headless Linux) it falls back to the prior 0600 plaintext store, a deliberate, documented decision (#5228 / #5230 → #5234 / #5268).
- **`chroxy credentials rekey` (#5229 → #5239):** rotate the at-rest data key — `rotateMasterKey()` mints a fresh 32-byte key and replaces the keychain entry, with `setMasterKey()` for rollback.

### Changed

- **Top status dot now reflects Connected (tunnel), not Running (#5182 → #5193).**
- **Top-bar layout pass (#5179–#5181 / #5193 / #5197 / #5200):** the header is now two stacked rows — model/permission selectors on top, the cost/token cluster on its own row below — so the bar is never crowded and the permission selector is no longer pushed past overflow; the token usage bar sits under the token count; the model dropdown is responsive and the cost badge truncates so the token count never clips.
- **Unify token formatters into store-core (#5058 / #5094 → #5122):** dashboard token-count helpers consolidated into a single `@chroxy/store-core` source of truth.
- **Extract `sharedStreamDelta` to dedupe the app/dashboard `stream_delta` handlers (#4981 → #5129).**
- **CLI-mode result fallback surfaces error-subtype text as a response bubble (#5088 → #5109);** pinned by tests for `stream_delta` content composition (#5090 → #5107) and CLI-mode usage emission on streamed turns (#5095 → #5108).
- **Make permission `requestId`s globally unique (#5133):** prevents cross-session collisions in permission correlation.
- **`bump-version.sh` scaffolds the new CHANGELOG section below `[Unreleased]` (#5207 → #5219).**

### Fixed

- **Retry reconnects to the active server, not always local (#5289):** in multi-host mode the reconnect path now targets whichever daemon the dashboard is currently attached to instead of always falling back to localhost.
- **Background-work banner no longer sticks forever (#5177 / #5178):** completed background shells are reaped (output-file quiesce sweep) so the "Waiting on background work" indicator clears instead of hanging after the command exits (#5187 / #5190).
- **Background-shell mtime sweep is advisory, not a liveness reap (#5247 → #5263):** the no-poll sweep no longer flips `isRunning` false on a 60s-quiesced shell — a `tail -f` / dev server / file watcher that logs then waits could be misread as finished and idle-timed out.
- **Hard-quiesce reap for long-dead background shells (#5265 → #5287):** a background command that genuinely finished but is never polled via `BashOutput` no longer pins `isRunning` true forever, so a long-idle session can finally idle-time out.
- **Worktree gc must not delete worktrees holding gitignored content (#5244 → #5249):** `isClean()` now runs `git status --porcelain --ignored` so a worktree whose only untracked content is gitignored (node_modules, build/) isn't treated as clean-and-reclaimable.
- **Re-lock a worktree when its removal fails mid-reclaim (#5245 → #5252):** if `git worktree remove` fails after the dead-pid lock was dropped, the lock is restored so the entry isn't left unlocked and exposed.
- **Verify worktree prune actually reclaimed each entry (#5246 → #5256):** `applyPlan` now checks each entry instead of reporting all items ok whenever a single global `git worktree prune` succeeds — a transient stat failure no longer misclassifies a present worktree as gone.
- **Build the Control Room activity tree iteratively (#5248 → #5250):** `selectActivityTree` no longer recurses per parent→child level, so a wire-controlled deep `parentId` chain can't blow the stack.
- **Harden the activity reducer against prototype-pollution wire keys (#5168);** guard the `stream_delta` handler against malformed payloads (#5131).
- **Control Room survey probes robust to large output + many PRs (#5240 / #5241 → #5251):** `gh pr list` runs with an explicit `--limit` so gh's default 30-cap no longer silently truncates PR counts / CI rollups.
- **Bound Control Room survey probes with a timeout + make runner gh enrichment configurable (#5259 / #5260 → #5262):** a 20s timeout (+ maxBuffer) on the git/gh/launchctl/systemctl shell-outs so a wedged probe can't hang the survey and pin the per-client in-flight guard.
- **Control Room from-review follow-ups (#5210 / #5211 / #5214 → #5215);** tab visibility, header cluster overflow, model dropdown width (#5198).
- **Credential store must not unlink the live file before rename (#5243 → #5255):** the win32 write path no longer deletes `credentials.json` before moving the replacement in, closing a crash-window that could leave no credentials file at all.
- **Credential atomic-replace retries a Windows held-handle lock (#5258 → #5261):** `replaceFileAtomically` retries the rename on EPERM/EACCES/EBUSY/EEXIST (AV / Windows Search holding the target handle), with credentials-safe warn logging on the retry/refuse/restore branches (#5264 → #5266).
- **Warn when an encrypted credential resolves null on keychain-unavailable (#5242 → #5257):** `getStoredCredential` no longer silently returns null (and launches a provider unauthenticated) when the keychain data key is momentarily unavailable for a valid encrypted file.
- **Gate provider-credential writes behind the primary token (#5155 → #5267):** pairing-bound (share-a-session) tokens can no longer *overwrite* the operator's provider credentials, closing a billing-redirection / integrity / DoS vector distinct from merely using resolved credentials.
- **SIGKILL escalation + bounded buffer in streaming `execInEnvironment` (#5132).**
- **Ratchet token usage for subscription CLI sessions (#5115 → #5136).**
- **Preserve space between final Web Speech segments (#4765).**
- **Untrack accidentally-committed node_modules symlinks (#5231).**
- **Cache fallback `DockerBackend` for snapshot DELETE (#5101 → #5110);** warn when a snapshot image survives a failed `docker rmi` (#5102 → #5111).
- **Defense-in-depth: drop soiled containers in pool acquire (#5049 → #5106).**
- **Commit the autogenerated `reset_speech_permissions` Tauri capability (#5112).**

## [0.9.43] - 2026-06-03

Two-day backlog-sweep release: 52 PRs landed. The headline additions are two brand-new features — a `docker-byok` container provider that sandboxes file/Bash tool execution inside a Docker container while the model loop stays host-side, and a `Task` subagent tool in `claude-byok` that lets the model delegate work to focused child agents. The rest is the v0.9.40 / v0.9.41 / v0.9.42 follow-up tail: ResumeUnknownChip mobile parity + escalation, SESSION_NOT_FOUND consumer wiring, intervention notifications widget, voice-permission reset affordance, extended Tauri menu bar, a real Windows CI runner, the auto-tag release-PR safety net, and a stack of polish across both dashboard and store-core.

### Added

- **`docker-byok` container provider (#4053 → #5021, polished through #5036/#5041/#5047/#5050/#5051/#5063/#5070/#5089/#5091/#5096/#5097/#5099/#5100/#5092/#5098):** new provider that runs the claude-byok agent loop on the host while redirecting tool execution (Read / Write / Edit / Bash / Glob / Grep) into an isolated Docker container. Everything else — model streaming, permission gating, MCP dispatch, cost accounting — is inherited unchanged from `ClaudeByokSession`. Iterated across the sweep:
  - Initial provider (#5021): `DockerByokSession` extends `ClaudeByokSession` via a new `_dispatchBuiltinTool` seam in `byok-session.js`; long-lived `sleep infinity` container with the standard chroxy hardening (`--cap-drop ALL`, `--pids-limit`, `--security-opt no-new-privileges`, non-root user, `--memory` / `--cpus`); workspace mount with `remapToContainerPath()` that refuses absolute-path traversal AND the absolute-with-`..` escape Copilot caught (`fix(server): address docker-byok review feedback`); `TodoWrite` / `WebFetch` stay host-side; registered via `registerDockerProvider()` and skipped silently when `docker info` fails. 37 tests + lints clean.
  - Dashboard provider selector polish (#5036): `getProviderInfo()` entry for docker-byok, `PROVIDER_BILLING` copy explaining the sandboxed-tools-with-same-API-key trade-off, a `Containerized` capability badge, and a container-settings hint that switches copy based on whether Environments exist. Copilot caught two issues: the hint stayed visible after the user picked an Environment in Advanced (gated on `!environmentId`) AND the hint pointed at "below" when the Environment dropdown lives in the collapsed Advanced section.
  - Per-session container reuse + idle pool (#5041): new `DockerContainerPool` (`src/docker-byok-pool.js`) keyed by `image|cwd|memoryLimit|cpuLimit|containerUser`; FIFO bucket per key; per-entry idle timeout (default 5m); caps per-key (2) and total (8); shutdown drains via `docker rm -f`. Opt-in via `CHROXY_DOCKER_BYOK_POOL=1`. `start()` consults the pool first; verify path runs `docker exec true` and falls through to fresh launch on failure. `destroy()` releases healthy containers back to the pool. Wires shutdown into `server-cli`'s SIGTERM/SIGINT handler so pool-released containers don't outlive the server. Copilot caught `stdio: 'ignore'` being silently ignored by `execFile` — replaced with `maxBuffer: 64 * 1024`.
  - `markSoiled()` design hook for snapshot integration (#5047): `DockerContainerPool#markSoiled(id)` / `isSoiled(id)` are idempotent; `release()` short-circuits when a container is soiled and evicts inline; `DockerByokSession#markActiveContainerSoiled()` forwards the live container id to the pool. Lays the snapshot/restore foundation.
  - Max container age (#5050): `maxAgeMs` constructor opt (default 30 minutes) + `CHROXY_DOCKER_BYOK_POOL_MAX_AGE_MS` env override. `acquire()` lazily evicts over-age head entries; `release()` refuses to pool an over-age container. `createdAt` tracked in a separate Map keyed by container id so the cap measures total lifetime, not time-since-last-release. Copilot caught that `Number.isFinite(Infinity)` is false — env-Infinity opt-out now special-cased; new public `pool.forget(containerId)` for callers that acquired but won't release, preventing slow `_createdAt` Map drift.
  - Structured pool events (#5051): `DockerContainerPool` now extends `EventEmitter` and emits `pool:hit` / `pool:miss` / `pool:released` / `pool:evicted{reason: idle | over_cap | shutdown}` / `pool:shutdown{drained}`, with per-container shutdown evictions firing before the final `pool:shutdown` so a listener can drain counters in order. Listener exceptions are caught + logged so a runaway subscriber can't wedge the pool.
  - DevContainer + Compose (#5070): three new ctor opts. `useDevcontainer: true` parses `.devcontainer/devcontainer.json` (or `.devcontainer.json` sidecar) and overlays image / remoteUser / containerEnv / mounts / forwardPorts / postCreateCommand onto the bare-image launch; explicit constructor opts always win. `composeFile` + `composeService` runs `docker compose up -d` under a session-scoped project id, attaches to the named service container, and runs `docker compose down --remove-orphans` on destroy; pooling is disabled in compose mode because the pool key shape assumes single-container resource shape. Shared parser logic lives in new `devcontainer-config.js` so EnvironmentManager's persistent-environment validation applies to ad-hoc sessions too. Copilot caught: relative-cwd containment check failed without `resolve()` normalisation; `extractMountSource()` didn't detect the Windows drive-letter prefix (`C:\` → returned `C` as source); bare port strings like `"3000"` mapped to a random host port instead of `3000:3000`.
  - `postCreateCommand` opt (#5063): DevContainer-style setup hook accepting `string | string[]` (default null, joined with `&&` so every step must succeed) plus `postCreateTimeoutMs` (default 5 min). Runs as the non-root container user between container start and `super.start()`. SHA-256 marker file on `/tmp` caches the result so reused pool containers skip a setup they already ran; a changed command derives a fresh hash. Copilot caught silent drops from `.filter()` masking templating bugs — `normalizePostCreateCommand` now throws on non-string or empty-string entries inside an array. Timeout validation routes through the shared `isOperatorTimeoutInRange()` helper so typoed values above 24h fall back to the 5-min default.
  - Distinguish postCreate command vs marker-write failures (#5089): collapsed two operationally-distinct failure modes — command exit non-zero (container unsafe, tear down) vs marker touch failed (workload IS functional, only the cache stamp didn't land). Marker-write now retags as `post_create_marker_write_failed` and emits a non-fatal error event so the session stays ready. Copilot caught the gap: the container stays eligible for pool reuse and the next acquire will re-run postCreate on the same container, almost certainly re-failing the touch for the same underlying reason — `markActiveContainerSoiled()` now fires on the marker-write path so the pool evicts on release.
  - Capture postCreate stdout/stderr on failure (#5091): `docker.js#execInEnvironment` previously rejected with `new Error(stderr.trim())` and dropped stdout — but `npm install`, repo bootstrap scripts, and `apt-get install` frequently emit the actual diagnostic to stdout before exiting non-zero. Now attaches raw `stdout` / `stderr` to the rejected Error; `docker-byok-session.js` tail-caps each stream at 4 KiB so a runaway script can't push the WS frame past the encryption ceiling. The event-normalizer fix was a second commit: the error mapper had only forwarded `data.message`, silently dropping the new streams at the wire boundary; `event-normalizer.js` now gates strictly on `code === 'post_create_command_failed'` and forwards `stdout` / `stderr` with the same "present-or-absent, never present-but-empty" guard used for `attemptedResumeId`, re-capped at 8 KiB at the wire boundary (the session layer applies a tighter 4 KiB tail-cap). 9 round-trip tests pin the contract.
  - Compose API-key forwarding (#5097): bare-image mode already forwarded `ANTHROPIC_API_KEY` via `docker run --env`; compose mode now writes the key to an `os.tmpdir()` tmpfile at mode 0600 keyed by the session-scoped project id, then passes it via both `docker compose --env-file <path>` AND `docker exec --env-file <path>` on every dispatch. The key never appears in argv — `--env KEY=secret` would expose it in `ps`. Tmpfile is unlinked on destroy and on the compose start-failure path.
  - DevContainer fingerprint in pool key (#5099): `useDevcontainer: true` overlays mounts / containerEnv / forwardPorts / postCreateCommand from `.devcontainer/devcontainer.json` onto the launch — fields that didn't show up in the 5-segment pool key. If the file changed between sessions, the next acquire silently returned a container provisioned against the stale config. Fix folds a 16-hex-char SHA-1 of the fully-resolved overlay into the pool key as a trailing segment. Image and remoteUser are deliberately excluded from the fingerprint because they are already first-class segments — including them caused spurious cache misses when an explicit constructor opt overrode the devcontainer.json value. Sort-keys-before-hash deferred (#5103).
  - Env-manager devcontainer helper migration (#5096): `parseDevContainer`, `validateMounts`, `sanitizeContainerEnv`, `extractMountSource` had been extracted into `devcontainer-config.js` for `DockerByokSession` (#5070) but `EnvironmentManager` still carried four duplicate instance methods. Migrated `EnvironmentManager.create()` over and dropped the four instance methods + the now-unused `VALID_ENV_KEY_RE` constant. Behaviour-preserving for env-manager (tests use absolute `mkdtempSync()` dirs that don't hit the resolve-normalisation gap).
  - Snapshot / restore (#5100, originally #5023 / #5071, with tag-name validation #5092 and dashboard panel #5098): session-level `snapshot({ name? })` runs `docker commit` against the live container to produce a `chroxy-byok-snap:<rand>-<ts>` tag and writes metadata JSON to `~/.chroxy/snapshots/`. Auto-soils the container via #5043 so the pool evicts on release instead of handing the dirty FS to the next acquirer. Restore via `snapshotImage` constructor opt: `docker run` mounts the snapshot tag, `useradd` is skipped (already baked in), and the restored container is auto-soiled so it never returns to the pool. Snapshot metadata writes via `writeFileRestricted` at mode 0600 with parent dir 0700; embeds host paths + `sourceSessionId`. Copilot caught: pool `acquire()` on the resource-shape key would return a stock container and `_startContainer()` never ran — the snapshot tag was silently ignored AND the recycled container's unrelated writable layer leaked in. `_acquireOrStartContainer` now skips `pool.acquire()` when `_snapshotImage` is set. Tag-name validation (#5092) locks the `name` field down at the API boundary (non-string EINVAL, > 64 chars EINVAL, uppercase or charset violation EINVAL, leading `.` or `-` EINVAL, whitespace-only EINVAL) so callers can't pass values that would later become tag-grammar bugs. Dashboard `SnapshotsPanel` (#5098): new ViewMode `'snapshots'`, threaded through `types.ts` / `persistence.ts` / `useShortcutDispatch.ts`; `GET /api/snapshots` (newest-first, tolerant of partial corruption) + `DELETE /api/snapshots/:slug` (bearer-auth, charset-validated slug, best-effort `docker rmi` with `imageRemoved: false` reported when rmi fails); 29 tests across snapshots-store / http-routes / SnapshotsPanel.
- **`Task` subagent tool in `claude-byok` (#4049 → #5015, expanded through #5037/#5040/#5046/#5055/#5057/#5059/#5066/#5086):** new affordance so the model can delegate work to a focused sub-agent, matching what claude-sdk and claude-cli already expose:
  - v1 design (#5015): `Task` tool in `byok-tools.js` with description / prompt / optional `subagent_type` input schema. `_executeToolBlock` routes Task to a new `_executeTaskTool` method before MCP / built-in dispatch. Sub-agent runs as a fresh `ClaudeByokSession` with isolated `_history`, sharing the parent's Anthropic SDK client, cwd, model, and permission mode. Emits `agent_spawned` / `agent_completed` tracked in `_activeAgents` (same shape `sdk-session.js` uses). Cost + usage from the child fold into `_subagentUsageThisTurn` / `_subagentCostThisTurn`, added to `result.usage` / `result.cost` before the result event fires. Interrupt cascade: `interrupt()` iterates `_subagentSessions` and calls `child.interrupt()`; a signal-abort listener also fires for the micro-race. `destroy()` awaits `child.destroy()` on every tracked subagent. Copilot caught: ctor failure left a stranded `agent_spawned` event + populated `_activeAgents` entry — now wrapped in try/catch with a rebalanced is_error tool_result; second `signal.aborted` check immediately before `child.sendMessage` so a signal that aborts after the top-of-function check still short-circuits.
  - Cost surfacing on error-path turns (#5037 → #5046): the parent's `_executeTaskTool` accumulated child usage + cost into `_subagentUsageThisTurn` / `_subagentCostThisTurn` unconditionally, but the fold-in into turn totals only ran on the success path. On STREAM_ERROR / ABORT the accumulators were silently dropped at `_finishTurn` reset — the user was still billed but had no way to see what the failed turn cost. Fix folds subagent totals into `turnUsage` / `turnCost` inside the catch block before the error fires; extends `_emitTurnError` with an optional `partials` arg carrying `{ usage, cost }`. The error envelope schema (`ServerErrorEnvelopeSchema`) is `.passthrough()` so the extra fields propagate over the wire without a schema bump. #5046 widens the session-manager cost-gate from `event === 'result'` to `(result || error) && isFinite(cost)` so the partials feed into `cumulativeUsage` / `sessionCost` / `cost_update` / budget gates; `turnsBilled` ticks for an errored turn because the user was charged for the partial work.
  - Per-launch `permission_mode` override (#5040): Task input now accepts an optional `permission_mode` field constrained to be at-most-as-permissive as the parent (ranking: `plan < approve < acceptEdits < auto`). When omitted, child inherits parent unchanged. Validation runs before spawn: rejects unknown values, rejects anything more permissive than parent. Exhaustive 4x4 (parent, requested) matrix test. Copilot caught: rank comment incorrectly claimed plan mode "short-circuits write tools server-side" — not true for byok (it has `planMode: false` and `PermissionManager` doesn't special-case `'plan'`); restrictiveness comes from the system prompt, not server-side blocks.
  - Parent MCP fleet inheritance (#5055): v1 constructed the child with `mcpConfigPath: null` so the child saw built-in tools only. Default now shares the parent's already-running `MCPFleet` by reference — zero extra child-process spawn cost. Borrowed-fleet child sets `_ownsMcpFleet = false` so its `destroy()` drops the reference without tearing down the parent's MCP children. Model can opt out per-launch via `inherit_mcp: false`. Copilot caught: non-boolean `inherit_mcp` rejected with is_error but `agent_spawned` had already fired and `_activeAgents.set` populated the map — dashboard would show a phantom badge. Validation now runs BEFORE the emit, mirroring the `permission_mode` typecheck placement.
  - `subagent_type` profile registry (#5066): wired the previously-ignored field to a profile registry seeded with three profiles: `general-purpose` (full toolset), `code-reviewer` (Read/Grep/Glob only — no Write/Edit/Bash so review can't mutate the workspace), `research` (Read/Grep/Glob + WebFetch). Each profile carries `systemPrompt` + `toolSet` (`'all'` or a list); `_executeTaskTool` applies via `sessionPreamble` + a per-session `_allowedBuiltinToolNames` set that filters `_buildTools()`. Copilot caught: unknown `subagent_type` returned is_error rather than warning + falling back per the #5018 AC; preamble applied via direct assignment instead of routing through `setSessionPreamble` (which enforces the 4000-char `SESSION_PREAMBLE_MAX_LENGTH` cap). #5086 adds the pinning test: every profile's `systemPrompt` length must stay under `SESSION_PREAMBLE_MAX_LENGTH` so a future profile addition fails at CI rather than getting silently truncated.
  - Error-path partial cost in chips (#5057): dashboard error toast + mobile Alert had been dropping the new `partialCost` / `partialUsage` envelope fields at parse time. `handleError` now surfaces `partialCost` in its typed return so consumers don't have to reach into the untyped envelope; new shared `formatPartialCostLine` in `store-core/cost-format` renders `"This turn cost $0.087 (1.2K in · 3.4K out)"` as the single source of truth so dashboard toast sub-line and mobile Alert body can't drift. `addServerError` gains an optional `partialCostLine` arg; Toast renders it as a `<span class="toast-submsg">` with `data-testid="toast-partial-cost-{id}"`.
  - Nested sub-bubble rendering for child agent progress (#5059): #5015 wired `agent_spawned` / `agent_completed` lifecycle events but child `tool_start` / `tool_result` / `tool_input_delta` / `stream_delta` events fired silently on the child's EventEmitter — the dashboard saw the parent's tool_call bubble open and close with no progress in between. New `agent_event` channel tagged with `parentToolUseId` re-emits child wire events on the parent; nested Task is handled by forwarding the child's own `agent_event` re-tagged with the outermost parent's `toolUseId`. Protocol adds `ServerAgentEventSchema`; store-core's `handleAgentEvent` appends each child event to `ChatMessage.childAgentEvents[]` on the parent Task tool_use bubble; new `ChildAgentEventList` dashboard component reduces the flat event log into per-tool rows + concatenated assistant text, collapsed by default. Copilot caught: `agent_event` was missing from `ws-server.js`'s Server → Client doc block and `PLATFORM_SPECIFIC`, so the protocol handler-coverage CI test failed; grand-child `parentToolUseId` was being dropped despite a comment claiming preservation; `stream_delta` messageId boundary wasn't inserted into the reducer's `assistantText` so multi-round child output fused unrelated paragraphs. Mobile rendering deferred (#5060).
- **Intervention notifications widget (#4890 → #5005, polished through #5030/#5054):** Slack-style header notifications widget — a bell trigger with an unread badge and a dropdown listing every intervention alert (read + unread) so the operator gets a durable "do I have outstanding interventions to deal with?" signal instead of vanishing toasts. `SessionNotification` gains an optional `readAt` timestamp (in-memory only); two new store actions: `markSessionNotificationRead(id)` (idempotent — re-reads preserve the first acknowledge timestamp) and `markAllSessionNotificationsRead()`. `switchSession()` now marks the target session's notifications as read instead of removing them outright; `dismissSessionNotification()` still removes outright. UI: bell with unread badge capped at "99+", click row body to mark-read + switch sessions, per-row eye affordance for mark-read-without-switching, per-row × for outright dismiss, "Mark all read" for bulk acknowledge, outside-click / Escape / window-blur all dismiss. #5030 brings the widget up to the same WAI-ARIA Authoring Practices menu pattern as `HeaderOverflowMenu` (`role="menu"` on the `<ul>` with `role="menuitem"` rows, full ArrowDown/Up wrap-around, Home/End, roving tabindex, focus-on-open, focus-restore on every dismiss path, clamps `focusedIndex` when the visible row set shrinks); also replaces the U+1F514 bell and U+1F441 eye emoji glyphs with inline SVGs since the other header icons render via CSS rather than platform color-emoji fonts (inconsistent in stripped-down Tauri WKWebView profiles), and drops an undefined `--bg-quaternary` token whose fallback washed out in light themes. #5054 swaps the `permission_resolved` / `permission_expired` handlers from hard-removing matching session notifications to `.map()`-stamping `readAt = Date.now()` so the bell retains a history with the read-row treatment while the banner stack still vanishes on resolution; idempotent for already-acked rows.
- **Mobile `ResumeUnknownChip` (#4971 → #4997, expanded by #5012):** dashboard companion to #4967; the shared store-core change already preserves `attemptedResumeId` end-to-end on `ChatMessage`, only the renderer was missing on mobile. New `packages/app/src/components/ResumeUnknownChip.tsx` mirrors the dashboard chip's copy ("Previous conversation could not be resumed — starting fresh") + amber-recoverable palette; `MessageBubble` branches on `isError && message.code === 'resume_unknown'` parallel to the existing `stream_stall` branch; `attemptedResumeId` rendered as mono subtext (`Menlo` on iOS for cross-platform parity with ToolBubble / DiffViewer / MarkdownRenderer); `accessibilityRole="alert"`. Copilot caught `accessibilityElementsHidden` hiding the attempted id from screen readers. #5012 then adds a `variant: 'recoverable' | 'exhausted'` prop to both chips so the new `resume_unknown_exhausted` code (see Changed) renders distinct "auto-recovery exhausted — start a new session manually" copy.
- **Distinct `SESSION_NOT_FOUND` consumer in the dashboard (#4982 → #4994):** #4979 / v0.9.41 added the server-side structured envelope; the dashboard now forwards `attemptedSessionId` through `handleSessionError`, clears `activeSessionId` to stop the resend loop, sets `sessionNotFoundError` so `SessionNotFoundChip` renders, and surfaces the message via toast. Chip is a calm amber banner mirroring `ResumeUnknownChip`'s visual language; shows `attemptedSessionId` as mono subtext for operator correlation against `~/.chroxy/session-state.json`. `switchSession` clears the banner — picking a live session resolves it. 4 message-handler tests + 7 chip render tests; 710 store-core handler tests still pass after `attemptedSessionId` was added to the `handleSessionError` return shape.
- **`reset_speech_permissions` Tauri command + Settings affordance (#4956 → #4998):** #4954 shipped the helper-entitlement fix but macOS may have a cached TCC denial against the previous (entitlement-less) speech-helper codesign hash, so end-users installing v0.9.40+ click mic and see the same broken behaviour. New `reset_speech_permissions` Tauri command runs both `tccutil reset Microphone com.chroxy.desktop` and `tccutil reset SpeechRecognition com.chroxy.desktop` and returns a structured error on failure; surfaced in Settings → Voice Input as a "Reset now" button gated on `inTauri && isMacPlatform`. Inline status hint (idle / running / success / error) keeps feedback next to the action. Copilot caught: error string only included stderr, but a tccutil failure might write only to stdout; reset hygiene needed for the panel-scoped `speechResetStatus` / `speechResetError`; idle hint version claimed v0.9.41+ when the helper-entitlement fix shipped in v0.9.40.
- **Extended macOS menu bar (#4942 → #5007):** follow-up to #4695. Adds the remaining submenus from the original layout proposal: File (Connect to Server…, Disconnect), Chroxy (Preferences…), Shell (Start/Stop/Restart Server, Open in Finder, Open Console), View (Toggle Sidebar Cmd+B, Toggle Plan Mode Shift+Alt+P, Show QR Code Shift+Cmd+Q, Reload), Tunnel (Quick / Named / No Tunnel radios + Tunnel Settings…), Window (Bring All to Front), Help (Documentation, Report Issue, Check for Updates). Server-control items and tunnel radios call existing Rust handlers directly from `on_menu_event` without a dashboard round-trip (same pattern the tray menu uses); tunnel radios stay in lockstep with the tray via `handle_set_tunnel_mode` fanning out to a new `AppMenuItems` struct alongside `TrayMenuItems`. Dashboard-state items flow through `useTauriMenuEvents`. Copilot caught: "Bring All to Front" originally relied on `window::show_window(app)` which only targets the `main` webview — when `handle_show_qr` had opened the `qr_popup` window, it was left hidden behind other apps; now iterates `app.webview_windows()` and calls `show()` + `set_focus()` on each.
- **`new-session` row in the header overflow menu (#5062 → #5083):** the "New Session" button used to sit in the header-right zone as a standalone `.chrome-new-session-btn`, crowding the permissions / model dropdowns after #4943 / v0.9.39. Folded into the existing `⋯` overflow menu alongside Skills / Copy transcript / Settings as the FIRST row a user scanning the menu hits. `Cmd+N` shortcut hint stays in the row's `title` attribute. Cmd+N global keymap and the macOS "File → New Session" menu item are untouched.
- **Context-window usage in header status line (#5065 → #5087):** replaces the header status-line's plain text context chip with a fill bar + absolute `used / total tokens` label (e.g. `30.0k / 1M tokens`) when the active session has both raw token counts and a known model context window. Mirrors the `FooterBar`'s existing meter so the same information is available at-a-glance in both surfaces. New shared `formatTokensCompact` helper in `@chroxy/store-core` (lowercase k, whole-million M without trailing `.0`). Reuses the same colour thresholds + over-budget pulse as `FooterBar` so the two surfaces flip green → yellow → red in lockstep. Hides automatically when no model is selected. Token-formatter consolidation across the dashboard tracked in #5094.
- **Auto-tag release PRs on merge (#5000):** fires when a `chore(release): cut vX.Y.Z` commit lands on main and pushes the matching annotated tag, then explicitly dispatches `release.yml` via `gh workflow run`. Closes a real reliability gap: v0.9.13 through v0.9.19 release PRs all merged but the tags were never pushed by hand, so `release.yml` never fired and no Docker images, Tauri bundles, or GitHub Releases shipped for those versions. Guards: job-level `if` checks the commit subject starts with the release prefix; strict semver regex anchored to whitespace/EOL refuses tags for malformed subjects; defence-in-depth check that `packages/server/package.json` version matches the subject; idempotent `git ls-remote` check before tagging. `GITHUB_TOKEN`-pushed tags don't trigger downstream workflows so the explicit `gh workflow run` dispatch is required; `actions: write` granted on the tag job. Even when the tag already exists, still dispatch `release.yml` — a hand-pushed tag that never fired the release pipeline still needs it kicked off. Backfill of v0.9.13-v0.9.19 intentionally out of scope.

### Changed

- **`SUBAGENT_PROFILES.systemPrompt` length pinned under `SESSION_PREAMBLE_MAX_LENGTH` (#5073 → #5086):** the byok Task tool applies a profile to a child via `child.setSessionPreamble(profile.systemPrompt)` which DOES enforce the 4000-char cap (silently truncating an over-long profile). A future profile addition with a multi-kilobyte prompt would get silently chopped and could leak past Anthropic's token budget under combinations with other context. New pinning test asserts every profile's length stays under the cap so the invariant fails at CI rather than at runtime; JSDoc on `SUBAGENT_PROFILES` documents the bound + points at the test.
- **`resume_unknown_exhausted` terminal-escalation code (#4948 → #5004, consumer wiring in #5012):** finalises the escalation UX added in #4944. Previously the post-fallback escalation still called `_scheduleRespawn()` while emitting a "give up" toast under the recoverable `code: 'resume_unknown'`, producing two confusing UX problems: the next spawn re-confirmed via `system.init` (looked like normal recovery with no signal), and if the fresh-start spawn ALSO failed the same way, the loop continued until `_respawnCount > 5` cap with the same confusing "give up + recover" toast pair every cycle. Now on escalation: emits `error{code:'resume_unknown_exhausted'}` (distinct from the recoverable `resume_unknown`), does NOT call `_scheduleRespawn()` — the session sits down so the operator takes the next step deliberately, resets `_didFallbackFromUnknownResume` so a future explicit user-driven start can re-arm the one-shot fallback, keeps `_sessionId = null` so a manual restart mints a brand-new conversation. `event-normalizer.error` also forwards `attemptedResumeId` for `resume_unknown_exhausted`. Consumer wiring (#5012): store-core widens the `attemptedResumeId` preservation gate to accept both codes; dashboard `ResumeUnknownChip` adds a `variant: 'recoverable' | 'exhausted'` prop — the exhausted variant uses `role="alert"` (assertive) vs. the recoverable variant's `role="status"` (polite). Mobile keeps `accessibilityRole="alert"` on both (RN convention) so the variant difference rides on `accessibilityLabel` + visible text.
- **Sidebar reorder handlers wired to `registry.matchEvent` (#4972 → #4993):** until this PR the `Sidebar.tsx` keydown handler matched `event.altKey && event.key === 'ArrowUp'|'ArrowDown'` directly, so the `sidebar.reorder.up` / `sidebar.reorder.down` registry entries added in #4964 surfaced the shortcut in the cheat sheet + Settings but a user rebind in Settings did nothing at runtime; `aria-keyshortcuts` on each draggable row was likewise hardcoded so screen readers announced the default even after a rebind. `handleRepoReorderKey` / `handleSessionReorderKey` now call `shortcutRegistry.matchEvent(event, 'global')` and derive direction from the matched id; the two `aria-keyshortcuts` attributes are built from `formatBindingForDisplay(registry.getBinding(...))` so SR announcement tracks the effective binding too. Copilot caught: `aria-keyshortcuts` should emit WAI-ARIA modifier tokens (`Meta`/`Control`/`Alt`/`Shift`) per spec, not the human-facing `Cmd`/`Ctrl` — new `formatBindingForAria()` helper handles the spec-token mapping while `formatBindingForDisplay` stays for human-facing UI; dropped an unsafe `as unknown as KeyboardEvent` cast since React's `KeyboardEvent` structurally satisfies `KeyEventLike`.
- **SessionBar shortcuts marked non-rebindable in Settings (#4970 → #4992):** `SessionBar.tsx` still hardcodes the keyboard ladder (Shift+Space lift, arrows to step, Enter/Escape commit/cancel) instead of consulting `registry.matchEvent`, so a Settings rebind would silently do nothing. Cheaper Option B from #4970 (vs wiring SessionBar.tsx through the registry): `session.reorder.lift` row stays in Settings as a discoverability surface but Edit + Reset are disabled with a tooltip explaining why, and a "(not rebindable)" hint sits next to the description. Follow-up: pre-#4970 users may have rebound it; second commit allows Reset for customized entries (`entry.isCustomized` true) so stale rebinds can be reverted to the working default — Edit stays disabled so users can't get back into the stale-rebind trap.
- **Coalesce assistant text across interleaved `tool_use` blocks (#4999 → #5011, CJK extension #5033):** single chat messages were splitting into two bubbles around an interleaved tool call — the tail of a sentence ending up orphaned below the tool output (e.g. "…CSS" → Read bubble → " vars)."). The post-#4889 continuation slot was firing whenever a tool was appended after the current response slot, regardless of whether the prior bubble's text reached a sentence boundary. #4975 mitigated the narrowest case (mid-word interruption) but still produced two distinct bubbles whenever the LLM emitted a normal word boundary mid-sentence. Now gates the post-tool continuation split on prior bubble ending at a sentence boundary: last non-whitespace char in `. ! ?` or trailing `\n`. Otherwise routes the post-tool delta back to the existing slot. #4889's paragraph-break case keeps splitting; #4975's mid-word peel stays in place as defense-in-depth. Mirrored across dashboard and mobile message handlers. Copilot caught: gate only inspected the last character, so a sentence wrapped in closing punctuation/quotes (`."`, `.")`, `?)`) read as mid-sentence — now strips trailing closers (`)`, `]`, `}`, `"`, `'`, curly quotes, guillemets) before evaluating the terminator. #5033 extends both the closing-punct strip set (CJK closing brackets `」』）`) and the `endsSentence` terminator set (CJK fullwidth `．！？` and ideographic full stop `。`) so non-ASCII assistant output gets the same paragraph split across a tool boundary that ASCII output does.
- **`RESUME_UNKNOWN_STDERR_PATTERNS` hardened — `\bid\b` anchor + gerund 'resuming' (#4989):** two #4966 follow-ups landed together because they edit the same three regexes. Bare `id` matched as a substring inside common English words (`invalid`, `considered`, `avoided`, `widget`, `mid`, `kid`) — each false positive would wipe `_sessionId` mid-conversation if logged during an in-flight `--resume`, re-introducing the failure mode #4950 fixed. Anchored with `\b` in all three. Patterns also required the literal token `resume`, missing the gerund form `Error resuming session abc-123` that claude CLI may emit. Broadened to `resum(e|ing)` and extended the prefix alternation with `error` so `Error resuming session` matches the `<verb-prefix>.*resume.*session` branch — without this, the gerund-with-error-prefix form falls through to the generic `exited unexpectedly` respawn loop reported in #4929. 5 positive gerund-form + 6 substring-bleed negative tests; all 18 existing assertions still pass. Closes #4968, #4969.
- **`HeaderOverflowMenu` full WAI-ARIA keyboard nav (#4980 → #4996):** #4974 left the menu with only a subset of the WAI-ARIA Authoring Practices menu pattern (Enter/Space activate + Escape dismiss). Now satisfies the same a11y acceptance set as `SessionContextMenu` (#4248): initial focus moves into the first item on open, ArrowDown / ArrowUp with wrap-around, Home / End jump to first / last, roving tabindex (only the focused item is `tabIndex={0}`), focus returns to the trigger after Escape, outside-click dismissal AND item activation, `aria-controls` on the trigger pointing at a `useId()`-generated menu id. 10 new tests cover every checkbox in the issue's acceptance set; existing 8 mouse / Tab / Enter / Space / Escape tests still pass. Copilot caught: focus restore was duplicated across Escape / outside-click / activate branches and `window.blur` dismissal silently skipped focus restore — single cleanup effect now runs when `open` transitions true → false, mirroring `SessionContextMenu`'s unmount pattern (guarded against trigger unmount via `isConnected` check). Also clamps `focusedIndex` if items shrink while the menu is open.
- **`/compact` slash command handled in CLI provider mode (#5064 → #5084):** the CLI provider silently dropped `/compact` — the assistant event only emits `stream_start` when `fullText.length > prevLen`, and the result event only emits `stream_end` when `hasStreamStarted` was set. `/compact` returns its summary in `data.result` with no streamed assistant content, so the dashboard saw nothing — no bubble, no acknowledgement. Mirrors the SDK fallback (`sdk-session.js:801`) inside the result handler: when no stream has started and `data.result` carries non-empty text, emits a `message` of type `response` so the dashboard surfaces the compaction summary. Streamed turns are unaffected — the `!hasStreamStarted` guard prevents double-emission. 4 unit tests pin the fallback, no-double-emit guard for normal streamed turns, empty/missing-result no-op, and that the result event still fires alongside the fallback. Verifying CLI-mode usage emission carries usage on subscription path tracked in #5095.
- **`speech.rs` 3s SIGTERM fallback now logs a warning (#4990):** without this, the 3-second SIGTERM safety net in `stop()` fired silently — so #4985 (helper SIGTERM'd every session since 0.8.x, voice never actually transcribed) hid behind a "graceful" kill for months because the Tauri-side behaviour looked normal. The no-op branch (process already exited cleanly via the `stop\n` signal) stays silent — only the `WNOHANG`-says-still-alive branch logs, which is the exact path that masked the prior bug. Closes #4986.
- **Cosmetic Bring All to Front + v<N> rule documented (#4988):** documents the `v<N>` cache-key bump rule directly above the `format!()` call in `desktop/src-tauri/build.rs`. The bump rationale comment was buried 50 lines above the actual format site, so the next person editing the cache_key fields was likely to miss the convention. Inlined the rule at the bump site. Closes #4957.

### Fixed

- **Preserve session IDs across `restoreState` (#4983 → #4995):** root-cause fix for the deeper companion to #4979's visibility safety net. Until now `restoreState()` called `createSession()` with no `preserveId` — every restored session got a fresh `randomBytes(16)` id. The dashboard's persisted `activeSessionId` in localStorage then pointed at a pre-restart id that no longer existed on the daemon side, so the next user send tripped the `SESSION_NOT_FOUND` chip (#4982) on EVERY daemon restart, not just on cross-machine state imports. `createSession` now accepts an optional `preserveId` param; when the id is a valid 32-char lower-case hex string AND does not collide with a live session, it's used verbatim; otherwise the fallback to `randomBytes` keeps every existing call site (and corrupted state files) safe. `restoreState` passes `preserveId: saved.id` so same-host daemon restarts preserve the dashboard's session pointer end-to-end. The #4982 chip is now reserved for the cases preservation can't help with: cross-host state imports, manually deleted sessions, very stale state. Inverted the original #4935 test from "restored sessions get fresh IDs" to the new contract "restoreState reuses persisted session IDs so dashboard lookups survive a daemon restart"; new defense-in-depth test for malformed persisted ids (short, dashes, uppercase) falling back to `randomBytes` so corruption doesn't wedge boot.

### Tests / Internal

- **Real Windows runner coverage for `writeFileRestricted` (#4927 → #5001):** new narrow `server-tests-windows` job on `.github/workflows/ci.yml` runs the platform-test suites on `windows-latest`, plus a companion `platform-windows.test.js` covering Windows-specific edge cases that `platform.test.js`'s `_isWindowsOverride` block cannot simulate on POSIX: native `MoveFileExW` atomicity (happy-path replace + custom `tmpSuffix`), crash-safety on real `fs.renameSync` failure (EIO shim leaves original generation intact + cleans up `.tmp` sidecar), ACL inheritance from user-only parent directory (asserted via `icacls` that a freshly-written file does not grant `BUILTIN\Users` / `Everyone` / `Authenticated Users` access), same-volume invariant for `<filePath><tmpSuffix>` so cross-volume rename (`ERROR_NOT_SAME_DEVICE`) is structurally impossible. Scope is deliberately narrow — the full server suite depends on node-pty / POSIX signals / shell scripts. Second commit fixes an ESM URL scheme bug discovered on the very PR that added it: the Windows-branch tests passed raw absolute paths to `node --import` and dynamic ESM `import`, which on real Windows crashes with `ERR_UNSUPPORTED_ESM_URL_SCHEME` ("Received protocol 'c:'") because Node's ESM loader only accepts `file:` URLs; replaced cached `PLATFORM_JS` path constant with `PLATFORM_JS_URL` computed via `new URL('../src/platform.js', import.meta.url).href` and wrapped shim paths via `pathToFileURL().href`.
- **Gate `server-tests-windows` on platform-only path filter (#5002 → #5028):** the Windows runner is billed at a 5x multiplier vs `ubuntu-24.04` but covers a narrow surface (Windows-only branches of `writeFileRestricted` in `platform.js` + the `platform-windows.test.js` suite). Lightweight `changes` job (`dorny/paths-filter@v3`) classifies each PR's touched paths and gates the Windows job on `push` to main (ALWAYS run so transitive breakage from a merged PR surfaces on main) or `pull_request` only when the filter flags `packages/server/src/platform*.js`, `packages/server/tests/platform*.test.js`, or `.github/workflows/ci.yml`. Filter globs use `platform*` so a foreseeable refactor into `platform-windows.js` / `platform-posix.js` still picks up coverage. `always() &&` on the gated job's `if:` is required because `changes` is itself gated to `pull_request` and gets skipped on push events — without `always()` the default `needs:` semantics would also skip Windows on pushes to main. Second commit grants `pull-requests:read` to the changes job for `paths-filter`'s `listFiles` REST call (works for same-repo PRs today via the implicit token grant but fork PRs from external contributors will hit "Resource not accessible by integration").
- **Pin `icacls` ACE removals to well-known SIDs (#5003 → #5029):** identified during review of #5001. The Windows-only platform test suite removed group/world ACEs by their localised principal names (`Users`, `Everyone`, `Authenticated Users`) and asserted on the same lowercase substrings — both sides were locale-dependent: a future `windows-latest` image shipped in any locale other than en-US would silently no-op the removes AND trip false results on the read-back. Changed every ACE reference in the test to its well-known SID using `icacls`'s `*<SID>` prefix syntax (`*S-1-5-32-545` `BUILTIN\Users`, `*S-1-1-0` `Everyone`, `*S-1-5-11` `NT AUTHORITY\Authenticated Users`); parse the current user's SID from `whoami /user`. Three locale-orthogonal bugs caught on the second commit: CI was failing with `whoami: extra operand '/user'` because the Windows job runs under `shell: bash` (Git Bash) which ships its own Unix-style `whoami` earlier on PATH (invoke `whoami.exe` by absolute path under `%SystemRoot%\System32`); `icacls /save` writes UTF-16 LE with BOM and well-known SIDs are abbreviated (`WD`=Everyone, `AU`=Authenticated Users, `BU`=BUILTIN\Users) so the raw-SID substring assertions were vacuously true — switched to `(Get-Acl <path>).Sddl` via `powershell.exe`; substring checks (`S-1-5-11`) collided with prefixes of legitimate SIDs (`S-1-5-113`, `S-1-5-114`) — anchored on the SDDL ACE closing paren via `/;<sid>\)/`. Closes #5031, #5032.
- **Unit-test the `verify-entitlements` helper-in-app branch (#4955 → #4991):** #4954 introduced a new branch in `verify-entitlements.sh`: when given a `.app` bundle, check `Contents/Resources/speech-helper` against a helper-scoped required-keys set. All prior tests run in plist mode and never reached this branch — the new branch only fired in production at release time. Stubs `codesign` so the parent extraction returns a valid plist and helper extraction returns empty, then asserts exit code 1 (helper FAIL aggregated to EXIT_CODE) + "speech-helper has no embedded entitlements" message present. Also adds a missing-helper case asserting WARN + exit 0. 13/13 cases pass locally. Closes #4955. Second commit captures stdout and stderr to separate temp files (cases 7 and 8 had used `2>&1` which would let a regression that printed FAIL/WARN to stdout still pass the "present in stderr" assertion) and drops a line-number reference in favour of a behavioural description so the line number can drift safely.
- **`session-manager` cost-gate `result`/`error` invariant documented (#5048 → #5082):** the previous comment claimed `result` and `error` are mutually exclusive per turn, but stream-stall paths in `sdk-session._handleStreamStall` and `cli-session._emitInterruptedTurnResult` emit both for the same turn. Accounting stays safe because the synthetic result emits `cost:null` and the `Number.isFinite` predicate filters it. Reworded to make the predicate (not emit topology) the single-counting guarantor, and call out the stream-stall path so future readers don't trip over the apparent contradiction. Tighter comment citing `cli-session._handleStreamStall` directly tracked in #5085.

### Process notes

- The two big features (`docker-byok` + `Task` subagent) each took ~10 PRs across the sweep, all from-review follow-ups landing on top of an intentionally narrow v1. Each follow-up was tracked as a separate issue and cycled through `/full-review` (agent-review + Copilot + thread resolution) → `update-branch` → squash-merge. Copilot caught at least 25 distinct issues across the docker-byok arc alone — path traversal escape via absolute paths containing `..`, container user not forwarded to `docker exec`, snapshot pool acquire silently ignoring the snapshot tag, post_create_marker_write_failed leaving the container eligible for pool reuse, `agent_event` missing from `PLATFORM_SPECIFIC`, `inherit_mcp` validation firing after `agent_spawned`, plus an entire class of "Windows is not en-US" bugs in the Windows runner tests. Every catch was addressed as a `FIX` reply on the thread; zero deferrals, zero false positives in the docker-byok arc.
- Two PRs deliberately ship as wrappers around larger-than-typical changes. #5100 lands #5023 / #5071 (docker-byok snapshot/restore originally drafted on a feature branch) onto main with the Copilot follow-up commits squashed; #5070 lands DevContainer + Compose support together since the parser logic is shared.
- The auto-tag workflow (#5000) is now in production; its first real test will be this very release. The dispatch path through `gh workflow run release.yml` is the safer bet given the `GITHUB_TOKEN`-pushed-tag won't-trigger-downstream gotcha.

### Follow-up issues filed during this sweep

- #4981 — `refactor(store-core)`: dedupe `stream_delta` handler between app and dashboard.
- #5023 — `docker-byok`: snapshot/commit-based restore (closed by #5100).
- #5049 — `docker-byok pool`: defence-in-depth check against `_soiledIds` in `acquire()`.
- #5052 — `docker-byok pool`: `pool.inspect()` returning per-key bucket snapshots.
- #5053 — `docker-byok pool`: dashboard panel (count, hit rate, recent evictions).
- #5056 — byok Task: relay subagent `permission_request` to dashboard when child needs MCP approval.
- #5058 — Consolidate `formatTokenCount` / `formatTokens` into a single store-core helper.
- #5060 — Mobile app: render Task subagent `agent_event` nested sub-bubbles.
- #5061 — Task subagent: relay child `permission_request` to dashboard nested sub-bubbles.
- #5069 — `docker-byok postCreateCommand`: stream output to session log during long-running setup.
- #5075 — `docker-byok`: orphan snapshot cleanup (image tag + metadata sidecar).
- #5078 — Support devcontainer.json `build` / `dockerFile` / `dockerComposeFile` fields in docker-byok.
- #5081 — Cache compose project ids in state so `destroy()` can clean up across restarts.
- #5085 — Tighten session-manager cost-gate comment: cite `cli-session._handleStreamStall` directly.
- #5088 — cli-session: result fallback surfaces error-subtype text as response bubble.
- #5090 — cli-session-events tests: pin `stream_delta` content in the no-fallback-on-streamed-turn case.
- #5094 — Unify token formatters across dashboard (`cost-format`, `status-tooltips`, `SidebarTokenView`, `App.tsx`).
- #5095 — CLI-mode session usage emission: verify `claude -p` result events carry usage on subscription path.
- #5101 — Cache `DockerBackend` instance for snapshot DELETE when env-management is disabled.
- #5102 — Dashboard `SnapshotsPanel`: surface `imageRemoved=false` in the UI when `docker rmi` fails.
- #5103 — Sort object keys before fingerprinting devcontainer overlay (#5080 follow-up).

## [0.9.42] - 2026-06-03

Single-fix release. Voice input on macOS desktop finally produces transcripts — v0.9.40's entitlement fix was necessary but two follow-on bugs in the Swift helper kept it silent until now. No other changes.

### Fixed

- **🚨 Voice input actually transcribes on macOS desktop now (#4985):** v0.9.40's `audio-input` entitlement fix (#4954) let `speech-helper` reach `tcc_send_request_authorization()` without being killed, but two runtime bugs kept the helper from ever producing transcripts:
  - `semaphore.wait()` was nested INSIDE the `requestAuthorization` completion closure. Since `requestAuthorization` is async, the closure runs on a background queue later — but `startRecognition()` itself had no blocking call at function scope. The helper submitted the TCC request and exited cleanly in ~100ms (exit 0, zero stderr) BEFORE TCC responded, before `audioEngine.start()` ran, before the recognition task was even created. This is why the v0.9.40 entitlement verification didn't catch the regression — the helper signed correctly and the prior `exit 0 in 100ms` *looked* like clean execution.
  - Apple's `SFSpeechRecognizer.recognitionTask(with:resultHandler:)` invokes its result handler on the **main thread**. Even with the scope bug fixed, blocking main on a DispatchSemaphore prevented the handler from firing, so recognition would run forever without producing partials or finals. Switched to driving `RunLoop.main` instead — services both the async authorization completion AND Apple-framework main-thread callbacks; `teardown()` calls `CFRunLoopStop()` to break out cleanly. Copilot caught that `RunLoop.current` should be `RunLoop.main` explicitly so the loop being driven always matches the one `setDone()` stops, regardless of which thread invokes `startRecognition()` in the future (`ea6e3ba3`).
  - Dropped the unconditional `requiresOnDeviceRecognition = true`. When on-device assets aren't downloaded for the user's locale, the recognition task hangs silently with no result and no error. Letting Speech pick its source (on-device when ready, network otherwise) is reliably responsive across configurations. Note: voice audio MAY transit Apple's recognition servers for users whose on-device assets aren't installed — same behavior as Apple's first-party Dictation feature.
  - Live verification: trace logging captured `Hello` at +1.6s → `Hello world` at +2.0s → `Hello world test` at +2.8s on a manual click → speak → stop cycle, where the prior helper produced zero callbacks before dying. Live confirmed working on the installed Chroxy.app — mic icon flips, partial transcripts stream into the input box, final transcript stays when stopped.

### Follow-up issues filed during this sweep

- #4986 — `speech.rs` 3-second SIGTERM kill-fallback in `stop()` previously masked this bug (helper "exited cleanly" via SIGKILL after Tauri timed out). The fallback should log a warning when it fires, so future bugs of this shape don't slip past local testing.

## [0.9.41] - 2026-06-02

Sixth daytime sweep: three user-visible bug fixes landed in parallel. One desktop UI fix (topbar overlap from the v0.9.39 New Session button), one chat rendering fix (mid-word fragmentation around tool/skill bubbles), and one server reliability fix (silent send failures after daemon restart now surface a structured error envelope). No version bumps to dependencies, no schema migrations, no breaking changes.

### Fixed

- **Topbar overflow — tertiary icons now collapse into a `...` menu (#4974 → #4977):** the prominent `+ New Session` button introduced in v0.9.39 (#4943) overlapped the model selector dropdown and crowded the skills/copy/settings icons at typical desktop widths (≤1400px). New `HeaderOverflowMenu` component collapses skills, copy-transcript, and settings into a single `...` popover with WAI-ARIA `role="menu"` + Escape/outside-click dismiss, while `+ New Session`, the model selector, and the token-cost meter stay inline at full prominence. Capability-gated so the menu only renders items the current session supports. Copilot caught three follow-ups: focus return after menu-item activation, `waitFor` side-effect contamination in the copy-transcript test, and explicit roving-tabindex on the menu items — all addressed in `e81288e5`. 9 new tests + 2 CSS-pin tests; existing App.test.tsx tests updated to open the overflow first.
- **Chat messages no longer fragment mid-word during agent/skill invocation (#4975 → #4978):** when the assistant emitted text → tool_use → text in a single message, the dashboard chat renderer was splitting the surrounding text into separate bubbles, and — more egregiously — could split *individual words* (e.g. `Del`/`egating`) across the tool bubble whenever the LLM happened to emit a partial-word delta immediately before the tool call. Root cause: the post-#4889 continuation-split fired at the exact wire-byte offset of the tool insertion, so any subsequent text delta landed in a fresh slot. Fix: `message-handler.ts` now peels the trailing partial word from the prior slot before creating the continuation slot, so word boundaries are preserved across the tool insertion. Applied identically to `packages/dashboard` and `packages/app` for mobile parity. Copilot caught a symmetric gap — the incoming-delta head also needs the peel gate, otherwise leading-partial-word post-tool deltas could leak through (`7d12fa78`). 6 new handler tests + 1 store-core renderer-shape test pin the contract; tightened 4 existing #4889/#4922 fixtures to use sentence boundaries so they exercise the intended path, not the new peel branch.
- **Sends after daemon restart now surface a structured `SESSION_NOT_FOUND` error instead of silently disappearing (#4935 → #4979):** when the daemon restarts (Tauri bundle swap, `pkill`, crash-recover) and restores sessions from `session-state.json`, every restored session gets a fresh random ID. The dashboard's persisted `activeSessionId` in localStorage still references the old ID, so the next `input` message addresses a session the daemon doesn't know about. Pre-fix behavior: `resolveSession` returned null, `handleInput` emitted a generic `session_error` with no actionable code AND the arrival log was DEBUG-only — net result, zero `sendMessage` lines in `chroxy.log` and zero UI feedback. The dashboard reported "Connected" while sends went into a void. Fix is visibility-only in this PR: `handleInput` + `handleInterrupt` now INFO-log the stale send AND emit a structured `{type:'session_error', code:'SESSION_NOT_FOUND', attemptedSessionId, message}` envelope back to the client, so the dashboard can route the failure to an actionable affordance. Copilot caught a token-binding precedence bug — must check `client.boundSessionId !== msg.sessionId` BEFORE the session-existence lookup, otherwise a real `SESSION_TOKEN_MISMATCH` would be miscoded as `SESSION_NOT_FOUND` (`3e6f891a`). The dashboard-side consumer (clear stale ID + render picker chip) is tracked in #4982; the deeper protocol fix (preserve session IDs across `restoreState`, or remap by name) is tracked in #4983. The 1361636a-style stale-ID wedge from the original incident can no longer happen silently after this release.

### Process notes

- All three PRs landed in parallel via worktree-isolated agents, then went through `/full-review` (agent-review + Copilot + thread resolution) in parallel, then sequential `update-branch` + squash-merge. Total of 10 Copilot inline comments across the three PRs, all addressed as `FIX` with commit hashes; zero false positives, zero deferrals.
- #4979 deliberately ships visibility-only. The actual silent-drop is now AUDIBLE — the dashboard can render an error toast or picker chip on `SESSION_NOT_FOUND` — but the *occurrence* of the stale-ID condition is unchanged until #4983 lands.

### Follow-up issues filed during this sweep

- #4982 — Dashboard consumer for `SESSION_NOT_FOUND`: clear stale `activeSessionId`, surface picker chip parallel to `ResumeUnknownChip`.
- #4983 — Server: preserve session IDs across `restoreState` so dashboard reconnects don't strand on a stale `activeSessionId`. The "right" structural fix for #4935.

## [0.9.40] - 2026-06-02

Fifth daytime sweep: 11 PRs landed. One critical user-visible fix (voice input on macOS desktop, broken since 0.8.x) plus 10 follow-ups across the v0.9.39 reorder + resume-failure surfaces. No new breakages — every PR carried regression tests, and CI on every merge was a fresh run on the post-update HEAD.

### Added

- **Distinct affordance for `resume_unknown` error (#4947 → #4967):** dashboard now renders a dedicated `ResumeUnknownChip` for the v0.9.39 `error{code:'resume_unknown'}` wire signal — a one-line "Resume failed" indicator with the truncated `attemptedResumeId`, sitting in place of the generic error toast. Wire path: `protocol/schemas/server.ts` adds `attemptedResumeId` to the optional message shape; `server/event-normalizer.js` forwards it on emit; `store-core/handlers/index.ts` preserves it on `ChatMessage`; dashboard `App.tsx` routes the field into the new chip. Mobile parity tracked in #4971. Wire-boundary hardening (gate on `code === 'resume_unknown'`, trim, 256-char cap) applied identically on server emit + store-core ingest.
- **`Sidebar` reorder shortcut + handle in cheat sheet (#4941 → #4964):** the existing Alt+ArrowUp / Alt+ArrowDown reorder shortcut for sidebar repo + session rows is now surfaced in the `?` cheat sheet (new `sidebar` category) and exposed via `aria-keyshortcuts` on draggable rows. Both arms wired so users can rebind independently in Settings. Hardening: `formatBindingForDisplay` now uses a `PRETTY_KEY_NAMES` table for canonical key rendering (`arrowup → ArrowUp`), with prototype-walk safety after Copilot caught the unguarded property access. Registry entries are intentionally informational-only — Sidebar.tsx still hardcodes the keys; migration to `registry.matchEvent` tracked in #4972.
- **`SessionBar` reorder shortcut + tooltip (#4949 → #4962):** Shift+Space (lift) + Arrow Left/Right (move) + Enter/Escape (commit/cancel) reorder ladder shipped in #4945 was undiscoverable — no cheat-sheet entry, no tooltip. Now exposes `title` + full `aria-keyshortcuts="Shift+Space Arrow Left Arrow Right Enter Escape"` on draggable tabs (only when `onReorder` is wired). Required a new `sessionbar` shortcut scope — `global` would have caused the dispatcher to `preventDefault()` Shift+Space everywhere outside text inputs, breaking native text fields. Rebindability deferred to #4970.
- **Mobile Maestro flow: AskUserQuestion Other → freeform send-path (#4877 → #4960):** new `.maestro/ask-question-other-freeform.yaml` exercises tapping the synthesized `OTHER_OPTION_VALUE` sentinel → typing a freeform answer → Send, using the testIDs that landed with PR #4864. Pins the mobile parity with the dashboard's `{answer:<otherLabel>, freeformText, toolUseId}` wire shape end-to-end on a real RN runtime. Mock-server gains a `show-ask-other` trigger.
- **Mobile Maestro flow: mixed multi-question payload (#4762 → #4965):** new `.maestro/chat-multi-question.yaml` exercises the 3-question mixed wire shape (single-select with model-supplied Other + multi-select + single-select with synthetic Other). Scoped to mobile's current Q[0]-only render surface; full multi-question UI (`approval-question-1` / `approval-question-2` + summary chip) deferred to #4973 since no React Native `MultiQuestionForm` component exists yet. PR uses `Related to #4762` so the parent issue stays open until the mobile component lands.

### Changed

- **`Sidebar` reorder state refreshes on server switch (#4940 → #4959):** the per-server sidebar reorder ordering wasn't reloading when the user switched servers — switching from A to B left A's order in place. Added a single `useEffect` keyed on `activeServerId` next to the existing `tabOrder` reload, calling `setSidebarRepoOrder(loadPersistedSidebarRepoOrder())` and `setSidebarSessionOrder(loadPersistedSidebarSessionOrder())`. Race-free because production `switchServer` (`connection.ts:2463`) sets scope BEFORE `activeServerId`, so the effect reads from the new scope.
- **`SessionBar` drag-over highlight no longer flickers across inner chips (#4946 → #4961):** crossing inner chips during a session-tab drag previously fired `onDragLeave` on every child intersection, flickering the highlight. Guarded `onDragLeave` with a `relatedTarget` containment check; only clears `dragOverId` when the cursor genuinely leaves the tab. Chose the `relatedTarget`-aware approach over an enter-counter because it is stateless and adds no refs. Required a small `dispatchDragLeave` helper for vitest since `fireEvent.dragLeave` doesn't propagate `relatedTarget` in jsdom.

### Fixed

- **🚨 Voice input works on macOS desktop again (#4953 → #4954):** voice input has been broken on every shipped macOS desktop build since 0.8.x. Root cause: macOS TCC evaluates microphone permission per Mach-O binary, not per bundle. The Swift `speech-helper` subprocess was being codesigned with empty entitlements — the parent app's `com.apple.security.device.audio-input` did NOT propagate. AVAudioEngine init returned denied, the helper exited immediately, the dashboard saw `voice_stopped`, and the mic icon reverted within ~100ms. #4801 / #4812 only patched the parent `entitlements.plist` and `verify-entitlements.sh` only checked the parent `.app`, so the regression slipped past release-time verification. Fix: new `entitlements-helper.plist` with just `com.apple.security.device.audio-input`; `build.rs` codesign call adds `--entitlements <helper-plist>` (cache key gains `helper_ent_mtime` so future plist edits force a re-sign); `verify-entitlements.sh` auto-extends to also check `Contents/Resources/speech-helper` when given a `.app` bundle, so the existing `release.yml` call gains helper coverage with no workflow edit. Caught by Copilot during review: `extract_entitlements()` was wrongly cat'ing any non-`.app` regular file as raw XML, which would have cat'd the Mach-O binary; tightened to only treat `*.plist` as raw text. **Post-install user step:** macOS may cache the prior TCC denial against the helper's old codesign hash. Run `tccutil reset Microphone com.chroxy.desktop && tccutil reset SpeechRecognition com.chroxy.desktop`, or delete Chroxy from System Settings → Privacy & Security → Microphone / Speech Recognition so macOS re-prompts against the new hash.
- **Sidebar resumable rows no longer hijack the parent repo's drag (#4939 → #4958):** resumable conversation rows sit inside the outer `.sidebar-repo` treeitem which becomes `draggable=true` once `onReorderRepos` is wired. HTML5 drag-and-drop bubbles, so without an explicit guard a click-and-drag on a resumable row would start the PARENT repo's drag (wrong visual feedback, stray reorder side effects). Fix: `draggable={false}` + `onDragStart={e => e.stopPropagation()}` on `.sidebar-resumable-item` — the same child-side guard active session rows already had via `handleSessionDragStart`. Three regression tests pin the contract.
- **`/resume.*failed/i` regex tightened to require session/conversation/id context (#4950 → #4966):** the loose pattern from #4944 was matching unrelated stderr like "tool resume failed", "user wanted to resume after the failed sync", or "background resume task failed: out of memory" — falsely classifying as `resume_unknown` and wiping `_sessionId` mid-conversation. Replaced with three tightened patterns that all require both the resume verb AND a session/conversation/id keyword nearby. Negative-case test pins 8 realistic "resume…failed" lines that the old regex matched and the new patterns must NOT match. Two follow-ups from Copilot: #4968 (anchor `id` with `\b` to prevent substring bleed — `pid`, `invalid`, `widget`) and #4969 (cover `Error resuming session …` gerund form).

### Tests / Internal

- **`a11y(dashboard)`: deprecated `aria-grabbed` swapped for live-region drag announcements (#4951 → #4963):** `aria-grabbed` is deprecated in ARIA 1.1+. Removed from SessionBar draggable tabs; added a hidden `role="status"` + `aria-live="polite"` + `aria-atomic="true"` live region (`data-testid="session-bar-reorder-announcer"`) that narrates drag state changes ("Picked up …", "Over …", "Dropped … at position N of M.", "Cancelled reorder of …") from both the pointer and keyboard reorder paths. Reuses the 1-px clipped-box SR-only style pattern from `ConnectionAnnouncer`. 7 new tests; Copilot caught 4 ladder edge cases (Space-commit narration, duplicate-text re-announce, stale doc comments, position derivation).

### Process notes

- Two PRs needed manual conflict resolution to land: **#4964** (sidebar shortcut tooltip) collided with #4962 on `shortcuts/registry.ts` (both added different unions — kept `sidebar` ShortcutCategory + `sessionbar` ShortcutScope) and `shortcuts/defaults.ts` (both added entries — kept both `sidebar.reorder.up/down` and `session.reorder.lift`) and `SidebarReorder.test.tsx` (both added describe blocks — kept both `Sidebar aria-keyshortcuts` and `Sidebar resumable rows do not hijack parent repo drag`). **#4965** (Maestro multi-question) collided with #4960 on `mock-server.mjs` (both added independent triggers — kept both `show-multi-question` and `show-ask-other`) and `run-all.yaml` (Flow 19 → both runs as Flow 19 + Flow 20). Both rebased + force-pushed; CI re-ran green.
- The new `verify-entitlements.sh` helper-in-app code path is not yet covered by a unit test (tracked in #4955). The existing 9 tests still pass and the helper-check correctly fails against the currently-installed buggy `Chroxy.app`, so the runtime regression guard at `release.yml:236` is functional.

### Follow-up issues filed during this sweep

- #4955 — Unit-test the new helper-in-app branch of `verify-entitlements.sh` (synthetic `.app` fixture).
- #4956 — Surface `tccutil reset Microphone com.chroxy.desktop` affordance in Chroxy Settings → Voice Input.
- #4957 — Document the `v<N>` cache-key schema-bump rule next to `cache_key` in `build.rs`.
- #4968 — Anchor `id` with `\b` in `RESUME_UNKNOWN_STDERR_PATTERNS` to prevent substring bleed.
- #4969 — Cover `Error resuming session …` gerund form in `RESUME_UNKNOWN_STDERR_PATTERNS`.
- #4970 — Route SessionBar reorder ladder through `registry.matchEvent('sessionbar')` so the registry rebinding actually drives runtime.
- #4971 — Mobile parity: render `ResumeUnknownChip` mirror on the React Native side.
- #4972 — Route Sidebar reorder Alt+Arrow keydown through `registry.matchEvent` so the registry entry is functional, not informational-only.
- #4973 — Mobile `MultiQuestionForm` component + remaining #4762 acceptance criteria.
- #4974 — Topbar overflow: New Session button overlaps model selector + crowds skills/copy/settings icons at typical desktop widths.
- #4975 — Chat messages fragment mid-word during agent/skill invocation (text + tool_use interleaving regression).

## [0.9.39] - 2026-06-02

Fourth daytime sweep: 7 issues landed. Two new visible features (drag-to-reorder for both SessionBar tabs and Sidebar rows), one prominent New Session button + Tauri menu bar, plus four #4887 / #4889 follow-ups (mobile text-chunk mirror, resume-failure error path, auto-checkpoint UX test, resume_conversation test coverage).

### Added

- **Drag-to-reorder SessionBar tabs (#4831 → #4945):** dashboard top-row session tabs are now drag-reorderable via native HTML5 DnD (no new dependency). Order is server-scoped + persisted to localStorage. Keyboard: `Space` lifts a tab into reorder mode (per ARIA grid pattern), arrows move, `Enter` drops, `Esc` cancels. `Shift+Space` kept as alias for back-compat. Three follow-ups: #4946 (drag-over flicker), #4949 (shortcut help/tooltip), #4951 (live-region a11y).
- **Drag-to-reorder Sidebar rows (#4832 → #4938):** left-sidebar session + repo rows are now drag-reorderable. Repo order is a flat list of cwd paths; session order is keyed by repo cwd so reordering within one name-group never reshuffles another. Both server-scoped. Filter-active reorder is gated off (typing in the filter shouldn't fight the user's session order). Three follow-ups: #4939 (parent drag bubbling through nested children), #4940 (reorder refresh on server switch), #4941 (Alt+Arrow shortcut in shortcut help + `aria-keyshortcuts`).
- **Prominent "New Session" button + Tauri menu bar entry (#4695 → #4943):** dashboard header gets a top-level New Session button (sharing the existing `handleNewSession` callback). Tauri macOS menu bar gets a "File → New Session" entry wired through a Rust→JS bridge. Additional menu entries (switch session, open settings, etc.) tracked in #4942 to keep this PR scoped.
- **`resume_unknown` error code for failed `claude --resume` (#4929 → #4944):** when the spawned `claude --resume` process emits a known-failure pattern (seven stderr regexes) AND `attemptedResumeId` is set, the session surfaces a distinct `resume_unknown` error code with a one-shot fallback latch (subsequent restarts in the same wedge don't re-emit). Dashboard surfacing tracked in #4947, escalation UX in #4948, regex tightening in #4950.

### Changed

- **Mobile text-chunk continuation split mirrors dashboard #4889 (#4922 → #4937):** verbatim port of the v0.9.38 dashboard fix (single-hop `_deltaIdRemaps` + index-based scan + replay-guard) into the mobile message handler. Closes the mobile half of the text-concatenation bug.

### Tests / Internal

- **CLI session auto-checkpoint UX contract pinned (#4930 → #4934):** 271-line test suite covering the new auto-checkpoint side-effect introduced by #4928 — frequency tripwire, payload shape, restore/rewind path interaction. Describe block names both #4930 and #4928 for git-blame traceability.
- **CLI `resume_conversation` end-to-end coverage (#4931 → #4936):** 15 subtests covering the new resume_conversation path enabled by #4928 — happy path, missing prior context, malformed resume id, capability gating. Fixed a latent false-pass in `conversation-handlers.test.js` where a `cwd` validator was short-circuiting before the `createSession` spy ran (Copilot catch — pinned with explicit `callCount === 1` assertion to prevent regression).

### Process notes

- One PR (#4945) required manual rebase + conflict resolution: collided with #4938 on `dashboard/src/store/persistence.ts` (two reorder persistence keys in the same constant block) and `dashboard/src/App.tsx` (overlapping import additions). Rebased onto main, hand-merged both intents (both reorder feature sets coexist now), force-pushed, CI green on retry.
- v0.9.38 install + bundle swap exposed a real bug: sessions can wedge silently after daemon restart — sends don't reach the daemon, no Working indicator. Filed as **#4935** (high priority follow-up; not addressed in v0.9.39). Likely backpressure-eviction loop on reconnect for large-history sessions OR stale session-ID reference in the dashboard's client-side state.

### Follow-up issues filed during this sweep

- #4935 — bug(server): sessions wedge silently after daemon restart (real bug from the v0.9.38 install).
- #4939 — fix(dashboard): sidebar nested rows bubble drag events to parent rows.
- #4940 — fix(dashboard): sidebar reorder state doesn't refresh on server switch.
- #4941 — a11y(dashboard): expose `Alt+ArrowUp/Down` in shortcut help + `aria-keyshortcuts`.
- #4942 — feat(desktop): additional Tauri menu bar entries beyond "New Session".
- #4946 — fix(dashboard): SessionBar drag-over flicker when crossing inner chips.
- #4947 — feat(dashboard): render path for `resume_unknown` error code.
- #4948 — design: escalation UX after `resume_unknown` fallback.
- #4949 — feat(dashboard): expose SessionBar reorder shortcut in tooltip / shortcut help.
- #4950 — fix(server): tighten broad `/resume.*failed/i` regex in resume-failure classifier.
- #4951 — a11y(dashboard): swap deprecated `aria-grabbed` for live-region drag announcements.

## [0.9.38] - 2026-06-02

Third daytime sweep: 11 issues landed — 3 real bug fixes (CLI cold-start resume, dashboard text concatenation, TUI wire fingerprint) plus 8 polish/observability follow-ups from v0.9.37. The Windows `writeFileRestricted` atomicity gap closes here, completing the three-PR arc (#4865 atomic POSIX → #4904 caller collapse → #4925 Windows parity).

### Added

- **Wire fingerprint instrumentation for TUI submits (#4733 → #4926):** `claude-tui-session.js` emits an INFO log fingerprinting the bytes sent on each TUI submit (counts of `\s`, control chars, etc., with trailing-newline stripping to match `_writePtyTextThrottled`'s strip-then-throttle path). Gated behind `CHROXY_LOG_WIRE_FINGERPRINT=1` so it stays off in normal operation. Lays the forensic groundwork for diagnosing the "spaces stripped + composer wedge" root cause without paying log-noise overhead on every run. Regression tests pin the interior-whitespace preservation contract that was previously implicit.
- **`writeFileRestricted` Windows atomicity (#4913 → #4925):** the `isWindows` branch of `writeFileRestricted` no longer short-circuits to a direct `writeFileSync` — it now uses the same temp+rename pattern as POSIX (without the chmod 0o600 step, since Windows ACLs handle permissions differently). Completes the three-PR atomicity arc (#4865 → #4904 → #4925). Tests use a platform-mock to validate cross-platform behavior; real Windows CI coverage is tracked in #4927.

### Changed

- **`session-state-persistence.js` collapsed onto `writeFileRestricted` (#4908 → #4924):** the bespoke `.tmp` + rename layer is gone; the existing `.bak` rotation flow + `restoreState` fallback are unchanged. `_rotateToBak`'s Windows retry+restore path is preserved. A `#2909` regression block + a new `#4908` crash-safety pin keep the rotate-before-write invariant locked.
- **Mobile + dashboard `session_stopped` copy aligned to `(exit N)` (#4910 → #4915):** mobile inline strip switches from `exit N` to `(exit N)` to match dashboard's parenthetical convention from #4895. Single canonical format across both surfaces.
- **Dashboard migrated to shared `isFreeformAnswer` (#4901 → #4921):** convergence with mobile #4900. Dashboard now uses `@chroxy/store-core/freeform-answer` instead of its inline detector. Subtle robustness improvement: `Object.prototype.hasOwnProperty.call` (vs original `in`) closes a prototype-pollution edge case.
- **`writeFileRestricted` logs on cleanup-unlink failure (#4906 → #4920):** restored the observability lost in #4874/#4904 — when the `.tmp` cleanup after a rename failure itself fails (non-ENOENT), `log.warn` surfaces the orphan path. 6-line restoration of the bespoke env-manager warn that was hoisted away.
- **Pinned `chmodSync`-after-`writeFileSync` as intentional belt-and-braces (#4907 → #4917):** audit found the `chmodSync` is NOT redundant — `writeFileSync`'s `mode` arg is only honoured on file creation; for pre-existing temp paths (stale sidecar from a prior crash, or a path another local user created) `O_TRUNC` preserves looser mode bits. The follow-up landed as a comment block + regression test pinning the defensive pattern, NOT a removal. Security commentary explicitly notes `chmodSync` covers final at-rest perms but does NOT close the transient write→chmod exposure window.
- **Mobile `conversationIdRow` tap target ≥44pt (#4893 → #4916):** sibling fix to #4892. Bumps `minHeight` from 32 → 44 (preferred over `hitSlop` because the row is a styled visible target — `minHeight` keeps the hitbox aligned with the rendered bounds rather than extending into adjacent UI). Tests assert the measured tappable area.
- **Mobile `session_stopped` strip clears on reconnect (#4909 → #4918):** follow-up to #4905 — the stale `stoppedAt`/`stoppedCode` no longer persist across a disconnect/reconnect cycle. Store clears them in the `history_replay_start` handler (the reconnect handshake's first message), so the strip drops as soon as the server starts replaying a fresh session history.

### Fixed

- **🚨 CLI session resume no longer cold-starts (#4887 → #4928):** `claude --resume` was running without the prior assistant context, so the model started fresh mid-conversation. Three follow-up issues filed for downstream observability (#4929 resume-failure error surfacing, #4930 auto-checkpoint UX validation, #4931 `resume_conversation` coverage).
- **🚨 Dashboard text chunks no longer concatenate without separators (#4889 → #4919):** assistant text chunks interleaved with tool calls were running sentences and paragraphs together. Fix is in the `_deltaIdRemaps` continuation handling: single-hop remap (no chained while-loop), index-based scan (no hot-path allocation), cycle-safe by construction. Mobile parity port tracked in #4922. Closed #4923 (chain-leak detection) as superseded.

### Process notes

- One PR (#4925) required manual rebase + conflict resolution: it touched the same `writeFileRestricted` lines as #4920's cleanup-failure log. Rebased onto #4920's landed change, merged both intents (POSIX-vs-Windows branching + rich security commentary), force-pushed, CI re-ran green.

### Follow-up issues filed during this sweep

- #4922 — Port the dashboard #4889 single-hop remap fix to the mobile app handler.
- #4923 — `_deltaIdRemaps` chain cleanup (closed as superseded by #4919).
- #4927 — Real Windows CI runner coverage for `writeFileRestricted` atomicity.
- #4929 — Surface `claude --resume` failures with a distinct error path.
- #4930 — Validate CLI session auto-checkpoint UX (new side-effect of #4928).
- #4931 — Cover `resume_conversation` into a CLI session.

## [0.9.37] - 2026-06-02

Second daytime sweep: 13 from-review follow-ups from v0.9.36 landed alongside two stale prior-cycle PRs (#4655, #4682). Mostly polish + observability with two real surface additions (`session_stopped` UX on both dashboard + mobile, provider-parity `stopped` emit for SDK / Codex / Gemini).

### Added

- **Dashboard `session_stopped` toast (#4878 → #4895):** dashboard now renders a quiet `"Session stopped."` info toast on `session_stopped`, with optional `(exit N)` suffix for non-zero exit codes. Closes the dashboard half of the #4756 epic begun in v0.9.36.
- **Mobile `session_stopped` status strip (#4879 → #4905):** mobile `SessionScreen` renders an inline quiet status strip on `session_stopped` (with `exit N` for non-zero codes). Closes the mobile half of the #4756 epic. Cross-PR copy alignment with the dashboard ("(exit N)" vs "exit N") tracked in #4910.
- **Provider-parity `stopped` emit (#4881 → #4912):** SDK, Codex, and Gemini sessions now emit the `stopped` event on natural session-end paths, matching what `cli-session.js` and `claude-tui-session.js` shipped in v0.9.36 (#4868). All five providers now emit the same wire event end-to-end.
- **`isFreeformAnswer` shared typed predicate (#4875 → #4900):** extracted into `@chroxy/store-core/freeform-answer` as a typed predicate replacing the inline 5-condition shape check that diverged between mobile callsites. Hardened against prototype-pollution via `Object.prototype.hasOwnProperty.call`. Dashboard convergence to the same predicate tracked in #4901.

### Changed

- **`unknown tool_input` shapes now render as compact key:value summaries (#4655 → #4725):** the generic tool-input fallback in `tool-summary.ts` no longer leaks raw JSON for tools whose shape has none of the hardcoded PRIORITY_FIELDS (ToolSearch, MCP tools, custom user tools). The canonical bug fixture was `ToolSearch` rendering `ToolSearch {"matches":[...],"query":"select:..."` during the v0.9.24 dogfood — now renders `ToolSearch query: "select:AskUserQuestion", max_results: 5`. String values JSON-escape; key-count degradation respects the budget; JSDoc + `array` handling tightened.
- **Per-turn `sendMessage done` summary log on teardown paths (#4682 → #4723):** `_teardownTurn` and the end-to-end hard-timeout / stream-stall handlers all emit the same grep-able `sendMessage done` line with `reason=` tag and per-stage timings (`waitForPromptMs`, `writePath`, `writeMs`, etc.), so every turn ends with a uniform shape regardless of outcome — feeds the #4678 wedge instrumentation.
- **Clipboard-failure toast uses `warning` severity (#4870 → #4894):** copy-transcript toast no longer trips the red error styling for a recoverable clipboard failure. Aligns with #4148 severity convention.
- **Sidebar copy-conversation-id surfaces warning toast on failure (#4871 → #4897):** the sidebar's copy-conversation-id callsite no longer silently no-ops on Tauri/WKWebView clipboard write failure — same warning toast as the transcript path.
- **Status dots drop `role="status"` + add debounced live region (#4873 → #4899):** reconnect / session-state churn no longer floods screen readers. New `ConnectionAnnouncer` with a 1.5s debounce announces the settled phase after the storm; first-paint announcement is delayed (not skipped). Tunnel-warming banner retains `role="status"` intentionally.
- **Tightened `lastIsSingleSelect` detection (#4883 → #4902):** TUI multi-question driver now surfaces unexpected question shapes (mixed, multi-select, freeform-only, unknown) rather than treating them as single-select by accident. Drift checks promoted to a defensive `'in'` operator; settle-gap measurement now boundary-aware; one new undefined-key drift test.
- **Mobile `voiceInputMode` rehydrate gated by `isVoiceInputMode` (#4872 → #4903):** mobile `loadSavedConnection` no longer accepts stale or tampered `voiceInputMode` blobs (`'push-to-talk'`, `null`, `42`) — same guard the dashboard adopted in v0.9.36 (#4858). Per-field validation also closed a latent bug where one valid boolean key spread the entire blob into store state.
- **Collapse manual `.tmp+rename` onto `writeFileRestricted` (#4874 → #4904):** `env-manager` + `models` callers no longer reinvent the temp-write-rename pattern manually now that `writeFileRestricted` is atomic (v0.9.36, #4865). `session-state-persistence` deferred (depends on `.bak` rotation rework — #4908). Three follow-ups filed: #4906 observability, #4907 redundant chmod, #4913 Windows write-atomicity.
- **Mobile session-header badges widened to 44pt touch targets (#4876 → #4892):** badges now meet Apple HIG minimum tappable area via `hitSlop`. Sibling `conversationIdRow` tap target tracked in #4893.

### Tests / Internal

- **Pin all-single-select 2-question form byte sequence (#4882 → #4898):** test coverage for the multi-question driver's all-single-select shape (Q1 → Q2 → Submit) using distinct keystrokes to disambiguate digit-1 (option) from digit-1 (Submit). Empirical recorder pass on real TUI still outstanding — #4882 stays open.
- **Pin trailing `\r` on mixed multi-question forms (#4884 → #4911):** 7 new fixtures cover S+M, M+S+M, S+M+S shape variants + forensic Submit→PostToolUse timing log keyed by toolUseId. Extends the #4866/#4886 single-select coverage.

### Process notes

- Two PRs (#4903, #4905) required manual rebase + conflict resolution: #4903 collided with #4900's `isFreeformAnswer` import; #4905 collided with #4895's PLATFORM_SPECIFIC entry for `session_stopped` (the entry got dropped entirely since both handlers now cover it natively). Both rebases hand-resolved + force-pushed; CI green on retry.
- Two stale PRs (#4725, #4723) needed dedicated triage: #4725 had a brace mismatch in `ToolBubble.test.tsx` from a prior rebase that broke typecheck (fixed in-line); #4723 was 87 commits behind main and its summary-log tests broke after the v0.9.36 logger sweep (wrong listener signature + missing `messageId` on `_activeTurn` stub).

### Follow-up issues filed during this sweep

- #4893 — Mobile `conversationIdRow` tap target below 44pt (sibling to #4876).
- #4901 — Dashboard `isFreeformAnswer` convergence onto the shared store-core predicate.
- #4906 — Re-add cleanup-failure observability in `writeFileRestricted` (was lost in the env-manager hoist).
- #4907 — Drop redundant `chmodSync` after `writeFileSync({ mode: 0o600 })`.
- #4908 — Re-audit `session-state-persistence.js` for safe simplification once `.bak` rotation is reworked.
- #4909 — Reconnect-time stale `stoppedAt` in mobile session-stopped strip.
- #4910 — Align mobile + dashboard `session_stopped` copy (`(exit N)` vs `exit N`).
- #4913 — Make `writeFileRestricted` atomic on Windows too (the `isWindows` branch in `platform.js` short-circuits to a direct `writeFileSync` with no temp+rename).

## [0.9.36] - 2026-06-02

Backlog-sweep release: 16 from-review issues landed in a single overnight marathon, plus one cross-PR fix-CI commit (#4886) when #4867's settle delay broke #4866's freshly-merged arrow-nav tests. All sourced from prior agent-review deferrals (#4823 / v0.9.34 / v0.9.35 follow-ups).

### Added

- **>9-option AskUserQuestion native drive (#4848 → #4866):** single-question and multi-question paths with `idx >= 9` now navigate via arrow-key sequence (`\x1b[?2004l` + N× `\x1b[B` + `\r`) instead of teardown-with-error. Multi-select still bails with `ASK_USER_QUESTION_TOO_MANY_OPTIONS` (deliberate scope per #4848). Arrow-nav byte sequence is conservative — empirical recorder verification deferred per the PR body; revisit if user reports misfires.
- **Wire `stopped` event end-to-end (#4756 → #4868):** `CliSession.emit('stopped')` (added in #4750) now propagates through `SessionManager._wireSessionEvents` → `ws-forwarding` → `event-normalizer` → `ServerSessionStoppedSchema` → wire `{type: 'session_stopped', sessionId?, code?}`. Client UX surfacing deferred to per-platform follow-ups (#4878 dashboard, #4879 mobile).
- **Prune stale device-preferences entries on startup (#4849 → #4863):** `~/.chroxy/device-preferences.json` now drops entries whose `activeSessionId` no longer exists (after `restoreState` lands), so the file doesn't accumulate stale device→session refs.
- **`isVoiceInputMode` runtime type-guard helper (#4853 → #4858):** new exported guard in `@chroxy/store-core/types`. Migrated dashboard `connection.ts:805` rehydrate path + `SettingsPanel` inline literal. Mobile rehydrate has the same latent bug — tracked in #4872.
- **Mobile single-question Other/freeform parity (#4755 → #4864):** mobile `useUserQuestion` now supports the `{otherLabel, freeformText}` answer shape, matching dashboard #4651. Wire payload: `{answer: <otherLabel>, freeformText: <typed text>}`.
- **Mobile multi-question intervention counter (#4764 → #4862):** new tappable header badge in `SettingsBar` showing intervention count, opens a newest-first sheet. Touch target sweep across all header badges deferred (#4876).
- **Mobile `sendUserQuestionResponse` per-question Record support (#4761 → #4859):** widened to accept `string | Record<string, string | string[]> | { otherLabel: string; freeformText: string }`. Three shapes covered: legacy single-answer, multi-question form, Other/freeform.
- **`end`-handler `inFlightRef` gate (#4851 → #4855):** defence-in-depth for the #4826 abort-end async race. End-handler continuous re-arm now requires `inFlightRef.current` true, so a queued `end` event after `abort()` can't re-arm a torn-down session.

### Changed

- **Multi-question all-single-select form submit (#4635 → #4867):** added 150ms settle + defensive trailing `\r` after the last-question single-select auto-advance so the Submit screen reliably commits. Empirical recorder verification of the all-single-select shape deferred (#4882, #4883, #4884).
- **Second-wave `loggerForSession` migration sweep (#4828 → #4869):** 50+ post-session-init log call sites in `claude-tui-session.js` / `sdk-session.js` / `cli-session.js` / 4 handler files migrated to session-scoped loggers. Cached `this._log` in sdk/cli sessions for early-path safety. Added 5 lint fixture tests + tightened the lint script.
- **Removed `VoiceInputMode` re-export shims (#4852 → #4856):** all callers now import directly from `@chroxy/store-core` (no migration needed — confirmed via caller audit). Hooks `useSpeechRecognition.ts` + `useVoiceInput.ts` drop their `export type { VoiceInputMode }` lines.

### Fixed

- **🚨 Hide AskUserQuestion content until permission granted (#4685 → #4860):** dashboard rendered question prompt + options before user clicked Allow. Now `QuestionPrompt` accepts `pendingPermission` prop and shows a placeholder; `App.tsx` derives the gate from `resolvedPermissions + messages`. Deny correctly keeps the gate up.
- **`writeFileRestricted` is now atomic (#4850 → #4865):** `connection.json` + `device-preferences.json` writes go through write-temp + rename so a killed writer can't leave a half-written file. 0o600 mode preserved by rename. Subprocess-based test exercises the simulated-crash invariant.
- **Header buttons in desktop dashboard now expose both `title` and `aria-label` (#4630 → #4861):** audited App header + FooterBar + SessionBar; paired both attributes on 9 controls that were missing one half. 13 new tests pin the contract.
- **Copy-transcript clipboard failure now surfaces a toast in Tauri (#4629 → #4857):** the underlying clipboard helper was already Tauri-aware (#4676); this PR ships the remaining AC — an `addServerError` toast when the helper reports failure instead of silently no-op. Sibling sidebar callsite has the same gap, tracked in #4871.
- **`ctx.currentToolUseId` aligned with synthesized fallback `toolId` (#4778 → #4885):** when upstream events omit `content_block.id`, the synthesized id (`msg-N-tool`) now also writes to `ctx.currentToolUseId` (cli path) and `_activeAgents` key (sdk path), so downstream `tool_result` events correlate.

### Internal (CI hotfix)

- **#4886 (no issue) — cross-PR test breakage:** #4867's 150ms settle + trailing `\r` broke #4866's arrow-nav tests (12-option waited 100ms, both expected arrays omitted the `\r`). Fix bumps waits to 300ms and adds the trailer to expected. Caught after merge; main was red for ~20 minutes.

### Follow-up issues filed during this marathon

- #4870 — Clipboard-failure toast should use `'warning'` severity per #4148 convention.
- #4871 — Sidebar `copyToClipboard` callsite still silently no-ops on Tauri/WKWebView failure.
- #4872 — Mobile app rehydrate has the same latent `VoiceInputMode` validation gap #4853 closed on dashboard.
- #4873 — Header status-dot `role="status"` live-region polish (cosmetic).
- #4874 — Audit three `writeFileRestricted` callers (models / env-mgr / session-state-persistence) for now-redundant double `.tmp+rename`.
- #4875 — Factor `isFreeformAnswer` into a shared typed predicate.
- #4876 — Mobile session-header badges below 44pt touch target.
- #4877 — Maestro flow for Other → freeform answer (third AC of #4755).
- #4878 — Dashboard quiet "Session stopped." toast on `session_stopped` event.
- #4879 — Mobile app quiet status confirmation on `session_stopped` event.
- #4881 — Provider parity: SDK / Codex / Gemini sessions should also emit `stopped`.
- #4882 — Empirically re-record all-single-select multi-question form bytes.
- #4883 — Tighten `lastIsSingleSelect` detection to surface unexpected question shapes.
- #4884 — Live-verify trailing `\r` on mixed multi-question forms.

## [0.9.35] - 2026-06-02

Bug-fix release driven by a live two-session reproduction: clicking a large-history CLI session tab in the dashboard reliably triggered a "Reconnecting…" loop and bounced the user back to the first session, making the offending session unreachable. Diagnosis traced this to a P0 trap composed of two server bugs (#4833 backpressure-eviction during chunked history replay + #4835 active-session-reset on every reconnect) plus a long-tail of voice-input + question-flow + docker auth polish from prior audits.

### Added

- **Per-device active-session persistence (#4835 → #4847):** `~/.chroxy/device-preferences.json` records the last `activeSessionId` per `deviceId`. On reconnect, `sendPostAuthInfo` restores the persisted session instead of falling back to `defaultSessionId || firstSessionId`. Boundary cases: `boundSessionId` clients still win their fail-closed path; if the persisted session was destroyed, falls back to `firstSessionId` without erroring; multi-device users keep independent active sessions. File is `0600`. Pruning of stale entries tracked in #4849; atomic writes tracked in #4850.
- **Bearer-token authority threat model doc (#4830 → #4839):** `docs/security/bearer-token-authority.md` formalises trust boundaries, token lifecycle, paired vs bound vs unbound clients, and TLS-via-Cloudflare-tunnel posture. Linked from CLAUDE.md.
- **`useDebouncedSetter` hook (#4739 → #4842):** new shared hook in `packages/dashboard/src/hooks/`. Migrated `SettingsPanel` preamble + `QuietHoursEditor` (net −92 lines in SettingsPanel.tsx). Includes regression fixes for asymmetric-equals field-clobber on own-echo and optimistic-flush on save.

### Changed

- **`VoiceInputMode` consolidated in `@chroxy/store-core` (#4825 → #4841):** single canonical declaration in `packages/store-core/src/types.ts`. Mobile `useSpeechRecognition.ts` + dashboard `useVoiceInput.ts` re-export for back-compat. Exhaustive `Record<VoiceInputMode, true>` guard in `SettingsPanel` so new modes light up a type error instead of silently falling through. Shim removal tracked in #4852; runtime type-guard helper tracked in #4853.
- **`SpeechModule.start()` options extracted into a single helper (#4827 → #4837):** `buildStartOptions(lang)` in `useSpeechRecognition.ts`. Both fresh-start and continuous-restart paths now route through it — drift between sites is structurally impossible.
- **Removed fake-coverage ChatMessage markdown overflow tests (#4803, audit P3.3):** the `describe('long markdown content (#4757)')` block in `packages/dashboard/src/components/ChatMessage.test.tsx` was structural-only — every assertion (`code.textContent`, `inlineCodes.length`, "doesn't throw") passed on the pre-PR commit, so removing the CSS fix in `components.css` (`max-width: 100%`, `min-width: 0`, `overflow-wrap: anywhere`) would not fail any test. jsdom doesn't measure layout, so unit tests cannot verify wrapping. The block is deleted with a comment pointing at the CSS rules; #4757 remains manually verified per release. A real visual-regression harness (Playwright screenshot of a narrow viewport with a 220-char fenced line) is tracked as a future enhancement.

### Fixed

- **🚨 P0 — dashboard "Reconnecting…" loop on tab switch (#4833 → #4845):** `replayHistory` chunked by message count (20), not bytes. A single chunk with fat `tool_result` payloads (file reads, diffs, long shell output) could push `bufferedAmount` past the 1 MB eviction threshold in `ws-client-sender.js`, triggering `ws.close(4008)` and an immediate reconnect. With #4835 still active, this created an unbreakable trap for large-history sessions. Fix adds `scheduleAfterDrain()` + mid-chunk early-break at 256 KB to both `replayHistory` and `flushPostAuthQueue`.
- **🚨 P0 — active session resets on every reconnect (#4835 → #4847):** see "Added" above. Compounds #4833: every eviction would bounce the dashboard back to `firstSessionId`, and clicking the original session re-triggered the eviction. Net effect: large-history sessions were unreachable from the dashboard. Now persisted per-device.
- **Backpressure eviction logged + metric-incremented N times per single close (#4834 → #4843):** `ws.close()` is async, so subsequent sends in the same synchronous chain re-tripped the eviction check. Added sticky `client._evicted` flag in both `ws-client-sender.js` (post-send path) and `ws-broadcaster.js` (`_sendOneWithBackpressure`). Single close = single log + single metric increment.
- **`useSpeechRecognition.startListening` now tears down a prior session (#4826 → #4838):** mirrors the #4789 stop-path teardown so calling `start()` while a session is mid-flight aborts the prior recogniser before starting fresh. Adds `inFlightRef` to track in-flight state synchronously (avoids the React-state race the old code had). Async-abort end-event race defence-in-depth tracked in #4851.
- **`isRecognizing` no longer flickers on soft-error restart in continuous mode (#4829 → #4836):** soft errors (`no-speech`, `network`, `speech-timeout`) in continuous mode used to flip `isRecognizing` false then immediately back to true on the auto-restart, causing a brief UI blip. Now gated on continuous-mode + soft-error: leave `isRecognizing` true across the restart, mirroring the dashboard's `useVoiceInput.onerror` behaviour. Hard errors still flip false.
- **Docker provider `PROVIDER_CREDENTIAL_MISSING` hint is now container-aware (#4780 → #4844):** previously, when a docker-based provider hit a credential-missing error, it inherited the host-CLI's "run `claude login`" guidance — useless from inside a container. `DockerSession` + `DockerSdkSession` now override `static preflight()` to drop `CLAUDE_CODE_OAUTH_TOKEN` from `envVars` (it isn't forwarded by `_startContainer` anyway) and surface guidance for setting `ANTHROPIC_API_KEY` (or mounting credentials) so the message matches the deployment context. Non-container providers continue to use the host hint unchanged.
- **Mic toggle in dashboard SettingsPanel — clearer labels + a11y (#4796 → #4840):** `aria-describedby` links the mode picker to its hint row, and the hint copy now quotes the dropdown labels verbatim instead of inventing "Continuous mode" / "Silence mode" shorthand. (The bounce-back-on-click symptom was actually fixed back in #4789; this PR ships the remaining clarity ACs and adds two regression tests.)
- **Single-question `AskUserQuestion` no longer silently drops with 10+ options (#4746 → #4846):** parity with the #4625 multi-question fix. The single-question path now teardown with `ASK_USER_QUESTION_TOO_MANY_OPTIONS` at `idx >= 9` instead of silently picking the wrong (or no) option. Native >9-option support tracked in #4848.

## [0.9.34] - 2026-06-02

P0 hotfix release closing the four highest-severity findings from the v0.9.33 8-agent swarm-audit (`docs/audit-results/code-quality-v0.9.33/`). Two are real cross-session security exposures introduced by the bound-mobile pairing model (log fan-out leaks PTY contents + tool-use IDs to any paired client; unbound clients can hijack another session's pending AskUserQuestion using leaked IDs). Two are correctness regressions from the v0.9.33 work itself (voice-input unmount race introduced by #4786 continuous mode; `streamStallTimeoutMs` per-provider override silently dropped by Codex/Gemini middle-layer destructures — exactly the `feedback_jsonl_subprocess_middle_layer` trap pattern, landing for the 3rd time despite a memory note).

### Fixed

- **Scope `log_entry` broadcasts to unbound clients only (#4787 / #4793, audit P0.1, SECURITY):** `_logListener` was broadcasting unscoped log entries — those without `entry.sessionId` — to every authenticated WS client via `_broadcast`. Across the server, ~113 of 114 `createLogger` call sites never used `.withSession(sid)`, so practically every server-side log line was multicast. Leaked content included 1 KB PTY tail hex dumps per turn, prompt sizes, toolUseIds for every AskUserQuestion answer, and attachment names — to mobile devices paired into single per-task sessions. Fix routes unscoped log entries only to clients whose `boundSessionId == null` (operator dashboards), closing the leak for bound clients. The durable Option B fix (`loggerForSession` factory + lint rule across all 114 sites) is tracked separately as #4792.
- **Require unbound clients to be subscribed before routing `user_question_response` (#4788 / #4794, audit P0.2, SECURITY):** `handleUserQuestionResponse` early-returned only for bound clients. For unbound clients, an answer with a known `toolUseId` was routed to whichever session owned the ID — with no check the client was viewing or subscribed to that session. Combined with the log leak (#4787), a hostile or operator-typo'd unbound client could hijack another session's pending AskUserQuestion. Fix adds a `subscribedSessionIds.has(questionSessionId) || activeSessionId === questionSessionId` guard for unbound clients mirroring `_broadcastToSession`'s filter, AND auto-subscribes recipients at `questionSessionMap.set` time via a new `WsServer._registerQuestionRoute` helper so the legitimate "view A → switch to B → answer A" flow keeps working after the guard lands.
- **Close voice input unmount race + dual-recognition window (#4789 / #4791, audit P0.3):** `useVoiceInput`'s unmount effect called `rec.abort()` without first signalling user-stop, so the spec-mandated `onend` re-armed `recognition.start()` on a torn-down React owner — leaving a runaway recogniser holding the mic with no UI to stop it. `start()` had the same shape: aborting a prior recognition while a new one was being constructed could leave both recognising the same mic. Fix detaches handlers (`onresult`/`onerror`/`onend`/`onstart`) before `abort()` on both paths — the `userStoppedRef` flip alone was insufficient because the ref races against `start()`'s own reset. Bonus: `restartCountRef` now only resets on `onresult` with non-empty transcript text, closing a wedged-backend loop that bypassed `MAX_CONTINUOUS_RESTARTS=5`.
- **Forward `streamStallTimeoutMs` through provider middle layers (#4790 / #4795, audit P0.4):** PR #4745 wired a per-provider stall override through `session-manager`, but `JsonlSubprocessSession`, `CodexSession`, and `GeminiSession` constructors each destructured a fixed key list that dropped `streamStallTimeoutMs` before calling `super()`. Feature was DOA for Codex and Gemini — the exact two providers the PR's motivation cited. The existing `session-manager.test.js` test missed it because it used `CapturingProvider` (no middle layer); new integration tests instantiate real `CodexSession` / `GeminiSession` / `JsonlSubprocessSession` subclasses to assert the field reaches `BaseSession`. This is the `feedback_jsonl_subprocess_middle_layer` trap pattern landing again; a static lint rule to prevent the next instance is tracked as #4797.

## [0.9.33] - 2026-06-01

Major drain on the `from-review` backlog plus a DRY/SOLID sweep. Two marathon rounds landed 27 PRs across the multi-question / AskUserQuestion surface (server form-driver, dashboard chips, store-core dispatch), per-session settings hardening, and a structural refactor pass that shrunk providers.js from 808→334 LOC and lifted shared store-core dispatch out of duplicated mobile/dashboard handlers. Two latent bugs were caught inside the refactor work: the mobile auth_ok parser was silently dropping `streamStallTimeoutMs`, and the WS broadcaster's session/client_joined paths were bypassing backpressure metrics.

### Added

- **SDK / BYOK end-to-end multi-question AskUserQuestion support (#4731 / #4763):** schema accepts `string | string[]` values; PermissionManager normalizes both shapes (plus legacy JSON-stringified arrays) to the SDK's canonical comma-separated format; dashboard renders MultiQuestionForm for non-TUI providers. 4 wedge shapes (mixed-type, all-single, all-multi, with-Other) pinned by 8 new server tests.
- **Per-question array answer wire format (#4735 / #4760):** widens `UserQuestionResponseSchema.answers` to `Record<string, string | string[]>`; dashboard MultiQuestionForm emits native arrays for multi-select instead of JSON-stringifying; provider gating via `allowMultiQuestion` opt-in (TUI / CLI still go through permission-hook).
- **Single-question "Other" / freeform answer support (#4651 / #4753):** two-stage server PTY write (Other digit → 150ms settle → freeform text + Enter); dashboard emits `{otherLabel, freeformText}` payload.
- **Surface multi-question AskUserQuestion denials end-to-end (#4653 / #4758):** server emits `multi_question_intervention`; store-core normalises into a deduped `SessionIntervention[]` ring; dashboard renders FooterBar counter chip + InterventionsPanel + one-time system message.
- **Pre-first-output silence watchdog for claude TUI sessions (#4732 / #4749):** arms a separate `FIRST_OUTPUT_TIMEOUT_MS` at `writePtyText` completion. Fixes the live failure where a claude TUI subprocess hung 3+ minutes after spawn with `consumed=0 stopFound=no` and no STREAM_STALL ever firing.
- **Dedicated dashboard chip for `ASK_USER_QUESTION_STALL` errors (#4615 / #4744):** one-tap Retry affordance + pending-prompt suppression, mirroring the StreamStallChip pattern.
- **Per-provider StreamStallChip copy + view-logs affordance (#4603 / #4740):** headline prefix per provider.
- **Surface `ASK_USER_QUESTION_TOO_MANY_OPTIONS` for picks at index >=9 (#4625 / #4741):** previously silently defaulted to option 1; now fires full turn teardown via a shared `_teardownAskUserQuestion` helper.
- **Per-provider `streamStallTimeoutMs` config (#4601 / #4745):** operators can override recovery window per provider id; default behavior unchanged when omitted.
- **Multi-client broadcast coverage for per-session settings (#4663 / #4743):** handler-level (server) + receive-side store-mutation (dashboard) for prompt_evaluator, chroxy_context_hint, session_preamble; 24 new tests.
- **Tauri updater latest.json now merges per-platform fragments (#3809 / #4736):** `scripts/merge-updater-feeds.mjs` + release.yml step combines macOS and Windows feed entries into one cross-platform auto-updater feed.

### Changed

- **providers.js shrunk 808→334 LOC via per-provider `static resolveAuth()` dispatch (#4769 / #4777, OCP):** OAuth probes and credential-file cache extracted to `auth-probes.js`; byte-identical behaviour across 83 provider/auth tests.
- **Extracted `ClaudeStreamParser` (#4768 / #4774, DRY):** wire-format parsing now shared between `CliSession` and `SdkSession`; 19 new boundary tests + 1 regression test on top of 294 existing tests.
- **Unified `auth_ok` wire parser in @chroxy/store-core (#4766 / #4781, DRY):** `handleAuthOk` + `parseConnectedClients` migrated app + dashboard onto shared dispatch. **Fixed latent mobile bug:** `streamStallTimeoutMs` was being silently dropped on the mobile side.
- **Centralized `session_list` dispatch in store-core (#4767 / #4782, DRY):** extracted `buildSessionListPatches` + `cumulativeUsageEquals` + `chunkSubscribeSessionIds`; migrated both consumers.
- **Moved `getWsCloseMessage` + `getHealthCheckErrorMessage` to @chroxy/store-core (#4771 / #4779, DRY):** dashboard now surfaces close-code-specific copy on socket.onclose and uses the richer health-check error split.
- **Extracted `useShortcutDispatch` + `useChatMessages` from App.tsx (#4770 / #4776, SRP):** App.tsx 2454→2231 LOC. Stale `useGlobalShortcuts` deleted. 36 new boundary tests.
- **Extracted `_sendOneWithBackpressure` helper on WsBroadcaster (#4772 / #4775, DRY):** unified 3 copy-pasted backpressure loops. **Fixed latent observability bug:** session/client_joined broadcasts silently bypassed backpressure metrics.
- **Extracted `sendSessionError` / `resolveSessionOrError` / `requireSessionMethod` helpers from handlers (#4773 / #4783, DRY):** 8 resolve sites + 6 capability gates + ~24 inline envelopes collapsed.
- **Extracted per-session-setting registry (#4664 / #4751, DRY):** collapsed the 5-site boilerplate that promptEvaluator → chroxyContextHint → sessionPreamble had each hand-written; migrated three existing knobs onto it.
- **Surgical AskUserQuestion watchdog teardown (#4691 / #4752):** `_onAskUserQuestionStall` now calls `_clearPendingAnswerByToolUseId` so the watchdog only drops the timed-out tool's entry, not every sibling. Other teardown sites keep all-or-nothing semantics.

### Fixed

- **Chat markdown overflows window — code blocks + inline code break wrapping (#4757 / #4759):** `pre` blocks now `max-width: 100%` + `overflow-x: auto`; inline `code` gets `overflow-wrap: anywhere`; chat message bubble gets `min-width: 0` to allow flex shrink.
- **Dashboard scroll respects user-initiated scroll-up when AskUserQuestion visible (#4652 / #4737):** add `overscroll-behavior: contain` + 60vh cap on multi-question form so chat history scrolls past the form.
- **Working banner sync to server `isBusy` across tab swaps (#4639 / #4742):** session_list seed/resync + new `session_activity` handler + switchSession seed.
- **Distinguish intentional SIGINT from child crash in `cli-session.js` (#4602 / #4750):** `_intentionalStop` flag suppresses respawn + emits quiet `stopped` event for user-triggered Stop.
- **Preamble debounce cancel on session switch + multi-client conflict banner (#4662 / #4738):** mirrors QuietHoursEditor #4570 pattern.
- **`scripts/tui-form-recorder` flushes JSONL before `process.exit` (#4729 / #4747):** extracted `flushAndExit` helper waits for stream finish before exiting; added `recordingClosed` guard against ERR_STREAM_WRITE_AFTER_END.
- **Widen `user_question_response.answers` to `Record<string, string | string[]>` (#4621 / #4748):** MultiQuestionForm ships native arrays instead of JSON-stringifying; legacy shape still accepted for back-compat.
- **CI: Expo Doctor allowlist extended (#4730):** RN directory metadata + Metro config + duplicate-deps categories now skipped (Expo published patch updates mid-marathon broke every post-merge CI rerun).

### Investigated

- **MCP elicitation shim spike (#4734 / #4754):** research doc + spike for Approach 3 (bypass TUI AskUserQuestion via MCP elicitation). Recommendation: **DEFER** until either Anthropic ships a preferred-tool override or claude TUI form-widget drift makes the keystroke driver materially worse than steering risk.

## [0.9.32] - 2026-06-01

Test-coverage push closing the gaps identified in the 2026-05-31 testing audit. The v0.9.x prompt-delivery wedge fixes (#4668/#4679/#4687/#4648/#4669) were already pinned server-side; this release locks in the surfaces that still had no regression coverage — mobile-side approval flows, the desktop Tauri command surface, the CLI command layer, and the SDK/CLI session persistence roundtrip.

### Added

- **Pin #4689 synthesized toolUseId edge case for PostToolUse cleanup (#4703):** new regression test in `claude-tui-session.test.js` that arms a pending entry via PreToolUse with no `tool_use_id` (forces `_emitToolHookEvent` to synthesize one), then asserts PostToolUse with the same synthesized id clears both the `_pendingUserAnswers` Map entry and the `askuserquestion-active` lock dir. Reverting the #4689 fix at line 1438 of `claude-tui-session.js` fails the test.
- **Maestro E2E coverage for plan-mode approval flow (#4704):** `plan-approval.yaml` (approve path) and `plan-approval-deny.yaml` (Give Feedback path) wired to a new `show-plan-approval` mock-server trigger that emits the production `plan_ready` envelope. testIDs added to `PlanApprovalCard` in `ChatView.tsx` (`plan-approval-card`, `plan-content`, `plan-approve-button`, `plan-deny-button`).
- **Tauri command integration test harness (#4705):** new `packages/desktop/src-tauri/tests/command_integration.rs` with 46 integration tests covering all 21 registered Tauri commands beyond the existing `command_drift.rs` name-sync check. Includes a `save_setup_config` → `get_setup_state` roundtrip pinning the first-run wizard contract.
- **Maestro E2E for terminal view + reconnect-after-tunnel-drop (#4706):** `terminal-view.yaml` exercises the Terminal mode toggle + xterm WebView mount via a new `show-terminal` mock-server trigger. `reconnect.yaml` simulates a tunnel drop via `simulate-disconnect` (now using `ws.terminate()`, see Fixed below) and verifies the reconnect banner + spinner appear and clear.
- **Maestro E2E for AskUserQuestion approve/deny (#4697 / #4707):** `ask-user-question.yaml` (approve), `ask-user-question-deny.yaml` (deny), and `ask-user-question-multi.yaml` (4-question form per #4604 Chunk B). Pins the mobile-side approval round-trip — the exact surface where the v0.9.x prompt-delivery wedges manifested but where mobile E2E had zero coverage until now. testIDs added to `MessageBubble.tsx` (`approval-card-<id>`, `approval-question-<index>`, `approval-button-<value>`).
- **SDK/CLI session-state persistence roundtrip coverage (#4700 / #4708):** every test in `sdk-session.test.js` and `cli-session.test.js` now uses a per-test temp `stateFilePath` (mirroring `session-manager.test.js`), and 8 new roundtrip tests pin the contract: happy-path metadata equality, corrupt-state graceful null, mismatched-id ignored, and Map serialization (the `[...map.entries()]` workaround that #4687 introduced for `_pendingUserAnswers`).
- **E2E coverage for CLI commands (#4699 / #4709):** 30 tests across all 12 CLI command modules under `packages/server/tests/cli/`, with a new reusable `spawn-cli.js` helper that isolates HOME + `CHROXY_CONFIG_DIR` per spawn so tests never touch real `~/.chroxy/`. Random high-port allocation (40000–60000) avoids collisions with the dev daemon on 8765.

### Changed

- Added a small `RNActivityIndicator` to the reconnect banner in `SessionScreen.tsx` so the spinner is visible during tunnel-drop recovery (part of #4706 — wrapped in the existing flex row, no layout side effects).
- Flipped 7 internal-crate modules in `packages/desktop/src-tauri/src/` from `private` to `pub` so they're callable from the new Tauri command integration test harness (part of #4705). No external API surface impact — `command_drift.rs` continues to pass unchanged.

### Fixed

- **Mock-server reconnect simulation: `ws.terminate()` instead of `ws.close(1006, ...)` (#4706):** RFC 6455 reserves close code 1006 — it cannot be sent in a Close frame. The `ws` library throws on the attempt, which the `try/catch` was swallowing, leaving the socket open and the reconnect flow hanging. `ws.terminate()` does an abrupt TCP teardown which clients observe as a local 1006 — exactly the shape of a real tunnel drop.

## [0.9.31] - 2026-05-31

Phase 3 of `docs/investigations/prompt-delivery-wedge.md` — targeted fix for #4668 using the diagnosis produced by v0.9.30's instrumentation. When claude TUI emits parallel `AskUserQuestion` tool_use blocks in one assistant turn (which it does post-#4648 multi-question deny), the pre-fix single-field `_pendingUserAnswer` was overwritten by each new tool_use → the user's answer to question 1 routed to question 4's slot → the keystroke landed in a TUI form bound to the wrong toolUseId → PostToolUse never fired → 30s watchdog tore the turn down → dashboard showed "Couldn't deliver your answers". Same opaque symptom we had been chasing under #4678 for weeks, completely different root cause.

### Fixed

- **Route AskUserQuestion answers by toolUseId (#4668, #4687):** `_pendingUserAnswer` (single field) → `_pendingUserAnswers` (Map keyed by toolUseId). Sibling pending answers from other tool_uses in the same turn now survive when one completes — previously a PostToolUse for `tool_A` cleared the pending entry for `tool_B` too. `respondToQuestion(text, answersMap, toolUseId?)` routes the dashboard's answer to the right Map entry; an answer for an unknown / stale toolUseId is logged and dropped rather than written into whatever form happens to be currently rendered. A back-compat getter/setter pair preserves the pre-fix field name so legacy callers and the 6 turn-teardown sites that write `= null` keep working unchanged. PostToolUse cleanup now uses the resolved local `toolUseId` (which may be a synthesized id for older claude builds / MCP tools that don't set `payload.tool_use_id`), so those entries no longer leak in the Map. The dashboard sends `msg.toolUseId` in `user_question_response`; `handlers/input-handlers.js` plumbs it through as the third arg.
- **Clean `askuserquestion-active` sibling lock on every turn-teardown path (#4668, #4687):** the permission-hook.sh's PostToolUse `tee | grep | rm` cleanup only runs on the happy path. When the turn tore down for ANY other reason (watchdog fire, stream stall, hard timeout, interrupt, PTY exit mid-turn, destroy), the lock #4669 created leaked into the next turn and tripped the sibling-deny check. New `_clearAskUserQuestionLock()` helper called from all 6 teardown sites; cheap idempotent rm.
- **Diagnostic: log PTY output tail before answer keystroke (#4668, #4687):** `respondToQuestion` now emits `_outputTailHexDump()` just before writing the answer. The wedge symptom v0.9.30 diagnosed had chroxy writing 1 byte and TUI going silent — without the trailing render bytes at write-time we couldn't tell whether the form was actually ready to receive a digit. Single-keystroke wedges almost always come from a form misalignment that's visible in the tail. Follow-up #4693 will rate-limit this for multi-answer turns if log volume becomes a concern.
- **Silent-fallback warn when dashboard omits toolUseId with N>1 pending (#4688, #4687):** the back-compat fallback path (no toolUseId → most-recent entry) is correct for single-pending cases but can misroute when multiple AskUserQuestion calls are pending. New `log.warn` makes this case greppable. Doesn't change behaviour — older dashboards that haven't been updated keep working, but the wedge symptom now produces a precise log line.

## [0.9.30] - 2026-05-31

Phase 1 of `docs/investigations/prompt-delivery-wedge.md` — the multi-session-restore wedge (chroxy logs `stream_start` then nothing for minutes) has been chased across 20+ PRs without isolating which stage of `sendMessage` actually stalls. This release adds pure-instrumentation timing logs at every stage so the next live repro produces a single grep-able trail pinpointing the wedge stage. Zero behaviour change; v0.9.31 will ship a targeted fix once the next repro is captured.

### Added

- **Per-stage timing logs for prompt delivery (#4681):** `claude-tui-session.js` now logs (a) `sendMessage start` on entry with sessionId/byte-count, (b) `waitForPrompt` exit with elapsedMs + `sawStatus` + `ready`, (c) `writePtyText` exit with path (paste/bulk/throttled) + bytes + elapsedMs + completed, (d) `hookPoll heartbeat` every 5s of silent waiting with sink-file count + actual `stopFound` state, (e) `hookPoll exit` capturing iters/consumed/abort/ptyExited/stillBusy, (f) `sendMessage done` summary via `_logSendMessageSummary` called from both the success path and `_finishTurnError` so every turn ends with the same shape regardless of outcome. New `HOOK_HEARTBEAT_MS=5000` static. ws-client-sender backpressure warn now includes the `message?.type` so we can correlate a warn at restore-time with which broadcast tipped the buffer. The companion investigation tracker doc (`docs/investigations/prompt-delivery-wedge.md`) captures the 4-wave lineage of prior PRs, the ranked wedge-point candidates from the code-trace audit, and the three-phase plan this release opens. Follow-up #4682 will extend the per-turn summary to the `_handleStreamStall` / `_handleHardTimeout` / spawn-onExit teardown paths.

## [0.9.29] - 2026-05-31

Hot-fix for the v0.9.28 dogfood: multi-line dashboard prompts (anything with an embedded newline from Shift+Enter in the composer) silently wedged claude TUI's input box. The TUI v2.1.x composer treats raw `\n` as "insert newline in multi-line composition" with no way to break out via a subsequent `\r` — the prompt appeared in the input but never submitted, leaving the dashboard's "Working…" indicator running against a TUI doing nothing. This blocked end-to-end testing of the v0.9.28 multi-question fixes because the test prompts themselves were multi-line.

### Fixed

- **Multi-line prompts delivered via single bracketed paste (#4678, #4679):** `_writePtyTextThrottled` in `claude-tui-session.js` now detects newlines in incoming text and bypasses the per-char throttle in favor of a single atomic write wrapping the body in CSI bracketed-paste markers (`\x1b[200~ ... \x1b[201~\r`). Order-sensitive sanitization strips embedded `\x1b[201~` end-markers BEFORE the trailing-newline strip so attacker- or user-injected paste terminators can't truncate the body and re-expose hidden trailing newlines. Single-line prompts continue through the existing paste-detector-aware throttle path unchanged. Pinned by 8 new tests in `claude-tui-session-paste-heuristic.test.js` covering byte sequence, CRLF normalization, trailing-newline strip, 201~ strip ordering, empty-body abort guard, abort-during-write, single-line regression, and the composite case where 201~ markers hide a trailing newline.

## [0.9.28] - 2026-05-31

Three follow-up fixes from the v0.9.27 dogfood: the multi-question dashboard form no longer renders for tool_uses that the permission hook will deny, the desktop Copy transcript actually puts text on the OS clipboard, and the require-review-before-merge hook resolves regardless of the bash cwd. The two dashboard fixes together stop the misroute path where users would submit the dead multi-question form and have all four answers typed into Q1's slot in claude TUI.

### Fixed

- **Suppress multi-question AskUserQuestion form in dashboard (#4666, #4675):** `QuestionPrompt.tsx` now renders a non-interactive `MultiQuestionDeferredNotice` ("Claude tried to ask N questions at once. Waiting for it to retry one at a time…") when `questions.length > 1`, instead of the combined form whose Submit button was dead under the #4648 hook deny. Removes the misroute path that fed all four answers into the first question's slot via `_pendingUserAnswer`. `MultiQuestionForm` is retained (exported, with re-enable comment) for #4668's long-term Map-keyed refactor.
- **Desktop Copy transcript actually writes to the OS clipboard (#4673, #4676):** new `packages/dashboard/src/utils/clipboard.ts` helper prefers the Tauri clipboard-manager plugin (already wired in `Cargo.toml` and `capabilities/default.json`) when running under `isTauri()`, falls back to `navigator.clipboard.writeText` for the browser dashboard. The previous `navigator.clipboard.writeText` path resolved successfully on Tauri 2's WKWebView without actually writing — the check-mark fired but the OS clipboard was empty. `handleCopyTranscript` and the sidebar Copy-path / Copy-Conversation-ID actions now only flip success state when the helper returns `true`, and the Tauri-reject path no longer falls through to the broken `navigator` call.
- **Require-review-before-merge hook resolves from any cwd (#4674):** `.claude/settings.json` switched the PreToolUse Bash hook from `bash scripts/require-review-before-merge.sh` (cwd-relative — silently broken when agents ran tests from `packages/dashboard/`) to `bash "$CLAUDE_PROJECT_DIR/scripts/require-review-before-merge.sh"`. Before this fix, the merge gate was silently bypassed on any `gh pr merge` invoked from a subdirectory.

## [0.9.27] - 2026-05-31

Short-term fix for the v0.9.26 multi-question AskUserQuestion wedge (#4668). When claude TUI retried as N "separate" single-question calls after the #4648 multi-question deny, it issued them as parallel `tool_use` blocks in one assistant turn — and chroxy's `_pendingUserAnswer` is a single field, so the user's answer to question 1 routed to question 4's slot and the 5-minute stream-stall watchdog fired. The hook now refuses sibling AskUserQuestion calls while one is already pending, forcing true serialization until the long-term Map-keyed refactor lands.

### Fixed

- **Sibling AskUserQuestion deny at the permission-hook layer (#4669):** `permission-hook.sh` now claims an `askuserquestion-active` lock in the session sink dir (`CHROXY_SINK_DIR`) on first AskUserQuestion and denies subsequent siblings while the lock is fresh (<60s). PostToolUse cleanup releases the lock via a `tee | grep | rm -rf` chain wired through `claude-tui-session.js`. Atomic via `mkdir` (TOCTOU-safe), portable across macOS and Linux (`uname -s`-switched `stat`), and stale-lock-resilient (auto-reclaims after 60s). Deny copy steers the model to wait for each `tool_result` before issuing the next `tool_use` instead of the ambiguous "answer each in turn" phrasing that the model previously read as "fire in parallel."

## [0.9.26] - 2026-05-31

Adds a per-session, user-authored **preamble** that the server prepends to the system prompt every turn so you can pre-load context once instead of retyping it in every message ("always respond in bullet points", "this is a Godot 4 project — prefer GDScript over C#"). New text area lives in the dashboard's Active session section, persists across server restarts, and applies to every provider (Claude TUI/SDK/CLI, BYOK, DeepSeek, Codex, Gemini).

### Added

- **Per-session preamble (#4660):** new `set_session_preamble` WS message and `session_preamble_changed` broadcast. `BaseSession._buildSystemPrompt()` now layers `preamble → chroxy hint → skills text` with `\n\n` separators; preamble rides at the front so the user's voice takes precedence over chroxy-controlled context. Trimmed + capped to 4000 chars server-side, 4096 chars on the wire. Persists in `session-state.json` and round-trips across server restarts. Settings panel text area debounces 400ms before sending to bound WS chatter.

### Changed

- `BaseSession._buildSystemPrompt()` rewritten to join non-empty layers via `parts.join('\n\n')` so multiple optional layers (preamble, chroxy hint, skills) compose cleanly without nested branching. Byte-identical to pre-#3805 when both preamble is empty and `chroxyContextHint` is OFF — zero observable change for existing users.

## [0.9.25] - 2026-05-31

Adds DeepSeek as a first-class provider alongside Claude, Codex, and Gemini. Subclasses the existing `ClaudeByokSession` and points at DeepSeek's Anthropic-compatible endpoint (`https://api.deepseek.com/anthropic`) so the entire BYOK agent loop — streaming, tools, permissions, MCP, history rollback, parallel tool execution — reuses unchanged. Two models in the picker: `deepseek-chat` (V3, 128k ctx) and `deepseek-reasoner` (R1, 128k ctx).

### Added

- **DeepSeek provider** (#4656, #4657) — pick it in the dashboard / mobile app under Settings → Provider → "DeepSeek (API key)". Auth via `DEEPSEEK_API_KEY` env OR a `deepseekApiKey` field in `~/.chroxy/credentials.json` (mode 0600 enforced, same security boundary as the BYOK Anthropic path). Pricing table sourced from DeepSeek's public docs; `npx chroxy doctor` confirms preflight readiness. `DEEPSEEK_BASE_URL` env override available for self-hosted / proxy endpoints. 28 new tests cover credentials, session, and registry wiring; all 50 existing BYOK tests stay green.

### Changed

- **`ClaudeByokSession` exposes four overridable seams** (#4657) — `_defaultModel`, `_resolveCredentials`, `_buildClient`, `_getPricing`. Behavior-preserving refactor that lets sibling Anthropic-compatible providers (DeepSeek now, potentially others later) reuse the entire agent loop by swapping only what differs (base URL, credentials, default model, pricing). The missing-credentials error toast now prefixes with the subclass's preflight label (`"DeepSeek credentials not found …"` instead of the contradictory `"BYOK credentials not found — DEEPSEEK_API_KEY not set …"`) and the per-session ready log uses the provider id rather than a hardcoded "BYOK" string.

## [0.9.24] - 2026-05-31

Rethinks chroxy's multi-question `AskUserQuestion` form handling end-to-end after a 6-agent `/swarm-audit` unanimously concluded the existing PTY-keystroke driver cannot work in production (0/7 success rate per `chroxy.log` forensic, 24h sample). Replaces the driver path with a permission-hook deny that forces the model to re-issue as N sequential single-question calls — each driven by the empirically-validated single-question happy path that has worked since v0.9.4. Also a cosmetic dashboard fix for the Read-tool collapsed preview.

### Fixed

- **Refuse multi-question AskUserQuestion at the permission hook** (#4648, #4649) — `packages/server/hooks/permission-hook.sh` now detects PreToolUse where `tool_name == "AskUserQuestion"` AND `questions[].length > 1`, returns `permissionDecision: "deny"` with a `permissionDecisionReason` instructing the model to re-issue as separate AskUserQuestion calls, one per question. Runs BEFORE permission-mode dispatch so `auto`/`approve`/`acceptEdits`/`plan` all behave consistently. Uses `python3` stdin JSON parse with safe fallthrough — malformed payload or `python3` absence falls through to existing behavior rather than denying broadly. Defense in depth: the v0.9.23 `_onAskUserQuestionStall` teardown still catches anything that slips through. The old multi-question driver code stays in place for one release cycle as defense-in-depth; deletion planned for a future release once refuse is proven stable in dogfood.
- **Action-oriented error toast on `ASK_USER_QUESTION_STALL`** (#4648, #4649) — was `"The agent's question response could not be delivered — likely a multi-question form. Please retry from your last message."` (chroxy jargon); now `"Couldn't deliver your answers. Tap Retry to resend your original request."` (action-oriented). Most multi-question forms never reach this toast now because the permission hook denies them upstream; the toast is reserved for the rarer cases that slip past the hook.
- **Raw `tool_input` JSON leaking into Read tool's collapsed preview** (#4648, #4649) — `packages/store-core/src/tool-summary.ts` adds `filePath` to the priority field list and a one-level nested-object walk so the Read tool input shape `{type:'text', file:{filePath:'/foo'}}` summarizes as `/foo` instead of falling through to `ToolBubble`'s raw-JSON-head fallback. Walk stops at depth one so bounded preview cost on the hot `ToolBubble` render path.

## [0.9.23] - 2026-05-31

Two follow-ups from v0.9.22 dogfooding. The `ASK_USER_QUESTION_STALL` watchdog from #4604 was firing the user-facing error correctly but leaving the session looking busy — the dashboard kept the "Working…" banner and Stop button up for the next 4.5 min (until v0.9.22's new 5-min stream-stall watchdog kicked in), so the toast's "retry from your last message" instruction had no Send affordance to retry from. And the multi-question form's option labels rendered with the radio/checkbox dot jammed against the text.

### Fixed

- **Full turn teardown when `ASK_USER_QUESTION_STALL` watchdog fires** (#4645, #4646) — `_onAskUserQuestionStall` now mirrors `_handleStreamStall` / `_handleHardTimeout`: best-effort Ctrl-C into the PTY (so `claude` itself unsticks from the form screen for the next turn) → clear all three inactivity timers → drop per-turn attachment dir → null `_activeTurn` / `_currentMessageId` / pending answer slot → `stream_end` → `_emitResult` (sweeps orphan tool_starts and fans `result` → `agent_idle`) → emit `error{code:'ASK_USER_QUESTION_STALL'}` last. Dashboard's Working banner and Stop button clear immediately; Send button returns. Pre-fix the dashboard stayed busy-looking for 4.5 min or up to 2h.
- **Spacing between radio/checkbox dot and option label in multi-question form** (#4644) — added `display: inline-flex; align-items: center; gap: 10px;` to `.question-option--radio` and `.question-option--checkbox` so the dot no longer reads as jammed against the text. Single-select `QuestionPrompt` path (no input element) is untouched.

## [0.9.22] - 2026-05-31

Active-recovery for the TUI provider's "Working… forever" wedge mode — when `claude` TUI accepts the prompt and then emits absolutely nothing (no Stop hook, no tool hooks, no PTY output) the soft warning sat at 30 min and the hard cap at 2h, neither of which helped a user staring at a frozen session at the 5-min mark. CLI and SDK sessions already had this fix from #4467; the TUI provider was the outlier.

### Fixed

- **Stream-stall watchdog on `ClaudeTuiSession`** (#4638, #4640) — ports the #4467 `_streamStallTimeout` recovery to the TUI provider. On stall fire: best-effort Ctrl-C into the PTY (so `claude` itself unsticks for the next turn) → emit `stream_end` → `_emitResult` (sweeps orphan tool_starts and fans `result` → `agent_idle` via the event-normalizer) → emit `error` with `code: 'stream_stall'` so the dashboard surfaces the same retry chip CLI/SDK stalls trigger. Default 5 min; operators can override via `streamStallTimeoutMs` config or set to 0 to disable.

## [0.9.21] - 2026-05-30

CSS polish for the multi-question AskUserQuestion form shipped in v0.9.19 — the component rendered with class names that had no rules at all, so Submit fell back to the native browser button (gray-on-dark, unreadable), questions ran together with no separator, and the native radio dot was harsh-white against the dark theme. No functional changes.

### Fixed

- **MultiQuestionForm styling (#4634 / #4636):** added rules in `packages/dashboard/src/theme/components.css` for `.question-prompt--multi` (flex column with 16px gap between questions), `.question-prompt-multi-row` (12px bottom padding + subtle bottom divider; last row clears its border so there's no dangling line above Submit), and `.question-multi-submit` (matches the existing `.question-freetext-send` shape — filled accent-purple background, white text, hover/disabled/focus-visible states). Plus `accent-color: var(--accent-purple)` on the per-option radio/checkbox inputs so the selection dot blends with the purple option-pill outline instead of standing out as pure white. `accent-color` is Baseline since 2022, safe for Tauri WKWebView.

### Known issues (filed)

- **#4635** — multi-question Submit fails on **pure all-single-select** forms. The driver shipped in v0.9.19 was empirically validated only against a MIXED form (with at least one multi-select question, captured via `scripts/tui-form-recorder.mjs`); the all-single-select case wasn't pinned and the same byte sequence doesn't make claude TUI emit PostToolUse. Stall watchdog still correctly recovers (chip clears, error toast shown, session re-promptable). Needs a fresh recorder pass against an all-single-select prompt before the right fix can be written.

## [0.9.20] - 2026-05-30

Patches the last remaining zombie-chip path in v0.9.19. Forensic on a live wedged session showed claude TUI sometimes drops a PostToolUse hook (1 of 35 observed in a clean turn — likely an upstream race between turn-end and post-hook fire). When that happens, chroxy persists an unpaired `tool_start` to `session-state.json`, and the dashboard's `activeTools` chip ticks forever — `result` is broadcast live so `handleAgentIdle` clears it, but `replayHistory` on dashboard reconnect sent the raw `result` event verbatim and the dashboard has no `result` handler, so the chip survived every reload until the next chroxy restart. Two-layer defense: prevent new orphans at turn-end (sweep), heal existing wedged sessions on reconnect (replay fan-out).

### Fixed

- **Zombie tool_start chip via emit-result sweep + replay agent_idle fan-out (#4628 / #4631):**
  - **Layer 3 (BaseSession `_emitResult` sweep):** new `_inFlightToolStarts` Map tracks every emitted `tool_start` until matching `tool_result` fires. `_sweepUnresolvedToolStarts(reason)` emits a synthetic `tool_result` per orphan (carries `synthetic`, `interrupted`, `isError`, `reason` diagnostic fields + the original `toolUseId` — dashboard's `applyToActiveTools` pairs by `toolUseId` alone, so the chip clears). `_emitResult(payload, reason)` wraps sweep + result emit so the synthetic fires BEFORE the result. `_clearMessageState` also sweeps as belt-and-braces for paths that emit result via a different route (e.g. SDK `_handleStreamStall` clears state BEFORE emitting result). Wired into all three providers (`claude-tui-session.js` — all 3 result paths + hook pair tracking + AskUserQuestion stall path; `sdk-session.js` — tool_start track + turn-end via `_emitResult`; `cli-session.js` — tool_start track) and into the shared `tool-result.js` helper (untracks when emitting `tool_result` via `emitToolResults`).
  - **Layer 2 (replay-time `result → agent_idle` fan-out in `ws-history.js`):** `replayHistory` now mirrors the live `event-normalizer.js` fan-out — any `result` entry in the replay stream is followed by a synthetic `agent_idle`. Without this, the dashboard's handler dispatch table (no `result` handler, only `agent_idle`) silently drops replayed results, so `handleAgentIdle` (the #4308 `activeTools` safety net) never fires. Heals existing wedged sessions on dashboard reconnect — no chroxy restart required.
  - Pairs with the existing layers: #4308 (live `handleAgentIdle`), #4619 (restart-time sweep on persisted history), #4618 (stall watchdog `tool_result` emit), #4614 (AskUserQuestion stall watchdog). Together they cover every known path from `tool_start` to chip-not-clearing.

## [0.9.19] - 2026-05-30

Coordinated attack on the "Running X · Nh Mm" zombie chip plus the stall paths that produced it — #4604 (multi-question AskUserQuestion) lands its full A→B→C arc: observability + 30s watchdog (#4614), root-cause multi-question form driver (#4620), and two fallbacks so the footer pill clears even when the driver can't help (#4618, #4619). Stream-stall watchdog extends to SDK sessions (#4608, closes #4467). Plus notification-prefs durability hardening (#4605, #4606) and a wire-timestamp respect for `tool_start` (#4612, closes #4607).

### Added

- **TUI multi-question form driver (#4604 Chunk B / #4620):** server `respondToQuestion` now iterates the full `questions` array and writes per-question keystrokes (`digit` for single-select auto-advance, `digit + Tab` for multi-select commit, `'1'` to submit) instead of treating every prompt as single-select. Dashboard `QuestionPrompt` renders N questions with multi-select checkbox UI; `handleUserQuestion` and `sendUserQuestionResponse` carry the full `questions`/`answers` shape end-to-end. Single-question path is byte-identical to #4290 (regression guard). Back-compat: old dashboards that only send `answer: string` default to option 1 with WARN. Empirical byte sequence captured via `scripts/tui-form-recorder.mjs` (also bundled in this PR — `node-pty` JSONL recorder, accepts iTerm's modify-other-keys form of Ctrl+D `\x1b[27;5;100~` alongside raw `\x04`).
- **AskUserQuestion stall observability + 30s watchdog (#4604 Chunks A+C / #4614):** server now emits structured `[ask-user-question-pending]` + `[ask-user-question-stalled]` log lines tracking pendingUserAnswer lifetimes, and a 30s watchdog fires `_onAskUserQuestionStall` to break the wedge when a multi-question form never gets PostToolUse. Pairs with the driver fix in #4620 — driver eliminates the cause; watchdog is the safety net.

### Fixed

- **Stall watchdog clears activeTools footer chip (#4616 / #4618):** when the AskUserQuestion stall watchdog (#4604 Chunk C, also shipped in this release via #4614) fired, the dashboard's `activeTools` entry stayed because `_onAskUserQuestionStall` only emitted `error` — no paired `tool_result`. Now emits `tool_result{toolUseId}` before `error`; store-core `handleToolResult.applyToActiveTools` removes the matching entry by toolUseId (#4308 wiring). Same fix applied symmetrically to `SdkSession._handleStreamStall` (#4467) which was emitting `stream_end + error` only — adds a synthetic `result{cost:null}` matching CLI's `_emitInterruptedTurnResult` so `event-normalizer` fans `result → agent_idle` and `handleAgentIdle` clears `activeTools: []` as the safety net. `cost:null` skips session-manager billing.
- **Session restore sweeps unresolved tool_starts (#4617 / #4619):** if chroxy was killed (or SIGKILL'd) while a tool was running, the unresolved `tool_start` was persisted to `session-state.json`. On next restore, history replay re-emitted it to the dashboard's `activeTools` but no path ever cleared it — footer pill stuck on "Running X · 4h+" until the session ended. `restoreState()` now scans history before `setHistory()` and synthesizes `tool_result{interrupted:true, synthetic:true, reason:'session_restored'}` for any orphan `tool_start`. Dashboard's normal pairing logic clears the chip.
- **Stream-stall watchdog extended to SDK sessions (#4467 / #4608):** stalls during streaming responses on `SdkSession` now trigger the same recovery path that `CliSession` has (`_handleStreamStall` → emit `stream_end` + `result` + `error`, clear `_isBusy`, leave session re-startable). Previously a stalled SDK session sat busy indefinitely; the timer never reset and a new turn would queue behind the dead one.
- **Preserve "Running tool · Ns" timer across tab-switch history replay (#4607 / #4612):** store-core `sharedToolStart` (in `handlers/index.ts`) was stamping both `chatMessage.timestamp` AND derived `ActiveTool.startedAt` with `Date.now()`, ignoring the wire `timestamp` field. The `toolUseId` dedup in `applyToActiveTools` masked this when an entry was already tracked at replay — but when `activeTools` was empty at `history_replay_start` (e.g. a prior `handleAgentIdle` swept it, or the tool predates the tracking), the rebuilt entry's `startedAt` jumped to the replay moment and the footer pill restarted at ~1s on every tab-switch. Now respects the wire `timestamp` so the elapsed time stays continuous.
- **Roll back in-memory notification prefs on persist failure (#4550 / #4605):** `PushManager.setPrefs` now persists to disk first and only mutates `this._prefs` on success. Previously the in-memory state was patched optimistically — a failed disk write (disk full, permission denied, atomic-rename race) left in-memory diverged from disk, so `isCategoryEnabled` returned stale values until the next restart silently reverted. Regression test forces a rename failure and asserts the pre-patch value survives.
- **Validate device-token format in notification_prefs_set (#4551 / #4606):** `handleNotificationPrefsSet` now iterates `patch.prefs.devices` keys and validates each via `PushManager.isValidPushTokenFormat`. Malformed keys produce `INVALID_REQUEST` and skip the persist call entirely — prevents a buggy or malicious client from bloating `~/.chroxy/notification-prefs.json` with junk entries that break subsequent `register_push_token` reads.

## [0.9.17] - 2026-05-30

Waves 5 + 6 of the from-review marathon — 6 follow-ups polishing what v0.9.16 shipped. Per-device notification overrides become operator-friendly: server now stamps `lastSeenAt` + `platform` on each entry (#4587), the UI renders "iOS · Last seen 15 min ago" next to the truncated token, and clearing your own row prompts before wiping local mutes (#4588). Mobile a11y catches up to the dashboard's `role="alert"` semantic on both Android (live-region prop, #4581) and iOS (`AccessibilityInfo.announceForAccessibility`, #4595). Plus a shared-helper refactor (#4591) and a copy unification (#4585) cleaning up the marathon's wake.

### Added

- **Per-device notification metadata (#4587 / #4590):** server stamps `lastSeenAt` (epoch ms) and `platform` (from `client.deviceInfo`) on every per-device notification-prefs entry it touches. `register_push_token` bumps `lastSeenAt` on existing entries without creating empty ones. Protocol's `NotificationDeviceEntrySchema` gets two optional fields; older clients/servers unaffected. Dashboard + mobile `KnownDevicesList` render `{Platform} · Last seen {rel}` next to the truncated token when fields are present; missing fields render exactly as before. Operators with multiple orphan tokens can now tell which one is which.
- **iOS VoiceOver announce for quiet-hours conflict banner (#4595 / #4597):** mobile `QuietHoursEditor` now calls `AccessibilityInfo.announceForAccessibility` on `pendingSnapshot` mount, gated on `Platform.OS === 'ios'` so Android (which already gets the announcement via the `accessibilityLiveRegion="polite"` prop from #4581) doesn't double-speak. Closes the iOS gap left by #4594 — `accessibilityLiveRegion` is Android-only, iOS needs an explicit announce call.
- **Android TalkBack roles on quiet-hours conflict banner (#4581 / #4594):** banner View carries `accessibilityLiveRegion="polite"` so TalkBack announces the divergence the moment it mounts; both action buttons carry `accessibilityRole="button"` + `accessibilityLabel` echoing the visible text. Closes the a11y gap reported on the #4570 fix.

### Fixed

- **Confirm before clearing current-device notification override (#4588 / #4592):** dashboard `window.confirm` and mobile `Alert.alert` now prompt when the user clicks Clear on the row tagged `(this device)`. Orphan rows skip the prompt — the whole point of the orphan list is fast cleanup. Catches the misclick that would silently wipe the operator's own mutes / quiet-hours overrides.
- **Unify mobile "not supported" notification copy (#4585 / #4593):** mobile `SettingsScreen` previously showed a long upgrade explanation in the Categories section and a terser `Requires chroxy v0.9.14 or newer.` in the Quiet-hours section — visible to any user testing against a pre-#4541 server. Both sites now share a single `NOTIFICATION_PREFS_UNSUPPORTED_MESSAGE` constant. Dashboard already colocated both under one capability-gated hint, so no change there.

### Internal

- **Extract `formatRelativeTime` + `formatPlatform` to `@chroxy/store-core` (#4591 / #4596):** the two helpers shipped duplicated in dashboard `SettingsPanel` and mobile `SettingsScreen` as part of #4587. Moved to a new `packages/store-core/src/device-format.ts` with 11 vitest cases covering all branches (minutes / hours / days / months / years / clock-skew fall-through). Both consumers now import from `@chroxy/store-core` — no new dependency on either side, since the package already ships to both. 24 lines deduplicated; mobile static-source tests pivoted to import + regression-guard.

## [0.9.16] - 2026-05-30

Wave 4 of the from-review marathon — 13 follow-ups polishing what v0.9.13–0.9.15 shipped. Notification preferences round out with optimistic toggles (#4558), WS-closed error surfacing (#4559), capability gating for pre-v0.9.14 servers (#4560), quiet-hours editor draft preservation (#4570), and per-device override cleanup (#4564). Quiet-hours validation and perf hardened (#4566, #4567, #4568). K8s `workspacePVC` finally gets an operator-facing config surface (#4556). Plus a refactor (#4569), accessibility (#4562), styling (#4563), test coverage (#4555), and v0.9.15 SidebarTokenView coverage extension (#4546 — which actually shipped in v0.9.15, but the polish chain continues here).

### Added

- **Capability-gate Notifications section (#4560 / #4584):** server now declares `notificationPrefs: true` in `auth_ok` capabilities; clients (dashboard + mobile) hide the Notifications section (or show "requires newer server" message) when connecting to pre-v0.9.14 servers that lack the foundation. Mirrors the existing `serverCapabilities` pattern used by `promptEvaluator` and `chroxyContextHint`. Follow-up [#4585](https://github.com/blamechris/chroxy/issues/4585) tracks mobile copy consistency.
- **Optimistic notification toggle (#4558 / #4578):** SettingsPanel toggles now apply locally before the WS round-trip lands, masking the ~50-200ms snapshot-broadcast latency. Server snapshot wins on disagreement (server is the truth source); rollback if the WS round-trip fails. Same shape in dashboard and mobile.
- **Inline error on WS-closed notification/BYOK writes (#4559 / #4582):** if a write fires while the WS is closed, the dashboard and mobile surfaces now show "Can't save changes — reconnecting…" instead of silently dropping. Uses the existing dashboard error-banner pattern.
- **Per-device override cleanup UI (#4564 / #4586):** SettingsPanel now lists known per-device entries with a friendly label (truncated token + "this device" marker) and per-row Clear button. Server `notification_prefs_set` learned a `devices: { [token]: null }` delete semantics. Follow-ups [#4587](https://github.com/blamechris/chroxy/issues/4587) (richer device labels — last-seen + platform) and [#4588](https://github.com/blamechris/chroxy/issues/4588) (confirm prompt for current-device clear).
- **chroxy-config surface for K8s workspacePVC (#4556 / #4583):** `[k8s.workspace]` block with `claimName` (required), `mountPath` (default `/workspace`), `readOnly` (default false). EnvironmentManager auto-injects `workspacePVC` when K8sBackend is active AND block is present (explicit per-call opts win if/when added). Config validated at load time so operators see errors at startup rather than first env-create. K8s docs updated.

### Fixed

- **Quiet-hours HH:MM range validation (#4566 / #4575):** `sanitizeQuietHours` now rejects hour > 23, minute > 59, non-numeric, missing colon, wrong length. Invalid input falls through to disabled (safe default) + warn log.
- **`isInQuietHoursIn` finite guard (#4567 / #4576):** defensive `Number.isFinite` on parsed hour/minute values; non-finite parses fall through to "not in quiet hours" so a future schema-drift can't silently block delivery.
- **Quiet-hours editor draft preservation (#4570 / #4580):** mid-edit snapshot broadcasts no longer clobber the in-flight editor. Dirty tracking + `pendingSnapshot` sentinel pattern: server snapshots park when local edit is dirty; user accepts or discards explicitly. Follow-up [#4581](https://github.com/blamechris/chroxy/issues/4581) tracks mobile a11y for the conflict banner.
- **SidebarTokenView nested-label hoist (#4562 / #4573):** v0.9.14's #4525 fix nested a `<label>` inside a parent `<label>` (invalid HTML, unpredictable screen-reader behavior). Restructured so each checkbox has its own non-nested label.

### Changed

- **Per-device notification row visual hierarchy (#4563 / #4577):** `.notification-prefs-device-row` CSS adds indent + de-emphasized typography so the per-device toggle reads as a sub-row of the global per-category toggle. Pure CSS + regression-test addition.

### Performance

- **Memoize `Intl.DateTimeFormat` per timezone (#4568 / #4579):** module-level Map cache replaces per-call constructor in the quiet-hours gate hot path. Timezone set is small + stable, so unbounded memory isn't a concern.

### Internal

- **Shared quiet-hours timezone choices (#4569 / #4574):** the IANA timezone list duplicated in dashboard and mobile is now `QUIET_HOURS_TIMEZONES` in `@chroxy/store-core`. Both surfaces import from the single source.
- **EnvironmentManager workspacePVC passthrough test comment (#4555 / #4572):** clarifies the stub-vs-real-backend invariant — the manager has no opinion about `cwd`+`workspacePVC` coexistence; that's the backend's job to enforce.

## [0.9.15] - 2026-05-29

Wave 3 of the from-review marathon — five follow-ups, completing the three deferred UI sub-issues from v0.9.14's #4349 decomposition. Notification preferences are now fully user-controllable: per-category mute (#4542), per-device routing (#4543), and quiet-hours window (#4544) all land here on top of v0.9.14's #4541 foundation. Plus a third regression test for v0.9.14's SidebarTokenView focus-restore (#4546) and the EnvironmentManager plumbing follow-up for v0.9.14's K8s PVC strategy (#4548).

### Added

- **Per-category notification opt-in/out UI (#4542 / #4557):** Notifications section in dashboard `SettingsPanel` and mobile-app Settings screen — one toggle per category (`permission`, `question`, `error`, `result`, `inactivity`) wired through `notification_prefs_set` WS messages from #4541's foundation. Server-side `RATE_LIMITS` remain as the defensive lower bound — user prefs can mute but never enable more spam. Follow-ups: [#4558](https://github.com/blamechris/chroxy/issues/4558) (optimistic toggle UI), [#4559](https://github.com/blamechris/chroxy/issues/4559) (inline error on WS-closed writes), [#4560](https://github.com/blamechris/chroxy/issues/4560) (capability-gate Notifications section for pre-#4541 servers).
- **Per-device notification opt-in/out UI (#4543 / #4561):** "Mute on this device" sub-row alongside the global per-category toggles. Per-device overrides layer on top of global defaults — muting on one device does not affect deliveries to others. Follow-ups: [#4562](https://github.com/blamechris/chroxy/issues/4562) (hoist nested label), [#4563](https://github.com/blamechris/chroxy/issues/4563) (CSS for per-device row hierarchy), [#4564](https://github.com/blamechris/chroxy/issues/4564) (clearing orphaned device overrides).
- **Notification quiet-hours window (#4544 / #4565):** server-side `isInQuietHours(now, pushToken)` (stub since #4541) now evaluates the per-device timezone'd window against the active prefs. `PushManager.send()` short-circuits the Expo push when "now" falls inside the window UNLESS the category is in the bypass list (default: `permission`, `error` — operator-blocking categories that should always page through). Quiet-hours editor in `SettingsPanel` and mobile Settings screen surfaces start/end time pickers + timezone selector. Tests cover midnight wrap (start=22:00, end=07:00), DST edge, per-device override resolution, and category bypass. Follow-ups: [#4566](https://github.com/blamechris/chroxy/issues/4566) (HH:MM range validation), [#4567](https://github.com/blamechris/chroxy/issues/4567) (Number.isFinite guard), [#4568](https://github.com/blamechris/chroxy/issues/4568) (memoize Intl.DateTimeFormat), [#4569](https://github.com/blamechris/chroxy/issues/4569) (share timezone choices), [#4570](https://github.com/blamechris/chroxy/issues/4570) (preserve editor drafts across snapshot broadcasts).
- **EnvironmentManager `workspacePVC` plumbing (#4548 / #4554):** `EnvironmentManager.createEnvironment` now forwards `workspacePVC` to the backend so high-level callers can opt into v0.9.14's PVC workspace strategy (#3385) without bypassing the manager. Backend interface JSDoc in `types.js` documents the option alongside `imagePullPolicy`. Design choice: operator configures PVC via chroxy config (operator-side, doesn't pollute per-project `devcontainer.json`) — tracked for surface implementation in [#4556](https://github.com/blamechris/chroxy/issues/4556). Follow-up [#4555](https://github.com/blamechris/chroxy/issues/4555) tracks a test-comment clarification.

### Internal

- **SidebarTokenView TUI-untracked focus-restore regression test (#4546 / #4553):** v0.9.14's #4525 fix lives in the shared `InfoDisclosure` component used by both the cost-info trigger AND the TUI-untracked trigger; the #4525 regression tests only exercised cost-info. Third test now covers the TUI-untracked path so a future refactor that splits the shared component can't silently lose coverage.

## [0.9.14] - 2026-05-29

Wave 2 of the from-review marathon — three follow-ups plus the foundation slice of the v0.9.13 #4349 user-notification-settings decomposition. The K8sBackend gains a multi-node-cluster path via a PVC workspace strategy (#3385), the dashboard's SidebarTokenView popover gains the same Escape focus-restore #4525 added to ActivityIndicator (#4539), and `PushManager` grows a user-prefs surface backed by `~/.chroxy/notification-prefs.json` + `notification_prefs_get/set` WS messages (#4541) — the substrate that the per-category UI (#4542), per-device UI (#4543), and quiet-hours (#4544) sub-issues will consume in a future marathon.

### Added

- **K8sBackend PVC workspace strategy (#3385 / #4547):** `opts.workspacePVC = { claimName, mountPath? }` translates to a `persistentVolumeClaim` volume + `volumeMount` in the Pod spec, giving multi-node-cluster operators a working alternative to the single-node-only `hostPath` workspace. Passing both `cwd` (hostPath) and `workspacePVC` throws early — operators pick one strategy. Existing `hostPath` path is unchanged. Follow-up [#4548](https://github.com/blamechris/chroxy/issues/4548) tracks plumbing `workspacePVC` through EnvironmentManager so high-level callers can reach it without bypassing the manager.
- **Notification preferences foundation (#4541 / #4549):** `~/.chroxy/notification-prefs.json` (mode 0600, atomic temp+rename writes) holds global per-category defaults + per-device override map keyed by Expo push token. `PushManager` grows `getPrefs()`, `setPrefs(patch)`, `isCategoryEnabled(category, pushToken)`, and `isInQuietHours(now, pushToken)` (stub — quiet-hours logic ships with #4544). WS protocol adds `notification_prefs_get` / `notification_prefs_set` messages with Zod schemas in `@chroxy/protocol`. Server-side `RATE_LIMITS` remain as the defensive lower bound — user prefs can mute but never enable more spam.

### Fixed

- **SidebarTokenView popover focus restore on Escape (#4539 / #4545):** Escape dismiss now calls `triggerRef.current?.focus()` so keyboard users return to the disclosure trigger instead of being parked on `document.body` (WAI-ARIA APG). Outside-click path deliberately does NOT restore focus — preserves pointer intent. Mirrors v0.9.13's #4525 ActivityIndicator fix. Follow-up [#4546](https://github.com/blamechris/chroxy/issues/4546) tracks a TUI-untracked-trigger regression test variant.

### Internal

- **#4349 decomposed:** the multi-package user-notification-settings parent closed in favour of four sub-issues — #4541 (foundation, landed here), #4542 (per-category UI), #4543 (per-device UI), #4544 (quiet hours).

## [0.9.13] - 2026-05-29

Wave 1 of the from-review marathon: 20 follow-ups across BYOK MCP (config, client, trust), dashboard ActivityIndicator polish, session-manager test helpers, and a timeout-ceiling consolidation. Theme is "harden the BYOK surface": the MCP trust store now serialises concurrent writes (#4526), uses JSON-encoded tuple keys that resist collision and tamper (#4529), denies bypass-mode auto-trust (#4531), and cleans up `.tmp` leakage on rename failure (#4534). The MCP client gets exponential restart backoff (#4530), a tunable handshake timeout (#4533), debug-level orphan-response logging (#4536), and a wall-clock fast-fail on broken MCP configs (#4537). Plus dashboard a11y/i18n polish (#4523, #4525) and the `mcpToolCallTimeoutMs` ceiling (#4538) closing the v0.9.12 #4517 follow-up.

### Added

- **Exponential restart backoff in byok-mcp-client (#4453 / #4530):** restart delays now ramp 1s → 2s → 4s (was fixed 1s/1s/1s), giving wedged dependencies — port conflicts, transient FS hiccups — time to recover before DEAD. Also fixed an off-by-one in the attempt-cap (`>=` → `>`) so the third attempt actually runs.
- **Per-instance handshake timeout in byok-mcp-client (#4454 / #4533):** new `opts.handshakeTimeoutMs` (and per-config `handshakeTimeoutMs`) overrides `DEFAULT_HANDSHAKE_TIMEOUT_MS` so slow MCP servers can have wider timeouts and tests can have tighter ones. Defensive guard against non-finite / non-positive values falls back to the default.
- **MCP wall-clock fast-fail (#4456 / #4537):** `MCPFleet.start()` now caps total wait at `DEFAULT_FLEET_START_CAP_MS` (1500ms) so a single broken MCP config can't hang session startup indefinitely. Operators can opt in to legacy convergence behaviour via `opts.startCapMs = Infinity`.

### Fixed

- **Trust-store serialization (#4460 / #4526):** two MCPFleet clients started in parallel could both pass through their trustGate (load → prompt → recordTrust) interleaved, with the last write clobbering the first. Added `withTrustStoreLock(filePath, critical)` — a per-path async mutex — and serialised the whole gate sequence inside it. Prompts now surface one at a time; concurrent recordTrust calls all persist.
- **Trust-store tuple key hardened against collision + tamper (#4461 / #4529):** replaced the NUL-byte separator with `JSON.stringify([name, command, arg0])` so values containing spaces, NUL, quotes, or brackets cannot collide. `loadTrustStore()` now recomputes each entry's canonical key from its stored components and drops any entry whose stored key doesn't match — catches "hand-edit command, keep stored key intact" tamper attempts.
- **Bypass-mode no longer silently persists MCP trust (#4462 / #4531):** `autoAllowPending()` now tags pending entries with `mcpTrust: true` and denies them explicitly with the reason "MCP trust not persisted via auto-mode bypass" — prevents auto-mode from quietly accumulating trust entries the user never approved.
- **Trust-store cleans up `.tmp` on renameSync failure (#4463 / #4534):** when `renameSync` threw (cross-device link, FS quota, ACL) the temp file was left behind in `~/.chroxy/`. Wrap in try/catch that `unlinkSync`-es the temp on failure and re-throws the original error.
- **MCP config-file 10MB read cap (#4447 / #4524):** `byok-mcp-config.js` now caps the JSON read at 10MB so a malformed or hostile config can't exhaust memory. Over-cap reads warn and fall back to empty config.
- **MCP config coerces and warns on non-string values (#4448 / #4528):** non-string values for `command`/`args` items now warn and are dropped instead of producing a broken MCPClient config.
- **Unified `mcpConfigPath` opt naming (#4449 / #4532):** `byok-session.js` now uses `opts.mcpConfigPath` consistently; the unused `claudeConfigPath` alias was dropped.
- **MCP client logs orphan JSON-RPC responses at debug (#4455 / #4536):** unsolicited responses (id the client never sent) now log at debug level instead of warn, since they're benign noise from buggy MCP servers. Notifications (id == null) are silently dropped.
- **`mcpToolCallTimeoutMs` clamped to MAX_SANE_DURATION_MS (#4517 / #4538):** the operator-facing knob now respects the 24h ceiling enforced for other timeout fields (extends v0.9.12's #4516 to the three byok-session sites + config validation).
- **1M-variant model label uses providerMeta (#4441 / #4518):** `humanizeModelId` now applies provider-supplied labels to the 1M variants instead of dropping back to the raw model ID.
- **ActivityIndicator popover focus-restore (#4445 / #4525):** Escape now restores focus to the disclosure trigger instead of dropping focus to the document body. Follow-up [#4539](https://github.com/blamechris/chroxy/issues/4539) tracks the SidebarTokenView parallel.

### Changed

- **`useId()` for ActivityIndicator popover id (#4444 / #4523):** replaced the manual `useRef(`indicator-${Math.random()}`)` hack with React 19's `useId()` so popover ids are stable across re-renders and SSR-safe.
- **Shared session-manager forwarding test helper (#4511 / #4519):** extracted `CapturingProvider` + `assertForwardingPattern` from session-manager tests into `packages/server/tests/helpers/provider-forwarding.js` so future timeout-forwarding tests don't duplicate the harness. Includes follow-up #4522 covering the `streamStallTimeoutMs=0` edge case.

### Internal

- **Dashboard registry conflict-scan coverage (#4442 / #4520):** added the both-defs-disabled case to `findConflict` tests.
- **Dashboard registry interface doc (#4443 / #4521):** documented enabled-aware conflict semantics on the registry interface JSDoc.
- **byok-mcp-client constants parameterized (#4452 / #4527):** `MCP_PROTOCOL_VERSION` and `MCP_CLIENT_VERSION` are now exported module constants — `MCP_CLIENT_VERSION` derives from `package.json` instead of the legacy `'1'` placeholder, so MCP server logs see a real chroxy version.

## [0.9.12] - 2026-05-28

Small follow-up sweep closing seven leftovers from the v0.9.10–v0.9.11 marathons. Theme is "finish what we started": the keyboard-shortcut registry now owns every dashboard binding (the tail #4412 deferred from v0.9.10's #3852), the context-window learn-loop now persists and runs on both Codex and Gemini (the two #4413/#4414 follow-ups from v0.9.10's #3857), and the pending-background-shells feature lights up the mobile app + handles overflow and multi-shell expansion (the three #4420/#4421/#4422 follow-ups from v0.9.11's #4307). No new user-facing features — every change is making an existing v0.9.x feature work the way it was advertised.

### Added

- **Mobile-app surface for pending background shells (#4422 / #4425):** `ActivityIndicator.tsx` (mobile) now shows "Waiting on background work" with the most-recently-started shell's command text, matching the dashboard's #4418 surface from v0.9.11. Uses the same `pendingBackgroundShells` store-core field that already flows through the WS event + snapshot — no protocol changes, just renderer parity.
- **ActivityIndicator chip handles overflow + multi-shell expand (#4420 + #4421 / #4426):** the chip text now tail-truncates long shell commands with `title=""` fallback so the full command is reachable on hover. Tapping a multi-shell chip expands to the full list of pending shells with start time. Bundled into one PR because both touch `ActivityIndicator.tsx` heavily.
- **Keyboard-shortcut migration tail — Cmd+1-9, Cmd+Shift+[/], Cmd+W (#4412 / #4429):** the remaining hand-rolled shortcuts deferred from v0.9.10's #3852 are now registered in the shortcut registry, so they show up in the cheat sheet and are rebindable. Three follow-ups left for the operator-visible polish: [#4427](https://github.com/blamechris/chroxy/issues/4427) (outside-click / Escape dismissal), [#4428](https://github.com/blamechris/chroxy/issues/4428) (aria-label off-by-one), [#4431](https://github.com/blamechris/chroxy/issues/4431) (registry-aware conflict-detection predicate), [#4432](https://github.com/blamechris/chroxy/issues/4432) (cheat-sheet collapsed-state mislabel).

### Fixed

- **Codex context-window ratchets survive server restart (#4413 / #4433):** v0.9.10 ratcheted the in-memory registry on every Codex turn but lost the result on restart. Now the bumped value is written through to the provider-scoped cache file (`~/.chroxy/models-cache.codex.json`) via `registry.saveCache()`. `saveCache()` is idempotent (snapshot-deduped) and logs a warn on disk failure rather than throwing, so the in-memory ratchet always succeeds even when the disk path is unwritable. The existing learn-loop test was caught writing to the operator's real cache file mid-run; the fix isolated it to a temp `CHROXY_CONFIG_DIR` per the long-standing `feedback_test_state_contamination.md` rule.
- **Context-window learn-loop extended to Gemini (#4414 / #4430):** the Codex-specific ratchet from v0.9.10 + #4413's persistence are now factored into a shared `maybeRatchetContextWindow` helper in `packages/server/src/utils/context-window-learn.js` and used by both Codex and Gemini. `Object.hasOwn` guard on the per-provider cap lookup so `getRatchetCap('constructor')` no longer returns `Object` from the prototype chain. `_processGeminiEvent`'s legacy path now has an explanatory comment for why the duplicate emit is intentional. Follow-up [#4431](https://github.com/blamechris/chroxy/issues/4431) tracks tightening the registry-enabled predicate for sessions that haven't reported usage yet.

### Changed

- **`_pendingBackgroundShells` documented as transient by design (#4417 / #4424):** v0.9.11 deferred the question of persistence across restart; this release makes it explicit. The Map is rebuilt from `Bash`/`BashOutput` events on the next foreground turn, so restart loses pending tracking only for the brief window between the shell launching and its first `BashOutput` — a tradeoff worth keeping for the operational simplicity of not writing transient state to disk. Docstring on `background-shells.js` now states this so the next reader doesn't re-relitigate it.

## [0.9.11] - 2026-05-28

Focused release shipping the long-standing dogfood pain point: TUI / SDK sessions waiting on a backgrounded shell no longer look idle/dead and can no longer be reaped by `CHROXY_SESSION_TIMEOUT`. Closes #4307 (the `priority:high` server bug) plus its dashboard renderer follow-up #4418, completing the user-visible feature in a single version.

### Added

- **Server tracks pending `run_in_background` shells per session (#4307 / #4416):** new `background-shells.js` module + Zod schema in `@chroxy/protocol`. `BaseSession._pendingBackgroundShells` is populated when a `Bash` tool result carries `"Command running in background with ID: <id>"`, cleared when a matching `BashOutput` arrives, and cleared on `destroy()`. Both `claude-tui` (PTY) and SDK providers ship with full parity. Exposed to clients via a new WS event `background_work_changed` *and* extended the session-list snapshot field so late-joiners catch up — store-core handlers mirror the `activeTools` pattern from #4308. Two follow-ups tracked: [#4417](https://github.com/blamechris/chroxy/issues/4417) (persist across restart or document as transient) and [#4418](https://github.com/blamechris/chroxy/issues/4418) (renderer — landed in this release).
- **ActivityIndicator surfaces "Waiting on background work" with command text (#4418 / #4419):** renderer companion to #4307. When `isIdle && pendingBackgroundShells.length > 0`, the dashboard chip shows the pending shell instead of "Idle". When `_isBusy === true`, the existing "Running <tool>" path still wins — pending shells are a secondary indicator during an active turn. Multi-shell case picks the most-recently-started one for the chip; full-list disclosure deferred to [#4421](https://github.com/blamechris/chroxy/issues/4421). Mobile-app surface deferred to [#4422](https://github.com/blamechris/chroxy/issues/4422); chip text overflow handling deferred to [#4420](https://github.com/blamechris/chroxy/issues/4420).

### Fixed

- **Waiting sessions are no longer reaped by `CHROXY_SESSION_TIMEOUT` (#4307 / #4416):** `BaseSession.isRunning` now also reports true when `_pendingBackgroundShells.size > 0`, so the idle-timeout skip-check in `SessionTimeoutManager` treats waiting sessions as not-idle. Operators running with the timeout enabled will no longer lose long-running background work. The 2h hard-cap (`base-session.js:53`) still applies — the assumption is that a real foreground turn will resume before then to surface the completion notification.

## [0.9.10] - 2026-05-28

Same-day follow-up to v0.9.9. Same theme — dashboard polish and dogfood-driven correctness — picking up everything #4396 spilled over, plus stale Codex context-window values, customizable keyboard shortcuts, and three small follow-ups to v0.9.9's thinking-keyword work.

### Added

- **Customizable keyboard shortcuts via Settings UI (#3852 / #4410):** shortcut registry (`packages/dashboard/src/shortcuts/`) with default bindings, rebind UI in the existing `ShortcutHelp` cheat sheet, key-capture input for capturing combos, conflict detection, and persistence across restarts. Scope-reduced from "migrate every shortcut" to "register one shortcut end-to-end + UI"; [#4412](https://github.com/blamechris/chroxy/issues/4412) tracks migrating the remaining hand-rolled shortcuts (Cmd+1-9, Cmd+Shift+[/], Cmd+W, etc.). In-PR critical fix: `App.tsx`'s `SHORTCUTS` useMemo dep was the stable registry reference, so a rebind didn't recompute the cheat sheet — now keyed on the effective bindings.
- **Codex context-window learn-loop + 100% compact-suggestion CTA (#3857 / #4411):** server now ratchets the registered context window upward when a Codex session reports a higher token total (capped at 2,000,000 with NaN/Infinity/negative input rejection), and the dashboard footer meter shows a "Try /compact" CTA when usage hits 100% — `prefers-reduced-motion` honoured on the over-budget pulse. Follow-ups [#4413](https://github.com/blamechris/chroxy/issues/4413) (persist ratchets across server restart) and [#4414](https://github.com/blamechris/chroxy/issues/4414) (extend to Gemini) are tracked.

### Fixed

- **ChatView state preserved across System-tab switch + skip hidden re-renders (#4397 + #4398 / #4408):** picks up the two follow-ups #4396 spilled over from #4305. The System tab now uses the same `display: contents` / `display: none` keep-alive pattern as Chat/Output, so `ToolGroup`/`ToolBubble` expand state survives switching to System and back. Separately, `ChatView` is wrapped in `React.memo` with a `Boolean(prev.hidden) && Boolean(next.hidden)` comparator that skips `renderMessage` entirely while hidden — long sessions no longer pay the re-render cost for the inactive pane. Always re-renders with latest props on the visible transition.
- **Thinking-keyword regex tightened to horizontal whitespace + reuse module-level regex (#4402 + #4404 / #4409):** v0.9.9's `\s+` between multi-word entries (`think\s+harder`) matched arbitrary newline runs, so "think" + Enter + "harder" across two lines would falsely escalate. Replaced with `[ \t]+` in both `detect-thinking-keyword.js` and `thinking-keyword-tokens.ts`. Also fixed the dashboard tokenizer cloning the module-level regex per call — it now reuses the module-level instance with `lastIndex = 0` between calls.

### Performance

- **InputBar overlay onScroll handler memoised (#4403 / #4407):** previously created fresh per render as an inline arrow function. Now wrapped in `useCallback` with a stable reference — same change applied to the gate's `tokens ? ... : undefined` form.

## [0.9.9] - 2026-05-28

Dashboard UX bug-bundle release. Focus areas: making the working session look alive (in-flight tool naming, spinners, thinking-keyword escalation) and fixing two long-standing chat/output rendering bugs that made dogfooded TUI sessions feel broken. Also adds the keyboard-only third leg of the sidebar context menu story (Shift+F10 / ContextMenu key) and several skill-template / process improvements for handling external contributors.

### Added

- **Thinking-keyword escalation + inline highlight (#4306 / #4401):** typing `think`, `think hard`, `think harder`, `megathink`, or `ultrathink` in the input now actually escalates the SDK session's `maxThinkingTokens` budget for that turn — mirroring the native Claude Code CLI behaviour. Each keyword is highlighted (uppercase / coloured) via an overlay/mirror technique in `InputBar.tsx`. Provider-gated: the legacy CLI provider (`thinkingLevel: false`) treats keywords as no-ops and skips highlighting, so the UI never lies about what's about to happen. New `detect-thinking-keyword.js` + `thinking-keyword-tokens.ts` modules with longest-match-first regex.
- **Per-session activity indicator names the in-flight tool (#4308 / #4399):** the `ActivityIndicator` now shows "Running Bash · 12s" / "Waiting on WebFetch" / the active sub-agent's description instead of a generic "Working…". Added `activeTools: ActiveTool[]` to `BaseSessionState` (store-core) — pushed on `tool_start`, popped by `toolUseId` on `tool_result`, cleared on `agent_idle` / `result`. `ToolBubble.tsx` now shows a running spinner in the collapsed header when there's no result yet.
- **Sidebar context menu opens via keyboard (#4392 / #4400):** the missing third leg of the keyboard a11y story for the sidebar context menu (PR #4369 was nav-within, PR #4390 was focus-restore). Pressing `ContextMenu` or `Shift+F10` on a focused session row, repo group header, or resumable row now opens `SessionContextMenu` positioned at the row's right edge. The handler `stopPropagation()`s so the tree-level key handler doesn't double-process.

### Fixed

- **Chat and Output panes stay mounted across tab switches (#4305 / #4396):** switching tabs used to unmount the inactive pane, which reset every `ToolGroup`/`ToolBubble`'s hook-local `expanded` state — producing a visible re-fold "jump" on switch and silently hiding trailing tool calls in the Chat tab that were visible in Output. Now both panes render with `display: none` toggling instead of conditional rendering, preserving expand state + scroll position across switches. Trailing tool groups stay expanded.

### Changed

- **Skill templates: external-contributor awareness (#4387, #4393, #4394):** Session Start Protocol now splits the open-PR review into yours (`gh pr list --author @me`) vs. external (`gh pr list --search "-author:@me"`) so contributor PRs can't get buried. `/tackle-issues` Phase 0 now pre-scans for open PRs referencing each queued issue and defers them instead of duplicating work in a parallel worktree. Placeholder issue #4394 tracks the stale-PR auto-close policy for when external contributions accumulate (currently 1 in flight — #4082).

## [0.9.8] - 2026-05-27

Same-day sweep release of the 16-PR follow-up marathon to v0.9.7. Focus areas: cross-client UX (chat composer history, sidebar Copy path, tri-state skipPermissions on CreateSessionModal, touch-friendly cost-gap tooltip), server-side correctness (byok abort-race + tool_start fallback parity, config-key rename with backwards-compat alias, opt-in Chroxy system-prompt context), mobile parity (unknown-permission-mode catch-all), a11y (SessionContextMenu keyboard nav, populated context menus for resumable rows), and several supporting refactors (import-type re-exports, build.rs cache key, supply-chain SHA pinning).

### Added

- **Up/Down history in chat composer (#3698 / #4379):** terminal-style recall of previous user messages from `InputBar.tsx`. Up at first/last-line boundary cycles back through history; Down moves forward; Escape (or Down past newest) clears to the draft. Per-session reset so switching sessions doesn't bleed history. Closed #3854 as a duplicate of #3698 via cross-reference comment.
- **Tri-state `skipPermissions` on CreateSessionModal (#4244 / #4368):** "inherit" (default) / "off" (require permissions) / "on" (dangerously skip). Lets users override a server-side default in either direction. Wire field stays boolean (`true`/`false`/`undefined`); the radio→payload mapping happens at submit.
- **`SessionContextMenu` keyboard navigation (#4248 / #4369):** WAI-ARIA menu pattern — Up/Down with wrap-around, Home/End, Enter/Space activate, Escape closes, focus returns to the trigger on close. Roving tabindex pattern; `role="menu"` + `role="menuitem"` on items.
- **Sidebar Copy path (#4268 / #4382):** new menu item on session rows + repo group headers writes the cwd to the system clipboard via `navigator.clipboard.writeText`. Capability-gated off when the session has no cwd. Toast on success/failure; works in both Tauri and browser dashboards.
- **Resumable rows now have menu items (#4249 / #4377):** prior to this, right-clicking a "Resumable" sidebar row opened an empty menu (silent dead-click). Now: Resume, Copy Conversation ID, Open in Finder (Tauri + cwd). Extracted the menu-item builder to `sidebarContextMenuItems.ts` so the per-target branch logic is unit-testable without rendering App.
- **Mobile catch-all for unknown permission mode (#4251 / #4376):** mobile app `PermissionPromptScreen` mirrors the dashboard #4019 catch-all so a future server-emitted mode renders the friendly hint instead of breaking the screen.
- **Touch-friendly disclosure for sidebar cost-gap tooltip (#4362 / #4371):** the v0.9.7 cost-gap hint (#4352) was hover-only — useless on iPad / touchscreen laptops. New `InfoDisclosure` component is tap-to-toggle, dismissed by click-outside or Escape; hover-on-pointer-mouse still works. PointerType-aware so a touch-tap doesn't flip-flop the popover closed via the synthetic mouseenter+click sequence.
- **Opt-in Chroxy system-prompt context hint (#3805 / #4380):** new server config flag `chroxyContextHint` (default OFF). When ON, every provider session prepends a short line letting the model know it's running inside Chroxy. In-PR critical fix plumbed the flag through 6 provider constructors so SDK/CLI/TUI/Codex/Gemini sessions all honor it consistently (and the session-manager restore path doesn't drop it).

### Fixed

- **`skipPermissions` survives provider switch (#4245 / #4375):** ticking the dangerous-flag radio for `claude-tui`, switching to `claude-sdk`, then switching back, used to leave the choice persisted with no fresh confirmation. Now: `useEffect` on `provider` resets the state to `'inherit'`, forcing a re-confirmation per provider switch.
- **byok phase-1 / phase-2 abort race in `_processToolBlocks` (#4247 / #4378):** abort firing between the gate (permission/approval check) and the schedule (actually run the tool) used to slip through and schedule the tool anyway. Re-check `aborted` between phases and emit a synthetic-abort `tool_result` if true; new `fillInterrupted` helper unifies the in-flight + inter-phase abort paths. Three timing-window tests pin every abort site.
- **byok `tool_start` fallback toolUseId parity (#4262 follow-up — #4364 / #4381):** v0.9.7's #4361 fixed the per-tool-id path, but the fallback (when `content_block.id` is missing) still emitted `toolUseId: undefined`, mismatching `sdk-session.js`'s parity (`toolUseId: messageId`). Now both paths match.
- **Strip stale `toolName` from byok-session test stubs (#4363 / #4374):** the 11 `_executeToolBlock` mock stubs still emitted `toolName: block.name` after v0.9.7's #4355 removed it from the production emit. Pure test cleanup, no behavior change.
- **`build.rs` speech-helper cache key tracks `APPLE_KEYCHAIN_PATH` (#4252 / #4366):** a keychain swap on the build machine now invalidates the cached signed helper so re-builds pick up the new identity instead of silently re-using the stale signature.

### Changed

- **Config: `skipPermissions` → `dangerouslySkipPermissions` (#4246 / #4383):** the CLI flag has always been `--dangerously-skip-permissions` (loud about its risk); the config key was just `skipPermissions` (gentle). Renamed for danger parity. Legacy key works with a `[security]` log-warn deprecation alias, no breaking change. Wire field unchanged. (Filed #4384 to add env-var binding for `CHROXY_DANGEROUSLY_SKIP_PERMISSIONS`, #4385 to document the rename in CONFIG.md.)
- **`getInputSummary` now used by ToolGroup too (#4259 / #4356):** dashboard ToolGroup migrated to the shared `@chroxy/store-core` helper that ToolBubble + mobile ToolBubble already use.
- **Sidebar context-menu items extracted to `buildSidebarContextMenuItems` (#4249 / #4377):** per-target-type branching is now pure and unit-testable, decoupling action wiring from the `App.tsx` render tree.
- **Refactor: `store/connection` re-export imports converted to `import type` (#4250 / #4370):** stricter TS treeshaking + isolatedModules correctness.
- **Security: `actions/setup-node` SHA-pinned via repo-relay v1.0.1 (#3819 / #4367):** upstream `blamechris/repo-relay` cut v1.0.1 with `setup-node` pinned by SHA. chroxy's CI now references it. Post-merge: `sha_pinning_required` re-enabled on the repo's Actions permissions.

## [0.9.7] - 2026-05-27

Sweep release of the 11-PR marathon following v0.9.6 dogfood. Focus areas: BYOK cost/protocol cleanup (cost-vs-token clarity, per-tool content_block IDs, redundant toolName strip), TUI prompt-write hardening (multi-byte, mid-loop PTY guard, bulk-write threshold), dashboard a11y (unnested ToolGroup interactive roles), voice-input portability (Web Speech API fallback for browser + Tauri-Win/Linux), and several store-core helper migrations that cut duplicate logic between dashboard and mobile.

### Added

- **Web Speech API fallback for dashboard voice input (#4350 / #4354):** `useVoiceInput.ts` now feature-detects `SpeechRecognition` / `webkitSpeechRecognition` and uses the browser-native engine when the Tauri macOS Swift bridge isn't available — closes the gap on browser dashboards, Tauri-Windows, and Tauri-Linux which previously had no voice input at all (macOS Tauri ✓, iOS ✓, Android ✓, everything else ✗ pre-fix). Cleanup on unmount, native error-name mapping (`no-speech` / `audio-capture` / `not-allowed` / `network`), `navigator.language` default, and a 369-LOC test suite cover the engine selection + error paths.
- **Tool-collapsed-preview testID + Maestro regression flow (#4260 / #4353):** Mobile `ToolBubble` gained a `tool-collapsed-preview` testID and a Maestro flow exercises it end-to-end. The current chat path actually routes `tool_use` through `ActivityEntry` (not `ToolBubble`), so the flow is intentionally a regression harness that will catch any future re-routing through `ToolBubble` — jest assertions remain authoritative for the current path.
- **Integration-level paste-heuristic stub for TUI prompt writes (#4271 / #4359):** New `paste-heuristic-pty-stub.js` helper plus a `claude-tui-session-paste-heuristic.test.js` integration suite. Pins down the bracketed-paste mode handshake (`ESC [ 200 ~` / `ESC [ 201 ~`) and the bulk-write threshold so future changes to `_writePtyTextThrottled` can't silently regress claude TUI's paste-detector workaround (#4269 / #4273 lineage).

### Fixed

- **TUI throttled prompt write hardened: multi-byte chars + mid-loop PTY exit + bulk-write threshold (#4274 / #4275 / #4276 → #4360):** Three #4273-line follow-ups bundled. `[...text].length` is now the source of truth for character counting so emoji and CJK fixtures (e.g. `'hi 😀 こんにちは 👋'`) don't miscount as multiple UTF-16 units; the throttle loop re-checks PTY state mid-loop so a destroyed session can't keep writing into a closed PTY; and prompts above `MAX_THROTTLED_CHARS = 8192` fall through to a bulk write instead of taking ~8 seconds to deliver. Six new tests cover all three paths plus the multi-byte fixture.
- **BYOK `tool_start` now uses per-tool `content_block.id` (#4262 / #4361):** byok-session was reusing the turn-level `messageId` as the `tool_start` ID for every tool in a turn, so two tools in the same turn collided on the client and the second tool's response text concatenated onto the first tool's bubble (per the `stream_id_collision` pattern). Now reads the per-tool `content_block.id` from Anthropic's stream events. Multi-tool-per-turn and stream_start cross-collision tests pin both regressions.
- **Visible-vs-billed token gap on BYOK cost badge (#4348 / #4352):** The cost badge previously left users wondering why a 147K visible-token session billed at $87 against the per-token rate. Added inline copy clarifying that Anthropic re-sends the full conversation context on every turn, so the bill scales with cumulative re-send + Opus 4.7 [1m]'s long-context premium ($30/$150 above 200K input), not the visible token counter.
- **ToolGroup interactive-role nesting violation (#4282 / #4357):** Outer `.tool-group` was `role="button"` while each entry row also carried `role="button"` — WAI-ARIA disallows nesting interactive elements, and NVDA / VoiceOver behavior was undefined. Outer container is now a plain `<div>` and the toggle moves to a real `<button class="tool-group-header">` that is a sibling of the entry list rather than an ancestor. Three new tests including a generic `button, [role="button"], a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])` DOM sweep guard against future regressions.
- **Redundant `toolName` stripped from byok `tool_result` emit (#4261 / #4355):** Client derives the tool name from the matching `tool_use`'s `toolName`, so the byok-session was emitting it twice on the wire. Wire-protocol audit confirmed no client ever read it (mobile/desktop both pull from the tool_use), so this is pure cleanup that brings byok-session in line with the sdk/cli emit shape. Sibling test stubs flagged as #4363 (11 mechanical edits, no behavior change).

### Changed

- **`getInputSummary` migrated from dashboard ToolGroup to `@chroxy/store-core` (#4259 / #4356):** `ToolBubble` already used the shared helper (#4243); `ToolGroup` was carrying a parallel local copy of the `command → file_path → path → description` priority logic. Now both dashboard surfaces import the same helper, and the mobile `ToolBubble`'s field-priority extraction stays in lockstep through the same source.
- **`toolInputPartial` truncation tracked via explicit boolean (#4263 / #4358):** Client-side accumulator state previously marked truncation by string suffix (`...[truncated]`), which had a small but real false-positive risk if a tool's input legitimately contained that literal substring. Now an explicit `toolInputPartialTruncated` boolean on `ChatMessage`. Rehydration from older client state still detects the legacy suffix for backwards compat — that fallback can be dropped after one minor-version cycle.
- **`packages/server/src/dashboard-next/` gitignored (#4267 / #4351):** Generated dashboard build artifacts no longer surface as untracked files during dev.

## [0.9.6] - 2026-05-25

Sweep release bundling the dogfood findings from v0.9.5: 14 marathon PRs (cross-provider transition test, in-flight tool naming, tail-group / singleton tool expansion, bracketed-paste in finally, codex/gemini OAuth preflight, AskUserQuestion answer-flow, mobile parity, and several refactors) plus four follow-ups filed during the v0.9.5 dogfood loop (slash-command picker Enter swallow, ToolGroup streaming-input visibility, ActivityIndicator perf/coverage refinements, disabled-provider affordance). All small, all targeted, no behavior regressions; the dashboard now feels noticeably more responsive on answer-send and on long-running Agent tools.

### Added

- **In-flight tool naming on dashboard ActivityIndicator (#4308):** "Working… last activity 12s ago" became "Running Bash · 12s" — the indicator walks `messages[]` backwards for the most-recent unresolved `tool_use` and names it. MCP tools format with the `Server: Tool` prefix (#4318). Falls back to the original "Working…" label when no tool is in flight (assistant text between tools). Also names the in-flight tool in the connect-race branch where `lastActivityAt == null` (#4320), so users get "Running Bash" instead of a generic "Working…" the moment a tool_start arrives.
- **Mobile parity for in-flight surfaces (#4321 / #4333):** Same in-flight tool naming, same pulse marker. Same predicate (`result !== undefined || resultImages.length > 0`) across dashboard ToolGroup / ActivityIndicator / ToolBubble and the mobile equivalents — all three surfaces now agree on "is this tool still running."
- **OAuth-credential preflight for codex / gemini providers (#4301 / #4335):** `providers.js` now probes `~/.codex/auth.json` and `~/.gemini/oauth_creds.json` (with the env-var path taking precedence as before). Disabled-provider hints in `CreateSessionModal` were rendering as literal-backtick text — now there's a warning-toned help panel below the dropdown (#4340) that renders the hint with `<code>` formatting, surfaces the `auth.detail` underneath, and stays focusable via `role="status"` for assistive tech.
- **Cross-provider transition test for sendSessionInfo (#4315):** Locks in the v0.9.5 `available_models` push fix — switching providers mid-session re-pushes the model registry under the new provider scope.

### Fixed

- **ToolGroup tail same-render flip latching (#4314):** The #4309 mitigation that kept tail groups expanded broke when a single render flipped `isActive: true → false` AND `isTail: true → false` together (response message arriving in the same batched store update as `stream_end`). Effects fire in declaration order on the same commit, so an effect-updated `isTailRef` would already reflect `isTail: false` by the time the `[isActive]` effect ran — collapsing the trailing group immediately. Latching `isTail` inline during render fixes it.
- **Singleton trailing tool_use stays expanded (#4313):** Tail-group expansion (#4309) was a `ToolGroup` mitigation, but singleton activity runs (1 tool, no group wrapper) bypassed it entirely. `ToolBubble` now takes an `isTail` prop and mounts expanded when true — closes the 1-tool gap that left Chat tab collapsed while Output rendered the tool inline.
- **AskUserQuestion answer-flow visibility (#4312):** Two symptoms, one PR. (1) The option block now collapses to a one-line `✓ <chosen label> ▸` chevron summary once answered (re-expandable for inspection); claude's prose preamble stays visible. (2) `sendUserQuestionResponse` now optimistically flips the active session to `isIdle: false` and bumps `lastClientActivityAt` on send — mirroring `sendInput`'s behavior — so the dashboard reads "running" immediately instead of looking idle in the gap between answer-send and the next server-emitted stream event. Pre-fix the answer was being delivered (#4296 Output echo proved it) but the chat UI made it look dropped.
- **ToolBubble pulse for images-only tool results (#4317):** Computer-use screenshots and browser tools that return base64 images leave `result === undefined` but populate `toolResultImages`. The pulse was treating that as in-flight and never stopping. Now uses the same `result !== undefined || resultImages.length > 0` predicate as ToolGroup and ActivityIndicator.
- **ToolGroup streaming input visibility (#4341):** Expanded `ToolGroupEntry` no longer shows "(no input)" for in-flight streaming tools (Agent in particular, whose prompts arrive via `tool_input_delta`). Falls through to `toolInputPartial` via the same shared `tryParseCompleteJson` path `ToolBubble` already used, with a `data-streaming="true"` hint for styling. Truly inputless tools still render the placeholder.
- **Slash-command picker swallows Enter when 'No commands found' (#4342):** Typing a non-matching slash (e.g. `/tackle-issues`, which is a local project skill not broadcast over WS) opened the picker, showed "No commands found", then ate every subsequent Enter. Fixed by closing the picker and falling through to the standard send path when the filtered list is empty.
- **Bracketed-paste mode restored in finally for TUI throttled write (#4287):** `_writePtyTextThrottled` now wraps the for-loop in `try { … } finally { try { this._term.write('\x1b[?2004h') } catch {} }`. Abort or throw mid-loop no longer leaks the disabled-paste-mode state. Tests cover the abort-mid-loop, throw-mid-loop, and double-throw cases.
- **`sendSessionInfo` null-provider test comment correction (#4316):** Comment was misleading about the handler's reset-to-null behavior; updated to match `message-handler.ts`.

### Changed

- **Shared `formatToolName` in ToolBubble (#4318):** `ToolBubble` now imports the shared `@chroxy/store-core` helper instead of carrying a local copy, and threads `serverName` through so MCP tools render with the server prefix consistently across the bubble header, ToolGroup summary, and ActivityIndicator chip.
- **ActivityIndicator narrowed selector (#4319 / #4336):** Replaced the full-`messages[]` subscription with a single `useShallow`-projected selector returning `{ tool, startedAt, serverName }`. One walk per store change instead of three, same re-render guarantee.
- **Test-helper sharing for in-flight predicate (#4337 / #4339):** `findInFlightToolUse` is now exported so the `#4319` test block asserts against the real predicate instead of an inline copy; added non-MCP `serverName` fixtures to ActivityIndicator + ToolBubble tests so the `${serverName} ${formatted}` branch of `formatToolName` is actually exercised (existing MCP fixtures bypass it).
- **TUI `respondToQuestion` rename (#4294):** Local `payload` → `writeText` so the variable name matches what it actually carries. Pure rename, no behavior change.
- **Dead `onKeyDown` removed from Thinking ToolGroupEntry (#4284):** The Thinking entry is non-focusable so the keydown handler was unreachable. Removed plus a regression test asserts the non-focusable invariant stays.

## [0.9.5] - 2026-05-26

Same-day patch bundling two visibility fixes from v0.9.4 dogfood. Both surfaced once AskUserQuestion was actually resolving correctly (#4290 / v0.9.4) and the rest of the chat flow could be observed end-to-end. Neither is a hard blocker — they're "the data was right, the rendering wasn't" — but together they made the Chat and Output tabs mutually contradict each other after every TUI turn that used tools.

### Fixed

- **Chat tab now renders claude's summary AFTER the tools it summarizes (#4297 / #4298):** `claude-tui-session.js` fires `stream_start` at turn-start (#4010) so the Stop button shows up the moment a turn begins, even when the turn opens with a tool call. The dashboard's `handleStreamStart` was appending an empty response slot at the front of `messages[]` right away; subsequent `tool_start` / `tool_result` events appended *after* that slot. When the final summary `stream_delta` arrived, the text materialized at the early slot's array position — making claude's wrap-up render *above* the tool groups it had just summarized. Fix: on the first `stream_delta` for a response slot whose `content === ''`, move that slot to the current end of `messages[]`. Gated tightly — reconnect-replayed slots (`content !== ''`) are never shifted; the post-permission-split and tool_use-collision paths already append at the end so they skip via the deltaId-remap check. Chat tab now matches Output-tab chronological order.

### Added

- **Output tab now echoes the user's AskUserQuestion answer (#4296 / #4299):** Pre-fix, the Output tab showed the AskUserQuestion tool_input JSON, then immediately the next tool fired with no record of which option the user picked. The `user_question_response` wire send happened invisibly. Fix: in `sendUserQuestionResponse`, append a cyan-tinted `> User answered: <answer>` line to the terminal buffer (matches the existing yellow user-prompt echo shape from `sendInput`) before the wire send, so the echo is present even when the socket queues. Works identically for option-pick (resolved label) and freeform "Other" (custom text). Empty answers skip the echo defensively.

## [0.9.4] - 2026-05-26

Same-day follow-on to v0.9.3 fixing the actual-answer-resolution side of the AskUserQuestion handler. v0.9.3 surfaced the question via the dashboard's QuestionPrompt UI and unblocked the silent-hang, but writing the chosen label text to the PTY caused claude TUI's prompt parser to single-character-jump-navigate through the menu and resolve to the wrong option ("Other" with empty custom text). Empirical trace + diagnosis in #4288.

### Fixed

- **TUI AskUserQuestion now resolves to the correct option (#4290 / #4291):** `respondToQuestion` writes the **1-indexed option number** (e.g. `2\r`) when the chosen label matches one of the structured options. claude TUI accepts numbered shortcuts as direct hotkey selection; label text triggered the jump-navigation bug. Single-digit guard limits the index strategy to options 1–9 (10+ falls through to label text since multi-digit hotkeys are unsafe to assume — most single-keystroke menus commit on the first digit) (#4292). Custom / Other path (user picked "Other" in the dashboard and typed freeform text) is unchanged — still falls through to writing the text literally, which may still mis-parse; tracked separately at #4288.

## [0.9.3] - 2026-05-25

Same-day patch surfacing two dogfood findings from v0.9.2 — both surfaced once the #4269 char-throttle landed and TUI sessions actually started streaming long prompts. One server bug (turn hang on AskUserQuestion), one dashboard UX gap (couldn't inspect tool calls in the chat group). v0.9.3 is intentionally a "test these in dogfood" release; full polish lives in follow-up issues.

### Added

- **TUI AskUserQuestion handling (#4278 / #4285):** TUI sessions previously had zero handling for AskUserQuestion — claude TUI called the tool through its own TTY-style prompt inside the PTY; chroxy emitted only a generic tool_start; no QuestionPrompt UI ever rendered; the turn hung until the inactivity hard timeout fired ~2 hours later. Now PreToolUse for AskUserQuestion emits a `user_question` event alongside the tool_start so the dashboard renders its existing QuestionPrompt UI, and a new `respondToQuestion(text)` on `ClaudeTuiSession` writes the chosen answer back to the PTY using the same per-character throttle from #4269. Lifecycle exits (`interrupt`, `destroy`, `_finishTurnError`, `_handleHardTimeout`) all clear the answer slot for symmetry (#4286). MVP — we write the chosen label text and hope claude TUI's prompt accepts it; #4288 tracks the empirical question for follow-up if rejected in practice.

### Changed

- **Per-entry expansion in ToolGroup (#4279 / #4280):** inner ToolGroup entries are now individually expandable to reveal the full `toolInput` and `toolResult` for each tool call — and crucially, clicking an entry no longer collapses the whole group. Pre-fix the entry row had no `onClick`, so every click bubbled to the parent group's toggle, and entries only rendered a truncated `getInputSummary(toolInput)` with `toolResult` never shown anywhere. Now each entry is a row-as-button with stop-propagation; the detail panel renders both input (JSON-formatted) and result (raw text, or `(no result yet)` placeholder), and multiple entries can be open simultaneously. Detail panel max-height tuned to sit below the outer list's scroller (#4281, #4283). Follow-ups: #4282 (nested role="button" a11y), #4284 (dead onKeyDown on Thinking row).

## [0.9.2] - 2026-05-25

Same-day patch fixing #4269 for real. v0.9.1's bracketed-paste-mode toggle (#4270) did not work — claude TUI does not respect DEC mode 2004 and runs its own paste detector based on byte-arrival rate. A single bulk write of the whole prompt collapses into a `[Pasted text #1 +N lines] paste again to expand` placeholder that chroxy never confirms, hanging the turn silently. Diagnostic confirmation came from dogfood: a single-word prompt (`hi`) submitted fine through the same code path, while a 600-char prompt hung every time — isolating the trigger to byte-arrival rate, not multi-line content, not mode toggles.

### Fixed

- **TUI prompt write still triggered claude's paste detector after #4270 (#4269/#4273):** replace the single `pty.write(prompt + '\r')` with a per-character throttled loop (`PROMPT_CHAR_DELAY_MS = 1`) so bytes arrive at typing speed. ~1 ms × prompt-length of one-time latency before claude starts (imperceptible during interactive use). The bracketed-paste mode toggles from #4270 are kept as defense-in-depth for any claude version that does honor mode 2004 — they cost 16 bytes per prompt. The loop also re-checks `_activeTurn.aborted` between chars so Stop mid-prompt terminates cleanly.

## [0.9.1] - 2026-05-24

Same-day patch fixing a `claude-tui` provider regression that v0.9.0 dogfood surfaced. TUI sessions hung silently on the first prompt — Output tab showed only the echoed input, no streaming, no tool calls, no error — until the inactivity hard timeout fired ~2 hours later. Root cause was on the claude side (TUI v2.1.147 added paste-detection that interprets chroxy's PTY write as a clipboard paste), but the fix is in chroxy. No other v0.9.0 features are affected.

### Fixed

- **TUI prompt write triggered claude TUI's paste detection → prompt never submitted (#4269/#4270):** wrap the `pty.write(prompt + '\r')` in bracketed-paste mode disable/re-enable sequences (`ESC [ ? 2004 l` ... `ESC [ ? 2004 h`) as a single atomic write. Tells claude TUI "this is typed input, not a paste" so the `[Pasted text #1 +N lines] paste again to expand` placeholder UX doesn't apply. Re-enable preserves the paste UX for any subsequent human-pasted content (e.g. a terminal multiplexer attached to the same PTY).

## [0.9.0] - 2026-05-24

A minor release covering ~87 commits since v0.8.6. (v0.8.7 was a same-day narrow TUI-readiness-probe release on 2026-05-21; everything below has accumulated since.) Two headline themes carry the version bump.

**1. `claude-byok` provider lands (epic #4047).** Chat-only core in #4055, full builtin toolset in #4060 (Read/Write/Edit/Bash/Glob/Grep), then WebFetch (#4131) and TodoWrite (#4136) extend the tools, and the paste-API-key form (#4140) gives the dashboard the credential-input UI. The provider talks Anthropic's `@anthropic-ai/sdk` directly — chroxy IS the agent loop, no `claude` binary in the path. Round-tripping fixes (#4108/#4115/#4129) and APIUserAbortError detection (#4093) harden the loop; #4145/#4176 surface `MAX_TOOL_ROUNDS` to model and user via a non-fatal toast.

**2. Session cost/usage tracking suite.** The BYOK provider emits per-result `usage`/`cost` (#4083), SessionManager accumulates per-session totals + emits `session_usage` (#4088), the dashboard sidebar (#4119) and mobile session header (#4121) both render cost badges with breakdown details, a configurable soft-warning threshold lights up over the limit (#4122), persistence across server restart (#4128), and `[1m]` long-context premium pricing is computed correctly across fallback paths (#4087/#4103/#4114). #4126 dedupes `formatCost*` helpers to `@chroxy/store-core` so all surfaces format identically.

Beyond those, the `tool_input_delta` wire (#4080/#4081) is now end-to-end across server/store-core/dashboard/mobile, TUI `--dangerously-skip-permissions` is plumbed through SessionManager + CLI + modal (#4044/#4207/#4235), and WebFetch ships with SSRF hardening (#4132/#4165/#4167/#4184/#4185/#4186/#4187/#4197) + userinfo stripping with audit trail (#4133/#4158/#4160/#4182/#4183/#4198).

### Added

- **`claude-byok` provider — chat-only core + tools (epic #4047):** chat-only core via `@anthropic-ai/sdk` directly (#4055); full builtin toolset Read/Write/Edit/Bash/Glob/Grep (#4060); WebFetch tool (#4050/#4131); TodoWrite tool (#4051/#4136); paste-API-key form for credential input in the dashboard (#4052/#4140). Replaces the `claude -p` subprocess path for users who supply their own Anthropic API key.
- **Session cost/usage tracking suite:** cumulative session usage/cost accumulator + `session_usage` event (#4072/#4088); per-result cost emit on BYOK result events (#4056/#4083); dashboard sidebar cost badge with hover breakdown for BYOK sessions (#4119); mobile session-header cost badge with tap-to-expand breakdown sheet (#4121); configurable session-cost threshold soft warning (#4122); cross-restart persistence of `cumulativeUsage` + `costThresholdNotified` (#4128); selector-based `cumulativeUsage` slice for sidebar memo perf (#4130); `MAX_TOOL_ROUNDS_REACHED` non-fatal warning toast (#4148/#4176); `MAX_TOOL_ROUNDS` cap surfaced to model + user (#4063/#4145); `session_usage` + cost-threshold protocol docs and Zod schemas (#4091/#4095/#4127); ws-server protocol comment for `session_usage` (#4090/#4094); long-context premium pricing for `[1m]` variants with `claude-3.5-sonnet[1m]`-style synth (#4087/#4103); pricing-table-drift warn for synthesized `[1m]` variants (#4113); `formatCostBadge` + `formatCostBreakdown` deduped to `@chroxy/store-core` (#4126).
- **WebFetch hardening + audit trail:** auto-mode bypass disclosed in tool description (#4135/#4157); strip userinfo from URL before fetch + echo (#4133/#4158); WebFetch URL line marked when userinfo was stripped (#4160/#4182); userinfo-source marker names the source URL (#4183/#4198); redirect scheme validation + SSRF posture (#4132/#4165); expanded SSRF block-list + boundary test coverage (#4167/#4184); SSRF block-list extracted to a dedicated module with IPv6-mapped tests (#4185/#4186/#4187/#4197); Content-Type charset respected (#4134/#4161).
- **`tool_input_delta` end-to-end wire (#4080/#4081):** server emits `tool_input_delta` events with toolUseId tracking (#4233); store-core handler accumulates per-tool partial JSON with a length cap to prevent runaway growth (#4241/#4255); dashboard and mobile `ToolBubble` render the streaming buffer with field-priority preview extraction shared from `@chroxy/store-core` (#4242/#4256, #4243/#4258, #4254). Bash early-abort (#4063) now lights up identically on web and React Native.
- **TUI `--dangerously-skip-permissions` plumbing (#4044/#4207/#4235):** session option, SessionManager wiring, CLI flag, and create-session modal all support the per-session override of the server default.
- **TodoWrite end-to-end renderers:** structured renderer for `TodoWrite` tool_results on the dashboard (#4139/#4179); mobile chat renderer (#4180/#4194); Maestro flow + mock-server fixture pinning the wire path (#4195/#4200); wiring into `ActivityEntry` so the mobile renderer engages (#4201/#4202); reject duplicate ids in a single `TodoWrite` call (#4138/#4155); clear `_todos` on session destroy (#4137/#4152).
- **Stale-credentials env-wins notice:** surface stale `credentials.json` when env wins precedence (#4144/#4174); broaden BYOK stale-file notice to the missing+fileExists case (#4175/#4222).
- **Header/footer chip tooltips:** explanatory tooltips on header/footer status chips (#3858/#4204); wire in/out token breakdown into the context-chip tooltip (#4205/#4230).
- **Sidebar right-click context menu (#4236):** Tauri-backed context menu with `reveal_in_finder` and `require_main_window` capability gate.
- **`PERMISSION_MODES.description` surfaced across surfaces (#4019/#4211/#4213/#4225/#4227/#4232):** descriptions render in dashboard picker, mobile SettingsBar, and create-session modal with per-option title parity.
- **`ServerByokCredentialsStatus` Zod schema (#4141/#4220):** schema-validated BYOK credentials status with dashboard `safeParse` adoption.
- **`ServerErrorEnvelope` typed `fatal` field (#4178/#4191/#4196):** discriminates fatal-vs-recoverable errors on the wire, exported as `ServerErrorEnvelopeMessage` type alias.
- **Provider built-in slash commands in picker (#4237):** dashboard slash-command picker now surfaces provider-built-in commands alongside user commands.

### Changed

- **Parallel `tool_use` execution in BYOK provider (#4238):** byok-session runs parallel tool_use blocks concurrently instead of serially.
- **Single source of truth for client-estimated-cost providers (#4229):** dashboard status-tooltips and message-handler share one set (`codex`, `gemini`).
- **FooterBar cwd updates on tab switch (#4029/#4218):** dashboard footer cwd no longer goes stale when switching session tabs.
- **`_cwdRealCache` + `_pricingWarnedModels` cleared on session destroy (#4153/#4221):** prevents cross-session bleed when a long-lived server destroys + recreates the same provider session.

### Fixed

- **BYOK `tool_start` wire shape (#4240/#4257):** byok-session emits now match what `event-normalizer` reads (`tool`/`input` rather than `toolName`) so the field arrives on the wire instead of as `undefined`.
- **BYOK turn atomicity on stream failures:** atomically roll back the entire turn on stream-init throw (#4115); roll back the turn on async-mid-stream throws at round ≥ 1 (#4129); BYOK history invariant on mid-loop tool abort (#4061/#4108); detect `APIUserAbortError` class on BYOK aborts (#4057/#4093).
- **Pricing resolution for dated full ids + warn-once per session (#4084/#4085/#4101):** preserves `[1m]` premium tier across fallback resolution paths (#4114); Sonnet/Haiku base-rate stickiness regression-test pinned (#4112); `resolvePricingKey` date-strip negative-form regex pinned (#4111).
- **`bash-exec` SIGKILL grace guard (#4067/#4092):** test asserts liveness, not the `killed` flag — the prior assertion was a false positive on macOS.
- **Explicit `--keychain` to `codesign` in build.rs (#4231):** Tauri desktop builds pass the keychain path explicitly so signing doesn't fall through to the default keychain in CI.
- **`bump-version.sh` syncs Cargo.lock with Cargo.toml (#4228):** version bumps no longer leave the Rust lockfile pinned to the previous version.
- **ActivityEntry images-only placeholder (#4203/#4223):** expanded body renders a placeholder when the entry contains images only (no text).
- **`errFatal` typo degrade contract pinned (#4193/#4199):** test asserts the dispatch-level degrade behaviour so future typos in the fatal-flag don't silently change UX.

### Internal

- **byok-session test coverage expansion:** real `_executeToolBlock` end-to-end coverage for the BYOK agent loop (#4149); real-executor coverage for Write/Edit/Bash/Glob/Grep (#4150/#4171); real-executor coverage extended with permission-gate paths (#4151/#4173); two-round tool-dispatch helper extracted for e2e tests (#4172/#4190); `MAX_TOOL_ROUNDS` summary-failure + abort event sequences pinned (#4147/#4168); `APIUserAbortError` swallow on cap-summary stream-init pinned (#4170/#4189); summary `finalMessage()` rejection branches pinned (#4169/#4188).
- **Defensive cost tests bundle (#4098/#4099/#4100/#4117/#4125):** SessionManager `_trackCost` integration via result-event wire (#4086/#4097) and a defensive-rounds suite covering currency-precision, threshold-crossing, and missing-pricing-table degradation.
- **Test backfill across packages:** TUI attachment-cap warn lines (#4216/#4224), CreateSessionModal description-vs-fallback precedence (#4214/#4225), per-option title parity on permission-mode picker (#4212/#4227), permission-hook.sh sidecar-file integration (#4020/#4234), block-type-tracking design boundary documented in translator JSDoc (#4059/#4219).
- **Pop-first iteration in attachment truncation (#4027/#4217):** algorithmic cleanup, no behaviour change.
- **`MAX_ATTACHMENT_SUFFIX_BYTES` truncation logging (#4026/#4215):** logs when the cap is hit so silent truncation is observable.
- **README note on Linux Tauri dep resync (#3931/#4226):** maintainer-facing reminder for cross-distro builds.

## [0.8.7] - 2026-05-21

End of the TUI readiness probe iteration series (#4014/#4031/#4035/#4039). The screen-scrape approach was fundamentally chasing a moving target — claude TUI renders its input prompt inside a bordered box with status widgets below it, so a "glyph at trailing edge" regex never matches, and a looser "glyph anywhere in window" regex false-positives on welcome text. Dogfood on v0.8.6 hit exactly this: every probe missed, the spawn warmup warn fired at 15s, the per-turn warn fired at 5s, the prompt bytes ended up in the input box but never submitted (the user's typed text "Hello this is a test..." sat there for ~4 minutes until they hit Stop).

This release adopts #4030's PID-file readiness spike: claude TUI already writes `~/.claude/sessions/<pid>.json` with a `status` field on every state transition — the same file `claude ps` reads. Polling that field is kernel-backed, atomic, and decoupled from any TUI rendering change.

### Fixed

- TUI readiness probe now reads claude's per-PID session file (`~/.claude/sessions/<pid>.json`) for `status !== 'busy'` instead of pattern-matching the rendered output. Resolves the v0.8.6 dogfood failure where both the spawn-warmup probe (15s) and the per-turn probe (5s) timed out on every turn and the prompt write landed in an unready PTY (#4040).

### Internal

- `_waitForPrompt` simplified to a 10-line file poller. The glyph constants (`PROMPT_GLYPHS`, `PROMPT_GLYPH`, `PROMPT_TAIL_WINDOW_CHARS`, `promptGlyphAppearsIn`) are removed — no external consumers, and the experimental verification in this PR confirmed claude TUI no longer emits a single recognizable prompt glyph at the trailing edge anyway.
- New static helpers `sessionFilePath(pid)` and `readSessionStatus(filePath)` are exposed so tests + future callers can probe claude's session-state file without re-implementing the path/parse.
- Hex-dump diagnostic is retained but decoupled from the (now-removed) probe window — caps at `PTY_TAIL_DIAGNOSTIC_BYTES` (1024) so log lines stay bounded.
- Readiness-probe test section rewritten end-to-end: 8 probe behavior tests + 4 hex-dump tests + 4 sendMessage integration tests, all against a temp `HOME` so they don't touch the real `~/.claude`.

### Verified

- Live experiment against `claude` 2.1.147 under node-pty: session file appears within ~600ms post-spawn, `status` transitions `idle → busy → idle` cleanly per turn, `\r` (carriage return) correctly submits, `\n` does NOT submit (so chroxy's existing submission byte was already correct — the v0.8.6 "typed but not submitted" symptom was a write-before-ready race that this probe fixes).

## [0.8.6] - 2026-05-21

Second hotfix in the TUI readiness probe series. v0.8.5's broadened probe was still too permissive — it accepted any line-anchored glyph anywhere in the trailing 1024 chars, including welcome-screen text like `> example` or `❯ bullet`. The probe would succeed at 563ms (well before cold claude actually rendered its input box), we'd write the prompt into the void, and the turn would sit at "Working..." until the 2-hour hard-timeout backstop fired.

### Fixed

- TUI readiness probe now requires the glyph to be at the **trailing edge** of the search window, with only whitespace allowed after it. The real claude TUI input prompt is always the last thing on screen — anything followed by more content is welcome-text, examples, or tool output, not the cursor's resting place. Implemented as a per-glyph regex `/(?:^|\n)<glyph>\s*$/` so a glyph deeper in the welcome text never wins, while trailing-cursor whitespace still passes. Encoding the optional whitespace in the regex (rather than trimming first) preserves the trailing space that's part of the `"> "` glyph (#4035).

### Internal

- New regression tests cover the welcome-text false-match (4 fixtures) and trailing-edge acceptance with various whitespace tails (6 fixtures).

### Longer-term

- #4030 — clarp-inspired PID-file readiness still the right answer. This is the third tactical probe iteration; the spike replaces screen-scraping entirely. Two follow-ups filed during this PR's review (#4037 docstring drift, #4038 regex caching) are queued but not in this release.

## [0.8.5] - 2026-05-20

Hotfix on top of v0.8.4. Targets the TUI readiness probe that was missing on real dogfood — without this, the Send button correctly toggles to Stop (#4010) but the prompt never lands in the input box (#4031). Tactical fix; the proper solution is the PID-file readiness spike tracked in #4030.

### Fixed

- TUI readiness probe: glyph match broadened to handle real claude TUI variants (`❯ `, bare `❯`, ASCII fallback `> `), and all candidates are now line-anchored so `> ` doesn't false-positive against markdown blockquotes in assistant prose. ANSI strip broadened from CSI-only to also cover OSC, SS3, single-char terminal-mode escapes, and stray C0 control bytes — the original strip left control codes interleaved with the glyph and broke the substring match. Search window widened from 256 → 1024 chars because claude TUI's startup splash + redraw cycle is larger than the original budget assumed (#4031).
- TUI readiness probe: on timeout, the warn log now includes a hex+ASCII dump of the trailing scan window so the actual bytes are visible. No more "probe missed, why" guess-and-rebuild loops. The dump reads the parallel raw-byte buffer (added in this PR) rather than the stripped tail, so OSC/SS3/control codes that may have caused the miss show up (#4031).

### Internal

- `PROMPT_TAIL_WINDOW_BYTES` renamed to `PROMPT_TAIL_WINDOW_CHARS` — backwards-compat shim preserves the old name. JS string slicing operates on UTF-16 code units, not bytes, so the old name was technically incorrect.
- New `_outputTailRaw` Buffer populated alongside `_outputTail` in the `onData` handler, so the diagnostic dump can show ANSI/control bytes that the strip-then-store path would otherwise hide.

## [0.8.4] - 2026-05-20

Adds the new **claude-tui provider** (drives the interactive `claude` TUI under a PTY so the round-trip bills as a subscription instead of programmatic) and a **check-in flow** that replaces the previous "kill the session on inactivity" behaviour with a soft prompt the user can dismiss. Plus the usual stream of Codex, dashboard, mobile, and ops-visibility polish that landed since v0.8.3.

### Added

- **claude-tui provider** — new `ClaudeTuiSession` drives the interactive `claude` CLI under `node-pty` so each round-trip bills as subscription rather than programmatic (`claude -p` and the Agent SDK switch to programmatic pricing on 2026-06-15; the TUI path is untouched). Persistent-process shape: spawn once, write each prompt to the same PTY, read Stop hook payloads. Surfaced in the CreateSession provider picker, mobile pill chip, and SessionPicker long-press alert (#3902/#3916/#3932/#3936/#3941/#3942).
- **Check-in flow replaces inactivity-timeout kill** — sessions that sit idle now emit an `inactivity_warning` and surface a check-in chip in dashboard and mobile, instead of killing the session. The hard timeout (`hardTimeoutMs`) is now broadcast on `auth_ok` so clients can show a backstop countdown. The CLI provider's result-timeout is now activity-based with a 30-minute default (#3892/#3899/#3901/#3905/#3908/#3913/#3926).
- TUI session: mid-session permission-mode switch. `ClaudeTuiSession` declares `permissionModeSwitch: true` and writes the current mode to a sidecar file the permission hook script re-reads on every tool call. Unlike `CliSession`'s restart-based approach, this preserves the resumed conversation context — flipping `approve` → `auto` mid-session does NOT kill and respawn the TUI (#4013).
- Permission-mode picker now shows clearer labels and a dynamic inline hint. The `auto` description explicitly names `claude --dangerously-skip-permissions` so users searching for that Claude CLI flag find the chroxy equivalent (#4013).
- TUI attachment passthrough preserves common compound extensions on disk (`.tar.gz`, `.tar.bz2`, `.tar.xz`, `.tar.zst`); prompt-suffix is capped at 8KB with a "...and N more file(s) omitted" marker for pathological cases — guards against future path-generation regressions producing a suffix large enough to stress PTY line-discipline buffers (#4023, #4024).
- Codex: `CHROXY_CODEX_SANDBOX` env var now overrides the default sandbox at spawn time (#3847). Invalid values warn once per spawn rather than spamming the log on every refusal (#3981).
- Codex: resume thread across turns now works correctly, with idle-push dedupe so a re-attached client doesn't see duplicate notifications (#3867).
- Dashboard: turn queue accepts attachment-only follow-ups (no text required) (#3903).
- Dashboard: `Cmd+L` / `Ctrl+L` clears the composer — text, queued attachments, image attachments, and collapsed paste blocks all together (#3883).
- Dashboard: bare `http(s)://` URLs in markdown are now autolinked (#3882).
- Dashboard: header picker tooltip surfaces the model name and context-window size (#3888).
- Server: `/diagnostics` endpoint gains a `?logTailBytes=N` query param so callers can request a specific tail size (#3739). The same endpoint now has a per-IP rate limit so a single noisy debugger can't pin the chroxy CPU (#3978).
- Server: `RateLimiter` gains lazy-reap on `check()`, per-IP map size cap, eviction-event metering, and windowed eviction-rate stats so ops can spot bucket churn (#3994/#3997/#4002/#4004/#4005).
- Mobile: pill chip on the SessionPicker now shows a provider hint (TUI, SDK, CLI, Codex) so the user can tell at a glance which back-end is running (#3940).
- Mobile: legend covers `source='none'` and a11y polish (#3690).

### Fixed

- TUI session: Stop button now appears the moment a turn starts instead of only after it completes. Pre-fix, `stream_start` was deferred until the Stop hook arrived, so a stuck turn left the dashboard thinking the session was idle and the user had no UI escape hatch (#4010).
- TUI session: prompts no longer race the input box. Replaced the hardcoded 3.5s warmup sleep with a readiness probe that watches `_outputTail` for the input-prompt glyph; same probe runs per-turn before every PTY write. Fixes the "first send stalls" and "second turn stalls indefinitely" classes — both caused by writing bytes to a TUI that hadn't finished re-rendering its input box (#4014, also hardens #4010).
- TUI session: attachments are no longer silently dropped. Each attachment is materialized to a per-turn directory under the session's sink dir, and the prompt grows a structured single-line suffix naming each file by absolute path. The spawned `claude` can then read the files via its Read tool — no inline multimodal-block support required from the underlying claude binary (#4012).
- TUI session: per-turn attachment dirs are now removed on every turn exit (success, abort, `_finishTurnError`, hard timeout, PTY-exit-mid-turn). Long sessions with many large attachments would otherwise have accumulated significant disk under `os.tmpdir()` (#4022).
- Mobile (iOS): treat `AppState='inactive'` as visible to keep the WebSocket attached. Pre-fix, brief lock-screen / Control-Center triggers were tearing down the WS and forcing a reconnect on resume (#3672).
- Desktop: Tauri quit now sends SIGTERM to the child chroxy server so the port releases cleanly. Pre-fix, repeated Quit→Launch cycles would fail to bind because the previous server had been killed without releasing the listening socket (#3696).
- Desktop: guard against unsigned native binaries in the bundled server (`bundle-server.sh` now rejects unsigned `.node` files before signing the app); macOS Gatekeeper would otherwise reject the .app on install (#3889).
- Desktop: `command_drift` parser hardened against multi-byte UTF-8 — previously could panic on emoji or other non-ASCII in claude output (#3992).
- Desktop: speech-helper cache key now includes the swiftc version, so a Swift toolchain upgrade invalidates the cached compile and avoids running stale binaries (#3950).
- Server: `respondToQuestion` and `PermissionManager.clearAll` emit the `toolUseId` on `_pendingUserAnswer`, so the dashboard's question prompt correctly clears (#3975, #3988).
- Server: `/permission` rate limiter buckets by Cloudflare connecting-IP, not by the tunnel's local-loopback IP. Pre-fix all permission traffic looked like it came from one IP and a busy session could exhaust the budget for everyone (#3980).
- Server: `permissionSessionMap` is cleaned up on all resolution paths — error, deny, timeout, all-cleared (#3736).
- Server: idle-push dedupe is now released on async `send()` failure so the next idle push isn't suppressed by a stale dedupe entry (#3881). Logs a warning when an idle push is suppressed by an uninitialised `wsServer` so the suppression is visible in `/diagnostics` (#3871).
- Server: `cli-session` interrupt-safety timers are now correctly cleared and unref'd so the process can exit cleanly (#3966).
- Dashboard: evict composer refs when sessions vanish from `session_list`, so a re-created session with the same ID doesn't inherit stale state (#3977).
- Dashboard: require the paste marker in text before enabling Send, so an empty composer with only a collapsed-paste placeholder doesn't trigger a no-op send (#3984).
- Dashboard: clear `pastedTextBlocksRef` on session close so the next session opens with an empty composer (#3800).
- Dashboard: Stop button stays reachable when the composer has draft text — it used to be hidden behind the Send button (#3900).

### Changed

- Skills toggle glyph swapped from 💾 to 🧩 so the UI reads as "puzzle pieces / skills" rather than "save / persistence" (#3875).
- `scripts/bump-version.sh` now scaffolds a CHANGELOG entry on every bump (`--no-changelog` to skip) — mechanical guard against the v0.7.0–v0.7.17 backfill problem recurring (#3803/#3974/#3995). Also traps and cleans up orphan `.tmp` files on script failure (#3945).
- Backfilled CHANGELOG entries for v0.7.0–v0.7.17, which had shipped without per-version notes (#3974).
- Docs: README documents Linux Rust + Tauri system-deps install steps (#3928). README cites the Anthropic pricing source on the programmatic-credit table (#3927). `/diagnostics` endpoint is documented in `docs/troubleshooting/` (#3738). `hardTimeoutMs` and the soft/hard inactivity split are documented in server README (#3899). Codex workspace-write surfaces are documented (#3848). claude-tui is covered in the "Choose between SDK and CLI" provider guide (#3936).

### Protocol notes

Backward-compatible additions only. New `inactivity_warning` server message (`ServerInactivityWarningSchema`) and optional `hardTimeoutMs` field on `auth_ok` (#3905/#3926). Old clients ignore both safely; new clients render the check-in chip when they receive the warning and use `hardTimeoutMs` to show a backstop countdown.

## [0.8.3] - 2026-05-13

### Changed

- Pre-launch documentation hygiene: README now reflects the actual `git clone + npm install + npx chroxy` flow, adds Linux prereqs, promotes the Windows MSI as the recommended install path, documents Anthropic's June 15 2026 programmatic credit pool with the `ANTHROPIC_API_KEY` bypass, and adds a "Verify it worked" block (#3859).
- Pruned ~9500 lines of internal audit material, aspirational design docs, and orphaned planning artifacts from `docs/`. Pre-cleanup state preserved at tag `archive/pre-launch-cleanup-2026-05-13` (#3863).
- `packages/server/README.md` no longer references the unimplemented PTY/tmux mode, `--terminal` flag, `chroxy wrap` command, or `PtyManager`/`OutputParser` components.
- `CONTRIBUTING.md` now sets explicit expectations on PR workflow, CI, squash-merge, and solo-maintained turnaround.

### Fixed

- Codex sessions in workspace-write mode now default to writing inside the session cwd, unblocking common Codex flows without requiring explicit sandbox configuration (#3846, follow-up to #3837).
- Dashboard provider dropdowns reflect the actual active provider; Codex polish from #3836 review (#3845).

## [0.8.2] - 2026-05-13

### Fixed

- Codex sessions can now start in non-git directories (was previously refusing to launch). Dashboard provider/model dropdowns are now provider-aware, hiding incompatible options instead of silently falling back (#3836).
- Composer paste-collapse now triggers when the clipboard contains only `text/html` (not just `text/plain`), so large pastes from Notion, Confluence, and similar sources collapse correctly (#3838).

## [0.8.1] - 2026-05-12

### Added

- Windows MSI build pipeline: `release.yml` now builds a `.msi` artifact on the `desktop-windows` job and attaches it to GitHub Releases. README documents the Windows install path (#3807).

### Changed

- Pre-1.0 security and privacy hygiene cleanup: removed PII from logs, audited token-handling paths, tightened error message contents to avoid leaking session-internal state (#3817).
- `release.yml` makes Tauri updater signing and Apple notarization conditional on the relevant secrets being set — the workflow now degrades gracefully when run from a fork or before secrets are configured, producing unsigned artifacts instead of failing (#3820).

### Fixed

- Universal `speech-helper` is now compiled from `.swift` source and signed atomically inside `build.rs`. Previous workflow-level pre-sign was being wiped by the Tauri bundle step (#3830, supersedes #3827).
- Server bundle no longer ships Bare-runtime prebuilds (`bare-*.node` files), shrinking the macOS `.app` payload (#3823).
- Windows Tauri build now correctly references `icon.ico` for the MSI bundler (#3811, #3812).
- Windows `beforeBuildCommand` now uses a bash wrapper so npm scripts run consistently across the CI runner (#3810).

## [0.8.0] - 2026-05-11

### Added

- Dashboard chat now groups consecutive tool calls under one collapsible block with a per-tool breakdown (#3747, #3794).
- Desktop dashboard supports Ctrl+V to paste a screenshot from the clipboard into the composer on macOS (#3748, #3796).
- Composer collapses large pastes (≥1500 chars or ≥20 lines) into an inline `[Pasted text #N]` placeholder with an attached chip, viewable in a read-only modal; full content is re-expanded on send. Mobile and desktop dashboards share the same selector via `@chroxy/store-core` (#3797, #3798).

## [0.7.17] - 2026-05-10

### Fixed

- Auto-replay frames now carry `fullHistory: true` so reconnecting clients clear local state before applying replayed events. Fixes duplicated/scrambled chat turns after each mobile reconnect (#3744).

## [0.7.16] - 2026-05-10

### Added

- Persistent file logging with rotation, plus a `/diagnostics` HTTP endpoint that returns build info, runtime status, and a tail of recent log lines for support and triage (#3734).

### Fixed

- Tauri 2.11 ACL grants for custom commands on the dashboard webview, restoring desktop command invocation after the Tauri upgrade (#3741).

## [0.7.15] - 2026-05-10

### Fixed

- Auto permission mode now actually bypasses prompts. Three compounding bugs — silent rejection of mid-turn mode changes, missing auto short-circuit in `PermissionManager`, and pending prompts not draining on switch — caused "auto" to be confirmed by the server while still emitting permission prompts under the old mode (#3729, #3730).
- Crash handlers now serialize session state before `destroyAll`, preventing state loss on abnormal shutdown (#3726).

### Changed

- Cached the `_hasClaudeOAuthCreds` probe with a 5-second TTL to cut repeated filesystem checks on hot paths (#3724).
- Extracted `_registerSessionHookSecretIfMissing` helper for reuse across restore/spawn paths (#3727).

### Removed

- Stripped `[stream-debug]` diagnostic logs that were added in 0.7.4 for issue #3700 triage (#3723).

## [0.7.14] - 2026-05-09

### Fixed

- Dashboard header selects now use per-kind widths so model, permission-mode, and skills dropdowns each get an appropriate width instead of all collapsing to a single fixed size (#3720).

## [0.7.13] - 2026-05-09

### Fixed

- Server now re-registers permission hook secrets for restored sessions on startup. Previously a server restart left restored sessions with no hook secret, so the next permission prompt failed silently (#3716).

## [0.7.12] - 2026-05-09

### Fixed

- Orphan permission-hook entries are now stripped from `settings.json` on hook register/unregister, preventing accumulation of dead hook references across session lifecycles (#3714).

## [0.7.11] - 2026-05-09

### Changed

- Moved the Skills control from the dashboard header tab bar to an icon button in the header-right cluster, freeing horizontal space and matching the other secondary actions (#3713).

## [0.7.10] - 2026-05-09

### Fixed

- Server now boot-prefixes `messageId` values so dashboard messages from different server boots can no longer collide on the same id after a restart (#3712).
- Dashboard chat auto-scrolls to the bottom on mount, restoring expected behavior when reopening a session (#3712).

## [0.7.8] - 2026-05-09

### Fixed

- Persisted the `messageId` counter across server restarts. Without persistence the counter restarted from zero each boot, colliding with messages from the previous boot still cached on the dashboard (#3700, #3709).

## [0.7.7] - 2026-05-09

### Changed

- Moved the Auto-evaluate toggle out of the dashboard header into Settings, decluttering the header for session-scoped controls (#3707).

## [0.7.6] - 2026-05-09

### Changed

- Rebuilt the dashboard header as a 3-column grid, fixing alignment drift between left/center/right clusters at narrow widths (#3706).

## [0.7.5] - 2026-05-09

### Fixed

- Dashboard UI polish: header selects, model picker chrome, and minor spacing fixes across the composer and session row (#3704).
- Persisted the booted model so it survives reconnects and is correctly reflected in the model picker on session resume (#3704).
- Permission optimistic update no longer double-renders the prompt when the server's `permission_resolved` broadcast races the local accept (#3693, #3704).

## [0.7.4] - 2026-05-09

### Added

- Temporary `[stream-debug]` server logging to diagnose dashboard messageId collisions tracked in #3700. Removed in 0.7.15 (#3702).

### Fixed

- Server shutdown is now idempotent. Duplicate `SIGTERM`/`SIGINT` signals no longer trigger a second shutdown pass that erased freshly-flushed session state (#3697, #3701).

## [0.7.3] - 2026-05-09

### Fixed

- Dashboard markdown now renders GFM tables. Previously pipe-delimited tables in assistant responses fell back to plain-text rendering (#3695).

## [0.7.2] - 2026-05-09

### Fixed

- Server now reports the actual booted model in `model_changed` broadcasts instead of the requested model, so the dashboard pill matches what the session is really running (#3687, #3688).
- Dashboard provider auth status panel now includes a color legend (#3686).
- Tunnel cold-start now retries on transient failures and catches errors cleanly instead of crashing the server (#3682).

## [0.7.1] - 2026-05-08

### Added

**Auto-Evaluator**
- Auto-evaluation hook on `user_input` with rewrite and clarify verdicts, dashboard UI for rendering both flows, and per-session `promptEvaluatorSkipPattern` override (#3188, #3625, #3634, #3639, #3643, #3663).
- 30s timeout on `evaluateDraft` plus an `EVALUATOR_TIMEOUT` error code so a stuck evaluator can't wedge the input path (#3651, #3668).
- `evaluator_rewrite` / `evaluator_clarify` broadcast schemas added to `@chroxy/protocol` (#3625).
- Recorded rewritten text in session history when the verdict is "rewrite" so subsequent turns see the rewritten draft (#3660).
- Per-provider auth/billing state surfaced to clients via `auth_ok` and on demand (#3404, #3673).
- Push notifications gated on client foreground state so backgrounded clients don't miss completion pings (#3404, #3669).

**Sidecar / Pod-Agent (Kubernetes Backend)**
- `SidecarProcess` consumer signal when stdin forwarding is disabled, with `SdkSession` handling of the `stdin_disabled` signal (#3467, #3498).
- `SidecarProcess` emits `stdin_dropped` on pre-dial buffer cap; detects wedged children via a stdin drain timeout in pod-agent (#3504, #3508).
- `K8sBackend.createEnvironment` workspace mount + resource limits; native `imagePullPolicy` option; RFC 1123 namespace validation (#3316, #3343, #3367, #3370, #3591).
- `CHROXY_AGENT_STDIN_CLOSE_GRACE_MS` env override; `SidecarProcess.stdin` wired to sidecar stdin frames (#3336, #3409, #3490).
- `DockerBackend.execInEnvironment` honors `env` and `cwd` opts (#3312, #3357).

**Stdin Forwarding Signals**
- Server emits `stdin_dropped` cumulative totals and a `stdin_disabled` signal over WS; `SessionInfo` carries a new `stdinForwardingDisabled` flag, hydrated on reconnect via `auth_ok`/`session_list` (#3537, #3560, #3564, #3572, #3582, #3594).
- Mobile and dashboard render a `stdinForwardingDisabled` banner on the session row / session screen (#3593, #3598).
- Session emits an error on `stdin_disabled` signal; cumulative dropped-bytes counter + louder log severity (#3536, #3537).

**Skills**
- SkillsPanel pending-review section gains richer rendering — description/source/path — and dashboard cross-author collision tests for `skill_trust_granted` (#3309, #3310, #3351, #3365).
- `skill_trust_grant` returns `INVALID_AUTHOR` when the author namespace mismatches, with `actualAuthor` surfaced in the error; toast retries the grant on dismiss (#3497, #3568, #3584, #3601).
- Server scans `community/*` for cross-author skill name detection in `skill_trust_grant` (#3535).
- `_scanCommunityForSkillName` `readdir` sorted for deterministic order (#3566).

**Dashboard Polish**
- Toast auto-dismiss pauses on hover and respects intra-toast focus moves; uses `performance.now()` for elapsed-time math (#3607, #3610, #3617, #3618).
- Actionable `INVALID_AUTHOR` toast retries `skill_trust_grant`; `actualAuthor` rendered in error UI (#3568, #3584, #3601).

### Fixed

- Serialized per-session evaluator awaits and re-checked `input_conflict` to prevent overlapping evaluator runs (#3636, #3657).
- Normalized history text trailing whitespace and serialized bursty input across all paths (#3665, #3666, #3667).
- Deduped socket `onerror`/`onclose` reconnect scheduling on the dashboard (#3622).
- Cleared `pendingTrustGrants` on the auto-reconnect path (#3613).
- `StdinDisabledBanner` restart now uses create-then-destroy ordering to avoid losing the new session if create fails (#3606).
- Cleared `SkillsPanel` pending state on `skill_trust_grant` errors so the row doesn't stay stuck in pending (#3600).
- Active-session eviction now emits a `session_lost` frame (#3390, #3442).
- `_enforceSessionCap` spawns before evicting and falls back when all sessions are active (#3392, #3395, #3430, #3433).
- `LineLimitTransform` correctly counts CRLF bytes (#3381, #3420).
- `K8sBackend` validates `imagePullPolicy` enum, deduplicates concurrent `_readAgentToken` fetches, validates container port range 1–65535, RFC 1123 namespace validation, and rejects Windows-style and 1-char `hostPath` mounts (#3371, #3375, #3386, #3426, #3431, #3443, #3455, #3499, #3591).
- Sidecar idle-TTL eviction closes `child.stdin` before `SIGTERM`; eviction reason aligned with `session_lost` frame reason; backpressure handled on `child.stdin.write()`; WS closed in send callback to avoid flush race (#3466, #3469, #3471, #3475).
- `DockerSdkSession`: preserve hydrated `_stdinForwardingDisabled` on restore; case-normalize community segment in skills walk; sort `_scanCommunityForSkillName` `readdir` for deterministic order (#3301, #3366, #3485, #3566, #3589).
- `DockerBackend` coerces and filters null/undefined env values; uses `--no-trunc` in container listing (#3361, #3414, #3496).
- Blocked prototype-pollution keys in handler `sendError` (#3590).
- Cleared stale sessions on no-`containerId` reconnect (#3494, #3533).
- Cancelled stdin drain timer on all sidecar kill paths (#3546).
- Validated Claude session model against available models (#3503).
- Resumed paused WS before close in sidecar terminal paths (#3557).
- `EnvironmentManager.reconnect()`: aggregate warn on failure; flip `allHealthy` on `reconnectAgentToken` throw and `getEnvironmentStatus` failures (#3487, #3491).
- Dashboard `CheckpointTimeline` description and active-skill row descriptions now use a `.trim()` guard; `SkillsPanel` pending-row path overflow + alignment fixed (#3368, #3425, #3458, #3483, #3519).
- `chroxy-pod-agent` sidecar sentinel args truncation (#3393, #3438).
- Required `firstSeen` in skill_trust v1 classifier and tolerated malformed entries in migration (#3486, #3531).
- Sorted skills-loader community walk for deterministic order (#3485).
- Suppressed sidecar close handler after terminal error closes WS (#3529).
- Tightened `reconnectAgentToken` return check and acted on `false` in `EnvironmentManager` (#3462, #3522).
- Warned on null/undefined env value in docker backend (#3463).
- Unified session activity indicators across the dashboard (#3408).

### Changed

- Refactored auto-evaluator polish — render-path cleanups and the `pendingEvaluatorClarify` default to `null` with tighter typing (#3637, #3640, #3641, #3642, #3658, #3664).
- `connectionPhase` is now the single dedupe source for reconnect on the dashboard (#3631).
- App `createSession` switched to an options object and extended with `model`/`permissionMode` for restart preservation (#3609, #3620).
- Rate-limited the `refused-sendMessage` warn log and formatted `stdin_dropped` cumulative bytes as KiB/MiB (#3559, #3586).
- Renovate schedule + stability rule, plus a regex manager for the `claude-code` Dockerfile pin (#3354, #3410, #3447).
- Pinned `@anthropic-ai/claude-code` in the sidecar Dockerfile via `ARG` (#3330, #3352).

## [0.7.0] - 2026-05-06

Dogfood release. Bumps Chroxy to 0.7.0 and stabilizes dogfood workflows: tunnel readiness improvements, Codex/OpenAI session fixes, stale Claude model preflight, restore-failure surfacing, persistence hardening, and related tests.

### Added

**Sidecar / Pod-Agent (Initial Landing)**
- `K8sBackend` skeleton with pod create/destroy and streaming exec via a sidecar WS bridge (#3191, #3315, #3320, #3331).
- `chroxy-pod-agent` sidecar — WS protocol, Dockerfile, kind-based integration test, and resume after restart (#3319, #3321, #3322, #3323, #3340, #3345).
- Extracted `Backend` interface and `DockerBackend` implementation from `EnvironmentManager` (#3190, #3311).

**Skills v2**
- Two-pass priority-aware tier budget loader with per-tier global budget guardrail (#3222, #3274, #3279, #3285).
- `_readFrontmatterOnly` bounded-read helper and split of `skills-loader.js` into three sibling modules (#3223, #3276, #3278, #3282).
- `list_skills` fallback shows scoped skills (#3226, #3267).
- `skill_trust_accept` WS endpoint exposes the skills-trust `acceptHash`, advertised via `auth_ok` capabilities (#3235, #3269, #3272, #3273).
- SkillsPanel "Accept new content" button (#3270, #3271).
- `skill_trust_grant` handler with trust-store schema migration (#3297, #3303).
- Community-namespace gate and `community/<author>/` walk in skills-loader (#3296, #3299).
- Skills loader hardening — TOCTOU close between `realpath` and `readFileSync`, mtime-keyed parse cache, content-sniff fix, symlink defense, markdown-only, size budgets, frontmatter (#3197, #3201, #3202, #3203, #3211, #3215, #3216, #3218, #3219, #3220, #3248, #3260, #3266).
- Skills v2 frontmatter consumers — provider gating, manual activation, injection (#3198, #3199, #3200, #3224).
- Skills trust SHA hashing, per-provider allowlist, atomic writes, case-insensitive keys, explicit mode in payload (#3204, #3207, #3228, #3231, #3232, #3233, #3234, #3237, #3238, #3239, #3240, #3241, #3242).
- Skills metadata UI — version, hash, last-activated, mismatch indicator — and runtime activate/deactivate WS for manual skills (#3205, #3209, #3245, #3249).

**Auto-Evaluator (Initial Landing)**
- Per-session `promptEvaluator` toggle (#3185, #3243).
- Evaluator skip heuristic for trivial messages (#3187, #3210).
- Evaluator API error status code surfaced in error envelope (#3100, #3261).
- `activateSkill` performs at most one layered skills scan (#3253, #3259).
- Public getters for the trust store and active manual skills (#3252, #3258).

### Changed

- `store-core.validateGitElements` aggregates its drop log; `protocol.isRateLimitMessage` lowercases content internally; `dashboard.GitStatusEntry` deduped against the shared `GitFileStatus` (#3181, #3183, #3184, #3262, #3264, #3265).
- Tightened `firstSeen`/`lastVerified` protocol schemas to `z.string().datetime()` (#3250, #3255).
- Re-exported `SetPromptEvaluator` and `ServerPromptEvaluatorChanged` for downstream consumers (#3254).
- Aligned pass-1 sort tiebreak with `_enforceTotalBudget` and updated JSDoc references (#3283, #3287, #3289, #3291).
- Hoisted `MismatchFlag` outside the skill toggle label for accessibility (#3251, #3257).
- Dropped the dead `entry` field from the `_collectCandidates` descriptor (#3293, #3295).

## [0.6.0] - 2026-03-18

### Added

**Container Environments**
- EnvironmentManager for persistent, named container environments with lifecycle management
- Docker Compose stack support — define multi-container environments with `docker-compose.yml`
- DevContainer spec support — create environments from `.devcontainer/devcontainer.json`
- Environment snapshot and restore via `docker commit`
- WebSocket protocol handlers for environment CRUD operations (create, list, destroy, get)
- Dashboard environment management panel with session integration

**Container Isolation**
- DockerSession provider for CLI-based container-isolated sessions
- DockerSdkSession provider for SDK-based container isolation with in-process permissions
- External container support — attach sessions to pre-existing Docker containers
- Sandbox option support for SdkSession (Agent SDK built-in isolation)
- Resource limits and security hardening: memory caps, CPU limits, PID limits, dropped capabilities
- Container isolation guide with provider comparison matrix

**Git Worktree Isolation**
- Git worktree isolation for sessions — each session gets an independent working copy
- Worktree toggle in CreateSessionModal (app and dashboard)
- CWD validation when worktree mode is enabled

**Permission System**
- PermissionManager rule engine with NEVER_AUTO_ALLOW guard for dangerous operations
- `set_permission_rules` WebSocket handler with reconnect replay
- Session Rules UI on mobile SettingsScreen
- "Allow for Session" button for per-session permission grants
- Per-session CHROXY_HOOK_SECRET replacing global CHROXY_TOKEN
- Rate limiting on permission_response messages

**Protocol & Shared Packages**
- `@chroxy/protocol` package — shared WebSocket protocol constants, message types, and Zod schemas
- `@chroxy/store-core` package — shared store logic, crypto utilities with platform adapters
- `extension_message` envelope for provider-specific payloads
- Consolidated syntax highlighter shared across app and dashboard
- Protocol tests wired into CI pipeline

**Dashboard & Desktop**
- Voice-to-text input via macOS SFSpeechRecognizer (desktop)
- Console page with connection info and QR code
- Live server log panel with filtering and auto-scroll
- Thinking level control
- Default model selector in settings panel
- Advanced session creation with permission mode selection
- Image preview support in Files tab
- SDK vs CLI provider badges with color coding
- System events channel for connect/disconnect notifications
- Loading skeleton during connect and session switch

**Mobile App**
- FSM validation on ConnectionPhase transitions
- Auto-resume last session on server reconnect
- Syntax highlighting in FileEditor read-only view
- Show mic button during streaming; one-tap LAN connect
- Android persistent notification for active sessions
- Live Activity manager and bridge stubs for iOS
- Session activity state tracker with elapsed duration
- Composable store slices: connection lifecycle, file operations, conversation, notification, terminal, web, multi-client

**Server**
- `registerEventType` and `registerMessageHandler` for runtime extensibility
- Codex provider with normalized provider labels
- `/metrics` endpoint for operational monitoring
- Request correlation IDs on message handling and error responses
- `--log-format json` for structured logging
- Security warnings for `--no-auth` usage
- Ephemeral pairing codes replacing permanent token in QR
- API token storage in OS keychain
- Per-session WebSocket rate limiting
- Concurrent session mutation locking
- Backpressure monitoring with slow-client eviction
- Grace period for recently-refreshed pairing IDs

### Changed

- App state management decomposed from monolithic store into composable Zustand slices
- Server handler architecture refactored to Map-based dispatcher pattern (both server and dashboard)
- Source-scan tests migrated to behavioral tests across three phases
- WsServer decomposed: WsClientManager, WsBroadcaster, ws-client-sender extracted
- SessionManager decomposed: SessionTimeoutManager, SessionStatePersistence, CostBudgetManager extracted
- SdkSession decomposed: PermissionManager extracted as standalone module
- ws-file-ops split into domain modules (browser, reader, git)
- BaseSession extracted to deduplicate CLI/SDK/Gemini session logic
- Tunnel registry collapsed from plugin system to direct factory
- Console calls replaced with structured createLogger throughout server

### Fixed

- Pending message queue: replaced single-slot with proper queue, drain via nextTick to prevent re-entrancy
- Checkpoint manager: replaced git stash push/pop with commit-tree snapshot (avoids dirty-tree conflicts)
- Supervisor shutdown: awaits child exit instead of wall-clock timer; captures child reference in force-kill
- Permission hook registration leak to settings.json on destroy race
- Dev-preview tunnel registered before start() to prevent zombie processes
- Docker session startup race, env allowlist, and API key forwarding
- DockerSdkSession path remapping heuristic hardened
- AbortSignal pre-abort guard in DockerSdkSession spawn callback
- Flaky encryption and permission tests stabilized
- Speech recognition unmount guard prevents mic leak
- EPIPE guard on stdin.write in cli-session
- Worktree removal fallback to rmSync when git worktree remove fails
- Config range validation for port, maxSessions, sessionTimeout, maxPayload
- Push notification fetch timeout with exponential backoff retry
- WebSocket EADDRINUSE with clear error message
- Input data and session name max-length validation
- Non-git directory friendly message in dashboard Diff tab

## [0.5.0] - 2026-03-08

### Added

**Multi-Server & Provider Ecosystem**
- Multi-server connection registry with per-server auth persistence and auto-connect
- Server picker UI for managing multiple remote machines
- Google Gemini CLI and OpenAI Codex CLI providers
- Provider picker in session creation flow with billing context and capability badges
- Native folder picker and file system browser for new session directory selection

**Dashboard — Desktop IDE Features**
- Split pane view with resizable panels
- File browser panel with syntax highlighting
- Checkpoint timeline visualization with create/delete
- Diff viewer panel
- Agent monitoring panel
- Cross-session notification banners with quick-approve for permissions
- Configurable send shortcut (Enter vs Cmd+Enter)
- Encrypted server tokens at rest in localStorage
- Server-scoped session persistence (isolated per server)
- Subtle breathing animation for idle session dots
- Inline URL validation in ServerPicker
- ARIA and keyboard navigation improvements throughout

**Desktop App**
- First-run wizard with dependency checking
- Clipboard manager plugin
- QR code popup from tray menu
- Cross-platform conditionals for Windows/Linux compilation
- Hardened CSP (removed unsafe-inline)

**Mobile App**
- Checkpoint timeline UI — list, create, delete, and auto-switch session on restore
- File editor component with save/cancel
- Git view component for mobile git operations
- Vector icons replacing emoji throughout
- Multi-indicator session pills with distinct status badges
- Rich notifications and plan approval in session banner
- Subscribe to all sessions for real-time multi-session events
- Session subscribe chunking for >20 sessions
- Token rotation handling with re-auth flow
- Cross-platform session rename
- Component rendering tests for critical UI

**Server**
- Git operations: `git_stage`, `git_unstage`, `git_commit` WebSocket handlers
- Cross-device input conflict resolution
- Cross-client permission sync via `permission_resolved` broadcast
- Unified `handleSessionMessage` (refactored from separate CLI handler)
- Provider list schema and WS endpoint
- Integration tests for untested WS message handlers

**Shared**
- Extracted `store-core` package with dependency injection adapters (shared between app and dashboard)

### Fixed

- **stream_start ID collision**: Server reuses same messageId for tool_start and post-tool stream_start, causing response text to concatenate onto tool_use messages. Now creates suffixed response ID with delta remapping.
- Cross-client permission propagation: all connected clients now see permission outcomes in real-time
- Dashboard markdown rendering for response and tool_use messages
- Message deduplication during all history replays
- Session state initialization for new sessions on session_list
- Crypto PRNG, disconnect UX, and user message sync in app
- Server-scoped persistence edge cases in dashboard
- Auto-dismiss notification banner on permission_expired
- Out-of-order directory listing response guard
- Codex provider error messages improved
- Empty state for Output tab and terminal data fallback
- Config save error propagation in desktop first-run wizard
- Deterministic time in ServerPicker tests
- Keyboard focus indicators on various components

## [0.3.0] - 2026-03-02

### Added

**Dashboard — Full React Rewrite**
- Complete React + TypeScript + Vite rewrite replacing the legacy string-template dashboard
- Sidebar with repo tree navigation, ARIA tree roles, and auto-expand filtering
- Command palette with keyboard navigation (Cmd+K), command registry, and MRU sorting
- Cross-session conversation search with parallel scanning and caching
- File browser with fuzzy search, recursive walk, and gitignore awareness
- Image attachments: drag-drop, clipboard paste, preview thumbnails, PNG transparency
- Slash command picker with autocomplete
- Welcome screen with quick-start actions
- Session auto-labeling and creation panel
- Multi-tab terminal management
- Question prompts with option buttons and free-text fallback
- Usage analytics with cost and token visualization
- DOMPurify sanitization for markdown rendering
- CSS-to-TypeScript theme token codegen
- Comprehensive accessibility: ARIA labels, keyboard focus indicators, screen reader support
- Responsive breakpoints for loading and error screens
- Reduced-motion support for animations

**Desktop**
- Standalone `.app` bundle with server embedded via `bundle-server.sh`
- Server crash auto-restart with exponential backoff
- Single-instance enforcement
- Consolidated to single Tauri window (replaced dual-window architecture)
- Tauri event system replacing `eval()` injection
- React loading and error screen components
- Restarting state in tray menu UI
- Protocol-version-aware logging for unknown message types
- QR code mobile pairing from desktop app

**Server**
- Session subscriptions and repo management
- History replay batching with readyState guard
- `list_files` WebSocket endpoint with recursive walk and gitignore
- PostAuth queue batch flush for event loop yielding
- Broadcast session focus across clients
- Protocol version negotiation in WebSocket handshake
- Token rotation with QR code regeneration and dashboard re-auth
- Conversation history scanner with parallel scanning and caching
- File attachment resolution with binary file rejection and symlink validation
- Shared `runWithConcurrency` utility

**Mobile App**
- Conversation history screen with resume
- Kanban-style session overview panel
- Vector icons replacing Unicode emoji
- Message entrance animations
- Haptic feedback for key user actions
- Shared active session with opt-in follow mode

**Infrastructure**
- CI staleness check for server `package-lock.json`
- Batch-merge skill for PR management
- Error journal convention for persistent debugging patterns

### Changed

- Dashboard architecture: legacy `dashboard.js` string monolith replaced with React component tree
- Desktop: dual-window approach consolidated to single window with Tauri events
- Health poll waits made interruptible in desktop app

### Fixed

- ReconnectBanner grid-column in sidebar layout
- `isTextInput` check narrowed to exclude non-textual inputs
- Code block placeholder prefix collision between fenced and inline blocks
- Lockfile included in `bundle-server.sh` for reproducible builds
- Health poll thread generation counter race condition
- Desktop `ensure_config` uses `create_new(true)` to avoid overwrites
- Keyboard focus indicators on QuestionPrompt
- InputBar disabled state checked in drag/drop/paste handlers
- Attachment path deduplication preventing React key collisions
- FilePicker keyboard navigation scrollIntoView
- ImageThumbnail remove button accessible on touch and keyboard
- Standalone server EADDRINUSE infinite retry loop
- Provider capability gates for plan mode and resume

## [0.2.0] - 2026-02-24

### Added

**Desktop Evolution**
- System daemon with `chroxy service install/uninstall/start/stop/status` commands
- Structured logging with file output and rotation
- Daemon-mode connection info delivery
- Web dashboard served from HTTP server with localhost encryption bypass
- Dashboard chat view, input, session management, and keyboard shortcuts
- Tauri tray app with scaffold, system tray, dashboard integration, and polish
- Dashboard Week 1: localStorage persistence, xterm.js terminal, desktop notifications, loading page
- Dashboard Week 2: syntax highlighting (15 languages), enriched tabs, permission countdown timer, reconnect backoff

**Multi-Session and Agents**
- Multi-session parallel execution
- Background agent tracking
- Codex provider for multi-agent support

**Mobile App**
- Voice-to-text input via `expo-speech-recognition`
- Plan approval UI with plan mode detection
- Biometric app lock (Face ID / Touch ID)
- Conversation search and terminal scrollback export
- Tablet layout and onboarding flow
- Enhanced permission detail UI and permission history screen
- Client-side persistence with AsyncStorage for offline session history
- Cost budget controls and usage limit warnings
- Image-bearing tool results display
- MCP server awareness in tool events

**Server**
- Claude Agent SDK provider (`sdk-session.js`) as default backend
- Provider registry (`providers.js`) for pluggable AI backends
- Checkpoint and rewind support
- Token rotation and expiry
- Session timeout and auto-cleanup
- SQLite session persistence
- WebSocket compression and connection quality indicator
- Dev server preview tunneling
- Push notifications via Expo Push API
- Web client fallback for browser access

**Infrastructure**
- CI pipeline: server tests, app type check, server lint on every PR
- ESLint flat config for server package
- Enterprise self-hosting guide
- Maestro E2E test flows for app UI verification

### Removed

- **PTY/tmux mode** — the legacy `--terminal` flag, `chroxy wrap` command, and all PTY code paths (`server.js`, `pty-manager.js`, `pty-session.js`, `output-parser.js`, `session-discovery.js`) have been deleted. CLI headless mode is now the only server mode.
- `node-pty` dependency

### Changed

- Node 22 is now the enforced minimum (was already required but now documented as hard requirement)
- Server architecture simplified to single CLI headless mode
- `ws-server.js` refactored from monolith into focused modules (`ws-message-handlers.js`, `ws-forwarding.js`, `ws-schemas.js`, `event-normalizer.js`)
- App state management split from monolithic `connection.ts` into domain modules

### Fixed

- Session lifecycle hardening (destroy cleanup, GC edge cases, checkpoint restore idle guard)
- Reconnect detection preserves chat history
- Cost and token budget hardening
- WebSocket auth enforced before data messages
- Touch targets meet 44pt minimum throughout app
- Keyboard handling accounts for Android suggestion bar
- Connection phase state machine for resilient reconnection with backoff

## [0.1.0] - 2026-02-01

### Added

- Initial release
- Server: PTY/tmux mode with output parser, WebSocket protocol, Cloudflare tunnel (Quick + Named)
- App: QR code scanning, connection flow, markdown rendering, dual-view chat/terminal
- Auto-discovery of tmux sessions
- Permission handling via hooks
