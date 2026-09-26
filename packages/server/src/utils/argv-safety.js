/**
 * Argv option-injection guards (#7290, #7291).
 *
 * `execFile`/`spawn` with an array argv already stops SHELL injection — no
 * shell ever sees the string. It does NOT stop ARGUMENT injection: the spawned
 * program still runs its own option parser over that array, so a value that
 * begins with `-` is read as an OPTION rather than as the datum it was meant
 * to be. That is a distinct class, and it needs a distinct guard.
 *
 * There are three correct fixes. Which one applies is decided by whether a
 * leading `-` is LEGITIMATE for that datum, and by how the target CLI parses
 * the slot — so it is a per-CLI question, answered by MEASURING, not assumed:
 *
 *   1. The value can never legitimately start with `-` (a git ref, a branch,
 *      a container name) → REJECT it. `isSafeArgvValue` / `assertSafeArgvValue`.
 *
 *   2. The value legitimately can (a user's chat message — "- first point"),
 *      and it sits in a POSITIONAL slot → do not reject; terminate option
 *      parsing with a `--` separator placed BEFORE the value, and put every
 *      flag the command needs BEFORE the `--`. This is what the `claude`
 *      web-task argv does, and (since #7342) what `buildCodexArgs` does on
 *      both the first-turn and `resume` forms of `codex exec` — including the
 *      resume SESSION_ID, which is itself a positional and so must also
 *      precede the separator.
 *
 *   3. The value legitimately can, and it is the ARGUMENT TO A NAMED FLAG that
 *      the CLI declares as requiring one → `=`-join the long form,
 *      `--flag=<value>`, binding the value to the flag in a single token.
 *      Neither (1) nor (2) works here. This is what `GeminiSession._buildArgs`
 *      does for BOTH its prompt and its model id (since #7342). Measured
 *      against gemini-cli 0.45.2 and re-measured on 0.46.0, whose `-p/--prompt`
 *      and `-m/--model` use yargs `requiresArg`:
 *
 *          gemini -p "- first bullet"       usage error, exit 1
 *          gemini -p -- --list-extensions   usage error, exit 1  (`--` BREAKS it)
 *          gemini --prompt="- first bullet" parses, value taken literally
 *
 *      So a blanket "add `--` everywhere" sweep would be a REGRESSION on such
 *      a CLI. Beware short-circuiting flags when probing: `gemini -p --version`
 *      prints a version because yargs handles `--version` before it validates
 *      `requiresArg`, which makes it look like injection when it is not. Probe
 *      with a flag that does not short-circuit.
 *
 * `--` is NOT interchangeable with (1). It ends option parsing at ITS OWN
 * position, so it cannot retroactively protect a value that precedes it.
 * Measured against git 2.54.0 while fixing #7290:
 *
 *     git diff --stat --        still applies --stat
 *     git diff --exit-code --   still exits 1
 *     git diff -O/etc/nope --   still reads the orderfile
 *
 * so `['diff', base, '--']` is not a fix for a dash-leading `base`, and
 * `--literal-pathspecs` (#7281/#7289) does not help either — that constrains
 * the PATHSPEC language, and a revision is not a pathspec.
 */

/**
 * True when `value` is safe to place in an argv slot whose contents would
 * otherwise be option-parsed.
 *
 * Rejects, in order: a non-string, the empty string, a leading `-`, and any
 * NUL / CR / LF. The control characters matter because several CLIs (and git's
 * own `--stdin` modes) treat a newline as a record separator, so an embedded
 * one can smuggle a second argument into a single slot.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeArgvValue(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('-') &&
    !/[\0\n\r]/.test(value)
}

/**
 * Throwing form of {@link isSafeArgvValue}, for call sites that must refuse
 * rather than fall back.
 *
 * @param {unknown} value
 * @param {string} [kind] - noun for the error message, e.g. 'branch', 'ref'.
 * @throws {Error} when `value` would be option-parsed.
 */
export function assertSafeArgvValue(value, kind = 'value') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`empty ${kind}`)
  }
  if (!isSafeArgvValue(value)) {
    throw new Error(`unsafe ${kind}: ${JSON.stringify(value)}`)
  }
}

/**
 * A git commit SHA, full or abbreviated — the shape of fix (1) for the one
 * datum this repo persists as a ref: `<config dir>/known-good-ref`, written by
 * `chroxy deploy` and read back by both `chroxy deploy` and the supervisor's
 * rollback path.
 *
 * Deliberately stricter than {@link isSafeArgvValue}: the datum is always a
 * SHA that chroxy wrote itself, so hex-only rejects not just `--exit-code` and
 * `-O/etc/passwd` but every branch name, refspec and revision expression a
 * corrupted file could otherwise smuggle into a `git` argv. Short SHAs of ≥ 7
 * chars are accepted to match the supervisor's historical behaviour.
 *
 * Lives here, and NOT copied to a second call site: this predicate had one
 * implementation inline in supervisor.js, and #7296 added the second consumer.
 *
 * @param {unknown} ref
 * @returns {boolean}
 */
export function isGitShaRef(ref) {
  return typeof ref === 'string' && /^[0-9a-f]{7,40}$/i.test(ref)
}

/**
 * Does a CLI's `--help` output advertise `flag` as a flag in its OWN right?
 *
 * A bare `help.includes('--remote')` is a false-safety guard: it reports
 * success without checking, because it also matches `--remote-control`. That
 * is not hypothetical — measured against the installed Claude Code CLI while
 * fixing #7291, whose help text carries `--remote-control` and
 * `--remote-control-session-name-prefix` and NO `--remote`:
 *
 *     help.includes('--remote')   -> true    (wrong: opens the gate)
 *     cliHelpAdvertisesFlag(...)  -> false   (right)
 *
 * The boundaries are the whole point — the flag must be delimited on BOTH
 * sides by something that is not a word character or a hyphen, which is what
 * distinguishes a flag from a longer flag sharing its prefix or its suffix.
 * A trailing-only test still returns true for `x--remote`, for `---remote`,
 * and — the exact mirror of the defect this function exists to prevent — for
 * a `-O` probe against a help line advertising `--O <file>`.
 *
 * @param {unknown} helpText - captured stdout of `<cli> --help`.
 * @param {string} flag - the exact flag, including leading dashes, e.g. '--remote'.
 * @returns {boolean}
 */
export function cliHelpAdvertisesFlag(helpText, flag) {
  if (typeof helpText !== 'string' || typeof flag !== 'string' || !flag) return false
  return new RegExp(`(?<![\\w-])${escapeForRegExp(flag)}(?![\\w-])`).test(helpText)
}

/** Escape a flag so it can be interpolated into a RegExp body. */
function escapeForRegExp(flag) {
  return flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Audited-sink catalogue for `scripts/lint-argv-sinks.mjs` (#7868).
 *
 * The lint enumerates every `spawn`/`execFile`/`execFileSync`/`spawnSync`
 * call site (and every `_buildArgs`/`build*Args`-shaped function) in
 * `packages/server/src` and requires each argv element that is not provably
 * a compile-time constant to be either provably safe — `assertSafeArgvValue`
 * / `isSafeArgvValue` applied to it, a `--` terminator placed before it, or
 * fused into one token behind a fixed non-dash prefix — or listed here.
 *
 * Each entry is `{ file, match, reason }`:
 *   - `file` — the sink's path, relative to `packages/server/src`.
 *   - `match` — a distinguishing substring of the finding's catalogueKey. For
 *     an unresolvable argv, that key is the whole call's normalised source
 *     text. For a single flagged ELEMENT (#7936), it is that element's own
 *     normalised text — UNCHANGED and always first — followed by the
 *     enclosing function (or `<module>`), the sink's callee, a per-
 *     (function, callee) call-site ORDINAL (review follow-through: two
 *     separate calls to the same callee within the same function still
 *     shared a key without this — see the `elementCatalogueKey` doc comment
 *     in `lint-argv-sinks.mjs`), and the element's position within its
 *     resolved argv array, e.g. `` `value [[runA#execFile#0#1]]` ``. A match
 *     written as just the bare element text (the pre-#7936 convention — most
 *     of the entries below) still matches, since that text is still a
 *     literal, unmoved prefix of the key, and may legitimately span several
 *     call sites that share one safety argument (the `domain`-style entries
 *     below). A match that also includes the bracketed suffix pins to
 *     exactly the one call site it was written against — use that shape
 *     when two sinks in this file could otherwise share an identically-named
 *     flagged element (`lint-argv-sinks.mjs`'s `elementCatalogueKey`). Not a
 *     line number on purpose: a line number drifts on every unrelated edit
 *     above it, which would force a churn-only update on every such edit. A
 *     source-text match only goes stale when the FLAGGED CODE ITSELF
 *     changes — which is exactly when re-auditing is wanted.
 *   - `reason` — one line: why this value cannot be attacker-controlled, or
 *     why the CLI it reaches cannot option-parse it.
 *
 * Checked in BOTH directions by the lint (#7199, #7216, #7544, #7639): an
 * entry that no longer matches any real, still-unguarded finding is STALE
 * and fails the build (the code moved on — remove the entry), and a real
 * finding that matches no entry and no structural guard also fails. A list
 * that only ever grows, or that nothing re-derives against the code, is the
 * "roster checked in only one direction" shape docs/false-safety-guards.md
 * catalogues.
 */
export const AUDITED_SINKS = [
  // ── acp-session.js ──
  {
    file: 'acp-session.js',
    match: 'spawn(spawnSpec.command, spawnSpec.args',
    reason: 'entryRef.args is providers.acp[].args from the operator config.json, loaded once at boot by registerAcpProviders(); no WS/client message reaches it.',
  },

  // ── auth-probes.js ──
  {
    file: 'auth-probes.js',
    match: 'service',
    reason: 'keychainItemExists(service) has exactly one production caller, passing the module constant CLAUDE_KEYCHAIN_SERVICE; also sits immediately after the required-arg flag -s, consumed unconditionally regardless of content.',
  },

  // ── built-in-tools/bash-exec.js ──
  {
    file: 'built-in-tools/bash-exec.js',
    match: 'command',
    reason: 'this is the Bash tool: command is intentionally run as a full shell string via bash -c, which is the documented feature (pipes/redirection/heredocs), governed by the permission system rather than argv-shape — a different, already-accepted risk class from accidental option injection into an unrelated program.',
  },

  // ── built-in-tools/tool-transforms.js ──
  {
    file: 'built-in-tools/tool-transforms.js',
    match: 'return { ci, ln, globArg }',
    reason: 'not actually an argv-returning function despite the *Args name match — it returns { ci, ln, globArg } string fragments consumed by a shell-command-string builder (buildGrepCommand), out of this lint scope by design (see the exec()/execSync() scope note above). pattern/root are already hardened behind -e / a -- terminator (#7295); the --glob fragment is shell-quoted via shellQuote() but its rg/grep-side arity is unverified — tracked as a follow-on rather than fixed here.',
  },

  // ── byok-mcp-client.js ──
  {
    file: 'byok-mcp-client.js',
    match: 'spawn(spawnSpec.command, spawnSpec.args',
    reason: 'this._config.{command,args} is an MCP server entry the primary/owner user names to run an arbitrary local program — that is the feature (STRICT-PRIMARY gate + a requestMcpTrust approval prompt before spawn), not option-flag injection into an unrelated binary; not reachable by a non-primary client.',
  },

  // ── claude-tui-session.js ──
  {
    file: 'claude-tui-session.js',
    match: "execFile(binary, args",
    reason: "runClaudeAuthStatus's one call site passes a literal ['auth','status','--json','--settings', this._settingsPath] array; --settings is a daemon-generated absolute path (join(sinkDir, 'settings.json') under a random-UUID sink dir) — never client text.",
  },
  // #7935 — `_spawnPty`'s node-pty `ptyMod.spawn(attemptedBinary, args, {...})`
  // became a scanned sink once the lint learned to recognise node-pty
  // bindings; `this._sessionId` needs no entry (recognised structurally —
  // guarded by the `assertSafeArgvValue(this._sessionId, 'sessionId')` call
  // right above, now that `pathKeyOf` resolves a `this.` base). The three
  // entries below use the new call-site-scoped catalogueKey shape (#7936:
  // element text + enclosing function + sink callee) so a future SECOND
  // sink in this file reusing one of these identifiers cannot silently
  // alias onto these — see elementCatalogueKey in lint-argv-sinks.mjs.
  {
    file: 'claude-tui-session.js',
    match: 'this._settingsPath [[_spawnPty#spawn',
    reason: "this._settingsPath is set by writeHookSettings(this._sinkDir, ...) to join(this._sinkDir, 'settings.json'); this._sinkDir is always join(<server-config base>, `s-${randomUUID()}`) — a daemon-generated absolute path, same reasoning as this file's execFile(binary, args) entry above (runClaudeAuthStatus's own --settings argument).",
  },
  {
    file: 'claude-tui-session.js',
    match: 'this.model [[_spawnPty#spawn',
    reason: 'this.model is gated BEFORE ClaudeTuiSession is constructed by SessionManager against ClaudeTuiSession.getAllowedModels() (models.js ALLOWED_MODEL_IDS, none starting with "-") — the same allowlist and preflight gate cli-session.js\'s own "model" entry documents — unless an operator opted the provider into config.providers.allowAnyModel (not client-reachable).',
  },
  {
    file: 'claude-tui-session.js',
    match: 'skillsPrefix [[_spawnPty#spawn',
    reason: 'bound via args.push("--append-system-prompt", skillsPrefix) — the same required-arg two-token flag on the same claude CLI that cli-session.js\'s "skillsText" entry already measured (2.1.282: a bogus flag-shaped value here starts the process normally, swallowed as the flag\'s own value); skillsPrefix carries client-settable skills/preamble text (_buildCombinedSkillsPrefix), but the argv SHAPE cannot be reinterpreted regardless of its content — same reasoning as skillsText.',
  },

  // ── cli-session.js ──
  {
    file: 'cli-session.js',
    match: 'spawn(spawnSpec.command, spawnSpec.args',
    reason: '_spawnPersistentProcess(args) has one caller (start()), which passes args = buildClaudeCliArgs({...}) — audited below, at buildClaudeCliArgs itself.',
  },
  {
    file: 'cli-session.js',
    match: 'model',
    reason: 'this.model traces to the create_session WS model field, but is gated BEFORE CliSession is constructed by SessionManager against CliSession.getAllowedModels() (a known id allowlist, none starting with "-"), unless an operator opted the provider into config.providers.allowAnyModel (not client-reachable).',
  },
  {
    file: 'cli-session.js',
    match: "allowedTools.join(',')",
    reason: 'this.allowedTools is populated only from server config (config.js allowedTools / CHROXY_ALLOWED_TOOLS env) — no WS/client code path sets it.',
  },
  {
    file: 'cli-session.js',
    match: 'skillsText',
    reason: 'bound via args.push("--append-system-prompt", skillsText) — a required-arg (<prompt>) two-token flag, measured directly against the installed claude CLI (2.1.282): a bogus flag-shaped value passed this way starts the process normally (swallowed as the flag value), while the identical text as a bare option immediately errors "unknown option" — confirming the required-arg two-token form is safe regardless of skillsText content (argv-safety.js’s own documented case-3 table). skillsText itself does carry client-settable text (sessionPreamble, via set_session_preamble), but that is irrelevant here since the argv SHAPE cannot be reinterpreted.',
  },
  // resumeSessionId needs no catalogue entry: `-r, --resume` is declared with
  // an OPTIONAL argument on the claude CLI (measured — the two-token form
  // INJECTS, unlike --model/--append-system-prompt above), so buildClaudeCliArgs
  // asserts it safe directly (case 1) rather than relying on it structurally.

  // ── cli/deploy-cmd.js ──
  {
    file: 'cli/deploy-cmd.js',
    match: 'fullPath',
    reason: 'join(process.cwd(), file) is always an absolute path (starts with "/"), so it can never be read as a flag regardless of the tracked filename it is built from; CLI-only (chroxy deploy), no WS path.',
  },
  {
    file: 'cli/deploy-cmd.js',
    match: 'testDir',
    reason: "join(process.cwd(),'packages','server','tests') is a fully literal path with no variable component; CLI-only.",
  },
  {
    file: 'cli/deploy-cmd.js',
    match: 'tagName',
    reason: "`known-good-${Date.now()}` — fixed literal prefix plus a numeric timestamp; can never start with '-'. CLI-only.",
  },
  {
    file: 'cli/deploy-cmd.js',
    match: 'old',
    reason: "old comes from `git tag --list 'known-good-*'` output, glob-filtered by git itself to always start with the literal 'known-good-'; never attacker text. CLI-only.",
  },

  // ── cli/session-cmd.js ──
  {
    file: 'cli/session-cmd.js',
    match: 'target.convId',
    reason: 'read from the local session-state.json (conversationId set either by a provider CLI itself, or accepted from a remote resume_conversation WS message only after CONVERSATION_ID_RE, a fully anchored canonical-UUID regex); the execFileSync call itself is CLI-only (chroxy resume).',
  },

  // ── cli/worktree-gc-cmd.js ──
  {
    file: 'cli/worktree-gc-cmd.js',
    match: "execFileSync(cmd, args, { encoding: 'utf8' })",
    reason: "dirSizeKib's one caller passes exec('du', ['-sk', path]) where path is an absolute filesystem path reported by git's own worktree-list output; CLI-only report path (chroxy worktree gc), not the daemon auto-reaper.",
  },

  // ── codex-session.js ──
  {
    file: 'codex-session.js',
    match: 'buildCodexArgs(text, this.model, this.resumeSessionId',
    reason: 'delegates to buildCodexArgs, a separate exported function audited at its own definition (text terminated behind --, model TOML-serialized via -c, sandbox enum-checked, threadId asserted safe — #7868).',
  },
  {
    file: 'codex-session.js',
    match: 'sandbox',
    reason: 'resolveCodexSandbox(sandboxOverride) is constrained to the frozen enum CODEX_SANDBOX_MODES (read-only/workspace-write/danger-full-access); any other value is discarded and replaced by the default, and is re-gated at the WS ingress schema.',
  },

  // ── docker-sdk-session.js / docker-session.js ──
  // Neither file's create_session wiring (session-manager.js) ever forwards a
  // client image/memoryLimit/cpuLimit — providerOpts only ever carries
  // containerId/containerUser/containerCliPath, so _image/_memoryLimit/
  // _cpuLimit always resolve to their hardcoded literal defaults today.
  {
    file: 'docker-sdk-session.js',
    match: 'this._containerId',
    reason: 'always Docker-daemon-generated (captured from this own docker run/create stdout) or resolved server-side via environmentManager.getContainerInfo(); restore is cross-validated against the live environment record. Never accepted as raw client text.',
  },
  {
    file: 'docker-sdk-session.js',
    match: 'this._memoryLimit',
    reason: "opts.memoryLimit || '2g' — never populated by the live create_session wiring, always the hardcoded literal default.",
  },
  {
    file: 'docker-sdk-session.js',
    match: 'this._cpuLimit',
    reason: "opts.cpuLimit || '2' — never populated by the live create_session wiring, always the hardcoded literal default.",
  },
  {
    file: 'docker-sdk-session.js',
    match: '${this.cwd || process.cwd()}:/workspace',
    reason: 'this.cwd is gated by validateCwdAllowed(), which must statSync+realpathSync it to an existing real directory before this is ever reached; fixed value-slot after -v, not free text.',
  },
  {
    file: 'docker-sdk-session.js',
    match: 'this._image',
    reason: "opts.image || 'node:22-slim' — never populated by the live create_session wiring, always the hardcoded literal default.",
  },
  {
    file: 'docker-sdk-session.js',
    match: 'setupCmd',
    reason: 'interpolates only this._containerUser, regex-gated at construction by VALID_USERNAME_RE (^[a-z_][a-z0-9_-]{0,31}$) — cannot start with "-" or carry shell metacharacters.',
  },
  {
    file: 'docker-sdk-session.js',
    match: 'containerId',
    reason: 'local var captured from this._containerId before nulling in destroy(); same chroxy/docker-generated origin as above.',
  },
  {
    file: 'docker-session.js',
    match: 'this._memoryLimit',
    reason: "opts.memoryLimit || '2g' — never populated by the live create_session wiring, always the hardcoded literal default.",
  },
  {
    file: 'docker-session.js',
    match: 'this._cpuLimit',
    reason: "opts.cpuLimit || '2' — never populated by the live create_session wiring, always the hardcoded literal default.",
  },
  {
    file: 'docker-session.js',
    match: '${this.cwd || process.cwd()}:/workspace',
    reason: 'same reasoning as docker-sdk-session.js: this.cwd is gated by validateCwdAllowed() to an existing real directory before reaching here.',
  },
  {
    file: 'docker-session.js',
    match: 'this._image',
    reason: "opts.image || 'node:22-slim' — never populated by the live create_session wiring, always the hardcoded literal default.",
  },
  {
    file: 'docker-session.js',
    match: "spawn('docker', dockerArgs",
    reason: "dockerArgs is this._containerId (see above, safe) plus the literal 'claude' plus ...buildClaudeCliArgs() — the same delegated, separately-audited builder as cli-session.js.",
  },
  {
    file: 'docker-session.js',
    match: 'containerId',
    reason: "local var in destroy(); this file's own constructor never accepts an external containerId at all (self-owned --rm container, per its own docstring).",
  },

  // ── doctor.js ──
  {
    file: 'doctor.js',
    match: 'execFileSync(s.command, s.args',
    reason: "checkClaudeTuiCliVersion's default exec seam always receives the literal ['--version'] from its one call site; prepareSpawn only rewraps for a Windows .cmd shim. CLI-only (chroxy doctor).",
  },
  {
    file: 'doctor.js',
    match: 'execFileSync(spawnSpec.command, spawnSpec.args',
    reason: "checkBinary's args are either the literal ['--version'] or a provider's static preflight.args declared in source (providers/*.js), never runtime/client data. CLI-only (chroxy doctor).",
  },

  // ── keychain.js ──
  // service/account/script are always fixed internal constants across every
  // real caller in this repo (DEFAULT_SERVICE='chroxy', ACCOUNT='api-token',
  // IDENTITY_KEY_SERVICE, CRED_KEY_SERVICE, DISCORD_WEBHOOK_KEYCHAIN_SERVICE,
  // PS_PROTECT/PS_UNPROTECT) — never client-set text. This is a whole-program
  // fact this per-file lint cannot see (keychain.js only sees its own
  // parameters), hence the catalogue rather than a structural guard.
  {
    file: 'keychain.js',
    match: 'service',
    reason: 'every real caller across the repo passes a fixed internal string constant (default "chroxy", or IDENTITY_KEY_SERVICE / CRED_KEY_SERVICE / DISCORD_WEBHOOK_KEYCHAIN_SERVICE) — never client-supplied text.',
  },
  {
    file: 'keychain.js',
    match: 'account',
    reason: 'every real caller passes a fixed internal string constant (default ACCOUNT="api-token", or DISCORD_WEBHOOK_KEYCHAIN_ACCOUNT) — never client-supplied text.',
  },
  {
    file: 'keychain.js',
    match: 'token',
    reason: "the secret value being stored, always generated server-side or set via local CLI init; also sits as -w's required argument (macOS security add-generic-password), consumed unconditionally regardless of content.",
  },
  {
    file: 'keychain.js',
    match: 'script',
    reason: '_dpapi(script, input) is only ever called with PS_PROTECT / PS_UNPROTECT, two hardcoded module-level PowerShell source constants; the actual secret goes over stdin, never argv.',
  },

  // ── platform.js ──
  {
    file: 'platform.js',
    match: 'filePath',
    reason: 'every caller builds filePath via configPath()/homedir()-rooted absolute paths, so it always starts with "/" (or a drive letter on Windows) and can never be read as a flag.',
  },
  {
    file: 'platform.js',
    match: '*${sid}:F',
    reason: "sid is the Windows account SID from currentUserSid(), regex-matched to /S-1-[0-9-]+/ against `whoami /user` output; the argv element also carries a literal '*' prefix.",
  },
  {
    file: 'platform.js',
    match: 'String(pid)',
    reason: 'pid is always a real OS process id (child.pid from Node child_process/pty), never client-supplied text; a Node pid is always a positive integer.',
  },

  // ── service.js ──
  {
    file: 'service.js',
    match: 'gui/${process.getuid()}',
    reason: 'process.getuid() is the Node builtin returning the current OS user numeric uid — always a non-negative integer; the template also carries a fixed literal "gui/" prefix.',
  },
  {
    file: 'service.js',
    match: 'servicePath',
    reason: "join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`) with SERVICE_LABEL a hardcoded constant — always an internally-computed absolute path, never client input.",
  },
  // Review #7929 — the five entries below cover `installWindowsService`,
  // `getWindowsTaskStatus`, `uninstallService`, `startService`,
  // `bootstrapLaunchd` and `stopService`, all of which build their `exec`
  // call through `const exec = options._exec || execFileSync` (a
  // test-injection seam whose fallback default was invisible to the lint
  // before #7929's local-alias tracking fix — see collectImports in
  // lint-argv-sinks.mjs). Every one of these functions is reachable ONLY from
  // `chroxy service install/uninstall/start/stop/status` (cli/service-cmd.js)
  // — no WS/client handler calls into service.js at all (grepped at audit
  // time) — and every real call site there invokes them with NO options
  // object, so `options._exec`/`options._taskName`/`options._wrapperPath`
  // are always undefined in production.
  {
    file: 'service.js',
    match: 'taskName',
    reason: "taskName = options._taskName || WINDOWS_TASK_NAME ('Chroxy', a hardcoded module constant); options._taskName is a test-only seam never set by the one real caller (cli/service-cmd.js, always called with zero args). state.taskName (the uninstallService darwin/win32 branch) is read back from service.json, which is written only by installWindowsService using this same taskName — so it round-trips the same constant. CLI-only, no WS path.",
  },
  {
    file: 'service.js',
    match: 'wrapperPath',
    reason: "wrapperPath = config._wrapperPath || join(stateDir, WINDOWS_WRAPPER_NAME) — an internally-computed absolute path (join() always returns one) or a test-only override; used as schtasks' /TR value, quoted. CLI-only (chroxy service install).",
  },
  {
    file: 'service.js',
    match: 'domain',
    reason: "domain = `gui/${process.getuid()}` — process.getuid() is the Node builtin returning the current OS user's numeric uid (always a non-negative integer), with a fixed literal 'gui/' prefix; can never start with '-'. Passed bare into `${domain}/${SERVICE_LABEL}` and as a positional to `launchctl bootstrap`. CLI-only (chroxy service start/stop).",
  },
  {
    file: 'service.js',
    match: 'plistPath',
    reason: 'plistPath is either state.servicePath (written by installWindowsService/installService as an internally-computed absolute path, never client text) or paths.plistPath (a server-computed default from getServicePaths()) — both existsSync-checked absolute paths before this point. CLI-only (chroxy service start).',
  },

  // ── session-context.js ──
  {
    file: 'session-context.js',
    match: "execFile(GIT, args",
    reason: "gitCommand(cwd, args)'s only 3 call sites in this file pass fully literal arrays (['rev-parse','--abbrev-ref','HEAD'], ['status','--porcelain'], ['rev-list','--count','@{upstream}..HEAD']) — args is unresolved only at this local helper's own scope.",
  },

  // ── session-manager.js ──
  {
    file: 'session-manager.js',
    match: 'baseCwd',
    reason: "baseCwd is always the required argument to git's -C flag, consumed unconditionally regardless of content (argv-safety.js case 3's two-token form); the value itself is client cwd already gated by validateCwdAllowed() to an existing real directory.",
  },
  {
    file: 'session-manager.js',
    match: 'worktreeDir',
    reason: 'join(this._worktreeBase || defaultWorktreeBase(), sessionId) — a server-config-rooted absolute path with a hex sessionId (randomBytes or restore-validated /^[a-f0-9]{32}$/); no WS field controls it directly.',
  },
  {
    file: 'session-manager.js',
    match: 'repoDir',
    reason: "repoDir is always the required argument to git's -C flag (same reasoning as baseCwd above); traces to the same server-computed baseCwd or restore-validated path.",
  },
  {
    file: 'session-manager.js',
    match: 'worktreePath',
    reason: 'set at creation to the server-computed worktreeDir (see above) or, on restore, to a saved path that is exact-matched against the deterministic expected worktreeBase/sessionId path before being accepted — never wired to a live WS field.',
  },

  // ── supervisor.js ──
  {
    file: 'supervisor.js',
    match: '${tag}^{commit}',
    reason: "tag is drawn from `git tag --list 'known-good-*'` output, glob-filtered by git itself to always start with the literal 'known-good-' — not attacker text, and structurally cannot start with '-'.",
  },
  {
    file: 'supervisor.js',
    match: 'fork(script, args, opts)',
    reason: "_fork(script, args, opts) is a documented override point ('Override point: fork a child process') for test injection — script/args are opaque PARAMETERS forwarded straight through, which per-file static analysis cannot resolve to the one real caller. That caller (_startChild) always passes childScript (a fixed internal path built from import.meta.url, never variable) and a literal [] for args — never attacker content. #7929 added `fork` to the lint's SPAWN_APIS roster; this entry is new because of that, not because the code changed.",
  },

  // ── tunnel/cloudflare.js ──
  {
    file: 'tunnel/cloudflare.js',
    match: 'spawn(bin, argv, spawnOpts)',
    reason: "the two real callers build argv from operator config only: this.tunnelName (config.tunnelName, set via `chroxy tunnel setup`, --terminated) and this.port (a server-config number embedded in a fixed 'http://localhost:' prefix); no WS handler touches either.",
  },

  // ── user-shell-registry.js ──
  {
    file: 'user-shell-registry.js',
    match: 'String(pid)',
    reason: 'pid originates from node-pty’s real OS pid (this._term.pid) and is additionally gated by Number.isInteger(pid) && pid > 0 on both the write and read paths before reaching here.',
  },

  // ── utils/resolve-binary.js ──
  {
    file: 'utils/resolve-binary.js',
    match: 'name',
    reason: "every caller passes one of a small fixed set of internal binary names baked into source ('git','claude','gemini','codex','cloudflared', or a provider's static preflight.binary.name) — never external/client input.",
  },

  // ── web-task-manager.js ──
  {
    file: 'web-task-manager.js',
    match: 'execFile(cmd, args, { timeout: 15_000',
    reason: "this generic exec wrapper's one caller passes ['--teleport', task.taskId], where task.taskId is a server-generated randomUUID() looked up from the task map — the client's raw taskId is used only as a Map key, never as the argv value itself. A separate, already-hardened call site handles the client prompt text via buildRemoteTaskArgs()'s -- terminator (#7291).",
  },

  // ── worktree-gc.js ──
  // planRepoGc/sweepOrphanChroxyWorktrees/applyPlan run automatically at
  // daemon boot and (opt-in) on a timer, not only from a human CLI
  // invocation — but every argv element traces to local git-reported paths,
  // server config, or a strictly hex-regex-constrained session id, never
  // WS-client-supplied text.
  {
    file: 'worktree-gc.js',
    match: "execFileSync(GIT, ['-C', cwd, ...args]",
    reason: 'cwd is always an absolute repo/worktree path from server config or resolveRepoSet discovery; the only variable positionals pushed through args are absolute paths reported by `git worktree list --porcelain` itself, or a --reason-bound lockReason value — never remote/WS-supplied text.',
  },
]

/**
 * How does a CLI's `--help` say `flag` is called — specifically, does it take
 * a REQUIRED argument?
 *
 * This decides whether fix shape (2), the `--` separator, is safe, and the
 * distinction is not cosmetic. Measured against the repo's commander 12.1.0
 * with a client prompt of `--dangerously-skip-permissions`:
 *
 *     declared as       ['--remote', prompt]   ['--remote', '--', prompt]
 *     --remote          INJECTS                safe
 *     --remote [name]   INJECTS                safe
 *     --remote <name>   safe — swallowed as    INJECTS — the `--` becomes the
 *                       the flag's own value   flag's value, freeing the
 *                                              prompt to be option-parsed
 *
 * So against a required-argument flag the separator is not merely useless, it
 * is strictly WORSE than omitting it. No single argv shape is correct under
 * both arities, so a caller must know which it faces and fail closed when it
 * cannot tell.
 *
 * @param {unknown} helpText - captured stdout of `<cli> --help`.
 * @param {string} flag - the exact flag, e.g. '--remote'.
 * @returns {'absent'|'boolean'|'optional'|'required'}
 */
export function cliHelpFlagArity(helpText, flag) {
  if (!cliHelpAdvertisesFlag(helpText, flag)) return 'absent'
  // Inspect what follows the flag on its own help line, skipping any alias
  // list (`--remote, -r <name>`).
  const re = new RegExp(`(?<![\\w-])${escapeForRegExp(flag)}(?![\\w-])((?:,\\s*-[\\w-]+)*)([^\\n]*)`)
  const m = re.exec(helpText)
  if (!m) return 'boolean'
  // Only a metavar BEFORE the description column counts. Two spaces or a tab
  // start the description in every help format we target, so a `<file>` in
  // prose ("same as --output <file>") is not mistaken for this flag's own.
  const head = m[2].split(/ {2,}|\t/)[0]
  if (/^[ =]*<[^>]+>/.test(head)) return 'required'
  if (/^[ =]*\[[^\]]+\]/.test(head)) return 'optional'
  return 'boolean'
}
