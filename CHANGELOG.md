# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
