# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Dashboard: a persistent end-of-turn summary for permission prompts that
  expired unanswered (#7365).** When a permission prompt times out with no
  answer, chroxy silently continues without that tool — the per-prompt
  marker (`PermissionPrompt.tsx`'s "Permission expired — Claude will continue
  without this tool") is easy to miss once the turn has moved on, since it is
  one collapsed row in a long transcript. Once a turn has actually ended, the
  transcript now also renders a persistent card attached to it, aggregating
  every prompt that expired unanswered during it: the count, the tool names,
  and a jump link back to the first one (which also moves keyboard/
  screen-reader focus, not just the scroll position). Turn boundaries use
  one of two EXPLICIT sources, chosen by the caller, never inferred: the
  live dashboard marks a position-independent `turnBoundary` on whichever
  message is last (skipping past any trailing `user_input` rows) when a
  turn's own `result` is processed — live or replayed identically — since a
  `user_input` row from a send-while-busy queued follow-up is recorded by
  the server at ENQUEUE time and can sit permanently mid-turn, and can even
  be the LAST thing before that turn's `result` if the turn's own last action
  was an expiring permission; a closed/historical transcript (no `result`
  entry exists in that data source) instead uses `user_input` row position,
  which is sound there specifically because Claude Code's own on-disk log
  only records a queued follow-up once it actually dispatches. No protocol
  change was needed for either source. The summary itself is gated on the
  turn having ended (the server-authoritative `isIdle` flag, defaulting to
  "ended" for a closed transcript) so its position never shifts while a turn
  is still streaming. No new native notification: the permission
  notification already fired when the prompt was raised (#7364); a second one
  per turn for the same event would be noise. Web dashboard only — the
  mobile app has no equivalent surface yet.

### Fixed

- **`web-task-manager.js`: a failed feature-detection probe is now logged, a
  dash-led remote task id can no longer be captured, and a destroyed manager
  stays destroyed (#7299).** Three pre-existing defects, all surfaced by the
  #7294 review panel and left out of it as out of scope. `detectFeatures`'s
  `claude --help` probe had a bare `catch {}` around the parse step — every
  failure mode (missing binary, a hang past the 15s timeout, a non-zero
  exit) correctly failed closed but left zero trace, so an operator saw web
  tasks silently unavailable with nothing to search for; it now logs via
  `log.warn` with the error's message and code, matching the existing
  `_verifyBinary` refusal log just above it. The matching `.catch` at the
  `ws-server.js` call site was unreachable dead code (`detectFeatures` never
  rejects) and has been removed rather than left unexplained; the class
  JSDoc's "re-detection can be triggered manually" was also false — nothing
  in the codebase calls `detectFeatures()` a second time — and has been
  corrected rather than wired up, since no caller for manual re-detection
  exists. Separately, `_spawnRemoteTask`'s `remoteTaskId` capture,
  `/task[:\s]+([a-zA-Z0-9-]+)/i`, put `-` inside the character class with no
  position constraint — the same unanchored-dash shape catalogued as entry
  13 in `docs/false-safety-guards.md` for `getDiff`'s revision allowlist, in
  the very file #7291 hardened against it. `remoteTaskId` is dead today
  (nothing consumes it), but it is a sibling argv site and would become live
  the moment it feeds `--teleport`. The capture is now a dedicated
  `parseRemoteTaskId` export: anchored so the first character can never be
  `-`, and re-validated with `utils/argv-safety.js`'s `isSafeArgvValue`
  before being returned. Finally, `_spawnRemoteTask`'s `execFile` callback
  runs asynchronously and could fire after `destroy()` had already cleared
  `_pollTimer`, calling `_startPolling()` again and leaking a fresh interval
  on an already-destroyed manager; a `_destroyed` flag, set in `destroy()`
  and checked both in that callback (before any state mutation or polling)
  and in `_startPolling()` itself, closes the gap.

- **Mobile app: a worktree-isolated session's nav header shows the repo
  name instead of `worktrees/<hex>` (#8181).** `App.tsx`'s `sessionTitle`
  selector derived the header purely from `session.cwd` — the last two
  path segments, after shortening `/Users/<name>` to `~` — but a
  worktree-isolated session's `cwd` is the opaque
  `~/.chroxy/worktrees/<32-hex session id>` checkout, so the header read
  e.g. `worktrees/34914672f8578ecdf71accf8f8aec47e` instead of the repo it
  belonged to. The server already sends the session's ORIGINAL repo
  directory as `repoCwd` on every `session_list` entry (added for the
  dashboard's #7328/#8123 fix of the same class of bug); the selector now
  prefers `basename(repoCwd)` when present, via a `deriveSessionTitle`
  helper (`utils/sessionTitle.ts`) built on `repoDisplayName`, hoisted from
  the dashboard's `utils/repoLabel.ts` into `@chroxy/store-core` so both
  clients share one implementation. A normal session, and a session or
  server without `repoCwd`, render exactly as before.

- **`chroxy schedule` resolves the default provider through the same CLI >
  ENV > file > default pipeline `chroxy start` and `chroxy doctor` use, so
  `CHROXY_PROVIDER` (as set by the Docker image, for example) is no longer
  ignored (#8189).** `schedule-cmd.js`'s `buildDeps` derived
  `defaultProviderName` by hand — `overrides.defaultProviderName ||
  config.provider || DEFAULT_PROVIDER` over a raw `readConfigSoft` result —
  which skipped the env tier entirely, the same defect class #8151/#8177
  fixed in `chroxy doctor`. A scheduled task with no explicit
  `target.provider` could therefore warn about (and, once fired, actually
  run against) a different provider than the one the daemon itself defaults
  to. `buildDeps` now routes through the SAME shared `mergeConfig` +
  `resolveDaemonDefaultProvider` pipeline those commands use — no
  hand-written copy of the derivation remains in `schedule-cmd.js` — while an
  explicit `overrides.defaultProviderName` (dependency injection for tests)
  still wins outright, ahead of the pipeline.

  A repo-wide sweep for the same hand-rolled shape found two more,
  behavior-preserving since both already sat downstream of an already-merged
  `config` object (so `CHROXY_PROVIDER` was never actually dropped at either
  site — this is a DRY/drift-prevention fix, not a second active bug):
  `server-cli.js`'s `startCliServer` passed the raw `config.provider` field
  into `buildServerBanner` instead of `resolveDaemonDefaultProvider(config)`,
  and `handlers/session-handlers.js`'s `handleSwitchSession` passed
  `ctx.services.config?.provider` into `resolveRosterProvider` instead of the
  shared helper, unlike every other call site of that function.

- **`claude-sdk` advertises `planMode: true` — the capability was stale, not
  the plan-mode pass-through (#8153).** `sdk-session.js` declared
  `capabilities.planMode: false` since the provider adapter's introduction
  (#583), yet `_sdkPermissionMode()` had always mapped `'plan'` straight
  through as the SDK's own native `PermissionMode` — a literal
  `--permission-mode plan` flag `query()` forwards to the same installed
  `claude` CLI binary `claude-cli` spawns (`pathToClaudeCodeExecutable`,
  #7986), so the native read-only tool restriction was always the same on
  both providers — though the approval routing and per-turn process model
  differ: SdkSession builds a brand-new `query()` every turn and simply
  reads `this.permissionMode` fresh each time (a mode change lands on the
  very next turn, no sidecar file or restart needed), `EnterPlanMode` only
  resets stale plan-ready state, and the plan-approval card itself comes
  from `ExitPlanMode`, which flows through the same `canUseTool` →
  `PermissionManager` pipeline as any other tool call. The only real gap
  was event wiring: SdkSession parsed
  `EnterPlanMode`/`ExitPlanMode` via the shared `extractToolInputSemantics`
  (used for `Task`/`Agent` tool tracking) but explicitly skipped the
  `enter_plan`/`exit_plan` kinds. `_handleToolUseBlock` now tracks
  `_inPlanMode`/`_planAllowedPrompts` and emits `plan_started` /
  `plan_ready` the same way `cli-session.js` does — `plan_ready` fires
  right before the turn's `result` — and `_clearMessageState` resets a
  stale flag left by an interrupt/crash the same way CliSession does. Since
  #8090/#8087 derive the advertised permission-mode list and the
  dashboard's "Plan" picker option directly from `capabilities.planMode`
  (not a per-provider name check), both the mobile app and dashboard now
  correctly surface Plan mode for `claude-sdk` sessions instead of hiding a
  mode that actually worked. `DockerSdkSession` inherits the flip via its
  existing `{ ...SdkSession.capabilities }` spread (same CLI binary via
  `docker exec`). `docs/providers.md` and `docs/feature-matrix.md` updated
  to match.

- **A `system`/`status` event no longer renders as a bare "status" chat
  bubble (#8153 review).** The SDK's `SDKStatusMessage`
  (`status: 'compacting' | 'requesting' | null`) carries no `message`/`text`
  field, so both providers' generic system-event fallback
  (`msg.message || msg.text || msg.subtype || 'System event'`) fell through
  to the literal subtype string. `claude-stream-parser.js`'s new
  `formatStatusContent()` gives `compacting`/`requesting` a human-readable
  label; `status: null` (the previous status clearing) is suppressed
  entirely rather than emitted as an empty bubble. Wired identically in
  `cli-session.js` and `sdk-session.js` so the two providers cannot drift.

- **The protocol and store-core dist-drift CI checks now catch a tracked dist
  file orphaned by a deleted source, not just a modified or new one (#8163).**
  #8152 closed the "new untracked/ignored file" blind spot, but a narrower one
  survived: a tracked dist file whose SOURCE was deleted is byte-identical to
  what's committed and matches neither check — `tsc` never removes output for
  a source file no longer in its program, it just leaves the old file sitting
  there. `scripts/check-dist-drift.sh` now owns the build itself instead of
  diffing whatever a separate build step left behind: it takes the build
  command as arguments, wipes `<dist-dir>`, reruns that command from scratch,
  and only then diffs — a source file that no longer exists simply produces
  nothing for it, which turns the orphan into an ordinary tracked-file
  deletion that `git diff --name-status` reports as `D` and the script names
  explicitly. Deriving "what's expected" from a real clean build (rather than
  a hardcoded file list) also means the check keeps working as each package's
  set of tracked dist files grows, instead of needing to be told about it.
  Both CI call sites (`ci.yml`'s `protocol-tests` and `store-core-tests` jobs)
  now pass their build command straight to the script instead of running it
  as a separate prior step.

  A review of the first version of this fix found three problems before
  merge, all addressed here. **The script now VALIDATES `<dist-dir>` before
  moving or deleting anything** — owning the build means owning `mv`/`rm -rf`
  on a caller-supplied path, and an unvalidated one let a reviewer
  permanently delete the directory containing the repo (`../../outer`) and a
  sibling directory (`../sibling`) in reproducible sandboxes; `<dist-dir>`
  must now be a relative path with no `.`/`..` component, ending in a
  component named exactly `dist`, that resolves (symlinks included) strictly
  inside the repo and outside `.git`, or the script refuses with a usage
  error before touching anything. The backup used to restore a failed or
  empty build is now a same-filesystem sibling of `<dist-dir>` (atomic
  rename, no TMPDIR cross-device copy) and is deleted only once a verdict is
  reached or a restore is verified to have succeeded — never on a failed
  restore, which now keeps the backup on disk and prints its path instead of
  discarding the only copy. SIGINT/SIGTERM/SIGHUP during the build now
  restore the pre-existing `dist/` the same way a failed build does, instead
  of leaving it wiped. **The untracked-file check was also widened**: it used
  to list only *ignored* untracked files (`git ls-files --others --ignored
  --exclude-standard`), which misses a file matching a package's own
  `!dist/<file>` negation — store-core's real shape — so an emitted file
  matching that negation but missing from the index passed as clean; it now
  lists any untracked file under `<dist-dir>` at all.

  `scripts/__tests__/check-dist-drift.test.sh` (48 cases) adds: the orphan
  case (proven red against the old one-argument contract on the same
  fixture); the untracked-but-not-ignored case (reproducing the real
  store-core false-green and proving the fix closes it); the zero-emit floor
  isolated against a dist dir with no tracked files at all; a build that
  fails after emitting everything (the `tsc`-on-a-type-error shape the
  zero-emit floor alone cannot catch); a git failure aborting non-zero; a
  SIGTERM mid-build restoring `dist/`; and, for the path-validation fix,
  every rejected shape (absolute, `..`-containing, repo root, `.git`,
  wrong basename, symlink) proven against disposable sandboxes with a canary
  checksummed before and after — alongside the existing clean/modified/
  untracked coverage from #8152.

  Passing the build command as a `check-dist-drift.sh <dist-dir> npm run
  ...` argument also broke the `#7613`/`#7661` npm-resolve CI-budget guard
  (`packages/server/tests/ci-npm-resolve-budget.test.js`): its reader had no
  way to know that `npm` sitting behind this particular first-party wrapper
  script is still in command position, since nothing there tries to guess
  whether an arbitrary prefix like `sudo`/`xargs`/`timeout` runs its operand.
  `workflow-reader.js` adds a narrow, explicit `COMMAND_WRAPPERS` roster
  (currently just this one script) recording how many of a wrapper's own
  arguments precede the command it execs, verified against the wrapper's own
  source rather than guessed at — every entry is checked to both exist on
  disk and be genuinely invoked by some real workflow job, and a mutation
  test removes the entry to prove the real `ci.yml` call sites revert to
  unclassified (the exact failure this fix closes) rather than merely
  asserting the roster's presence.

  **A second review round found the containment check itself still
  bypassable.** It verified the physical directory sat somewhere inside the
  repo, but not that `<dist-dir>` NAMED that location — so an npm-workspace
  symlink (`node_modules/@chroxy/protocol/dist`, present in every checkout),
  any other in-repo symlinked intermediate component, and (on a case-
  preserving filesystem such as APFS) a wrong-case spelling of a real path
  all physically resolved somewhere legitimate while git's pathspecs could
  not see through them — a silent false-clean that deleted a real orphan
  from the working tree while reporting "OK". A crafted path containing an
  embedded newline (`IFS='/' read -ra` only scans the first line of its
  input) reached the same containment check with its embedded `..` never
  segment-checked, and walked a symlink back "inside" the repo on paper
  while the physical `mv`/`rm -rf` acted on the real, outside-the-repo
  target. Fixed by requiring an EXACT match between what `<dist-dir>` claims
  and where it physically resolves (`cd -P` + the external `/bin/pwd -P`,
  not the builtin, which was observed to preserve the caller's typed case on
  APFS) — any symlinked component or case mismatch now fails validation —
  plus an up-front rejection of any control character in `<dist-dir>`. Also
  closed in the same round: a SIGINT/SIGHUP in addition to the already-
  handled SIGTERM (bash pre-ignores SIGINT for a backgrounded job in a non-
  interactive shell, which had made the harness's own INT coverage a no-op
  rather than a real test); a backup stranded by a SIGKILL (which no trap
  can catch) or an already-failed restore is now detected by the NEXT run
  before it creates one of its own, refusing until the stray copy is
  resolved by hand; and `--literal-pathspecs`, whose comment wrongly claimed
  the basename rule made it moot — pathspec magic is a prefix of the WHOLE
  path, not its last component, so a `:(glob)`-prefixed first component
  still needs the flag.

  `scripts/__tests__/check-dist-drift.test.sh` grows to 86 cases, adding
  ISOLATING coverage for each safety layer individually (a round-2 review
  found 11 of the original 14 such cases were each caught by two or more
  overlapping layers at once, so deleting any single layer left the harness
  green): a symlinked intermediate resolving outside the repo; `.git/dist`
  targeted directly; an in-repo symlinked dist dir with a real orphan behind
  it (reproducing the false-green, and the round-1 logic that would have
  accepted it); the embedded-newline case; a pathspec-magic first component
  with a real orphan, both with the flag intact and removed (mutant); SIGINT
  and SIGHUP restoring `dist/` the same as SIGTERM; a restore that itself
  fails via a PATH-shimmed `mv`, proving the backup is kept and byte-
  identical (plus a mutant restoring round-1's unconditional-delete bug,
  confirming the case actually catches it); no backup surviving a clean or a
  drift verdict (plus a leak mutant); and the stranded-backup detection.

  **A third review round, having confirmed all three round-2 bypasses
  closed (including the `.GIT` case variant, established directly against a
  freshly-mounted case-insensitive disk image rather than inferred), found
  two more problems in this round's own additions.** The stranded-backup
  glob (`STRAY=($BACKUP_GLOB)`) expanded its pattern UNQUOTED, so the
  directory part — not just the intended trailing `*` — was both word-split
  and glob-interpreted: a space or glob character in the repo root or the
  dist dir's parent silently skipped the whole check (every invocation from
  such a checkout never saw a stranded backup again), and a space-containing
  parent with an unrelated real sibling directory misread that sibling AS a
  stranded backup and told a developer to `rm -rf` it. Fixed by quoting only
  the dirname and leaving the literal glob suffix outside the quotes; the
  printed recovery commands are now `printf '%q'`-quoted too (an unquoted
  path with a space previously split `rm -rf parent/dist` into two wrong
  arguments), and the restore form now ends in `&& rmdir <parent>` so
  following it verbatim doesn't leave an empty backup directory for the next
  run to trip over. Separately, the harness's own isolating case for the
  round-2 exact-match fix never actually reached it: its fixture symlink was
  named `linked-dist`, which the "must end in `dist`" basename rule rejects
  BEFORE containment ever runs, so reverting the exact match to round 1's
  prefix-only logic — the one thing round 2 was blocking on — left the
  harness fully green. Replaced with a symlinked INTERMEDIATE component
  (the actual npm-workspace shape) whose own last component is literally
  `dist`, which does reach and is rejected by the exact-match check, proven
  by a mutant that reintroduces the prefix-only regression.

  Folded in the same round: the harness's "RED proof" for that same case had
  been run inside a pipeline subshell, silently discarding its pass/fail
  result (measured: forcing it to fail left 87 printed outcomes against a
  summary of 86); `check()` now also appends to a real file on every call,
  and the final tally cross-checks against that file's line count, which a
  subshell cannot make disappear. The INT/HUP signal cases were found to
  signal only the whole process group, under which bash's own default fatal-
  signal handling fires regardless of whether this script's own trap is
  present — so removing either trap went unnoticed; per-PID-only variants
  (with `set -m` still active so the job's signal dispositions stay normal)
  now isolate each trap, backed by its own mutant. A nested, non-submodule
  `.git` (e.g. `packages/sub/.git/dist`) was previously accepted, since the
  physical check's own `.git` rule only ever compared against the top-level
  path; a component-level `.git` rule now rejects one at any depth. The
  case-variant closure gained a harness case too, detected at runtime
  (case-insensitive filesystems only) with a visible, count-neutral SKIP
  line where it cannot run.

  `scripts/__tests__/check-dist-drift.test.sh` grows to 120 cases.

- **The root Docker image serves the dashboard and defaults to the headless
  `claude-sdk` provider, and actually proves it (#8151, HIGH-tier review
  round).** An owner decision scoped the image to exactly two things: the
  headless `claude-sdk` provider, and the web dashboard — the embedded
  user-shell terminal and the `claude-tui` provider are not supported
  (`node-pty` has no linux prebuild in this image, and `claude-tui` assumes
  an interactive login shell).

  A new `dashboard-builder` stage builds `@chroxy/dashboard` (Vite) from just
  its own dependency graph (`@chroxy/design-tokens`, `@chroxy/protocol`,
  `@chroxy/store-core` — installed via `npm ci --workspace=@chroxy/dashboard`,
  never the whole monorepo) and the final image copies in only the built
  `dist/`, so `GET /dashboard` now serves the real app instead of 404ing.
  `ENV CHROXY_PROVIDER=claude-sdk` overrides the daemon's own default
  (`claude-tui`) so a plain `docker run` no longer starts sessions doomed to
  fail; `-e CHROXY_PROVIDER=...` still overrides it per the normal CLI > env
  > config > default precedence — and so does `chroxy doctor`'s own provider
  resolution now, which previously skipped the env tier entirely and
  preflighted/reported on `claude-tui` even with `CHROXY_PROVIDER=claude-sdk`
  set and no config file yet written.

  Selecting the terminal or `claude-tui` anyway fails with a clear,
  ACTIONABLE message (`describeNodePtyUnavailable`, shared by both call
  sites, leading with "use claude-sdk instead" and appending only the first
  line of the real cause) rather than a raw native-module error — and that
  message is now the one a client actually SEES: `claude-tui-session.js`'s
  `start()`/`_spawnPty()` split used to let a generic "claude PTY failed to
  spawn" overwrite it the instant `start()` rejected (the `error` event and
  the rejection are different channels; `session_create_failed.errorMessage`
  reads the rejection). Both call sites now latch the real failure
  (`.code: 'PTY_UNAVAILABLE'`) and reject with it directly.

  The dashboard's own "New Session" provider picker also used to pre-select
  the shared `DEFAULT_PROVIDER` constant (`claude-tui`) regardless of what
  the connected server actually runs by default — `provider_list` /
  `auth_bootstrap` now carry the daemon's resolved `defaultProvider`
  (`resolveDaemonDefaultProvider`), applied client-side only when the user
  has no persisted explicit choice; `listProviders()` also marks `claude-tui`
  `auth.ready: false` with an actionable hint when a cached, one-shot
  node-pty probe (`node-pty-probe.js`, warmed once at boot) finds it
  unavailable, so the picker greys it out instead of letting it be chosen at
  all.

  `scripts/docker-image-smoke.sh` grew from three checks to six: (1) the
  Default session actually comes up under `claude-sdk` — checked 2's
  HEALTHCHECK answers regardless of session state, so a `claude-tui` image
  was previously HEALTHCHECK-healthy while its Default session silently
  failed and was torn down — proven by polling `docker logs` for the sdk
  session's own ready line and asserting neither a node-pty failure nor a
  destroyed-session line appears; (2) `GET /dashboard` first confirms NO
  token is rejected (403), then extracts the REAL entry-bundle path from the
  served HTML and fetches it — a `<title>` check alone passes on the UNBUILT
  source `index.html` just as readily as on a real build; (3) every
  THIRD-PARTY dependency in `packages/server/package.json` is checked via
  the same subpath-aware specifier scan check 1 already used for
  `@chroxy/*`, generalized — `@modelcontextprotocol/sdk` is resolved at its
  real used subpaths instead of a hand-written exemption that hid it from
  ever being checked at all, and the two remaining special cases
  (`node-pty`, an EXPECTED import failure that itself fails loudly if it
  ever unexpectedly succeeds; `@xterm/*`, checked by file existence at the
  exact paths `http-routes.js`'s `readModule` reads, never exempted from
  checking) are validated in both directions.

  `docs/self-hosting-guide.md` documents the supported/unsupported split,
  the terminal's actual failure message, the `CHROXY_CWD=/workspace` example
  (new sessions otherwise default to `$HOME`, not the bind-mounted
  workspace), and that the baked-in `ENV` outranks a mounted config file's
  `provider`. `.dockerignore` and `ci.yml`'s `docker` path filter stay in
  sync for the two newly-whitelisted packages, and `.dockerignore` now also
  excludes stray `.env*`/coverage/`.tsbuildinfo` files, the dashboard's own
  test sources, and `packages/server/src/dashboard-next` (the gitignored
  Tauri-bundle copy of this same dashboard, invisible to `.dockerignore`
  once it exists on a machine that has built the desktop app).

  **Round-2 review** found four more CRITICAL gaps, each confirmed
  independently, every one fixed here:

  1. The two "start() rejects with the actionable message" tests only ever
     exercised the TEST-ONLY `_ptyModOverride` seam — the PRODUCTION
     `ptyMod = await import('node-pty')` branch was untested, and reverting
     only that branch's catch (both files) left 2229 tests green. A new
     `node-pty-production-import.test.js` runs the real `start()` in a
     CHILD PROCESS with a `node:module` `registerHooks` resolve hook that
     makes `import('node-pty')` actually reject, loaded alongside the usual
     sandboxed `tests/_setup.mjs`. The two catch bodies (one per
     import-invocation shape, kept separate so `lint-argv-sinks.mjs` still
     sees the literal `ptyMod = await import('node-pty')` line) now share
     ONE failure-building helper, `nodePtyImportFailureError`
     (`node-pty-support.js`), instead of duplicating the construction.
  2. `chroxy doctor`'s own CHROXY_PROVIDER/CHROXY_PROVIDERS fix (above) was
     itself a regression outside Docker: `CHROXY_PROVIDERS` is a REAL,
     documented env var for `config.providers` (the anthropic/openai
     -compatible endpoint registrations), not a provider-name list — setting
     it to its own documented JSON-object form got comma-split into garbage
     tokens, and an unrelated `CHROXY_PROVIDERS` could make doctor check the
     wrong provider entirely. `resolveProviders` now routes through the same
     shared `mergeConfig`/`resolveDaemonDefaultProvider` the real daemon
     startup path uses, instead of a second hand-written env/file read.
  3. The whole C3 default-provider chain was unguarded end to end — deleting
     the probe's real import, `auth_bootstrap`'s `defaultProvider` field, or
     either store-core `applyServerDefaultProvider` call left every affected
     suite green (211/211, 340/340, store-core 2445/dashboard 6228). New
     tests cover each link: the probe's boolean under a real
     success/failure import (child process + resolve hook, with an
     attempt-counter proving the cache avoids a second resolution);
     `sendPostAuthInfo`'s `auth_bootstrap` defaultProvider against a
     configured provider and the DEFAULT_PROVIDER fallback; store-core's
     `provider_list`/`auth_bootstrap` dispatch calling (or correctly NOT
     calling) `applyServerDefaultProvider`; and the dashboard adapter
     actually writing (or correctly not overwriting) the store's
     `defaultProvider` depending on whether `chroxy_default_provider` is
     already persisted.
  4. The smoke script's own negative-signature grep (`'node-pty
     unavailable'`) was DEAD — S8's rewording to "node-pty is unavailable
     here" left it matching nothing a real regression would ever produce.
     `describeNodePtyUnavailable()` now embeds a stable
     `NODE_PTY_UNAVAILABLE_CODE` marker (`PTY_UNAVAILABLE`, also the
     failure's `.code`), and the smoke script reads that SAME marker from
     the image's own `node-pty-support.js` rather than hand-copying the
     prose — so a future rewording can't silently disarm the check again.
     Re-run against a `claude-tui`-mutant image with the earlier
     "Ready for messages" gate temporarily bypassed, the marker check is
     confirmed to independently catch the regression on its own.

  Plus eight suggestions: the log-signature check now ALSO re-reads
  `docker logs` at the very end of the run (after checks 4-6), not just
  once right after the Default session comes up; the dashboard check now
  fetches EVERY referenced `/dashboard/assets/*` file (script src + link
  href), not just the first `<script>`, and the entry bundle additionally
  gets a 10KB floor against a degenerate near-empty build; the dependency
  scan's subpath scanner now fails and names the line if it finds a line
  that both mentions `from`/`import`/`require` AND quotes a declared
  dependency in a form the strict specifier regex doesn't recognise
  (narrower than a bare substring match, which flagged 57 false positives —
  common words like "ws"/"openai" are frequently plain string values
  unrelated to any import); the non-Docker remediation now says "rebuild
  AND restart the daemon", and the probe module's doc no longer claims Node
  doesn't cache a rejected import (it does — measured: a throwing stand-in
  module's body runs exactly once across four repeated imports; the real
  reason this module still caches a boolean is that `listProviders()` is
  synchronous and can't await on every call) and now notes that on win32 a
  successful import proves only that the JS wrapper loaded, not that the
  native binding actually works; the dispatch-table doc for
  `applyServerDefaultProvider` no longer claims an app-side implementation
  that doesn't exist — the mobile app's "Default" chip already sends no
  explicit provider at session creation, so the functional behaviour this
  field exists to fix is already correct there by construction, and wiring
  the hook into the app's own persisted-settings store (closing a smaller,
  cosmetic capability-lookup gap) is tracked as a follow-up rather than
  folded in here; and `run_with_timeout`'s bounded calls now escalate to
  SIGKILL after a 10s grace period if SIGTERM alone doesn't reap the
  process (`-k 10` for `timeout`/`gtimeout`, a matching grace-then-KILL loop
  in the perl fallback) instead of potentially hanging past their own bound
  against a command that ignores SIGTERM.

  **An independent verifier confirmed every round-2 mutant goes RED, and
  found one more real production bug plus further test gaps, all fixed
  here too.** The real bug: `auth_bootstrap.defaultProvider` was
  UNCONDITIONALLY `DEFAULT_PROVIDER` (claude-tui) in every real connection
  — `WsServer._historyCtx` (the ctx `sendAuthBootstrap` actually runs
  against) had no `config`/`services` key at all, so
  `resolveDaemonDefaultProvider(services?.config)` always resolved
  `undefined`. The round-2 C3 test never caught it because it built its ctx
  object by hand, with exactly the shape the (buggy) code expected — never
  exercising a real `WsServer`. Fixed with a `get config() { return
  self.config }` getter on `_historyCtx` (flat, matching its existing
  `fileOps`/`tunnelUrl` shape — `_handlerCtx` nests the same read under
  `services`, used by `list_providers`; both now read the same
  `self.config`, so the two can't diverge again), and a new test that
  builds a REAL `WsServer` with `config: { provider: 'claude-sdk' }`,
  connects a real client, and asserts the real `auth_bootstrap` frame off
  the wire.

  The two new child-process test files also failed on Windows CI
  (`ERR_UNSUPPORTED_ESM_URL_SCHEME`): `--import` goes through Node's ESM
  loader, which requires a `file://` URL for a Windows absolute path — a
  bare `A:\...\thing.mjs` throws. Fixed by converting every `--import`
  value to `pathToFileURL(...).href` (a no-op on POSIX); the MAIN SCRIPT
  argument stays a plain path, since it resolves through a different,
  non-URL-aware mechanism (confirmed: a file:// URL there fails on POSIX
  too). One of those same child-process harnesses was also found writing a
  stray `~/.claude.json.chroxy.<uuid>.tmp` copy into the real developer
  `$HOME` — `ClaudeTuiSession.start()`'s real `ensureCwdTrusted` call reads
  `homedir()`, which the in-process fs sandbox cannot intercept in a
  spawned child. Fixed by giving the child its own disposable `HOME`/
  `USERPROFILE`, with a test assertion that the real `~/.claude.json`'s
  mtime is unchanged after the run.

  Further gaps closed: the boot-time probe cache and `listProviders()`'s
  no-injection read of it were never exercised together (only each in
  isolation) — a new child-process test resets the probe, forces a real
  import failure, then calls `listProviders()` with no injection and
  asserts `claude-tui` comes back greyed out, plus a
  structural pin that `server-cli.js` still calls the probe before
  `wsServer.start()`. `chroxy doctor`'s CONFIG-FILE provider tier (the
  lowest of its four, below CLI/ENV/default) had no test coverage at all.
  `run_with_timeout`'s own `-k 10` fix (above) returns 137, not 124, when
  the KILL escalation actually fires — GNU `timeout`'s exit-code convention
  reports the wrapped command's own "killed by signal" status once TERM
  alone didn't work, not its usual 124 — normalized in the one place both
  GNU backends return through, with new TERM-ignoring-process cases added
  on both the real backend and the forced perl fallback. The dependency
  scan's unrecognised-import-line floor missed a template-literal
  specifier with interpolation (`` import(`@pkg/${sub}`) ``, never
  followed by a closing quote); its mention-matcher now also accepts
  `${` as a valid terminator. The entry-bundle size floor was applied to
  "whichever `.js` asset happened to sort first" rather than the actual
  `<script src>` entry tag — Vite's own lazily-loaded chunks (route
  splits, heavy deps like `mermaid`/`katex`) aren't referenced from the
  HTML at all today, but a future build emitting a small referenced one
  would have silently floor-checked the wrong file. The S1 end-of-run
  re-check only covered whatever the 2-3s gap between checks happened to
  leave — now actively tops up to a 15s observation window past Ready,
  and additionally asserts the container is still `Running` and that the
  image's own HEALTHCHECK command still passes, not just that its logs
  don't yet show a failure. A dead `|| fail "internal: ..."` guard (attached
  to a process substitution's own discarded exit status, which bash never
  propagates to the enclosing `while`) is now attached to a real command
  substitution's exit status instead. The node-pty-probe module's win32
  -vs-macOS claim was itself wrong — checked directly against the
  installed package: node-pty ships prebuilt native addons for BOTH win32
  AND darwin (none for linux), so the "a successful import doesn't prove
  the native binding works" caveat applies to both platforms equally, not
  just win32. `config.js`'s `envKeyForConfig` export (added for the now
  -replaced direct-read approach) reverted to module-private — nothing
  outside this file reads it anymore.

- **`git_status` and `git_stage`/`git_unstage` now agree on what a path
  means, status paths are no longer C-quoted or octal-escaped, and a
  renamed entry's `oldPath` never leaks onto the wrong half or onto a copy
  (#7292, review follow-up #8183).**
  `gitStatus` (`packages/server/src/ws-file-ops/git.js`) forwarded `git
  status --porcelain=v1` paths to the client verbatim. Defects fell out of
  that, all invisible at the repo root (every prior git-status/git-stage
  fixture used it) and all real from a session cwd that is a repo
  subdirectory: (1) `git status` paths are REPO-ROOT-relative even when run
  from a subdirectory, while `gitStage`/`gitUnstage` resolve whatever they
  receive against the SESSION CWD — staging from a subdirectory session
  could silently stage the wrong file, or fail with an opaque pathspec
  error; (2) porcelain C-quotes/octal-escapes a path containing spaces or
  non-ASCII bytes (`"caf\303\251.txt"`), and the client received the
  literal quotes/escapes, which can never match a real file; (3) a
  staged rename reported only its destination, so unstaging it left the
  source's staged deletion behind (git records a rename as two independent
  index operations, not one atomic move).
  The wire contract is now explicit (documented in `git.js`'s header and the
  protocol schema): `git_status_result` paths are always relative to the
  SESSION CWD — the same base `git_stage`/`git_unstage` already resolve
  `file` against — '/'-separated, and never quoted/escaped. `gitStatus` gets
  there with `git status --porcelain=v1 -z` (NUL-delimited, which disables
  quoting and reports a rename/copy as two separate fields instead of an
  ambiguous `<path> -> <path>` join) and rebases every repo-root-relative
  path onto the session cwd via `git rev-parse --show-toplevel`.
  A **rename-only** `oldPath` field was then found to leak in a follow-up
  review: it was attached to BOTH halves of a record whenever the STAGED
  side was a rename/copy, so an "RM" record (a staged rename whose
  destination is further modified, unstaged) wrongly carried `oldPath` on
  the plain `modified` unstaged entry too, and a **copy** (whose source is
  NOT removed, unlike a rename) got expanded the same way a rename does —
  staging/unstaging a copy's destination could fold in the source's own,
  unrelated changes. `oldPath` is now attached per COLUMN (only when that
  half's own code is `R`), never for `C`, and the extra NUL field is
  consumed whenever EITHER column is `R`/`C` (a worktree-side rename via
  `git add -N` on a moved file previously desynced the NUL parser, inventing
  ghost entries and swallowing real ones). `@chroxy/store-core`'s
  `expandRenamePathsForStaging` — sent alongside `path` by the dashboard's
  `GitPanel` and the mobile app's `GitView` on stage/unstage — also checks
  `status === 'renamed'` directly as defense in depth. Also fixed in the
  same follow-up: `--show-toplevel`'s output is trimmed of only its
  trailing newline (not `.trim()`-ed, which mis-based every path when the
  repo root's own directory name ended in whitespace); an untracked
  directory keeps its trailing slash on the wire instead of losing it to
  `relative()`; a session cwd inside (or that IS) an untracked directory no
  longer emits a bare `''`/`'..'` untracked entry nothing could act on;
  and `gitStage`/`gitUnstage`'s pathspec args gained fixtures proving the
  existing `--` separator actually matters (a file named `--all`/`--hard`
  would otherwise be read as a flag by git's own argv parser).

- **Dashboard: worktree sessions show and group by their repo on the
  sidebar, footer, and file tree — not the opaque worktree-hex basename
  (#8123, follow-up to #7328).** #7328 fixed the SessionBar tab-cwd badge so
  a worktree-isolated session (whose `cwd` is `~/.chroxy/worktrees/<32-char
  hex>`) shows the repo name via `repoCwd` (already threaded on every
  `session_list` entry); its thread flagged three more sites leaking the
  same hex. `packages/dashboard/src/utils/repoLabel.ts`'s `repoDisplayName`
  is now the ONE shared derivation all four surfaces call:
  - **Sidebar repo group (`App.tsx`'s `sidebarRepos`).** The worst of the
    four — sessions were grouped BY `cwd`, so every worktree session formed
    its own hex-named group instead of joining its repo's other sessions,
    defeating the grouping's purpose. The group key is now `repoCwd || cwd`;
    a repo's normal and worktree sessions now appear under one group named
    after the repo. `repo.path` (the group key) also feeds "new session in
    this repo" and the per-repo drag-order/collapse state — a worktree
    group's new-session action now targets the real repo directory instead
    of a worktree path, and stale per-worktree order entries saved under the
    old (pre-fix) key simply age out (`applyOrderById` already drops
    unmatched saved ids and appends the merged group at its natural
    position) rather than needing an explicit migration.
  - **Footer cwd breadcrumb (`FooterBar.tsx`).** Its own, differently-shaped
    `abbreviateCwd` (last 2 path segments, not SessionBar's 1) predates
    `repoLabel.ts` and is intentionally different, so `repoDisplayName`
    gained an optional `fallback` parameter — the footer passes its own
    last-2-segments function, sharing only the worktree-repo-name part while
    a plain session's display is byte-identical to before.
  - **File-tree root label (`fileTreeLogic.ts`'s `buildBreadcrumbs`).** A
    new optional `rootLabel` parameter overrides the root crumb's LABEL
    only; its `path` always stays derived from `rootPath`, so a worktree
    session's file tree shows the repo name at the root while breadcrumb
    navigation still targets the real worktree directory.
  `packages/app` was checked for the same leak and does not share this fix —
  see the follow-up note below.

  **Review follow-up (same PR):** the grouping-key change above had one
  consumer nobody had updated — `sidebarContextMenuItems.ts`'s repo-group
  "Summarize & start new session" item still filtered on raw `s.cwd`, so a
  worktree-only repo group's Summarize item silently vanished and a mixed
  group could only ever target its plain session. Fixed by extracting the
  group-key rule into a THIRD shared helper, `sessionGroupKey` (also in
  `repoLabel.ts`), that both `App.tsx`'s `sidebarRepos` memo and
  `sidebarContextMenuItems.ts` now call — the two can no longer drift apart.
  `RepoEventsSection.tsx`'s "active repos" scope (`activeRepoBasenames`) had
  the same bug class and now derives from the same key. `abbreviateCwd` now
  splits on `[\\/]+` (matching `repoBasename`'s Windows-aware split) instead
  of `/` only, so the two "basename of a path" helpers can't silently
  disagree on a Windows daemon's backslash cwd.

- **`release.yml` smokes the Docker image before pushing it (#8150).** The
  `docker` job built the root Dockerfile with `docker/build-push-action`,
  `push: true`, and pushed straight to GHCR — nothing in the job ever
  started the image. That is exactly how the v0.11.0 image shipped unable to
  start at all (`ERR_MODULE_NOT_FOUND`, #8133): the push succeeded because a
  push doesn't care whether the thing it uploads can run.
  `scripts/docker-image-smoke.sh` (added for #8133) already proved an image
  can start, but nothing wired it into the one workflow that actually
  publishes a release — it only ran PR-side, path-filtered, and not
  required. The job now builds once with `load: true` / `push: false`
  (tagged with both the real metadata-action tags and a fixed local
  `chroxy:release-smoke` tag), smoke-starts that same local image, logs in to
  GHCR only AFTER the smoke passes (narrowing the window registry
  credentials are present), and only then pushes the already-built tags via
  `env: TAGS:` (never interpolated into the shell script) — never rebuilt, so
  what is smoked is byte-for-byte what ships. `ci.yml`'s `Docker Image
  Smoke` job now builds with the SAME pinned `docker/build-push-action` ref
  and `load: true` / `push: false`, so the release build+load path is
  exercised on every Docker-touching PR, not just at release time.
  A new static gate test (`release-docker-smoke-gate.test.js`) runs over
  every job in `release.yml` with a publishing step (not one job looked up
  by id) and fails the build if: the smoke step is missing, wrapped (`||
  true`, `; exit 0`, a preceding `set +e`, or commented out), reordered
  after a publish, given `continue-on-error`, or paired with a publishing
  step whose `if:` isn't absent or exactly `success()` (closing three
  operand-order bypasses `X || success()` / `!success()` / `true ||
  success()` a naïve "contains always/failure/cancelled" check misses); if a
  build-push-action step publishes via `outputs: type=registry` or a
  non-lowercase-`false` `push:` value without ever setting `push: true`;
  if anything rebuilds the image between the smoke and the last publish; or
  if a registry login runs before the smoke. The "was this tag really
  built?" check reads the build step's `tags:` input structurally (not a
  raw-text scan, which a neighbouring step's comment could satisfy). It also
  rejects a `shell:` override other than absent or the literal `bash` on the
  smoke step or a publishing step (a custom shell template can swallow a
  real exit code without the `run:` text ever changing), rejects job-level
  `continue-on-error:` anywhere in a publishing job's transitive `needs:`
  closure (previously checked only inside `verify-artifacts`' own body),
  and rejects a `docker tag`/`docker image tag`/`docker load`/`docker image
  load`/`docker import`/`docker pull`/`docker image pull`/`docker commit`/
  `docker buildx imagetools` step between the smoke and the last publish —
  a retag or reload repoints the pushed tag at unsmoked content without
  ever rebuilding. A second new test (`ci-docker-path-filter.test.js`,
  parsed with `js-yaml`) ties `ci.yml`'s `docker:` path filter to
  `.dockerignore`'s package whitelist in both directions, so the two
  rosters cannot drift apart un-noticed (#7639) — a floor, not a pinned
  set, so a correct two-sided package addition never trips it, and a glob
  whitelist entry fails loudly instead of misparsing. The shared "what
  counts as publishing" vocabulary and the job-level gating walk
  (`packages/server/tests/helpers/release-publish.js`) are now one module
  imported by both this gate and `release-verify-artifacts-gate.test.js`,
  which previously carried its own, already-drifted copy.

- **The spawn-env inherited-secrets roster strips comments with a real
  tokenizer, not a regex, so it can no longer misread a glob quoted in a
  comment as a block-comment delimiter (#8142).** The roster test's
  `stripComments()` used a naive `/\*[\s\S]*?\*\//g` block-comment regex with
  no awareness of strings, template literals, or regex literals: it just
  scanned raw text for the next `/*`...`*/` pair anywhere. `src/byok-tool-executor.js`'s
  prose quotes glob patterns in backticks like `` `node_modules/**` `` and
  `` `**/*.ts` ``, whose literal `/**` substring the regex read as a
  block-comment open, then deleted everything up to the next glob's own `**/`
  much later in the file — ~76% of that file's real text (39,658 of 165,633
  chars survived), including a `try {` whose paired `finally {` survived
  alone (a real parser rejects the result outright: `'try' expected`). The
  fix replaces it with the already-existing, `ts.createSourceFile`-backed
  `stripComments` (`packages/server/scripts/lib/strip-comments.mjs`, already
  used by every lint in this package): it blanks only genuine comment trivia
  from a real parse, so there is no "next `/*`/`*/`-like substring" for it to
  misread. `packages/server/tests/providers.test.js`'s own local
  `stripComments` had the same defect class one level down (its block-comment
  open is restricted to the start of a line, but a line-start JSDoc block
  whose prose contains a literal `*/` — the same glob shape — still closes
  early) and is fixed the same way. A new oracle
  (`spawn-env-inherited-secrets-roster.test.js`) parses every file the roster
  scans — 342 files today — twice, once over the raw source and once over
  the stripped output, and asserts both that the stripped text still parses
  with zero syntax diagnostics and that its non-comment token stream is
  byte-for-byte identical to the raw file's (JSDoc pseudo-nodes and the
  terminal `EndOfFileToken` excluded from both sides, since TypeScript parses
  JSDoc prose into real tree nodes for plain `.js` files). A companion
  hand-rolled comment scanner in `scripts/lint-write-only-ctx-fields.mjs` has
  a narrower version of the same defect (filed as #8172 rather than folded
  into this fix, given its size and dedicated test suite).

- **The root Docker image ships a pinned, signature-verified `claude` CLI, so
  `start` now passes preflight without `--skip-checks` (#8145).** The image
  never installed a `claude` binary at all: since #7986/#8035, SDK mode
  deliberately spawns an *installed* CLI via `pathToClaudeCodeExecutable` and
  refuses the Agent SDK's own bundled platform binary as unverified, so
  `chroxy start` in the image failed preflight with `✗ claude: Not found`. A
  new `claude-cli` builder stage downloads one exact release straight from
  Anthropic's release bucket, verifies the release signing key's fingerprint,
  re-exports that key BY FINGERPRINT into its own single-key keyring, and
  verifies the signed manifest against ONLY that keyring with `gpgv`, not
  `gpg --verify` — checking that the pinned fingerprint is present somewhere
  in the downloaded key file and then verifying against the whole imported
  keyring accepts a signature from *any* key in it, which is a real bypass an
  attacker controlling the download could exploit by appending a second key
  (found and reproduced during review). The manifest's own version is then
  checked against the pin, and the platform binary's sha256 against the
  manifest, before it is copied into the final image — every step fails the
  build on mismatch. `scripts/docker-image-smoke.sh` no longer passes
  `--skip-checks` to `start`, and now also checks that the image's own
  `claude --version` reports the pinned version. The sidecar Dockerfile's
  `CLAUDE_CODE_VERSION` pin is bumped from 2.1.128 (below the
  `CLAUDE_SDK_MIN_CLI_VERSION` floor) to 2.1.280, and a new server test
  (`dockerfile-claude-version-floor.test.js`) fails the build if any
  Dockerfile's pin ever falls below that floor again. Renovate now tracks the
  root Dockerfile's pin alongside the sidecar's.

- **`scripts/verify-publish-artifacts.mjs` now runs on PRs that touch what it
  verifies, not only at release time (#8167).** The script packs
  `@chroxy/protocol`, `@chroxy/store-core` and `@chroxy/server`, installs them
  into a clean prefix, and proves the result boots — `chroxy --version`,
  `chroxy doctor` through `classifyDoctorOutput`, and the daemon's lazily
  imported entry points. Its only callers were `release.yml`'s
  `verify-artifacts` job (which runs only when a release is cut) and the
  manual `scripts/publish-siblings.sh`, so the end-to-end path — doctor's real
  output on the real hosted runner going through the classifier — was first
  exercised by a release. `v0.11.1` showed how that fails: the release job
  was broken for as long as it existed, and nothing noticed until a publish
  depended on it. `ci.yml` now has a new path-filtered `Verify Publish
  Artifacts (PR)` job, gated on a new `publish_artifacts` `dorny/paths-filter`
  output covering `packages/server/**`, `packages/protocol/**`,
  `packages/store-core/**`, the verify script and its `scripts/lib/` helpers,
  the root manifest/lockfile, and `release.yml` itself (which this job
  mirrors — same runner, same checkout/setup-node/`npm ci` steps). It is
  **not** a required check: like `Docker Image Smoke` before it, it is new,
  rare (path-filtered), has no measured flake baseline yet, and its install
  step resolves dependencies from the npm registry on every run — recorded in
  `CONTRIBUTING.md`'s not-required table alongside the same reasoning. A new
  static test, `ci-publish-artifacts-path-filter.test.js`, checks the filter
  list against the verify script's own `PACKAGES` array and `./lib/*` imports
  in both directions, and against the real repo tree, so the two cannot
  silently drift apart the way `ci-docker-path-filter.test.js` (#8150) already
  guards for the Docker image's filter.

## [0.11.2] - 2026-09-30

### Fixed

- **`release.yml`'s `verify-artifacts` gate can now actually pass on the hosted
  runner, and nothing publishes ahead of it (#8165).** `scripts/verify-publish-artifacts.mjs`
  required `chroxy doctor` to print "All checks passed", but ubuntu-24.04 has
  neither `cloudflared` nor the default claude-tui provider's `claude` binary,
  so doctor always failed those two checks there and the gate could never go
  green — meanwhile `docker` and the desktop builds needed only `test`, so a
  release could push the GHCR image (and move its floating `:{major}.{minor}`
  tag) while verification failed and `github-release` was skipped: a partial
  publish. Doctor now runs via `spawnSync` (a nonzero exit is data, not a
  throw) and its output is classified by a new pure `classifyDoctorOutput()`
  (`scripts/lib/classify-doctor-output.mjs`): the `Node.js` and `Dependencies`
  rows must be OK, and any `FAIL` row is tolerated only when it is a missing
  binary (`Not found — <hint>`, cloudflared or a provider CLI) — anything else
  still fails the gate. `docker`, `desktop-macos`, and `desktop-windows` now
  each also `needs: verify-artifacts`, and a new workflow-structure test
  (`packages/server/tests/release-verify-artifacts-gate.test.js`) pins that
  every job performing a publish action (a Docker push, the GitHub Release
  upload) transitively needs it. A follow-up review hardened this further:
  the verifier now also `import()`s `server-cli.js`/`supervisor.js` out of
  the installed package (`chroxy start`'s own lazily-imported daemon module
  graph, which nothing above it had ever exercised), the binary-miss
  tolerance is anchored to the start of a FAIL row's message rather than a
  loose substring, a row that doesn't fully parse (an embedded `\r`,
  U+2028, or U+2029) now fails closed instead of silently vanishing,
  doctor's closing summary line is required so a truncated or
  signal-killed run can't pass as a completed one, and the workflow test
  also catches a job-level `if:` that bypasses `needs:` gating and a
  `verify-artifacts` job that no longer actually runs the verifier script.

- **`release.yml`'s Test Suite now installs ripgrep before running the server
  tests, from the same definition `ci.yml`'s Server Tests job uses (#8160).**
  Merging #8157 cut the `v0.11.1` tag and dispatched `release.yml` (run
  36669663799); Test Suite failed with ten hard failures in
  `tests/built-in-tools/grep-argv-injection.test.js` (#7295), all of them
  "ripgrep is not installed on this CI runner" — a deliberate CI hard-fail, not
  a skip, so a green log was never possible without rg. The #7978 oracle in
  `tests/permission-floor-grep-glob.test.js` failed alongside it, in its
  describe-level `before` hook for the same reason, which cancelled every test
  under it. Every downstream job was skipped as a result, so **the `v0.11.1`
  tag exists but was never published**: no GitHub release, no
  `ghcr.io/blamechris/chroxy:0.11.1` image, no desktop artifacts. The two jobs
  now share one composite action, `.github/actions/ensure-ripgrep`, so they
  cannot drift apart again, and
  `packages/server/tests/ci-ripgrep-prerequisite.test.js` fails the build if
  any workflow job that runs the server test suite stops calling it (Windows
  is the one documented exemption — its two rg-dependent test files already
  skip themselves on `win32`). The next release cuts `v0.11.2` with this fix
  included.

- **`scripts/bump-version.sh` now rewrites `@chroxy/*` dependency ranges inside
  `package-lock.json`'s workspace entries too, not just the manifests (#8159).**
  The script already re-pointed every workspace `package.json`'s `@chroxy/*`
  ranges at the new version and bumped the `version` field of every
  `package-lock.json` workspace entry (`packages["packages/<name>"]`), but left
  those same entries' own `dependencies`/`devDependencies`/`peerDependencies`/
  `optionalDependencies` ranges untouched. After a bump the lockfile disagreed
  with the manifests — `npm ci` didn't catch it, since the linked workspace
  package satisfies either range, but the lockfile was no longer what
  `npm install --package-lock-only` would generate, so the next install
  anywhere rewrote those lines as an unrelated diff (found by hand for 0.11.1,
  #8157 — exactly 9 stale range lines). The lockfile rewrite now mirrors the
  manifest rewrite's range construction exactly, and
  `scripts/__tests__/bump-version.test.sh` gained a case asserting no
  `@chroxy/*` range in the lockfile still names the old version after a bump,
  guarded against passing vacuously if its fixture carried none to check.

- **`scripts/bump-version.sh` now passes every path and the version string to
  `node -e` through the environment instead of splicing them into JS program
  text (#7237).** Every `node -e "..."` block — reading the current version,
  rewriting each package's `package.json`/`app.json`/`tauri.conf.json`, the
  workspace `@chroxy/*` dependency ranges, `package-lock.json`, and the
  CLAUDE.md version references — built its JS source by interpolating shell
  variables (`$SERVER_PKG`, `$CLAUDE_MD`, `$TAURI_CONF`, `$ROOT_LOCK`,
  `$NEW_VERSION`) straight into single-quoted JS string literals, the same
  shape #7234's AGENTS.md verification had already moved off of. A checkout
  path containing a single quote broke every one of these with a JS
  `SyntaxError` before a single file was written; a crafted path could have
  gone further. Every `-e` program is now a single-quoted shell argument (so
  the shell performs no expansion on it at all, regardless of content) and
  reads its inputs via `process.env.*`. `scripts/__tests__/bump-version.test.sh`
  gained a case that runs a full bump against a fixture path containing both
  a space and a single quote, and a static guard that fails if any `node -e`
  invocation in `bump-version.sh` is not single-quoted (and that refuses to
  pass when it finds no invocation at all). The Cargo.toml `[package]` version
  rewrite and its verification had the same shape in `sed` and `grep`: both
  now use `awk` with the versions read from `ENVIRON`.

- **The protocol and store-core dist-drift CI checks now catch a new,
  never-committed dist file, not just a modified one (#8152).** Both steps
  rebuilt the package and then ran a bare `git diff --exit-code` against the
  committed `dist/` — but `dist/` is gitignored, so a build that emits a NEW
  file (a new `packages/protocol/src/foo.ts` producing `dist/foo.js`) leaves
  that file untracked *and* ignored, which `git diff` never sees; the check
  stayed green while the file was never committed. `scripts/check-dist-drift.sh
  <dist-dir>` replaces both inline checks: it still diffs tracked content, and
  additionally fails on any untracked/ignored file under the directory
  (`git ls-files --others --ignored --exclude-standard`), printing the
  offending paths and pointing at `git add -f` since the directory is
  gitignored. The store-core step got the same review: its check only ever
  diffed the single `dist/crypto.js` file and never looked at the also-committed
  `dist/crypto.d.ts` at all, a real (and now closed) false-green on its own.
  `scripts/__tests__/check-dist-drift.test.sh` proves a clean dist passes, a
  modified tracked file fails, a new untracked/ignored file fails (the #8152
  case, reproduced against the old check to show it stayed green), and a
  missing dist directory fails loudly rather than reading as clean.

## [0.11.1] - 2026-09-30

### Added

- **Tab now completes the highlighted slash command or `@`-file into the
  composer without sending it (#7370).** The picker already highlighted a
  selected item on Up/Down navigation, but there was no way to accept it
  without also sending — Enter both selects and can dispatch, so the only
  way to complete a command by hand was to type the rest of it. Tab is now
  the explicit two-step affordance: it inserts the highlighted command (or
  file) via the same insertion path Enter/click already use, closes the
  picker, and leaves focus in the composer — the user still presses Enter to
  send. Tab falls through to default browser focus behaviour whenever no
  picker is open, and Shift+Tab never completes, so keyboard/screen-reader
  users can still Tab out of the composer normally.

### Fixed

- **The Docker image can load the server again (#8133).** The published GHCR
  images, including `0.11.0`, could not start: every `start` died on
  `ERR_MODULE_NOT_FOUND` right after the entrypoint wrote its config. The root
  `Dockerfile` copied only `packages/server/` into the image, and
  `.dockerignore` whitelisted nothing else. But the server imports two sibling
  workspace packages at runtime, `@chroxy/protocol` and
  `@chroxy/store-core/crypto`, and `npm ci` links
  `node_modules/@chroxy/<name>` to `packages/<name>`. Those links pointed at
  nothing. The image now copies each package's `package.json` (its exports map)
  and its committed `dist/`. They are copied after `npm ci`, because a workspace
  manifest present at install time makes npm run its `prepare` (`tsc`) script
  even under `--ignore-scripts`. The image's `npm ci` also skips the audit and
  fund calls (#7616). The entrypoint stops writing a `shell` config key the
  server no longer reads (it logged an "Unknown config key" warning on every
  start). The stub `packages/app/package.json` loses its stale hardcoded
  version. The release workflow built and pushed the image on every release,
  but nothing ever ran it, which is how this went unnoticed. A new
  path-filtered `Docker Image Smoke` CI job now builds it and runs
  `scripts/docker-image-smoke.sh`. Every `@chroxy/*` import in the image's own
  server source must resolve inside the image, and an import in a form the
  script can't check fails rather than being skipped. The entrypoint's `start`
  must then pass the image's own HEALTHCHECK. The smoke run passes
  `--skip-checks` until the image ships a `claude` CLI (#8145). Gating the
  release push on the same smoke is #8150.
- **The server now reports `plan` permission mode as unsupported for every
  provider that declares `capabilities.planMode: false` — claude-tui, codex
  (app-server and legacy exec), claude-byok, gemini, and sdk-session — not
  just claude-tui, so the mobile app's chip row disables it exactly where the
  dashboard already hides it (#8090).** `getPermissionModes()`
  (`handler-utils.js`) only special-cased `auto`/`autoPermissionMode`, so
  `available_permission_modes` advertised `plan` as fully supported for every
  one of those providers even though claude-tui's PreToolUse hook (and its
  siblings) skip Chroxy's protected-path floor entirely in that mode (unlike
  approve/acceptEdits/auto, which all route through it) — the raw PTY's own
  prompt, invisible to the structured chat UI, was the only thing left
  standing between a tool call and execution. The check follows
  `capabilities.planMode` directly, the same capability-only rule the
  dashboard has applied since #8087/#8084 (`showPlanMode: caps?.planMode !==
  false`), so mobile and dashboard now agree for every provider instead of
  only claude-tui. The mobile `SettingsBar` chip row already disables purely
  from the server-sent `supported: false` flag, so no app change was needed
  beyond a regression test. The fix is scoped to the advertised list only —
  `assertProviderPermissionModeSupported`/`BaseSession.setPermissionMode()`
  still accept `plan` on every provider regardless of `planMode` — so an
  already-persisted `plan`-mode session on any of these providers restores
  exactly as before instead of failing.
- **Both clients' user-initiated Disconnect now clears the same transient
  streaming/plan state their socket-close handler already swept (#8148).**
  PR #8144 (#7411) taught `onclose` to sweep `streamingMessageId`/
  `isPlanPending`/`planAllowedPrompts` across every session, but explicitly
  left `disconnect()` alone on both clients — a real gap, not something
  reconnect logic papers over, because `disconnect()` nulls `socket.onclose`
  before closing the socket, so onclose's sweep never runs on a
  user-initiated disconnect. A background session mid-stream (or with a
  pending plan) kept its phantom "thinking" bubble / stale plan through the
  next connect. The app's `disconnect()` now makes the same
  `clearStreamingAndPlanStateAcrossSessions(get)` call `onclose` already
  does; the dashboard's `onclose` sweep is now a shared
  `sweepTransientSessionState` helper that `disconnect()` calls too, so it
  additionally clears `pendingEvaluatorClarify` and the presence role
  (`sessionRole`/`primaryClientId`) on disconnect, matching its own onclose
  sweep exactly.
- **The mobile app's socket-close handler no longer strands a phantom
  "thinking" bubble or a stale pending plan on a background session across a
  reconnect (#7411).** The dashboard has swept transient state
  (`streamingMessageId`, `isPlanPending`/`planAllowedPrompts`) for every
  session on socket close since #5731 T4; the app's `onclose` handler still
  used `updateActiveSession` for this trio, so a session other than the one
  currently on screen kept its dirty state through the drop and reconnect —
  `streamingMessageId` in particular renders as a stuck "thinking" indicator
  the next time that session is viewed. `clearTransientSessionState`
  (`@chroxy/store-core`) is now the single source for this clear, used by
  both clients so the two sweeps can't drift apart on it again, and the app's
  `onclose` now sweeps every session the same way it already does for
  `inactivityWarning`/`sessionRole`/`primaryClientId`.
- **The mobile app now shows the provider badge for every session, the default
  provider included (#8130).** `SessionPicker`'s badge gate
  (`session.provider !== DEFAULT_PROVIDER`) suppressed the badge whenever a
  session ran the default provider, so a `claude-tui` pill sat unbadged next to
  a `claude-cli` pill's `CLI` badge — indistinguishable from a session whose
  provider was simply unknown. The badge and the long-press alert title suffix
  now both render unconditionally whenever `session.provider` is present,
  routed through the same shared `getProviderInfo` helper the dashboard already
  uses (PR #8129) so the two surfaces cannot disagree again.
- **`claude-opus-4-8` pricing corrected to $5/$25 with no long-context premium
  (#7434).** Was incorrectly priced at $15/$75 with a 2× premium above 200K
  input tokens. Opus 4.8 has 1M context at standard API pricing with no
  premium tier (source: https://platform.claude.com/docs/en/about-claude/pricing).
  Cost display and estimates now accurately reflect published rates.
- **A straggling survey from a pruned session can no longer write its stale
  reading into a reused session id's new record (#8094).** The shared
  per-session survey throttle (`survey-throttle.js`) orders a write-through
  onto a superseded record only by `snapshotAt`, and a record with no reading
  yet passes that check unconditionally — the escape hatch that lets a first
  survey's completed reading reach a record its own admission has since been
  superseded on. `forget()` (a session_destroyed prune) deletes a record
  outright, and a session id can be reused afterward (`preserveId`
  restore/rebind) with the new admission's record starting the same way, with
  no reading yet. A survey admitted under the forgotten prior incarnation that
  finally resolved after the reuse satisfied the same escape hatch, writing
  its stale reading into the new incarnation's record. Every record now also
  carries a `lineage` — copied forward from `prior` on an ordinary supersede,
  minted fresh only when there is none to copy (i.e. right after a
  `forget()`) — and a write-through additionally requires the committing
  survey's lineage to match the current record's, so a straggler from a
  forgotten incarnation can never land in one that reused its key.
- **BYOK tool calls no longer stream unredacted secrets over `tool_input_delta`
  (#8137).** `byok-session.js`'s `content_block_delta` handling forwarded the
  Anthropic SDK's raw `input_json_delta` partial-JSON chunks verbatim as
  `tool_input_delta { partialJson: t.partial }` — never run through
  `sanitizeToolInput` (`redaction.js`, the #6029 secret-redaction floor).
  Unlike the latent gap #8135/#8136 fixed on cli/sdk, this one was live on
  every BYOK tool call that carried input, whether or not the call ever
  triggered a permission prompt: a secret embedded in a benign-keyed value —
  `{ command: 'export TOKEN=sk-ant-api03-...' }`, `{ url:
  'https://discord.com/api/webhooks/...' }` — streamed to every subscribed
  client, unredacted, on the live wire. Raw partial JSON can't be safely
  redacted (a secret can straddle chunk boundaries; mid-stream partial JSON
  generally isn't parseable), so `byok-session.js` no longer forwards
  `input_json_delta` chunks at all. It now delivers the SANITIZED full input
  as a single `tool_input_delta` once `stream.finalMessage()` resolves and
  the tool_use block's complete input is known — through `_recordToolInput`
  (`base-session.js`), the same choke point cli/sdk's finalized-input capture
  already runs through, so there is still exactly one sanitizer in the
  codebase. This also fixes the stale "BYOK streams raw partials" claim in
  cli-session.js's `customEvents` comment and in the #7346 changelog entry
  above, both written when BYOK was still the odd one out.
- **`lint-argv-sinks`'s catalogue now matches an argv expression exactly, not
  by substring (#8112).** `AUDITED_SINKS` entries like `match: 'this._image'`
  were compared against a finding with `.includes()`, so any WIDER expression
  containing an attested one silently passed as though it were the attested
  value — `this._image || this._userSuppliedImageOverride`, a template
  literal interpolating an attacker value around `this._image`, or
  `attacker + this._image` all passed the lint unchanged on `main`, found
  reviewing #8109. Catalogue matching is now whole-expression equality
  (`catalogueEntryMatchesFinding`, `lint-argv-sinks.mjs`): an entry attests a
  finding only when its normalised text equals the entry's `match`, not
  merely contains it. Several existing entries that had been relying on the
  old substring looseness — a truncated opaque-call prefix, a template's text
  without its own backticks, a bare identifier accidentally also covering a
  wider expression built from it — were tightened to name the exact
  expression they attest; none represented a real unguarded widening. Also
  documents the opaque-sink-wrapper coverage trade-off (`lint-argv-sinks.mjs`'s
  header, `docs/false-safety-guards.md` entry 36) so a future same-file
  wrapper around a sink doesn't silently give up element-level coverage the
  way #8109's first pass did. Review on this fix found a second instance of
  the same class in the new matching code itself (#8126): the ` [[<site>]]`
  site suffix an entry can use to pin a match to one call site was compared
  with a plain `f.site.startsWith(...)`, so an entry pinned to `fn#execFile`
  (the documented callee-only shorthand) also attested an unrelated
  `fn#execFileSync` site, since `execFileSync` extends `execFile` as a
  string (`SPAWN_APIS` contains that pair, plus `spawn`/`spawnSync`). Fixed
  by requiring a field-boundary (`#`, or end-of-string) immediately after an
  unterminated site prefix.
- **The sidebar now shows the provider badge for every session, the default
  provider included (#7334).** `session.provider && session.provider !==
  DEFAULT_PROVIDER` suppressed the badge whenever a session ran the default
  provider, so a `claude-tui` row sat unbadged next to a `claude-cli` row's
  `CLI` badge — indistinguishable from a session whose provider was simply
  unknown. The session tab (`SessionBar`) never suppressed this way; the
  sidebar now matches it and renders the badge unconditionally whenever
  `session.provider` is present, with the label routed through the same
  shared `getProviderInfo` helper `SessionBar` uses so the two surfaces
  cannot disagree again. Added a dedicated `.sidebar-provider-badge` CSS
  rule (previously unstyled) so the badge doesn't get squeezed by the row's
  flex layout; it is not interactive, so the 44px tap-target rule doesn't
  apply.
- **`claude-cli`/`claude-sdk` tool calls no longer show `(no input)` while
  running, after completion, or after a session switch (#7346) — and the
  fix does not leak secrets or bypass the persisted-history size cap doing
  it (#8135, #8136).** Neither provider's `tool_start` ever carried the
  real input — the wire protocol's `content_block_start` for a `tool_use`
  block never does — and nothing captured it once the block finished:
  `cli-session.js` buffered the streaming `input_json_delta` chunks only to
  drive four special-cased tools' session state (AskUserQuestion/Task/
  Agent/EnterPlanMode/ExitPlanMode) and discarded them for everything else,
  while `sdk-session.js` never emitted `tool_input_delta` at all, so the
  dashboard's existing partial-input fallback (#4341) had no CLI/SDK data
  source. The completed-call symptom was the same root cause surfacing on
  a session switch: server history's `tool_start` entry was write-once
  with `input: null`, so a `forceFull` replay faithfully rebuilt the same
  input-less entry.

  Both providers now capture the finalized input and record it via
  `base-session.js`'s new `_recordToolInput` — the ONE choke point both
  flow through, which runs every input through `sanitizeToolInput`
  (`redaction.js`, the existing #6029 secret-redaction floor previously
  applied only on the `permission_request` path) before storing it. That
  one call redacts secret-shaped values (a key-name pass plus a recursive
  value-shape pass — a `Bash` command containing `export TOKEN=sk-ant-...`
  comes out `[REDACTED]`) and caps the serialized size to the existing
  ~10KB broadcast cap, so `tool-result.js`'s `emitToolResults` (which
  attaches the tracked input to the matching `tool_result`) and
  `session-message-history.js`'s backfill of the persisted `tool_start`
  entry both get an already-safe value for free.
  `SessionMessageHistory.truncateEntry`'s 50KB persisted-state cap also
  gained an object-shaped `input` branch (measured by serialized size,
  same as the pre-existing string branch) as a second, independent bound
  at the persistence boundary. `event-normalizer.js`'s live `tool_result`
  wire mapper — previously an explicit field whitelist that dropped
  `input` — now forwards it too, so the fix reaches the live broadcast
  path, not only the persisted-history replay.

  Unlike `byok-session.js`, which streams the Agent SDK's raw
  `input_json_delta` chunks as `tool_input_delta`, cli/sdk do NOT stream
  raw partial-JSON chunks — a secret can straddle chunk boundaries and
  mid-stream partial JSON can't be run through the sanitizer. Instead they
  deliver the sanitized FULL input as a single `tool_input_delta` once the
  tool_use block finalizes (`content_block_stop` for cli, the assistant
  message's `block.input` for sdk) — still milliseconds into a
  long-running tool call, well before it finishes executing. The expanded
  panel's copy also now distinguishes "still running, input not received
  yet" from "genuinely no input" (matching the existing `(no result yet)`
  vs. `(no result)` pattern), instead of the same false `(no input)` for
  both.

  BYOK is unaffected here — it never populates `_inFlightToolStarts`, so
  the capture/backfill above is a no-op for it. At the time this entry was
  written, BYOK's own `tool_input_delta` still streamed the same raw,
  unredacted partial JSON it always had; that pre-existing exposure was
  filed separately as #8137 and is now fixed — see the #8137 entry above.
- **A winning `'migrate'` compare-and-swap on the path-hash trust ledger no
  longer reverts itself when its first persist fails (#8098).**
  `PathHashTrustLedger._mergeLoaded()` deleted a winning migrate's
  `_migrateExpectations` entry unconditionally, inside the merge — which
  runs BEFORE `flush()`'s `saveJsonState()` write is known to succeed.
  Flushes are best-effort (`throwOnFlushError: false`), so a failed persist
  keeps `_changedKeys` set for a retry, same as every other op — but with
  the expectation already gone, the retry's CAS check read `expect` back as
  `undefined`, treated the still-valid migration as a lost race, and
  silently reverted it to the legacy record it migrated from (fail-safe —
  nothing was bypassed — but it broke the documented "a failed flush
  retries" invariant for this one op and wasted a re-migration on the next
  verification). The expectation is now cleared only after `flush()`'s
  write actually succeeds, mirroring how `_changedKeys.clear()` is itself
  deferred; a losing CAS still drops its expectation immediately, unchanged.
- **`chroxy start`'s dependency checks now probe the named tunnel the MERGED
  config actually resolved, not whichever tunnel doctor's own default
  `config.json` names (#8116).** `runDoctorChecks`'s named-tunnel routability
  probe (`checkTunnelRoutability`, #5328 step 5.6) read `tunnel` /
  `tunnelHostname` from its own default config file, independent of the
  merged config `chroxy start` (`server-cmd.js`) already resolved (`-c
  <path>`, `--tunnel`, `--tunnel-hostname`, `CHROXY_TUNNEL*` env) — the same
  defect shape #8074 (binary-provenance mode) and #8115 (provider selection)
  closed for their own pieces of this same wiring gap. `chroxy start -c
  other.json` (or `--tunnel named:…`) probed the default config's tunnel, or
  none at all, while the daemon it started used the other one; the probe is
  advisory, so this was a wrong or missing hint rather than a wrong gate.
  `runDoctorChecks` now accepts `tunnelMode` / `tunnelHostname` overrides
  (same seam shape as #8074's `binaryProvenanceMode`) that replace the
  default-file read when supplied; `server-cmd.js` passes both from the
  merged config's already-parsed tunnel. `chroxy doctor` (which never
  supplies the override) is unaffected.
- **A worktree-isolated session's tab now shows the repo name instead of the
  opaque worktree hex (#7328).** The cwd badge rendered `abbreviateCwd(session.cwd)`
  — the last path segment — but a worktree session's cwd is
  `~/.chroxy/worktrees/<32-char hex>`, so the badge read as a meaningless
  hash. The server already threads the session's original repo directory
  through as `repoCwd` on every `session_list` entry; the badge now prefers
  its basename when present and falls back to the cwd basename (today's
  behavior) for plain sessions or an older server. No protocol/server change
  was needed — only the dashboard's SessionBar. The full worktree path is
  still available via `title`/`aria-label` on hover.
- **`setModel`, `setThinkingLevel`, `grantCommunitySkillTrust` and
  `evaluateDraft` no longer leave a phantom optimistic value, a permanently
  stuck SkillsPanel row, or a promise waiting out a misleading timeout when
  the WebSocket send itself fails (#8086, sibling of #7029/#6321).** All four
  armed a one-shot correlation (a pending revert, a pending trust grant, or a
  promise + timeout) and then called `wsSend` without checking its boolean
  return — so a send that failed the OPEN→CLOSING TOCTOU (#6283, `wsSend`
  returns `false` when `socket.send` throws) left the armed state dangling:
  `setModel`/`setThinkingLevel` flipped the dropdown to a value the session
  never switched to with no round-trip coming to revert it;
  `grantCommunitySkillTrust`'s pending-trust map has no timeout backstop at
  all, so a failed send left the row "approving" permanently; `evaluateDraft`
  waited out the full 60s timeout before rejecting with a misleading "timed
  out" message for something already known to have failed synchronously. All
  four now check-then-arm — `wsSend` is attempted first, and the pending
  registration / optimistic mutation / timeout only run on a successful send —
  mirroring `setPermissionMode` (#6321) and `setNotificationPrefsCategory`
  (#6310) rather than a new shared helper, since the fix is a two-line
  reordering already established in this file, not new logic to factor out.
  A send that throws outright (a serialization bug, not the TOCTOU) is safe
  by the same reordering: nothing is armed yet when it happens, so nothing can
  dangle. The same sweep found `summarizeSession` in the same file arming its
  pending request before an unchecked `wsSend` too (identical shape to
  `evaluateDraft`) and fixed it the same way.
- **A BYOK Bash or Grep tool call no longer intermittently returns empty output.**
  `executeBash` returned as soon as the child process exited, but Node can report
  the exit before the stdout/stderr pipes have delivered their data, so a command
  that finished in a few milliseconds could lose its output. It now waits for
  both streams to end, bounded by a short grace so a backgrounded process that
  keeps the pipe open cannot stall the tool. (#8120)
- **The Discord status embed and billing-alert sinks now neutralize
  `@everyone`/`@here`/role/user mentions in every free-text field, and every
  Discord payload sets `allowed_mentions: { parse: [] }` as a server-side
  backstop (#8105).** #8103 added `neutralizeMentions()` for the new CI sink's
  PR-title text, but `discord-webhook-sink.js` (session name, task/activity
  body, tool detail) and `discord-billing-sink.js` (warning body, codes)
  still ran caller-supplied free text through `escapeAndCap` alone, which
  escapes markdown metacharacters but never touched `@`/`<@...>` — a session
  name or billing-warning string containing a literal `@everyone` reached
  Discord as a live ping. All three sinks now neutralize mentions before
  escaping and set `allowed_mentions` on every outgoing payload
  (`discord-webhook-client.js`'s new shared `DEFAULT_ALLOWED_MENTIONS`); no
  sink configures a deliberate user/role ping today, so a blanket `parse: []`
  is correct everywhere.

- **A claude-tui background-task snapshot read that never gets broadcast no
  longer silently advances the idle poll's dedup baseline or stops the poll
  (#8052).** `ClaudeTuiSession.getBackgroundTaskSnapshot()` did two side
  effects on EVERY call, whoever the caller was: it set
  `_lastBackgroundTaskKey` (the idle re-scan poll's change-detection
  baseline) and ran `_refreshBackgroundTaskPoll(snapshot)`, which stops the
  poll outright when the snapshot is empty. Only the callers that actually
  broadcast what they read (event-normalizer's `ready` handler and the poll
  tick itself) may safely trigger those side effects — but
  `PushNotificationHandler`'s idle-push body composition
  (`readBackgroundTaskSnapshot()` in `notifications/ready-body.js`) called
  the very same method purely to read the snapshot, whenever a session had
  no active viewers. If a `run_in_background` task drained during a turn
  that ended with nobody watching, that read alone advanced the baseline and
  stopped the poll — and because it never broadcasts, no `claude_ready` /
  `background_tasks_changed` ever told the client. A client already showing
  a non-empty background-task indicator was stranded: `ws-history.js`
  replays a bare `claude_ready` on reconnect, where an absent field means
  "keep state", so the stale indicator never cleared. `ClaudeTuiSession` now
  exposes a side-effect-free `peekBackgroundTaskSnapshot()` — same
  underlying transcript scan, none of the poll bookkeeping — and
  `readBackgroundTaskSnapshot()` reads through that instead, alongside
  #8048's turn-end model refresh (`_refreshObservedModel()`), which already
  read via the private scanner directly. Only `getBackgroundTaskSnapshot()`
  itself, still used by the two paths that broadcast, may commit the
  baseline or arm/stop the poll.

- **`chroxy start`'s dependency checks now preflight the provider the daemon
  is actually about to spawn, not whichever provider the default
  `config.json` names (#8075).** `runDoctorChecks({ port })` was called with
  no provider selection at all, so it fell back to re-reading the provider
  out of doctor's own default config file (or `DEFAULT_PROVIDER` when that
  file is missing) — never the provider actually chosen via `--provider`,
  `-c <path>`, or `CHROXY_PROVIDER` on the config `loadAndMergeConfig` had
  already built for the daemon that was about to start. `chroxy start
  --provider codex` on an installation whose default `config.json` named
  `claude-sdk` checked `claude`'s binary/credentials and never touched
  `codex`; `chroxy start -c other.json` checked whatever the *default* file
  named, never `other.json`'s own provider; `CHROXY_PROVIDER=gemini chroxy
  start` checked the default file's provider too. Missing binaries,
  credentials, version floors, the shim refusal and the `binaryProvenance`
  gate (#8041/#8074) all went unchecked for the provider that would actually
  run, while the wrong provider's dependencies were checked instead — and the
  same misrouted selection fed the billing-canary line's `effectiveDefault`
  and the claude-tui version-pin probe. `server-cmd.js` now passes
  `providers: [resolveDaemonDefaultProvider(config)]` — the single existing
  derivation of "this daemon's resolved default provider" (#7932,
  `providers.js`), already used everywhere else a spawn needs to agree with
  the daemon's actual selection — so `runDoctorChecks` never re-reads the
  default file for a decision the merged config already made. `chroxy
  doctor` (the standalone command) has no `-c`/config-path option at all and
  was unaffected — it already only ever reads its own default config file or
  an explicit `--provider` override, by design.

- **A spawned provider no longer inherits the daemon's own `CHROXY_PORT` /
  `CHROXY_HOOK_SECRET` from the ambient environment when its session sets
  neither, and a BYOK session's own Bash/Grep tool call can no longer read
  the daemon's full-authority primary `API_TOKEN` (#7360, #8113 — critical,
  security).** `_buildChildEnv()`-style builders that copy the full parent
  env (`cli-session.js` via `buildSpawnEnv`'s denylist mode,
  `claude-tui-session.js`'s `_buildPtyEnv`, `user-shell-session.js`'s
  `_buildShellEnv`, `byok-mcp-client.js`'s `_buildChildEnv`,
  `statusline.js`'s `defaultBuildEnv`) forwarded whatever the DAEMON PROCESS
  ITSELF happened to inherit — e.g. the daemon was launched from inside
  another chroxy session, or a developer's shell still exported a prior
  session's values — into a child that has no use for a foreign session's
  hook secret: without hooks (or with a different session's hooks), the
  child gains nothing from the key and the daemon gains a needless leak
  surface. A new shared helper, `stripInheritedChroxySecrets()` in
  `utils/spawn-env.js`, drops any ambiently-inherited value before a
  builder reasserts THIS session's own port/secret, so the session's real
  value (when set) still wins.

  #8113, found during #7360's own security review, was a sixth, un-audited
  copier of the same shape with much higher severity:
  `byok-tool-executor.js`'s `buildSafeBashEnv()` — the env for the built-in
  Bash/Grep tool BYOK-style sessions run themselves — carried an independent,
  hand-rolled denylist (the BYOK provider's own credential only, `ANTHROPIC_
  API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`, #4069) that never covered chroxy's own
  daemon-private secrets. A BYOK session's own model could retrieve the
  daemon's full-authority primary bearer token with one `env | grep
  API_TOKEN` Bash call and use it to gain full control of the daemon over
  the WebSocket/HTTP surface. Fixed the same way, via the shared
  `CHROXY_SECRET_DENYLIST` (now also carrying `CHROXY_INGEST_SECRET`, the
  daemon-level `/api/events`/`/api/mailbox` bearer, for the same reason) and
  `stripInheritedChroxySecrets()`.

  A roster test (`spawn-env-inherited-secrets-roster.test.js`) enumerates
  every file under `src/` matching a known full-env-copy spelling (a spread,
  `Object.assign` with any target, `Object.entries`/`Object.keys`,
  `structuredClone`, or a direct env-reference — widened from just the
  spread/`Object.assign({}, …)` shapes after #8113 escaped the original
  discovery sweep) and requires each to either call the helper or carry a
  documented exemption; it also verifies, both statically (the strip's
  argument must be the identifier that is actually returned, not a
  throwaway object) and behaviorally (direct execution of the three
  plain-function builders with ambient secrets set), so a future builder —
  or a call to the helper on the wrong object — can't silently pass.
- **The orphan-reaper's sweep now runs under launchd and Tauri instead of
  logging `spawnSync lsof ENOENT` every 5 minutes forever (#8083).** `lsof`
  lives at `/usr/sbin/lsof` on macOS, but the launchd service PATH
  (`~/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, from
  `com.chroxy.server.plist`) and Tauri's GUI launch both omit `/usr/sbin` —
  a bare-name `lsof` spawn resolved through PATH and failed with ENOENT, so
  the cwd lookup was "unavailable" on every tick and the reaper never
  actually swept. `orphan-reaper.js`'s new `resolveLsofBinary()` tries
  `/usr/sbin/lsof`, then `/usr/bin/lsof` (covers most Linux distros), before
  falling back to a PATH lookup via the shared `resolveBinary()` helper —
  absolute candidates first, never trusting the ambient PATH for a
  well-known system utility, the same reasoning `verify-provenance.js`'s
  `MACOS_SPCTL` / `verify-binary.js`'s `MACOS_XATTR` already use. Where
  `lsof` is genuinely unavailable (Linux without it installed, or any other
  host), `maybeReapOrphans` now logs that specific case once instead of
  every sweep — every other "cannot check" reason still warns on every
  tick, unchanged.
- **A claude-tui session's tool cards show the tool's actual output again,
  instead of the raw JSON result envelope (#8082).** Bash cards showed
  `{"stdout":"…","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}`
  and Read cards showed `{"type":"text","file":{"filePath":"…","content":"…",…}}`
  — `_emitToolHookEvent`'s PostToolUse handler (claude-tui-session.js) was
  forwarding the hook's structured `tool_response` wholesale through
  `JSON.stringify`. A new `normalizeClaudeTuiToolResponse`
  (claude-tui-tool-response.js) unwraps the known shapes into the same
  flattened display text SdkSession/CliSession already forward for a real
  tool_result content block — Bash renders `stdout` (plus `stderr` on its own
  line when non-empty), Read renders `file.content`, an array-of-text-blocks
  `content` (Task/Agent, MCP) is flattened the same way `tool-result.js`'s
  `emitToolResults` does, and a plain string `content` field (Grep's
  content-mode result, a string-content MCP response) is used as-is —
  **unless** the object is shaped like the built-in Write tool's result
  (`{type:'create'|'update', filePath, content, structuredPatch, …}`), where
  `content` is the entire written file rather than a summary; that shape
  instead renders the same short confirmation `byok-tool-executor.js`'s
  `runWrite` already produces (`Wrote N bytes to <path>`, via the shared
  `formatWriteConfirmation` helper), never the file body. An unrecognised
  structured shape still falls back to `JSON.stringify`, unchanged from
  before this fix.

- **Adding or removing an MCP server now resolves the submit spinner
  immediately when the WebSocket send itself fails, instead of waiting out
  the full 15-second timeout for something already known to have failed
  (#7029).** `addMcpServer` / `removeMcpServer` armed a one-shot callback via
  `armMcpServerOpCallback` and then called `wsSend` without checking its
  return — so a send that failed the OPEN→CLOSING TOCTOU window (#6283,
  `wsSend` returns `false` when `socket.send` throws) left the callback armed
  and the request tracked as in-flight, even though the daemon never saw it.
  Both call sites now go through a new shared helper, `sendMcpServerOp`
  (message-handler.ts), which arms and sends in one step and, on a failed
  send, resolves the callback with `{ ok: false, code: 'NOT_CONNECTED' }`
  through the same exactly-once resolution path a broadcast or the timeout
  would use — no dangling pending entry, and the 15s timer can never fire a
  second callback afterwards.

- **A binary-provenance first-sight decision (and a revoke) is refreshed from
  disk before it trusts a miss in its own memory, so a pin `chroxy resume`
  writes after the daemon started now stops the daemon's very first exec of a
  swapped binary, not just its second (#8073).** #8068/#8072 fixed WHAT a
  flush writes — a pin one process persisted was no longer erased by another
  process's next flush — but not WHEN each process's own view of the world
  refreshes: every `PathHashTrustLedger` instance still decided every trust
  question from the snapshot it loaded at construction (or wrote at its own
  last flush) until that instance's own next flush happened to run.
  `verifyProvenance()`'s first-sight check treated `ledger.getRecord(path) ===
  null` as "trust on first use" without ever looking at disk again, so a
  daemon that started before `chroxy resume` pinned a path first-sighted the
  swapped binary too — and, in block mode, ALLOWED that one exec before
  self-healing on its next flush. `PathHashTrustLedger` gains a `reload()`
  that re-reads the file and merges it with this instance's own pending
  changes — sharing the exact conflict rule `flush()` already used, factored
  out into `_mergeLoaded()` rather than duplicated — but never writes.
  `verifyProvenance()` now calls it on a `getRecord()` miss before deciding a
  path is first sight (an injected fake ledger with no `reload` is
  unaffected); `revoke()` calls it before deciding there is nothing to
  remove, so revoking a key this instance never itself loaded now correctly
  removes another instance's on-disk pin instead of silently no-op'ing;
  `SkillsTrustStore.inspect()` — one instance per SESSION, so its exposure to
  this class of bug was already broader than the binary ledger's two
  processes — gets the same refresh before its own TOFU path. The TOFU write
  itself is re-checked too: after `approve(path, hash, { firstSight: true })`,
  `verifyProvenance()` re-reads the record and reports `pinned` only when it
  still holds our hash, closing the narrow window where a genuine pin from
  another process lands between the `reload()` and this `approve()`'s own
  internal re-read. A reload that hits a corrupt file or a read error
  (EACCES/EIO/…) leaves every in-memory pin exactly as it was — it never
  resets to empty — but does not itself block: the first-sight decision then
  proceeds exactly as it did before this fix and allows the spawn in every
  mode, `block` included, since a read failure says nothing about what disk
  actually holds. The remaining read-to-rename race in `flush()` itself (two
  flushes landing inside the same narrow window) is the same bug class, out
  of scope here, and stays documented rather than solved pending a lockfile
  helper this codebase doesn't have yet (#8080). A ledger HIT is still
  decided from memory alone with no refresh at all — unchanged by this fix —
  so an already-running daemon does not pick up a re-seeded pin or an
  operator's "remove this entry" remediation until its own next miss or
  flush (#8081).

- **A settled CI run now reaches Discord — `ci_complete` was silently dropped
  by the per-project status sink, indistinguishable from a successful
  delivery (#7428).** #7424/#7426 added the `ci_complete` push category (a CI
  run finishing on the pull request a session opened) and wired the Expo sink
  to deliver it; `discord-webhook-sink.js`'s `STATE_FOR_CATEGORY` has no entry
  for it, so `send()` returned `true` for a category it never touched — a
  Discord-only setup got no CI-completion notice at all, with nothing in the
  return value to say so. `ci_complete` is not a session-lifecycle state
  (folding it into the per-project embed would repaint whatever the session's
  actual status is with a stale CI verdict from a run that may have settled
  long after the session moved on), so it gets a new, separate,
  **stateless** sink, `discord-ci-sink.js`, modelled on the billing-alert
  sink's precedent for "an event that is not a session state" — except this
  one posts a brand-new message for every completion rather than tracking one
  to edit: two runs settling for the same PR are two distinct completions and
  get two distinct Discord messages. Each embed carries the PR number and
  link, a ✅ passed / ❌ failed / ❓ unrecognised conclusion, and the check-count
  summary and PR title chroxy already builds for the push notification — a PR
  title is GitHub-authored text, so it is escaped the same way every other
  Discord sink escapes free text (#5475) and has any `@everyone` / `@here` /
  role-or-user mention neutralized (`neutralizeMentions`, new in
  `discord-webhook-client.js`) before it reaches the wire. The sink shares the
  status sink's webhook and is on by default whenever one resolves; set
  `notifications.discord.ciAlerts: false` to keep CI notices off Discord
  specifically.

- **The per-session pull-request survey throttle is pruned on every
  session-teardown path, a completed reading can no longer be stranded in a
  superseded record NOR silently discarded by a later rollback, and a
  write-through recency tie now has a pinned, tested outcome (#7450, #8091,
  #8092).** #7445's per-session throttle stamped a
  `WeakMap<sessionManager, Map<sessionId, …>>` that was never cleaned up, so
  its entry count was bounded by every session id ever surveyed over the
  daemon's lifetime rather than by the live session count — the same PROBLEM
  `SessionCiWatcher._state` already guards against, though that watcher does
  it by a periodic live-session sweep in `tick()`, not an event listener.
  `survey-throttle.js` (shared by both the PR-status and the PR-thread-count
  handlers since #7430) now keeps a registry of every throttle instance it
  creates, and one exported `forgetSurveyKey(owner, sessionId)` prunes the
  record from all of them — a per-instance prune wired to only one handler
  would have reproduced the exact "guard wired to only some of its callers"
  shape this codebase already catalogues. That call is made from
  `SessionManager._cleanupSessionMaps()` (and from `destroyAll()`, the one
  path that bypasses it) rather than from a `session_destroyed` listener: the
  first attempt at this fix listened for that event alone and missed
  `_handleAsyncStartFailure()`'s restore-rebind branch, which removes a
  session without ever emitting it (#8092) — the identical gap this codebase
  already documented, and already fixed the same way, for the #7552
  environment-untag. Folded in alongside it, a completed survey that arrives
  after being superseded by a later admission now writes its reading THROUGH
  to the current record instead of being stranded — but the first version of
  that write-through mutated the current record in place, which a later
  `rollback()`'s identity-only check could not tell apart from "nothing
  happened since I was admitted," so a superseded survey's rollback could
  silently discard an already-written-through reading and reopen the window
  on a stale timestamp (#8091). Every record now carries an ownership token:
  a write-through replaces the record (never mutates it) while carrying the
  current token forward, and `rollback()` keys on that token rather than on
  object identity — a rollback that is still current restores `{ at:
  prior.at, snapshot: newest(current, prior) }`, so it fully undoes its OWN
  admission window while never regressing to an older reading than what is
  already there. The write-through recency guard's exact-tie boundary (does
  an equally-fresh reading overwrite the current one?) is now covered by a
  dedicated test pinning "no" — the current reading wins a tie.

- **`session_pr_status`'s server-only `indeterminate` marker can no longer
  reach the wire from a future sender, because it is no longer an ordinary
  property at all (#7442).** The marker (added in #7435, so the CI watcher can
  tell "a fork-widening lookup failed transiently" apart from an authoritative
  "no open PR") was kept off the wire by a single strip at the one existing
  WS-handler call site — a whole-object invariant enforced by exactly one of
  its consumers, the same "guard wired to only some of its callers" shape a
  second sender (a future broadcast-on-settle, a REST mirror) would have
  silently defeated. `session-pr-status.js` now defines the field
  `enumerable: false` via `markIndeterminate()`/`baseSnapshot()`, so an
  ordinary `{ ...snapshot }` spread or `JSON.stringify(snapshot)` structurally
  cannot carry it — the handler's explicit strip is gone, and the CI watcher
  reads the marker through a new `isIndeterminate()` accessor instead of a
  bare property check.

- **`chroxy tunnel setup` now execs the same verified `cloudflared` binary the
  daemon's tunnel adapter would use, instead of a bare, unverified PATH lookup
  (#8066).** `cli/tunnel-cmd.js` ran an unconditional, ungated
  `CloudflareTunnelAdapter.checkBinary()` — `execFileSync('cloudflared',
  ['--version'])`, resolved off `PATH` and executed BEFORE any prompt — and
  then three more bare `execFileSync('cloudflared', …)` calls (`tunnel login`,
  `tunnel create`, `tunnel route dns`), none with an existence, quarantine, or
  opt-in provenance check. In `binaryProvenance.mode: 'block'`, a `cloudflared`
  whose pinned hash no longer matched still ran here unchecked, even though the
  exact same binary would refuse a real tunnel start. Like `chroxy resume`,
  this CLI subcommand runs standalone with no daemon `SessionManager` to read
  the gate's mode/signature-gate flags or ledger off of, so
  `resolveVerifiedCloudflaredBinary()` builds the same options bag from a
  config file (`resolveBinaryProvenanceMode`/`isBinarySignatureGateEnabled`,
  the same resolvers `chroxy start`/`chroxy resume` use — defaulting to
  `<configDir>/config.json` but honoring a new `-c, --config <path>` option)
  and the daemon's own pin ledger, then runs
  `runProviderPreflight(ProviderClass, { provenance })` against a minimal
  `preflight`-shaped stand-in for `cloudflared` (there is no session Provider
  for a network tunnel binary), reusing the identical gate `chroxy resume` and
  the tunnel adapter's own `_verifyCloudflaredProvenance` both run rather than
  a third implementation — the actual gate sequence (read config → mode →
  signatureGate → lazy ledger → preflight) now lives once, in a shared
  `resolveVerifiedCliBinary()` helper (`cli/shared.js`) both `chroxy resume`
  and `chroxy tunnel setup` call, not two copies. The pre-fix `--version`
  existence probe is gone entirely — `verifyBinary`'s stat-based
  existence/quarantine check answers "is it available" with no exec at all —
  so every remaining exec (`login` / `create` / `route dns`) now runs the
  verified absolute path, never the bare string `'cloudflared'`. A refusal
  prints the gate's labeled error and exits non-zero with nothing spawned; a
  missing binary is reported as the ordinary "not found" case (`cloudflared
  not found. Install with: …`, matching the pre-fix wording), never
  mislabeled as a provenance failure, and — on POSIX — nothing in the current
  working directory is ever hashed for a binary the health check couldn't
  confirm exists.
  `-c, --config <path>` now drives BOTH the gate's read and Step 4's
  save — the same file, so a daemon later started with `chroxy start -c
  <path>` actually sees the named-tunnel settings this run saved; before this
  fix `-c` changed only which file the gate read, while the save always went
  to the default `config.json`. The dead, still-ungated
  `CloudflareTunnelAdapter.checkBinary()` (and its `BaseTunnelAdapter` base
  stub) — unreachable from `chroxy tunnel setup` after the fix above, and with
  no other caller in the repo — is deleted outright, closing the class of gap
  entirely rather than leaving an ungated exec on the shelf for the next
  caller. "Gates off: unchanged" is not quite literal: a minimal `PATH` (no
  `cloudflared` directory) now finds it via `resolveBinary()`'s
  `CLOUDFLARED_CANDIDATES` fallback, where the old bare `execFileSync`
  exec would simply fail — an improvement, not a regression. Removing the
  `--version` probe also changes what an operator sees for a binary that is
  present but broken (wrong architecture, a truncated file): before, this
  surfaced as "not found" before any prompt; now the stat check passes, the
  operator answers the first prompt, and the failure surfaces one step later
  as "Login failed."

- **Shift+Tab now always moves focus backward everywhere, and the plan-mode
  toggle moved to its own binding — Shift+Alt+P — which honors the active
  provider's `planMode` capability (#8084).** `session.togglePlanMode` was
  globally bound to `shift+tab` (`packages/dashboard/src/shortcuts/defaults.ts`),
  so every focusable control outside a text input — buttons, tabs, tool cards,
  the #8051 focusable conversation scroller — could not reverse-tab; the
  shortcut also silently flipped plan mode along the way (WCAG 2.1.1 / 2.4.3).
  The default binding moves to Shift+Alt+P, matching the desktop app's own
  "Toggle Plan Mode" menu accelerator (`Shift+Alt+P` in `src-tauri/src/lib.rs`),
  which had already picked that chord because macOS menus can't represent
  Shift+Tab. It's listed in the `?` cheat sheet and stays rebindable in
  Settings like any other registry entry; a user who never rebound the
  shortcut gets the new default automatically, and a user who explicitly
  rebound it (including to Shift+Tab itself) keeps their own choice —
  overrides are stored per shortcut id, not per combo, so there is no
  migration to perform. `CreateSessionModal`'s cwd-suggestions Tab-completion
  handler also intercepted Shift+Tab (it was missing the `!e.shiftKey` guard
  the composer's slash-command and `@`-file pickers already carry from
  #7370) — fixed to match. Separately, `claude-tui` declares `planMode: false`
  (`claude-tui-session.js`), but the permission-mode dropdown still offered
  "Plan" and the shortcut still toggled into it regardless: the dropdown now
  drops the "Plan" option and the create-time permission-mode picker disables
  it (same treatment as the existing Auto/`autoPermissionMode` gating) for a
  provider that reports the capability as `false`, and the shortcut becomes a
  no-op for ENTERING plan mode on such a session — leaving plan mode (if a
  session is somehow already in it) still always works.

- **`chroxy start`'s dependency checks now run the same verified binaries a
  real session would use, instead of unchecked, no-gate `--version` probes
  (#8041).** `doctor.js`'s `runDoctorChecks()` — which runs BEFORE any session
  or tunnel exists, on every `chroxy start` and every desktop-app launch
  unless `--skip-checks` — ran the configured provider's binary (plus
  `claude` for `claude-tui`) and `cloudflared` with a bare `--version` probe
  and no provenance or signature gate at all: in `binaryProvenance.mode:
  'block'`, a binary whose pinned hash no longer matched the ledger still
  executed here unchecked, even though the exact same binary would refuse a
  real chat session or tunnel start. `checkBinary()` (shared by the
  provider-binary and `cloudflared` checks) and `checkClaudeTuiCliVersion()`
  now run the opt-in gate — `verifyProvenance`, the SAME function
  `runProviderPreflight` and the tunnel adapter's
  `_verifyCloudflaredProvenance` both call — on the resolved path BEFORE the
  version-probe exec, but ONLY once a binary is confirmed to exist: the gate
  never runs on a not-found bare name (which would otherwise hash relative to
  the current working directory and could mislabel a missing binary as a
  provenance failure, or TOFU-pin an unrelated same-named file). `chroxy start
  -c <path>` gates from that file's `binaryProvenance`, mirroring how `chroxy
  resume -c` already does. Every check shares one config+env-resolved
  mode/signatureGate and one lazily-constructed `binary-trust.json` ledger,
  and cloudflared's candidate paths are imported from the tunnel adapter's own
  list rather than a second copy. A `block`-mode hash mismatch or failed
  signature gate reports a doctor `fail` row naming the gate's status code and
  remediation, and the binary is never exec'd; `chroxy start` exits non-zero on
  it like any other failed dependency check. A `warn`-mode issue now reports a
  `warn` row (not only a log line), and a blocked claude-tui version-pin probe
  returns `null` rather than a second, duplicate `fail` row for the same
  binary. With gates off, behaviour is unchanged.

- **The binary-provenance gate now hashes a launcher's whole installed
  package, not only the resolved entry file (#8040).** For an npm-installed
  `codex`, the resolved path is `bin/codex.js`, a small launcher that
  `spawn`s a native binary from a separate platform package; for `gemini` it
  is `bundle/gemini.js`, which loads dozens of sibling chunk files. Neither
  the native binary nor the bundle chunks were ever hashed, so in
  `binaryProvenance.mode: 'block'` an `npm i -g` that replaced only those
  files left the pinned hash unchanged and went undetected. `verifyProvenance`
  now classifies a resolved path as a launcher when it is a script (a `#!`
  shebang, or a `.js`/`.mjs`/`.cjs` extension, checked on its realpath) with
  an enclosing `package.json` that has a `name` AND whose `bin`/`main` field
  actually resolves to this entry (so a stray unrelated `package.json`
  somewhere above the script can't become its "root"), and — only then —
  hashes a manifest of the entry, every sibling file (nested `node_modules`
  included, where an npm-global codex's native binary actually lives), and
  any `optionalDependencies` package hoisted outside the package root
  (resolved by directory, the way Node itself would, from the launcher's
  real location) instead of the one file. A symlink is recorded by its link
  text and never followed. The manifest also binds WHICH file is the entry,
  not just the tree's content, so retargeting the resolved path at a
  different script already inside the same tree is refused too. A native
  (non-script) resolution, or a script with no enclosing package that claims
  it, is unaffected and keeps the exact single-file hash as before. **This
  does not yet cover Windows npm `.cmd` shims, or pnpm/Volta shims — those
  stay single-file-hashed, tracked as #8095.** The walk is
  capped on file count and total bytes and fails closed (refused in `block`
  mode) past either cap or on an unreadable tree, mirroring how an unreadable
  single file was already handled. The ledger records which kind of hash a
  pin holds (`kind: 'file'` vs `'tree'`); a pre-#8040 single-file pin for a
  path that now resolves as a launcher is transparently upgraded to the tree
  digest the first time its current bytes still match the legacy pin — no
  spurious "binary changed" refusal from the daemon update itself — and
  refused exactly as before when they don't. The migration write itself is a
  compare-and-swap (a new `'migrate'` ledger op, `path-hash-trust-ledger.js`):
  applied only when a fresh re-read at flush time still shows the exact
  legacy record this instance migrated from, so a write whose own read
  strictly precedes a different process's already-completed, already-flushed
  migration cannot overwrite that genuine record — the stale write is
  dropped, and the caller's own post-write read observes the other process's
  record instead of its own. Two flushes landing inside the SAME
  read-to-rename window is a narrower race this does not add a new guarantee
  for — it remains the general, still-open case tracked as #8080. This is
  one shared code path (`utils/verify-provenance.js`), so every caller —
  provider-spawn preflight, `chroxy doctor`'s dependency checks, and the
  `cloudflared` tunnel gate — gets the same coverage automatically.

- **`chroxy resume` now execs the same verified `claude` binary a
  fresh chat session would use, instead of a bare, unverified PATH lookup
  (#8061).** `cli/session-cmd.js` ran `execFileSync('claude', ['--resume',
  convId, …])` resolved by the OS's own PATH lookup, with no existence,
  quarantine, or opt-in provenance check of any kind — in
  `binaryProvenance.mode: 'block'` a `claude` whose pinned hash no longer
  matched still ran here unchecked, even though the exact same binary would
  refuse a new chat session, and the path could differ from the one every
  claude-family provider resolves. This CLI subcommand runs standalone, with
  no daemon `SessionManager` to read the provenance mode/signature-gate flags
  or ledger off of, so it now builds the same options bag from a config file
  (`resolveBinaryProvenanceMode`/`isBinarySignatureGateEnabled`, the same
  resolvers `chroxy start` uses — defaulting to `<configDir>/config.json` but
  honoring a new `-c, --config <path>` option, so a daemon started with
  `chroxy start -c <path>` is gated from the same file it reads its own
  settings from) and the daemon's own pin ledger (`binary-trust.json`,
  opened only when a gate is actually on), then runs
  `runProviderPreflight(CliSession, { provenance })` — `CliSession` because
  `chroxy resume` always execs the `claude` CLI directly, never the Agent SDK
  or claude-tui's PTY. The bag builder (`buildBinaryProvenanceOptions`) is
  now shared with `SessionManager._binaryProvenanceOptions()` rather than
  reimplemented, so "the gate is off" is defined in exactly one place. An
  existing config file that can't be read or parsed now refuses outright
  (matching `chroxy start`'s own refusal on the same file) instead of
  silently falling back to gates-off, which is what a corrupt
  `config.json` used to do. A gate refusal prints the gate error's message
  and exits non-zero with nothing spawned; the binary actually executed is
  the verified absolute path preflight resolved, never the bare string
  `'claude'`. With gates off (the default), a healthy binary still spawns —
  the same observable outcome as before — but the command now also runs the
  existence/quarantine check every other one-shot gate in this fleet runs
  regardless of mode, so a missing or quarantined `claude` refuses with a
  labeled error instead of throwing a raw `ENOENT`/`EACCES`.

- **Web tasks (feature detection, launch, and teleport) now spawn `claude`
  through the same verified one-shot binary gate as the codex model-catalog
  probe, instead of a bare, unverified PATH lookup (#8039).**
  `web-task-manager.js` ran `execFile('claude', …)` at three no-session spawn
  sites — `detectFeatures()` (parsed at daemon start, with no session or user
  action involved), `_spawnRemoteTask()` (every `launch_web_task`), and
  `teleportTask()` (every teleport) — with no existence check, no quarantine
  check, and no opt-in provenance verification at any of them. In
  `binaryProvenance.mode: 'block'`, a `claude` whose pinned hash no longer
  matched was still executed unchecked by all three, even though the exact
  same binary would refuse a fresh chat session. All three now resolve their
  binary through `SessionManager.verifyOneShotExecutable(CliSession)` — the
  same #8030/#8036 verified one-shot resolver the codex model-catalog probe
  uses, reused rather than a second gate — re-running `CliSession`'s
  preflight (existence, quarantine, opt-in provenance/signature verification,
  and its optional-credential check) fresh on every call, since this class
  has no create-time session of its own to pin a path from. `CliSession`
  declares neither `requiresDirectExec` nor a `minVersion`, so the
  direct-exec shim refusal and version floor other providers get are no-ops
  here — a `.cmd`-only Windows host still passes this gate and fails later
  with an unlabeled spawn error, which is tracked as a follow-up rather than
  fixed in this change. A gate refusal degrades
  `detectFeatures()` to "feature unavailable" (logged at `warn`, naming the
  refusal's code) and fails a launch or teleport with the gate's coded error,
  surfaced through the same `task_error`/`web_task_error` paths those
  operations already use for any other spawn failure — nothing is spawned in
  either case. With gates off (the default), behaviour is unchanged.

- **A raw `data.project` from an external event can no longer bypass the
  ingest project clamp (#7123).** `event-ingest.js`'s `POST /api/events`
  handler computes a clamped `project` (`event.project`, or a #7121-clamped
  derivation from `data.cwd`) and only overrode the push payload's `project`
  key with it when that value was truthy — but the payload was built by
  spreading the raw `data` bag first, so when neither an envelope `project`
  nor a `data.cwd` was given, a `data.project` supplied directly in the data
  bag (schema-legal up to 4096 chars — 16x the 256-char cap `event.project`
  itself gets) passed straight through untouched, reaching
  `pushManager.send` and, from there, `DiscordWebhookSink._projectKey`,
  which uses it as the Discord state-file map key. `data.project` is now
  stripped from the spread unconditionally — the clamped/derived `project`
  is the only value that can ever reach the payload under that key, and it
  is simply absent when none is derivable, rather than falling back to the
  raw field. Checked every other `...data`-shaped raw spread in the ingest
  handler and the notification sinks for the same pattern; none exists —
  this was the only site.
  **Review follow-up:** `DiscordWebhookSink._projectKey()`'s own fallback
  chain (`data.project || data.sessionName || data.sessionId || 'chroxy'`)
  left `data.sessionName` and `data.sessionId` open to the identical
  bypass — both are raw, wire-legal-to-4096-char `IngestEventDataSchema`
  values, untouched by the ingest-side strip above, and the envelope
  `sessionId` override only fires when `event.sessionId` is truthy.
  `_projectKey()` now clamps its own OUTPUT to `MAX_EXTERNAL_PROJECT_CHARS`
  (reused from `external-session-registry.js`, since the return value is
  always used downstream as a project identifier — the state-file map key
  and the per-project color-override lookup — regardless of which fallback
  field produced it), closing `project`, `sessionName`, `sessionId`, and
  any future fallback added to that chain in one place. The clamp runs on
  the already-sanitized string, so every existing state-file key under the
  cap is returned byte-for-byte unchanged.

- **The codex model-catalog probe now spawns `codex app-server` through the
  same verified one-shot binary gate as the summarizer and semantic-title
  calls, instead of a fresh, unverified resolve (#8036).** On every post-auth
  `available_models` push, `scheduleProviderModelsRefresh` called
  `CodexSession.refreshModels()` with no live client, which spawned a
  short-lived `codex app-server` from `resolvedBinary` — a plain PATH resolve
  with no existence/quarantine check, no direct-exec shim refusal, and no
  provenance verification. In `binaryProvenance.mode: 'block'`, a `codex`
  binary whose pinned hash no longer matched was still executed by this path
  on every dashboard auth, even though a fresh chat session with the same
  binary would have been refused. `SessionManager.verifyOneShotExecutable()`
  (#8030) is now generalized to accept an explicit provider class, and
  `scheduleProviderModelsRefresh` threads a `bin` thunk built from it into
  `refreshModels(deps)` — running the FULL create-time preflight (existence,
  quarantine, the direct-exec shim refusal, provenance, and credentials) on
  every no-session probe, not just the provenance check: a codex install with
  no `OPENAI_API_KEY` and no `codex login` OAuth creds now no longer probes
  either, matching what `createSession` already refuses for that same
  configuration. A gate refusal (missing binary, quarantine, missing
  credential, or a `block`-mode hash mismatch) spawns nothing, leaves the
  previously discovered catalog untouched, and logs the refusing gate's error
  code at `warn`; a live codex session's own probe (which reuses its
  already-verified client) is unaffected. A refusal is TTL-cached for the same
  5-minute window a success is (`CODEX_CATALOG_TTL_MS`), so e.g. a `codex
  login` run to fix a credential refusal can take up to 5 minutes to show up
  in the picker. `CodexSession.refreshModels`'s own default (no `client` and
  no `bin` at all) now fails closed too, rather than falling back to an
  unverified `resolvedBinary` — the same precedent #8030 set for the
  summarizer/semantic-title one-shots.

- **A `claude-tui` native session whose route marker is rejected no longer
  relaunches claude five times and dies with "failed to stay alive" (#8057).**
  On an explicit native agent-connection session, a PTY respawn whose
  SessionStart route marker reports a custom endpoint, token, gateway or cloud
  selector (`NATIVE_ENDPOINT_ROUTE_MISMATCH`) or is missing
  (`NATIVE_ENDPOINT_UNVERIFIED`) is now refused like #8044's auth-status
  verdict: the rejected PTY is killed, the native code is emitted once, no
  backoff is armed, and the session stays listed. The next input relaunches
  and re-checks, so fixing the configuration and sending again recovers the
  session in place. Previously each attempt emitted no coded error at all.

- **A logged-out `claude-tui` native session no longer burns its respawn
  budget into "failed to stay alive" (#8044).** On an explicit native
  agent-connection session, a PTY respawn whose `claude auth status` reports
  logged out, a non-first-party route or unreadable output (including the
  probe itself timing out or failing, which can be transient) is now refused
  like a #8038 binary-gate refusal: nothing is spawned, the native code
  (`NATIVE_LOGIN_REQUIRED`, `NATIVE_AUTH_ROUTE_MISMATCH` or
  `NATIVE_AUTH_STATUS_UNVERIFIED`) is emitted once, no backoff is armed, and
  the session stays listed. The next input re-runs the check, so running
  `claude login` and sending again recovers the session in place instead of
  it being destroyed after five futile retries.

- **The sidebar's machine-wide monthly meter no longer asserts "Credit
  spend" for a subscription session (#7377).** #7333/#7361 fixed the
  per-session and per-provider rows to resolve their cost label from the
  billing class (`subscription` → "Included (subscription)", no dollar
  figure; `programmatic-credit` → "Credit spend" with one), but the
  machine-wide monthly meter (`SidebarTokenView.tsx`, #5665) kept a
  hardcoded "Credit spend" label gated only on "is there a budget or some
  spend" — the fourth site of the #5630 rule, missed by #7333's sweep of
  the other three. The server's `monthly_budget` payload now carries a
  `billingClass` (derived from the same programmatic-credit-era check — the
  operator flag and the era start date — that already gates what feeds the meter — `programmatic-credit` while the era
  is in force, `subscription` while it is not, which is the default since
  the era never started), and the dashboard resolves the meter's label
  through the same `BILLING_CLASS_LABEL` map the per-session/per-provider
  rows use instead of a fourth hand-written copy. A `subscription` snapshot
  now reads "Included (subscription)" with no dollar figure and no
  progress bar (a stale total left over from before #7361 no longer reads
  as live credit spend); a `programmatic-credit` snapshot is unchanged; a
  server that predates this field falls back to a neutral "API-equivalent
  estimate" label rather than asserting either claim.

- **`claude-tui` (the default provider) now reports the model a session is
  actually running instead of showing a blank badge/header (#7327).**
  `bootedModel` was never populated for claude-tui — the dashboard's model
  badge (`SessionBar.tsx`) and header label (`App.tsx`) stayed blank for
  every session started without an explicit `model` override (the common
  path), because `session-manager.js`'s `entry.session.model ||
  entry.session.bootedModel || null` fallback had nothing to fall back to.
  Unlike `cli-session`/`sdk-session`, which learn their booted model from the
  CLI/SDK's own structured init event, claude-tui is a PTY-driven interactive
  TUI with no such signal — the only place the running model appears at all
  is `message.model` on the session's own conversation transcript
  (`~/.claude/projects/<slug>/<sessionId>.jsonl`). `TranscriptTaskScanner`
  (the incremental transcript reader `getBackgroundTaskSnapshot()` already
  used for background-task tracking, #5431) now also tracks the most
  recently observed `message.model` as it reads, excluding the harness's own
  `<synthetic>` placeholder entries (API-error stand-ins) so a transient
  error never reports a fake model. `ClaudeTuiSession` re-checks that
  observation at the end of every turn that reaches the normal success or
  error teardown path (hard-timeout, stream-stall and interrupt paths defer
  to the next completed turn or a respawn instead) and, only when it
  actually changed `bootedModel`, re-emits `ready` — the same event path
  CliSession/SdkSession use to report their own booted model — so the
  badge/header update live without a respawn. The re-emit is skipped
  outright when the PTY has already died or the session is tearing down
  (`ready` never announces a session nothing can talk to); the observation
  is still recorded for the next boot/respawn to report. This is strictly an
  OBSERVATION: it is never derived from the session's configured/requested
  `model` option, and model *switching* remains unavailable for claude-tui
  (`modelSwitch: false`, tracked separately by #7855); discovery of
  available models is #7348.

- **Dashboard chat scroller is now keyboard-focusable (#7406).** `.chat-messages`
  had no `tabIndex`, so a keyboard-only reader could never move focus into it —
  axe's `scrollable-region-focusable` rule, WCAG 2.1.1. `tabIndex={0}` puts the
  container itself in the tab order, and `role="region"` + `aria-label="Conversation"`
  give it an exposed, reliably-announced accessible name (a bare `aria-label` on
  a generic `div` is not; `role="log"` was deliberately avoided — its implicit
  `aria-live="polite"` would announce every streamed token). #7404's scroll-intent
  `onKeyDown` handler now also fires with the container itself as
  `document.activeElement` (previously reachable only from a focused descendant
  like a row's copy button), so Arrow/PageUp/PageDown/Home/End scroll the
  conversation once it holds focus directly. A `:focus-visible` outline using the
  `--border-focus` design token (inset, matching the sidebar rows) makes the
  focused state visible.

- **`claude-cli` and `claude-tui` now re-verify their binary before every
  (re)spawn, and `codex` app-server's one spawn is pinned and re-verified
  (#8038).** #8035 (below) closed the per-turn gap for `gemini` and `codex
  exec`, but `claude-cli` and `claude-tui` keep one long-lived child/PTY per
  session and spawn it again later: `claude-cli` on a model switch, a
  permission-mode change, the next message after the user clicks Stop, or a
  crash; `claude-tui` whenever its PTY dies. Those respawns ran with no
  existence, quarantine, provenance or version check — `claude-cli` and a
  plain `claude-tui` session resolved `claude` afresh each time, and a
  `claude-tui` agent-connection session reused its create-time path without
  re-verifying it (only the explicit native auth route re-ran preflight). In
  block mode, replacing the installed `claude` in place
  (`npm i -g @anthropic-ai/claude-code`) therefore went unchecked until the
  next such respawn ran it. `codex` app-server spawns once per session, but
  from a fresh, unpinned resolve rather than the path create-time preflight
  verified. All three now route through the same `_gatedSpawnBinary` seam
  #8030/#8035 use, pinned to the exact create-time path. A refusal on a
  (re)spawn is not treated as the process dying: nothing is spawned, one coded
  `error` is emitted, no further auto-respawn backoff is armed and the respawn
  count resets, so a refused binary can no longer burn that budget into a
  misleading `respawn_exhausted` / `pty_respawn_exhausted` "failed to stay
  alive" (this includes the `claude-tui` native route, whose binary-gate
  refusals used to do exactly that; its auth-status refusals did too until
  #8044, above). The session sits idle until something asks for a new spawn
  — the next input, or for `claude-cli` also a model or permission-mode change
  — which re-runs the gate; an input the gate still refuses is rejected with
  the gate's code rather than queued, and `claude-cli` messages queued before
  the refusal are held and delivered once a later attempt succeeds. `codex`
  app-server has no respawn loop; a refusal there fails `start()` before the
  client is created, the same as any other start failure. Operator-visible:
  with `binaryProvenance.mode: block`, a swapped `claude` now refuses the next
  respawn of a live `claude-cli` or `claude-tui` session instead of running
  it, and pinning applies in every mode, including the default `off` (a
  vanished pinned binary refuses the respawn with a message to start a new
  session, rather than spawning whatever `PATH` now resolves).

- **`codex-app-server`'s attachment dir and `docker-byok`'s compose env-file —
  which HOLDS `ANTHROPIC_API_KEY` — now leak on a crash no more than the two
  session-dir classes #5323/#7337 already fixed do (#7373).** Both sites wrote
  a per-session tmp artifact removed on `destroy()` but never on a crash:
  `codex-app-server-session.js`'s materialized-attachment dir was a bare
  `mkdtempSync(join(tmpdir(), 'chroxy-codex-attach-'))`, and
  `docker-byok-session.js`'s `ANTHROPIC_API_KEY` tmpfile sat flat under
  `tmpdir()` as `chroxy-byok-<project>.env`. Neither carried an ownership
  signal, so a boot-time reaper could never tell a crashed session's leftover
  apart from a live one's — deleting on age alone would have removed a live
  session's credential file mid-use. Both now follow the shared shape
  `sweepStaleOwnedDirs`/`ensureOwnedBaseDir` already established: a
  dedicated, owned base dir (`ATTACH_BASE` / `ENV_FILE_BASE`), an
  `s-`-prefixed per-session dir stamped with `owner.pid`, and the artifact
  written inside it. `destroy()` removes the whole dir — for `docker-byok`
  this is new (was: just the file); `codex-app-server`'s `destroy()` already
  removed its whole `mkdtemp` dir and is unchanged in that respect, only the
  dir's location and ownership stamp moved. A new boot sweep entry in
  `sweep-stale-provider-dirs.js` (`CodexAppServerSession.sweepStaleAttachDirs`
  / `DockerByokSession.sweepStaleEnvDirs`) reaps a dead owner's leftovers —
  including the API-key file — while a live owner's are never touched. No
  second reaper implementation was added; both route through the existing
  `sweepStaleOwnedDirs`.

  **Not covered:** credentials leaked by a crash *before* this fix shipped —
  the legacy flat `chroxy-byok-chroxy-byok-<hex>.env` (holds
  `ANTHROPIC_API_KEY`; the doubled prefix is real — the old path was
  `` `chroxy-byok-${composeProject}.env` `` and `composeProject` itself
  already starts with `chroxy-byok-`) and `chroxy-codex-attach-<random>/` —
  are outside the new sweep's two bases and are never swept automatically,
  because the old flat files carry no `owner.pid` a sweep could use to tell
  a genuinely-dead pre-upgrade session from one still running the old code
  (for example a desktop daemon already upgraded alongside a CLI daemon that
  hasn't been — deleting the latter's `--env-file` out from under it breaks
  every later `docker exec` in that session). List and review them by hand
  before removing anything (macOS/Linux; `find` has no direct Windows
  equivalent, so on Windows check `%TEMP%`/`%TMP%` by hand instead):
  ```
  find "${TMPDIR:-${TMP:-${TEMP:-/tmp}}}" -maxdepth 1 \( -type f -name 'chroxy-byok-chroxy-byok-*.env' \) -o \( -type d -name 'chroxy-codex-attach-*' \)
  ```
  For each `chroxy-byok-chroxy-byok-<hex>.env` match, the compose project is
  the filename with the leading `chroxy-byok-` and trailing `.env` stripped
  (`chroxy-byok-<hex>`) — `docker compose ls -a` shows whether that project
  is still up before you touch its env-file.

- **`gemini` and `codex exec` sessions now re-verify their binary before
  every turn, not just at session create (#8035).** #8030 (below) closed this
  gap for the Agent SDK; the per-turn subprocess providers were the ones left
  — `JsonlSubprocessSession.sendMessage` (the shared base class for
  `GeminiSession` and the legacy `CodexSession`) spawned a fresh, unverified
  `resolvedBinary` read on every turn, so a binary swapped, quarantined, or
  hash-mismatched after session create ran unchecked until the session was
  recreated. `spawnPreflight` — the same per-spawn re-verification gate #8030
  wired for the SDK — is now a `BaseSession` constructor opt, so every
  session type built through the `buildBaseSessionOpts` picker inherits it
  automatically instead of the middle layer (`GeminiSession`/`CodexSession`)
  having to read it off `opts` by hand and risk silently dropping it (the
  "middle-layer trap" that has bitten three times before). Two shared
  `BaseSession` helpers now back both consumers: `_gatedSpawnBinary` (re-runs
  the pinned gate or falls back to a plain `resolvedBinary` read when no gate
  is wired) and `_refuseTurnBeforeDispatch` (the byte-identical refusal wire
  shape #8030 shipped for the SDK — an `error` event with the gate's own code,
  never routed through an error-text rewriter that could mis-rewrite a
  provenance message's hex hash as a rate-limit/auth error). A refusal here
  leaves the session idle: no child spawned, `_isBusy` stays false, and a
  skills-prepend retry still injects the skills text on the next attempt.
  Operator-visible: with `binaryProvenance.mode: block`, a change to the pinned
  `gemini` or `codex` file now refuses the next turn of a live session
  (`PROVIDER_BINARY_PROVENANCE`) instead of only the next session create,
  matching what #8030 already did for `claude-sdk`. For an npm-installed `codex`,
  and for `gemini` however installed, that file is a JS launcher — #8040
  closes the gap this entry originally reported here (an update that replaced
  only the native binary or a bundle chunk going undetected) by hashing a
  manifest of the whole installed package instead, once the resolved path is a
  launcher (macOS/Linux npm, Homebrew and bun/yarn installs — a Windows npm
  `.cmd` shim, or a pnpm/Volta shim, is not yet covered; tracked as #8095).
  The pinned gate runs in
  every provenance mode, including the default `off`: each turn re-checks that
  the pinned binary exists, is executable and is not quarantined, plus the
  version floor and required credentials. A pinned `gemini`/`codex` that
  disappears (`nvm uninstall`, a package removal) now refuses each later turn with a
  message saying to start a new session, instead of spawning whatever `PATH`
  resolves. Also adds a narrower spawn-failure backstop to `acp-session.js`: a
  configured ACP agent `command` that is an absolute path and is quarantined or
  not executable gets the same labeled diagnosis as the other providers; a
  missing absolute command keeps Node's raw `ENOENT` (it names the configured
  path), and a bare (PATH-resolved) command keeps its raw error, since the
  binary-health check can't tell "not found" from other causes for a
  non-absolute path. Spawns that are still ungated are tracked in #8036,
  #8039 and #8041.

- **Every Agent SDK spawn — chat turn, session summarizer, and semantic
  title — now goes through the same binary-verification gate, not just
  session create (#8030).** #7986 (below) fixed the SDK spawning a different
  binary than preflight verified, but preflight itself still ran once, at
  session create; the SDK execs a brand-new process every chat turn, so a
  binary swapped, quarantined, or hash-mismatched between session create and
  a later turn spawned unverified until the next session create. Chat turns
  now pin the exact create-time-verified path and re-run the full binary gate
  (existence, quarantine, the direct-exec shim refusal, the opt-in provenance
  gate, the version floor) against that exact path before every `query()` — a
  `PATH` change mid-session never redirects the spawn, but a content change
  at the pinned path is caught on the very next turn. The session summarizer
  and the semantic-title generator had no create step at all and were never
  gated in any mode; both now run the same preflight fresh, through a new
  `SessionManager.verifyOneShotExecutable()`, and `defaultRunOneShot` no
  longer falls back to an unverified resolve when no gate is supplied — it
  fails closed instead. `SdkSession` also gained the same spawn-failure
  backstop the subprocess providers already had
  (`labelBinarySpawnFailure`): a pre-first-message launch failure against a
  quarantined or vanished binary now gets a labeled diagnosis instead of the
  SDK's generic "native binary … failed to launch" text. Re-hashing and
  re-`spctl`-ing on every turn would add real latency, so both checks are now
  cached by stat identity (`utils/stat-identity.js`, shared with the existing
  version-probe cache) including file **ctime** — mtime alone can be restored
  by `utimes(2)` after an in-place write, but ctime cannot be forged by
  unprivileged code, so a swap that tries to hide behind a restored mtime still busts
  the cache. A cached signature pass also expires after 10 minutes, since a
  revoked notarization does not change the file. Operator-visible: with
  `binaryProvenance.mode: block`, a `claude` auto-update now refuses the next
  turn of a live `claude-sdk` session (`PROVIDER_BINARY_PROVENANCE`) until the
  new hash is re-approved, where it used to take effect only at the next
  session create. A `docker-sdk` turn sent before its container exists is now
  refused (`CONTAINER_SPAWN_UNAVAILABLE`) instead of running the host `claude`
  outside the container. On Windows the hash is not cached, because NTFS
  ChangeTime can be set by the file's owner. The per-turn subprocess providers
  (gemini, `codex exec`) still verify only at create; that is #8035.

- **The `claude-sdk` provider's minimum-version floor no longer hard-blocks
  every install after an SDK bump — it is now a hand-kept hard floor plus a
  soft, advisory floor (#8031).** #7986 (below) enforced a minimum `claude`
  version equal to the installed Agent SDK's own `claudeCodeVersion` field.
  That field names the CLI build the SDK release was *published alongside*,
  not a genuine minimum — the CLI's patch number is its release counter, so
  a `claude` on a lagging release channel (e.g. npm `stable`, which trails
  `latest`) could be several patches behind without being broken in any way,
  and every SDK bump instantly hard-blocked it regardless. Preflight now
  enforces a small, hand-raised `CLAUDE_SDK_MIN_CLI_VERSION` constant as the
  hard floor (below it: `ProviderBinaryVersionError`/`PROVIDER_BINARY_VERSION`,
  unchanged), and treats the SDK's own `claudeCodeVersion` as a soft,
  advisory floor instead: at/above the hard floor but below the SDK's
  pairing, preflight logs a warning and `chroxy doctor` reports `warn`
  (never aborts `chroxy start`) rather than throwing. A tripwire test forces
  a maintainer to re-verify (and, if needed, raise) the hard floor whenever
  an SDK bump moves its pairing, and Renovate now throttles
  `@anthropic-ai/claude-agent-sdk` bumps the same way it already throttles
  `@anthropic-ai/claude-code`, so a lagging CLI channel gets real time to
  catch up between bumps.

- **The `claude-sdk` provider now spawns your installed `claude`, resolved through
  the same candidate list preflight verifies at session create (#7986).**
  The Agent SDK's `query()` spawns its own bundled platform binary unless told
  otherwise, while preflight, including the opt-in provenance gate, verified
  the installed `claude`. So the binary that was checked was not the binary
  that ran. `SdkSession` now sets `pathToClaudeCodeExecutable`, re-resolved
  through the shared resolver on every turn — the same resolver preflight used
  at session create, but each turn's resolve is not itself re-verified, so a
  binary swapped in place mid-session spawns unchecked until the next session
  create. The session summarizer's one-shot `query()`, which semantic session
  titles also use, sets the same resolved path but is not preflighted or
  provenance-checked at all. See #8030.

  Preflight also enforces a minimum `claude` version for the SDK provider: a
  hand-kept `CLAUDE_SDK_MIN_CLI_VERSION` hard floor, with the installed SDK's
  own `claudeCodeVersion` field as a soft, advisory floor on top of it (see
  #8031). A binary below the hard floor gets a `claude update` remediation
  instead of a mid-turn failure. On Windows, the SDK spawns without a shell,
  so it needs the native `claude.exe`; an npm `.cmd` shim is refused before
  any probe with its own error, `PROVIDER_BINARY_UNSUPPORTED`, and
  `chroxy doctor` fails it the same way. `chroxy doctor` resolves the same
  hybrid floor.

  The generic minimum-version gate also makes preflight enforce
  `claude-channel`'s existing `claude >= 2.1.80` floor at session creation.
  That floor was previously checked only by `chroxy doctor`. The `claude`
  binary-candidate list, which was copied across five modules and missed
  `~/.local/bin/claude` in the SDK's copy, is now a single shared list.

- **Desktop: the app bundle drops the Agent SDK's ~207 MB unsigned `claude`
  binary, and the notarization guard now catches extension-less Mach-O files (#7986).**
  `bundle-server.sh` prunes the `@anthropic-ai/claude-agent-sdk-<platform>`
  packages on every host. The server no longer spawns them, and on macOS the
  unsigned binary was invisible to the extension-based native-binary guard.
  The guard now also scans the staged tree by Mach-O magic bytes, covering
  thin and fat binaries in both byte orders and telling Java class files
  apart. The universal macOS app no longer carries an arm64-only SDK binary,
  since each user's own `claude` matches their architecture.

- **Desktop: the tray app now honours `CHROXY_CONFIG_DIR` (#7241).** `config.rs`,
  `settings.rs`, `qrcode.rs` and the "Reveal in Finder" action each resolved
  `~/.chroxy` from `dirs::home_dir()` and never read the override, so a relocated
  install split the desktop app from its own daemon. All four now go through a
  single `config::config_dir()` resolver mirroring the server's `config-dir.js`
  (read per call, absolute-only, relative values refused — not resolved).

  The autostart path was affected too, and not in the way it looked: `server.rs`
  never cleared `CHROXY_CONFIG_DIR` from the spawn environment, so the embedded
  server **inherited** it and read the relocated root while the tray kept reading
  `~/.chroxy`. Silent for the same reason as #7239 — `API_TOKEN` is passed
  explicitly in the spawn env, so the token survived and only the rest of the
  state diverged. Sharpest visible symptom: the QR code encoded a stale
  `connection.json`, because a stale file still parses.

  If you do not set `CHROXY_CONFIG_DIR`, nothing changes.

- **Dashboard: composer and form keyboard handlers no longer act on the key
  that commits an IME composition (#8064).** While typing with an input
  method editor (Japanese, Chinese, Korean, …), `InputBar.tsx` checked
  `isComposing` / `keyCode === 229` nowhere: the Enter that commits a
  composed candidate could send the message or select a highlighted `/` or
  `@` picker item instead, and — since #7370 — Tab could complete a picker
  item the same way. Every affected handler now returns early when
  `e.nativeEvent.isComposing` (or, as a Safari fallback, `e.keyCode === 229`)
  is true, before any Enter/Tab/arrow/Escape handling runs, so the IME gets
  the key first. Fixed in the message composer (send, Tab-complete slash
  command/`@`-file) and every other composer-adjacent field with the same
  submit/select-on-Enter shape: the `AskUserQuestion` free-text input and the
  prompt-evaluator clarify textarea, the Cmd+P / Cmd+Shift+O / Cmd+Shift+F /
  command-palette / model-picker search boxes and the in-conversation find
  bar, and the session-name/working-directory/checkpoint-name/tab-rename
  text fields. Left unchanged: widgets where Enter/Space merely activates a
  focused button-like control (no text composition involved), and the chat
  scroller's Arrow/PageUp/PageDown keydown handler, which already bows out
  on any text-entry target.

- **Docker: `CHROXY_CONFIG_DIR` is now honoured by the entrypoint (#7239).**
  `scripts/docker-entrypoint.sh` hardcoded `$HOME/.chroxy` while the daemon
  honours the override, so `docker run -e CHROXY_CONFIG_DIR=/data` split the
  container in two — the entrypoint wrote `config.json` to `~/.chroxy` (the
  mounted `chroxy-data` volume) while the daemon read `/data` for everything
  else.

  This was silent because the API token survived it by accident: the entrypoint
  exports `API_TOKEN` and the daemon falls back to that. What actually broke was
  everything else — `server-identity.json`, `credentials.json`,
  `session-state.json`, `scheduled-tasks.json` and the trust ledgers landed in an
  **unmounted** container path and were destroyed on every restart, while the
  volume sat mounted where nothing wrote to it. A regenerated identity key is the
  sharp end: pinned clients report it as a possible MITM.

  If you run the container **without** `CHROXY_CONFIG_DIR`, nothing changes.

- **A pin `chroxy resume` writes to `binary-trust.json` is no longer lost at
  the daemon's next flush, and the same fix applies to every other trust
  ledger built on the shared `PathHashTrustLedger` (#8068).** Since `chroxy
  resume` (#8065) became a second `BinaryProvenanceLedger` writer process
  alongside the daemon's `SessionManager` on the same default ledger file,
  `flush()` re-serialised only the flushing instance's own in-memory
  snapshot — so a pin one process had just written was silently erased the
  next time the other process flushed anything at all. `flush()` now
  re-reads the file immediately before writing and merges it with only the
  keys this instance itself changed, instead of overwriting the whole file:
  a path this instance changed wins (including a revoke, which stays
  revoked rather than being resurrected), a path it did not touch keeps
  whatever is on disk (including a pin a different process wrote in the
  meantime), and the same path changed by two processes resolves to
  whichever one flushes last. The merged result also refreshes the
  flushing instance's in-memory records, so a later read in that same
  process sees the other writer's pins too. `SkillsTrustStore` (one
  instance per session, so this bug's real-world blast radius was already
  larger than the binary ledger's two processes) gets the same treatment
  for its `communityTrust` sibling index. `SessionPresetTrustStore` and
  `BinaryProvenanceLedger` inherit the fix with no changes of their own.
  Atomicity and mode `0600` are unchanged. A genuinely missing file (an
  operator deleting the ledger to reset it) still resets to empty. A file
  that exists but comes back KNOWN-BAD at flush time (malformed JSON or the
  wrong shape) falls back to this instance's own in-memory records instead
  of wiping every pin it didn't touch this flush — disk is garbage either
  way, so overwriting it is a repair. A file that exists but the READ
  ITSELF fails (permissions, too many open files, …) is treated differently:
  that says nothing about whether disk's current content is good, so this
  flush is skipped entirely and retried later rather than risking a
  repair-overwrite that clobbers a healthy pin a different process just
  wrote. Only an explicit `approve`/`revoke`/`acceptHash`/
  `grantCommunityTrust` is last-writer-wins; a trust-on-first-use
  first-sight pin or a `lastVerified` bump is never allowed to override a
  pin or decision this instance never saw, and — once resolved that way —
  is forgotten rather than replayed against a later, different disk state
  (which otherwise could resurrect a pin someone had deliberately revoked).

- **`chroxy start --skip-checks` no longer crashes when the default provider
  fails preflight (#8029).** `startCliServer` created the startup "Default"
  session unconditionally; `createSession` runs the same provider preflight
  `chroxy start`'s doctor pass runs (missing/quarantined/unsupported/wrong-
  provenance/wrong-version binary, or missing credentials), and without
  `--skip-checks` doctor catches it first and refuses cleanly. With
  `--skip-checks`, the doctor pass is skipped and the preflight error was
  thrown uncaught, crashing the daemon. The default-session step now catches
  only that typed preflight error class — the same class the session-restore
  path a few lines above it already treats as recoverable — logs a readable
  warning, and keeps the daemon running with no default session; the
  dashboard, app and desktop clients already render a clean "no sessions"
  state. Any other error still propagates unchanged.

### Changed

- **The MCP server-name regex, reserved-key set, and cloud-metadata host
  blocklist are now single-sourced in `@chroxy/protocol/mcp-validation`
  (#7030).** `packages/dashboard/src/lib/mcp-server-validation.ts` used to
  hand-duplicate `MCP_SERVER_NAME_RE`, the `__proto__`/`constructor`/
  `prototype` reserved-key guard, and `isBlockedMetadataHost` from
  `packages/server/src/byok-mcp-config.js` — verified byte-identical at
  review time, but exactly the shape of drift #6986 and #7001 hit. Both
  packages now import the same Zod-free `@chroxy/protocol/mcp-validation`
  subpath, and a guard test fails if a second copy of these constants
  reappears anywhere in packages/server, packages/dashboard, packages/app, or
  packages/store-core. No behavior change — the server remains the sole
  validation authority on write.

- **`CHROXY_CONFIG_DIR` now relocates ALL daemon state (#7052).** It previously
  moved only about half of it: `models.json`, `connection.json`, `pages/`,
  `snapshots/`, `checkpoints/`, `ingest-secret` and the session-token store
  followed it, while roughly twenty other files stayed pinned to `~/.chroxy`
  regardless. Every path now resolves through one accessor that reads the
  variable per call.

  **If you do not set `CHROXY_CONFIG_DIR`, nothing changes** — the default is
  still `~/.chroxy` and every path resolves exactly as before.

  **If you DO set it**, the following move out of `~/.chroxy` on upgrade and the
  daemon will not find your existing files there: `config.json`,
  `credentials.json`, `session-state.json`, `scheduled-tasks.json`,
  `server-identity.json`, `server-identity-rotation.json`, `environments.json`,
  `notification-prefs.json`, `push-tokens.json`, `discord-webhook-state.json`,
  `discord-billing-state.json`, `binary-trust.json`, `skills-trust.json`,
  `session-preset-trust.json`, `supervisor.pid`, `known-good-ref`, `skills/`,
  `worktrees/` and `logs/`.

  Move them once, before starting the upgraded daemon:

  ```bash
  # with CHROXY_CONFIG_DIR set to your chosen directory
  chroxy config-dir migrate --yes
  ```

  or by hand, which does the same thing:

  ```bash
  mkdir -p "$CHROXY_CONFIG_DIR"
  cp -a ~/.chroxy/. "$CHROXY_CONFIG_DIR"/
  ```

  Two consequences are worth calling out because they are easy to misread:

  - **Do NOT run `chroxy init` to fix a "No API token configured" error.** On a
    host without an OS keychain the token lives in `config.json`; if that file
    has not been moved the daemon exits with `Run 'chroxy init' first`, but
    `init` mints a *brand new* token and every paired device has to re-pair.
    Move `config.json` instead.
  - On a host without an OS keychain, an unmoved `server-identity.json` makes
    the daemon mint a **new identity key**, which pinned clients report as a
    possible MITM. Moving the file avoids it; if you have already hit this, the
    fix is to re-pair.

  The daemon now logs its resolved config/state root at startup, so you can
  confirm which directory it actually opened. A relative `CHROXY_CONFIG_DIR` is
  now refused (with a warning) and falls back to `~/.chroxy`, rather than
  scattering credentials into whatever directory the daemon was launched from.

  `chroxy service install` now bakes `CHROXY_CONFIG_DIR` into the generated
  launchd plist / systemd unit / Windows wrapper when it is set, so the
  installed service and your shell agree on one root.

### Added

- **Stranded state is now detected and reported, and `chroxy config-dir`
  migrates it (#7240).** The relocation above is silent by construction: the
  daemon simply reads a different directory and finds nothing. Three things now
  surface it.

  The daemon **warns at startup**, naming every entry still at `~/.chroxy` and
  the remedy. The warning is emitted before the token check, which matters: with
  a stranded `config.json` on a keychain-less host the daemon exits at that check,
  and the "config/state root" line added in #7052 comes later in startup — so the
  operator previously saw `Run 'chroxy init' first` with no indication that a
  relocation caused it. That message now names the real cause and, in this case,
  explicitly says not to run `chroxy init`.

  **`chroxy doctor`** gains a `Config/state root` check reporting the resolved
  root and anything stranded. Its `Config` check no longer answers a missing
  `config.json` with "run `chroxy init` to create" when the file is merely
  stranded — that advice mints a fresh token and forces every device to re-pair.

  **`chroxy config-dir status`** lists what is stranded; **`chroxy config-dir
  migrate --yes`** copies it forward, preserving `0600` file and `0700` directory
  modes, never overwriting anything already in the destination, and leaving the
  originals in place.

  The migration is **opt-in rather than automatic, deliberately.** The daemon
  cannot distinguish "operator just relocated and wants their state" from
  "operator pointed at a deliberately clean root" — a container, a per-project
  directory — and copying an identity key and credentials into a directory that
  may be shared, synced or bind-mounted is the operator's security decision to
  make, not a side effect of an upgrade.

  What is reported as stranded is **computed** — every entry present at
  `~/.chroxy` and absent at the resolved root — rather than compared against a
  list of known state files, so a state file added later is covered without
  anything to update. Runtime-ephemeral entries (`supervisor.pid`,
  `update.lock`) are excluded from both the report and the copy.

## [0.11.0] - 2026-08-15

The **Codex-controllable-like-Claude** release. Codex now flows through Chroxy's
permission pipeline **by default** — you approve/deny its commands and file edits,
switch permission modes, and send it image attachments, exactly the way you do
with Claude. Plus device-friendly **persistent pairing tokens** and two claude-tui
reliability fixes.

> This release also ships the previously-unreleased **0.9.47** "model-serving
> freshness + operator-security" changes (folded in below) — v0.9.47 was
> prepared but never tagged, so everything since v0.9.46 lands here.
>
> **Why 0.11.0 and not 0.10.0.** The packages carried a `0.10.0` version for
> two months without a matching tag, and a `@chroxy/server@0.10.0` was
> published to npm on 2026-07-06 from a build ~463 commits behind this one.
> npm does not permit republishing a version, so `0.10.0` is unusable as a
> release number. This release takes the next clean version instead, so the
> git tag, the package versions, and the npm artifact agree from here on.
> There is no `0.10.0` entry in this changelog because no `0.10.0` release
> was ever cut.

### Added

- **Codex approvals surfaced through the permission pipeline (epic #6605).** A new
  persistent `codex app-server` (JSON-RPC) session driver routes Codex's approval
  requests into the same `PermissionManager` Claude uses, so you approve/deny
  Codex's shell commands and file edits from the dashboard/app, and switch
  permission modes mid-session (#6606 driving layer, #6611 approval surfacing,
  #6613 permission-mode mapping). Per-mode: `approve` prompts everything,
  `acceptEdits` auto-approves edits but prompts commands, `auto` runs freely.
- **Codex image attachments + document references (#6609).** Image attachments
  become native `localImage` vision input; documents / file references are named
  in a prompt suffix Codex can read. (The legacy exec path rejected attachments
  entirely.)
- **Codex intra-session conversation memory** — the persistent app-server thread
  keeps context across turns within a session (the exec path was stateless).
- **Persistent, configurable pairing tokens (#6598).** Paired-device session
  tokens now survive daemon restarts (encrypted at rest) and use a configurable
  **sliding TTL** (default 30 days) via `CHROXY_SESSION_TOKEN_TTL` — so a device
  that keeps connecting stays paired and only an *idle* device expires. No more
  re-pairing every restart.

### Changed

- **Codex now drives the app-server path by default (#6616).** It's a strict
  superset of `codex exec` (approvals + attachments + intra-session memory, no
  regression). Set `CHROXY_CODEX_APPSERVER=0` (or `false`/`no`/`off`) to fall back
  to the legacy `codex exec` path.

### Fixed

- **claude-tui first-message stall (#6578).** Current `claude` releases no longer
  write the session-status file the readiness probe relied on; resolve the session
  file by session id and fall back gracefully so the first message is no longer
  swallowed into a multi-minute wedge.
- **claude-tui readiness via PTY-output quiescence (#6601).** Detect readiness from
  the PTY output settling instead of the dropped status field, cutting
  first-message readiness from a ~15s degraded wait to ~1s.

A **model-serving freshness** release with **operator-security hardening**. The headline: you no longer need to release a new build to **call, add, or re-price a model** the provider's API already exposes — across the whole provider matrix. Alongside that: a **host-local user-shell approval** control, completion of the **#6201 Open/Closed catalog** refactor, an **OpenAI-compatible provider**, a **mobile mission-control** read-only slice, a deep **store-core/protocol contract-typing** wave, and broad reliability/UX polish.

### Added

- **Serve a new model without a release (model-serving freshness epic).**
  - `providers.allowAnyModel` — a per-provider config opt-in (default OFF) that lets the static-allowlist providers (Gemini, Codex, DeepSeek) serve any API-valid model id verbatim, letting the upstream API be the validator — mirroring how Ollama already works (#6378).
  - The hot-reloadable `~/.chroxy/models.json` **model overlay** now reaches **every provider's registry** via an optional per-entry `provider` field — add or relabel or re-window a Gemini/Codex/DeepSeek/Ollama model at runtime, not just Claude (#6377).
  - **Per-provider overlay pricing** — a `provider`-tagged overlay entry can re-price a non-Claude model (e.g. DeepSeek) with no release (#6381).
  - A user guide for the model overlay, previously undocumented (#6376).
- **Host-local per-spawn user-shell approval (#6277).** Opt-in `userShell.requireApproval` holds a user-shell spawn pending the host operator's explicit OK, served over a **separate `127.0.0.1`-only listener** the Cloudflare tunnel never forwards (closing a tunnel-loopback bypass); driven by a new `chroxy shell approve|deny|list` CLI. Plus a boot-time orphan reaper for user-shell PTYs with a start-time identity gate (#6276).
- **OpenAI-compatible provider** via the Anthropic shim — config-driven `/v1/chat/completions` endpoints (OpenAI, OpenRouter, LM Studio, vLLM, …) as first-class BYOK providers (#5420).
- **Mobile mission-control** (read-only slice) — cross-session activity view on the app, with a live activity feeder and `lastClientActivityAt` tracking (#5968, #6246, #6248); desktop dock-badges the cross-session blocked+failed count (#6184).
- **Dashboard model-picker** reworked to a button + modal picker with keyboard nav (#6220, #6238); the Control Room tab strip gains drag-to-scroll + edge chevrons (#6230, #6218).
- **`doctor`** surfaces keychain health + the active storage backend (#6236).
- **CI:** a Playwright dashboard smoke test (#6315) and a nightly Maestro app-E2E workflow (#6355) wired in.

### Changed

- **#6201 Open/Closed epic completed.** The Claude model catalog (roster, pricing, context-window heuristic) moved onto its own provider-owned module, inverting the dependency so the generic registry no longer reaches back into Claude specifics (#6366); DeepSeek pricing moved onto its provider class (#6365). `set_model` no longer falls through to the Claude allowlist for a non-Claude provider that declares none (#6367).
- **Default model is now Opus 4.8**; Fable removed from and disallowed in the model registry (#6219, #6233).
- **store-core dispatch-table migration (#5618)** — the remaining server→client handlers (`agent_idle`, `permission_mode_changed`, `budget_warning`/`plan_ready`/`rate_limited`/`server_shutdown`, `conversations_list`/`checkpoint_restored`, `search_results`) moved onto the shared dispatch table.
- **Protocol contract-typing wave** — Zod-schemed the high-traffic, `environment_*`, and git/file/checkpoint-result server→client families (#6314, #6324), and drained the `PENDING_CONTRACT_TYPES` backlog with behavioural contract fixtures (#6325 close-out).
- The release CI test gate broadened to match full CI coverage so a release re-tests the same suites (#6316).

### Fixed

- Declared the `provider` field on the `available_models` protocol schema to match the senders that emit it (#6370); boot-cache warm + legacy `available_models` are now scoped to the active provider when `DEFAULT_PROVIDER` is non-Claude (#6368).
- **Connection resilience (mobile/dashboard):** the `ConnectionPhase` FSM rejects illegal transitions instead of failing open and restricts forced exits to whitelisted terminal phases; File/Git op failures on a closed socket surface instead of wedging; optimistic `set_model`/permission-mode/notification-pref/permission-answer flips now honor a false `wsSend` return (#6308, #6321, #6222, #6285, #6289).
- **Desktop voice/speech helper:** single-owner reaping + decoupled stderr drain, with stderr surfaced on unexpected exit and a voice error when the restart budget is exhausted (#6281, #6282); deterministic concurrency regression tests added (#6362).
- No macOS keychain modal on a broken login keychain — the daemon detects an unusable keychain without prompting (#6234).
- `terminal_resync` recovers a desynced live PTY mirror, with a manual "refresh terminal" button on app + dashboard (#6329, #6330).
- A `rate_limited` throttle notice is surfaced on app + dashboard (#6334); never-sent queued bubbles are dropped on Stop/Cancel and stranded in-flight flags reset on disconnect.

## [0.9.46] - 2026-06-20

A large release on three fronts. **A security and identity-rotation wave** lands token revocation with scheduled rotation, revoke-kills-live-shells, identity-key rotation handoff, exchange-key domain separation, pairing-bound-token write gates, broadcast-path secret redaction, and a single-source answer-authorization predicate. **Two operator epics** open up: the **user-shell terminal** (#5982) puts a real `$SHELL` PTY behind a primary-token gate across server, dashboard, and mobile, and the **Control Room env/runtime control** epic (#5530) turns the dashboard into a live ops surface for containers, repo runtime config, the BYOK pool, host prune, device runtimes (iOS/Android/WSL2), and cross-session mission control. On top of that: **queue-while-processing** (server-authoritative send queue with per-item cancel and a live "Claude is working" indicator), an **OpenAI-compatible provider** translation core, an **agent-to-agent mailbox** with live interrupt, and a deep reliability/refactor wave — the store-core handler split, the swarm-hardening audit, claude-tui hardening, and CI moved onto self-hosted macOS + Linux runners with the last `--test-force-exit` retired. The original control-surface slice (Control Room Integrations/Settings tabs, pairing epic #5509, latency epic #5514, OpenRouter) ships in the same release.

### Added

- **Control Room Integrations tab (#5498):** per-repo repo-memory status with a Reindex action (#5503, #5504), repo-relay observability — workflow presence, version drift, run status (#5505) — re-running failed repo-relay runs (#5506), and surfacing repo-memory's top missed search queries (#6107).
- **Control Room Settings tab (#5544):** single home for appearance, session defaults, shortcuts, provider credentials/BYOK, notification preferences, and desktop options; the gear icon, the `Cmd+,` shortcut, and Tauri menus redirect to it (#5549).
- **Control Room Skills tab (#5554):** skill inventory + usage history (#5574).
- **Control Room Mailbox tab (#5919):** agent-to-agent mailbox observability.
- **Control Room env/runtime control epic #5530** — the dashboard becomes a live ops surface:
  - Containers survey + lifecycle (stop/restart/destroy) — server contract (#6142, #6145) and dashboard tab with action buttons (#6143, #6147).
  - Per-repo runtime config survey + tab (#6139 / #6148, #6149).
  - BYOK pool stats survey with drain/recycle/resize actions (#6135 / #6150, #6151, #6152).
  - Host prune guardrails — chroxy-scoped orphan docker prune — server + tab (#6140 / #6154, #6156); `com.chroxy.managed` docker label stamp with label-first prune scoping (#6155 / #6172).
  - Device runtimes tab — iOS simulators with a Ready-for-Maestro verdict + boot/shutdown (#6136 / #6157, #6158, #6159), Android emulator survey + boot/kill (#6137 / #6161, #6162), WSL2 distro survey + start/terminate (#6138 / #6173, #6176).
  - EnvironmentPanel converged into the Control Room (#6141 / #6160).
- **Control Room v2 phase 2:** cross-session activity aggregation selector (#6182 / #6185) and a cross-session mission-control view (#6183 / #6186).
- **User-shell terminal epic #5982** — raw `$SHELL` access inside Chroxy:
  - `UserShellSession` PTY provider activating the terminal (#5983 / #5993), advertised as a `userShell` capability in `auth_ok` (#5995).
  - Embedded dashboard terminal UI (#5986 / #5996); mobile read-only mirror scaffold (#5987 / #6002) plus interactive keystroke input (#6003 / #6014).
  - Primary-token fail-closed gating — WS primary-token primitive + `terminal_*` gates (#5985b / #5988, #5991), require the current non-grace token to create a shell (#6004 / #6011).
  - Auto-remove a shell when its PTY exits (#6007); always-on, level-independent shell-audit trail (#6000, #6001 / #6008).
- **Queue-while-processing:**
  - Server-authoritative send queue with flush-on-result for SDK/CLI (#5941), shared per-session queued-message model + events (#5942), and a `cancel_queued` wire message for per-item cancel (#5943 / #5948).
  - Dashboard queued-message UI (#5939 / #5949) unified with the input busy state (#5952 / #5955); mobile mid-turn queueing instead of blocked send (#5938 / #6111) with a queued-count + disconnect warning (#6080).
  - In-chat "Claude is working" indicator with live tool surfacing (#5953 / #5956); Stop + queue affordance during the busy-pre-stream window (#6116 / #6117); attach/camera kept available during an active turn (#6118 / #6122).
- **OpenAI-compatible provider (#5420):** Anthropic↔OpenAI translation core (#6127).
- **OpenRouter ergonomics (#5548):** `chroxy providers add openrouter` preset, generic `modelDiscovery: { url, format }` catalog discovery for anthropic-compatible entries (openrouter + openai formats), and per-model pricing autofill so OpenRouter sessions report real cost (#5550).
- **Model metadata foundation:** `MODEL_METADATA` registry consolidation (#5930 / #5947) with a model-metadata foundation — fable, user overlay, graceful degradation (#5663), version-aware opus context-window heuristic (#5931 / #5934), and hot-reload of the `models.json` overlay without a restart (#5932 / #5945).
- **Agent mailbox:** `POST /api/mailbox` live-interrupt that wakes a live recipient (#5914), auto-registering a session's `AGENT_COMM_ID` at `create_session` (#5918).
- **Live claude-tui PTY mirror epic #5835:** server pipe + dashboard render (#5836, #5838), resize sync at the authoritative size (#5840, #5841), and raw-keystroke forwarding making the mirror interactive (#5842, #5843); the mirror coalescer is gated on having a subscriber (#5837 / #5844).
- **Per-repo Open-session button (#5507):** quick-start a session in any surveyed repo from the Project status tab, with model + permission pickers (#5508); trust-gated per-repo session presets — editable preamble + seed (#5576).
- **Summarize & carry a session (#5547):** right-click a session (or project group) in the sidebar → server-side one-shot continuation brief from the persisted history → create-session modal opens with the summary seeded editable in the composer; Copy transcript joins the same menu (#5551).
- **Pairing epic #5509 — camera-less connection:**
  - Pairing-approval primitive — approve new devices from the dashboard (#5527).
  - One-click Request-to-pair on discovered LAN daemons (#5528).
  - Typeable 8-char short pairing code — host display + dashboard entry (#5531).
  - Discord pairing-link delivery — host-triggered, approval-gated (#5538).
- **Chroxy Pages (#5683):** core serve + security (#5685), publish surface — `POST /api/pages` + `chroxy publish` CLI (#5687), a Pages panel for list/copy-link/delete (#6109), and a publish-artifact form (#6110 / #6180).
- **Billing canary & metering:** monthly programmatic-credit budget meter for CLI/SDK sessions (#5665 / #5678), era-aware billing class — cost labels + June 15 copy (#5669), default flipped to claude-tui ahead of the 2026-06-15 credit cutover (#5822) with `DEFAULT_PROVIDER` single-sourced (#5823 / #5824), the billing canary wired into `chroxy doctor` (#5821), the daemon, and the dashboard (#5827) with opt-in datacenter-egress detection + push (#5830), IPv6 detection (#5831 / #5834), and a Discord billing-alert sink (#5828 / #5832).
- **Force-destroy escape hatch for a wedged/stuck-running session (#5710 / #5727).**
- **Push-to-talk dictation in the dashboard chat input — hold Space (#5625).**
- **EAS Update (OTA) pipeline wired up on mobile (#5641)**, migrating iOS to CNG so `eas update` is enabled (#5670) and adding a preview-simulator EAS profile for no-credentials iOS validation (#5671).
- **Accessibility:** debounced connection-phase announcements for screen readers (#5581 / #5582); per-tab "needs your permission" indicator on mobile (#5750 / #5758) with assertive prompt announcements (#5760).
- **Doctor named-tunnel routability probe (#5328 / #5961)** and pinned tested claude CLI version in `chroxy doctor` (#5868).
- **Latency instrumentation (#5520):** `serverTs` on stream messages, stamped pong, token-to-render summaries.
- **Turn-edge ingest (#5541):** `UserPromptSubmit`/`Stop` hook emitters (#5542) + ingest types (#5545) so external-session Discord status flips working/ready on real turn boundaries.
- **Discord webhook resolved from the OS keychain as a third source (#5493 / #5928).**

### Changed

- **Streaming feels live (epic #5514):** memoized bubbles, adaptive delta flush keyed on EWMA RTT, tighter single-client coalescing (#5532); chat list virtualization (#5534, #5561 / #5572); terminal WebView writes via postMessage (#5529); mobile auto-prefers a verified direct LAN connection with tunnel fallback (#5535); a shrunk delta-coalescing window driven by the client EWMA (#5562 / #5568) with deflate-aware coalescing (#5578 / #5584); a shared `RttSmoother` (#5556 / #5569); a `sessionId→clients` reverse index for broadcast + subscriber counts (#5563 / #5575).
- **Faster connect handshake (#5555):** eager key exchange folded into the auth handshake (#5590), an `auth_bootstrap` burst collapsing the post-auth round trip (#5592), `lastSeq` delta replay + no-blank-flash reconcile (#5593), a reconnect backoff ladder + keepalive coordination (#5594), and per-attempt reconnect-endpoint re-resolution with LAN→tunnel fast fallback (#5600).
- **Shared client-runtime extraction:** store-core client message dispatch table built out slice by slice (#5591, #5595) with dispatch-table factories (#5877), a shared `createConnectFlow` orchestration (#5598), a shared `createDeltaFlusher` (#5588), an extracted shared connection runtime — heartbeat/handshake (#6035 / #6065), and `session_context`/`model_changed` migrated onto the shared table (#5618 / #5768, #6126).
- **store-core handler split (audit P2-3):** `message-handler` carved into a `handlers/` family — git, file, environment, shared helpers, budget, plan, checkpoint, agent, usage, stream, session-status, client, session-list, session-lifecycle, conversation, web-task, dev-preview, intervention, error, user-question, permission (request + mode), auth/connection, and a final misc slice (#5892–#5917), with the misc catch-all later split into topical slices (#6034 / #6060).
- **Swarm-hardening audit waves** across server, ws, store-core and protocol: phase-1 quick wins (#5564, #5565, #5566); round-2 index lint / CI asserts / per-pid tmp (#5579 / #5585); P0/P1 fixes — free the port before re-forking the supervisor (#5851), scope cloudflared cold-start timeout to the attempt (#5852), preserve worktrees on shutdown (#5853), consolidate claude-tui per-turn teardown (#5862), dedup the terminal-mirror gate (#5863), reclaim orphaned session worktrees at boot (#5859 / #5865, #5922), centralize config fatal-vs-warn policy (#5866); P2 DRY pack — ws-broadcaster (#5874), quick-tunnel recovery generation guard (#5875), declarative `validateRange` config table (#5879), provider DRY pack (#5883), settings-handler split (#5884), built-in-tool pure transforms shared by host + container (#5882 / #5888).
- **`@chroxy/protocol/project` extraction (#5850):** shared project module (#5885) cross-platform hardened (#5886 / #5887), with the chroxy-worktree `.git` parser consolidated into it (#5869 / #5926).
- **Claude-family membership single-sourced** via a static `claudeFamily` (#5858 / #5890), with a lint requiring `ClaudeByokSession` subclasses to declare it (#5925) and all Claude-family providers (incl. default claude-tui) treated as Claude (#5855).
- **Explicit primary-ownership semantics for shared sessions (#5589)**, with session-role (primary/observer) state surfaced in both clients (#5612).
- **TUI AskUserQuestion handling:** multi-select reinjected as text (#5776 / #5781) — sanitized (#5796 / #5803), capability-wired to the client to close the split-brain (#5806), behind `CHROXY_TUI_MULTISELECT_REINJECT` (#5797 / #5804) — with AskUserQuestion render logic and provider predicates hoisted out of the twin clients into store-core (#5800 / #5810, #5795 / #5802).
- **Skills compile to per-agent native formats (claude/gemini/codex) (#5814)**, synced with registry hardening (#5816).
- Control Room tabs auto-fetch on open with a staleness guard — no more manual Refresh on entry (#5546); a tab registry as one descriptor array (#5557 / #5570); App.tsx decomposed into feature hooks + Shell components (#5602).
- Mobile decomposition: SessionScreen view-state + secondary panels (#5656), SettingsScreen into `settings/` sections (#5658), WS send guards collapsed into a single `sendIfOpen` helper (#5657), and file-ops/git + web_task cases migrated to the shared dispatch table (#5659, #5662).

### Fixed

- **Durability marathon — fail loudly, never silently lose state:** surface session-state flush failures (#5701 / #5712) and `session_persist_failed` to clients (#5714 / #5729), surface checkpoint persistence failures (#5731 T3 / #5734), reject `destroy_session` while running (#5695 / #5707), only broadcast `model_changed` when `setModel()` applied (#5696 / #5708), roll back optimistic model / permission-mode / thinking-level on NOT_APPLIED (#5715, #5722, #5742), reject `set_model` on providers without `modelSwitch` (#5731 T1 / #5732), cap the SDK mid-turn message queue at 3 (#5717), re-home other clients on checkpoint restore (#5700 / #5927) and refuse restore when another busy session shares the cwd (#5741), worktree GC age fallback for recycled PIDs (#5706 / #5718), and surface tunnel-stop / repo-config-write / fresh-session-start failures instead of faking success (#5743, #5744, #5738).
- **Permission containment & answer integrity:** attribute and contain permission prompts to the owning session (#5667 / #5673, #5705) with mobile parity labels (#5694) and an aggregate "N pending" badge + jump-to-next (#5693 PR-3 / #5709); fail closed on a stale/unmapped question toolUseId (#5753 / #5762); reap a denied-shape AskUserQuestion's leaked pending entry (#5792 / #5975); drain pending HTTP-hook permissions on destroy (#5739); refcount and tear down permission-induced subscriptions (#5704 / #6026); isolate per-permission throws in reconnect resend loops (#6054 / #6067); refuse permission/question answers on a disconnected session in both clients (#5699 / #5728, #6077).
- **claude-tui provider:** nudge the first-message submit on a freshly-spawned TUI (#5777 / #5787) and harden that nudge (#5794 / #5809); unwrap tool-result JSON in the Output tab (#5778 / #5783); suppress the AskUserQuestion raw `tool_input` streaming bubble (#5770 / #6017, #6018 / #6086); deny multi-select AskUserQuestion in the provider (#5771 / #5772); async fs in the hook-drain hot path (#6132 / #6177) with bounded/coalesced drain so a stuck sink self-recovers (#6178 / #6179).
- **Reconnect & presence:** clear transient stream/plan state for all sessions on socket drop (#5736), re-sync `session_role` on reconnect (#5737, #5623 / #5755), reset flat `primaryClientId` on session switch (#5731 T2 / #6131); cap the reconnect ladder + a terminal "server down" state on dashboard (#5698 FIX-2 / #5724) and mobile (#5725 / #5980); broadcast a terminal session-dead signal on respawn exhaustion (#5698 / #6024) and serve a terminal-down signal when the supervisor gives up (#6130).
- **Mobile input integrity:** stop silently losing input on resume, session-switch, and queue overflow (#5637), route all manual-disconnect paths through the unsent-queue discard guard (#6081 / #6087), match dashboard busy-detection for queued sends (#6113 / #6115), gate SettingsBar model/permission chips on provider capabilities (#5747), guide users when LAN scan returns no results (#5661), and handle the rotate-pin key decision exhaustively (#5978 / #6101).
- **Dashboard chat scroll:** auto-scroll to bottom on send and follow when near bottom (#5780 / #5785), snap to bottom on approve/answer with a deduped scroll primitive (#5786 / #5805), keep streaming auto-scroll pinned to the bottom (#5954 / #5957), and re-pin to the tail when the input area grows (#5954 / #5981).
- **Dictation:** clear `isDictationUpdateRef` on stop/error (#5567 / #5571), re-anchor merges around mid-recognition manual edits (#5573 / #5583), surface voice-recognition errors instead of a silent mic-off (#5668 / #5756); push-to-talk no longer corrupts fast typing or hijacks active recordings (#5672).
- **Supervisor:** clear the pending restart timer in `startChild` to prevent a double-fork (#5748); track and clear the standby `EADDRINUSE` retry timer (#5921).
- **Pricing & models:** price + correctly label current-gen Claude models (#5631 / #5757), price `gemini-2.0-pro` and warn on unpriced offered models (#5745), header model dropdown reflects the active session model (#5664), and let an explicit `model:null` survive create as the provider-default marker (#3403 / #6070).
- **Desktop:** adopt an external server in client mode instead of hanging (#6015 / #6123) with an actionable message when auto-start is on but no token (#6129); theme the summon hotkey input + buttons (#5587).
- **Ingest:** split rate-limit buckets so keepalives can't starve transitions (#5675 / #5679); heartbeat watchdog downgrades abandoned online embeds (#5676 / #5680).
- **Self-healing UI:** self-heal an orphaned "Queued" badge via `queueLength` reconciliation (#5958); terminal-only providers no longer trap tabs or split (#5997 / #5999); reset Control Room survey loading flags on socket close (#6163); degraded-survey error-banner parity + normalization (#6166, #6168) with real CSS for the callout chips (#6169 / #6170).
- **Discord embed:** markdown escaped in free-text fields (#5525), subagent counts aggregated per project (#5496), scheduled-wakeup push body rendered as relative time (#5522), webhook URL resolved from encrypted credentials.json (#5523); warn on unknown keys in `notifications.discord` (#5453 / #5845) and in k8s/billing/worktreeGc/rancher config (#5878 / #5946).
- launchd/systemd service starts out of the box (#5526); cloudflared 502/530 treated as tunnel-routable (#5521); claude-hooks installer hardened against malformed settings.json (#5524) and never deriving the opaque session id for an unrecoverable chroxy worktree (#5483 / #5849), with parent-repo recovery for chroxy-worktree cwds in event ingest (#5483 / #5864).

### Security

- **Token revocation & rotation (#6006):** revoke-kills-live-shells distinguishing revoke vs scheduled rotation with forced re-auth (#6009), an operator revoke trigger — primary-gated `revoke_token` + a dashboard panic button (#6010), and a `client.authToken` refresh on scheduled-rotation push so honest primaries need not reconnect (#6012 / #6013).
- **Identity-key rotation handoff (#5616 phase 1):** crypto + pin chain-forward (#5977); the daemon's E2E identity key pinned from pairing (#5536 / #5603), with a hardened, deduped E2E key-pinning trust path (#5614, #5615 / #5627).
- **Exchange-key domain separation (#5604):** domain-separated signature on an accept-both ramp (phase 1, #5960) then emit-only (phase 2, #6083).
- **Pairing-bound-token write gates:** reject permission-rule writes from bound tokens (P0-4 / #5854), skill-trust grants/accepts from bound tokens (#5857 / #5860), and require a primary token to DELETE a host snapshot (P1-6 / #5861); scope `/qr`, `/pairing-code`, `/qr/session`, `/connect` to the primary token class (#5601).
- **Answer-authorization single source (#6030 / #6057):** one predicate, exercised by real handlers in test (#6059 / #6068), covering bound-client + empty-string sessionId edges (#6085).
- **Broadcast-path redaction:** redact secret-shaped values on the tool-broadcast path (#6029 / #6037) and tool input on the SDK permission broadcast path (#6038 / #6047).
- **BYOK credentials routed through the canonical encryption-aware store (#5867 / #5889).**
- **Mobile at-rest hardening:** encrypt the AsyncStorage persistence cache (#5649), engage biometric lock on cold start not just resume (#5648), add a navigation allow-list to the WebView terminal (#5650), and gate the Expo push-token log behind `__DEV__` (#5647).
- **WS frame integrity:** reject post-handshake plaintext frames once encrypted (#5639); roll back the eager handshake when `auth_ok` delivery fails (#5721 part 1 / #5944); abort the handshake when `key_exchange_ok` send fails (#5702 8b / #5720); guard unguarded error/push sends (#5702 8a+8d / #5719).
- **Embedded server binds to loopback by default (#5356 / #5611).**
- **A validated builder for `permission_request` emits (#6031 / #6052)** plus a protocol lint that every server→client schema type reaches both clients (#6033 / #6061).
- **Collision-proof the compat credential-cache slot key (#5486 / #5847).**

### CI / Testing

- **Self-hosted runners:** Desktop Rust Tests on the self-hosted macOS runner (#6041); ubuntu jobs routed to a fork-safe self-hosted Linux runner (#6044) with Store Core + App (#6046 / #6076) and a container-portable Server Tests suite (#6075 / #6093) migrated over; deduped `SELF_HOSTED_OR_HOSTED` expression (#6045 / #6050); pinned root/container contract for the perm-skip tests (#6094 / #6102); cancel superseded in-progress CI runs on PR branches (#6040).
- **Retire `--test-force-exit` (#5480):** CI guard on `--test-force-exit` truncation via a test-count guard (#6028), leaked-handle teardown so the suite exits cleanly (#6027 / #6042), `unref()` on destroy/respawn/shutdown force-kill timers (#6043 / #6051), and dropping the last usages (#6100).
- **Temp-git-repo teardown ENOTEMPTY hardening (#6075):** harden teardowns against the background-gc race (#6095, #6099), re-recurse / `rmDirRobust` on ENOTEMPTY (#6114 / #6119, #6120 / #6121), and widen the retry budget for runner load (#6106).
- **Maestro suite repairs:** determinism markers + setup dedup + key-exchange flow (#6088), repair against the current Maestro CLI — anyOf + hideKeyboard rot (#6089 / #6090), a reliable per-flow runner with timeout + sim reset (#6104), tappable activity-group entries + answerable multi-question forms (#6105), and a permission-tap-while-disconnected no-op flow (#5699 / #6092).
- **Test sandboxing & coverage:** sandbox the api-token keychain in the suite (#5915); both-clients SWITCH_FIXTURES / handler-coverage enforcement (#5619 / #6020, #6055, #6025) and `permission_resolved` contract fixtures (#6058 / #6071, #6074 / #6084); auth_ok encryption/identity-refusal + offline-queue coverage (#5638); behavioral-contract fixtures + encrypted-handshake e2e (#5556 / #5605); real-socket reconnect parity after the connection-runtime extraction (#6066 / #6181); cover untested pure helper modules (#6108).

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
