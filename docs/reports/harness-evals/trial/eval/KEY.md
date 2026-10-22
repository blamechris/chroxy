# Sealed key — harness trial 2026-10

Sealed at 2026-10-17T23:17Z by the owner, before any trial run started. Trial base T0: the merge-base of any trial/* base with main, identified in docs/reports/harness-evals/trial/README.md (the bases may be re-cut before run 1; the key does not depend on which commit).
Commitment: the SHA-256 of this file is recorded in docs/reports/harness-evals/trial/KEY-COMMITMENT.md on main. Any edit after sealing changes the digest.
This file stays outside the repository until README step 11 (unseal, after run 4). Graders use "Acceptance checks" as the pass bar and "Expected root cause" to judge whether a fix is the right fix or a workaround.

## #8233 — cli: chroxy doctor ignores the configured port and checks 8765

- Expected root cause: cli/doctor-cmd.js reads only the -p flag and never the merged config, so port is undefined unless -p is passed and doctor falls back to 8765 while start honours config.
- Acceptance checks: doctor checks the same merged port as start (flag, then env, then config, then 8765); a test with "port": 8794 in config and no flag reports 8794; the -p path still wins over config.
- Fix already known (yes/no): yes.

## #8215 — isLoopbackHost: the ::ffff:7f prefix match accepts non-loopback mapped addresses

- Expected root cause: h.startsWith('::ffff:7f') in bind-host.js matches any hextet that merely begins with 7f, including short ones, so ::ffff:7f:1 (0.127.0.1) and the incomplete ::ffff:7f classify as loopback.
- Acceptance checks: the hex form is loopback only when the first mapped hextet is four hex digits in 7f00–7fff; ::ffff:7f:1 and ::ffff:7f are false; ::ffff:7f00:1 and ::ffff:127.0.0.1 remain true; tests pin all four; the dotted branch is unchanged.
- Fix already known (yes/no): yes.

## #7771 — models.js updateContextWindow admits NaN

- Expected root cause: the guard uses typeof contextWindow !== 'number' || contextWindow <= 0, and NaN passes both halves; it then lands in activeModels and contextWindowOverrides and is persisted by saveCache().
- Acceptance checks: Number.isFinite replaces the typeof check; updateContextWindow(id, NaN) returns false and leaves getModels() and the override map untouched; the test is shown red against the old guard first.
- Fix already known (yes/no): yes, one line plus a test.

## #8595 — custom model collision labels repeat pinned descriptors

- Expected root cause: the final collision fallback in the shared model-choice formatter (store-core model-display, modelChoices) appends the full-target discriminator to the already augmented label instead of recovering the original base label.
- Acceptance checks: a cross-family collision regression through modelChoices (alpha → claude-alpha-1-0, beta → claude-beta-1-0, both labelled Custom) yields labels with exactly one discriminator and no repeated "(pinned 1.0)"; distinct target choices and original selection IDs are preserved.
- Fix already known (yes/no): yes; whether it lives in the formatter or the fallback is open, either is acceptable.

## #8364 — app: the lone tool bubble and tool detail modal show no terminated state

- Expected root cause: on mobile only ActivityGroup handles toolResultTerminatedReason; ToolBubble and ToolDetailModal render the raw result text.
- Acceptance checks: both components render the amber terminated state with the reason when toolResultTerminatedReason is set, matching ActivityGroup and the dashboard; component tests for both are red without the change; no simulator evidence required.
- Fix already known (yes/no): yes, by analogy to ActivityGroup.

## #8282 — record the stream kind on history entries so reasoning text is distinguishable from replies

- Expected root cause: SessionMessageHistory.recordHistory ignores the thinking flag at stream_end and stores reasoning with the same shape as a reply; only the -thinking-<n> id suffix distinguishes them.
- Acceptance checks: a recorded reasoning stream carries an optional kind field and a reply does not; a pre-change state file restores with -thinking- ids classified as reasoning; the field survives persist, restore and per-entry truncation; existing replay tests pass; the protocol schema accepts the optional field; dropping the flag in recordHistory turns the first test red.
- Fix already known (yes/no): design yes; whether the Codex adapter also records reasoning is open and not required.

## #8277 — dashboard: Settings hides a saved provider override the connected server does not offer, and never shows the migration notice

- Expected root cause: persisted New Session keys are origin-global, and Settings → Default provider renders effectiveProvider (first available) instead of the stored override; the migration notice is rendered only in New Session.
- Acceptance checks: Settings shows a dormant override as dormant (disabled option or hint) instead of silently showing another provider; Settings → Session Defaults shows the undismissed migration notice with the same dismiss as New Session; behaviour is tested.
- Fix already known (yes/no): behaviour yes; UI placement and copy are the run's call. Overlap with #8611 is acceptable only for the notice.

## #8567 — notifications: DEFAULT_BYPASS_CATEGORIES is still hand-copied in both clients

- Expected root cause: after #8566 moved the category roster into @chroxy/protocol, the default-bypass set remained a hand-maintained copy in the app and the dashboard with no guard against drift from the server.
- Acceptance checks: one definition of the default-bypass set, either in the shared protocol module or derived from a per-category flag on NOTIFICATION_CATEGORIES; server and both clients consume it, or the server copy is checked against it in both directions; a guard proven red by a category added to the bypass set in one place only; protocol dist rebuilt consistently.
- Fix already known (yes/no): yes, two acceptable designs.

## #8303 — server,dashboard: Browse is $HOME-only while Create honours workspaceRoots, and a blank cwd inherits a configured directory that explicit Create would refuse

- Expected root cause: three disagreeing rules: validateCwdAllowed for explicit Create, a $HOME-only listDirectory in ws-file-ops/browser.js that never consults workspaceRoots or the default cwd, and a blank-cwd path in session-manager createSession that skips validateCwdAllowed entirely.
- Acceptance checks: with workspaceRoots set, Browse lists the roots and their subdirectories and still refuses directories outside every root and $HOME; the configured default cwd is browsable when it passes validateCwdAllowed; New Session shows a one-line note when the prefilled cwd is not browsable; the daemon warns at startup when config.cwd fails the check; tests cover Browse under workspaceRoots, Browse of the default cwd, and the credential-dir deny-list still applying. Whether a blank cwd should bypass validateCwdAllowed is explicitly deferred; a run that decides it has overreached.
- Fix already known (yes/no): direction yes, details no.

## #7815 — test(server): doctor 'accepts custom port' hardcodes 59123 and asserts pass

- Expected root cause: tests/doctor.test.js asserts on ambient machine state at two sites (59123 at :171, 59124 at :180); any process holding the port turns pass into warn.
- Acceptance checks: both sites stop depending on ambient state; preferred shape binds an OS-assigned port and asserts deterministically in both directions (pass when free, warn when deliberately bound); if a run instead drops the status assertion it must add a separate warn test for a bound port, otherwise it has removed the only pass/warn coverage; proven red by binding the ports before the old test.
- Fix already known (yes/no): yes, with a preferred option.
