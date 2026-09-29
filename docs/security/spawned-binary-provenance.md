# Spawned-Binary Provenance & Integrity

How Chroxy verifies the external binaries it executes as providers, what that
verification does — and does **not** — protect against, and where the deeper
hardening line sits. P1 (detect & surface, #6708) is implemented in
`packages/server/src/utils/verify-binary.js`, wired into `utils/preflight.js`, the
subprocess spawn path, and `chroxy doctor`. P2 (opt-in provenance: a SHA-256 pin
ledger + a macOS signature gate, #6858) is in `utils/verify-provenance.js` +
`binary-provenance-trust.js`, wired into the same preflight and the `cloudflared`
spawn — see §4.

This is distinct from the [credentials-at-rest model](./credentials-at-rest.md)
and the [transport-layer model](./encryption-threat-model.md). Those protect
data. This document is about the **code Chroxy runs**: the daemon execs
`claude`, `codex`, `gemini`, and `cloudflared` as child processes, and until
#6708 it did so with no integrity, provenance, or quarantine check of any kind.

## 1. The gap this closes

Chroxy resolves a provider binary by PATH lookup (`which`/`where`) with a
hardcoded candidate-path fallback (`utils/resolve-binary.js`), then spawns
whatever resolves first. Two concrete failure modes motivated this work:

- **Quarantined-but-present binary.** On macOS a Gatekeeper-quarantined binary
  keeps its execute bit. The old preflight checked only `existsSync` +
  `access(X_OK)`, so it green-lit the binary and the failure surfaced *later* as
  an opaque mid-turn spawn error the operator couldn't diagnose, and
  `chroxy doctor` mislabeled it "Not found — install …".
- **Stale module-load path.** Each provider cached its resolved binary path in a
  module-level `const` frozen at import. A binary quarantined, moved, or removed
  *after* daemon start was still spawned from the stale path — and, because
  preflight re-resolved independently, the existence gate and the actual spawn
  could even resolve *different* paths.

The triggering incident: macOS **XProtect Remediator** removed the OpenAI Codex
native binary out from under a running daemon during a background scan. (That
specific verdict is a probable XProtect false positive; the daemon-executes-
unverified-binaries gap it exposed is real regardless.)

## 2. What Chroxy checks now (P1 — detect & surface)

`verifyBinary(resolvedPath)` classifies a resolved path into one of four states:

| Status | Meaning | Where surfaced |
| --- | --- | --- |
| `ok` | absolute, exists, executable, not Gatekeeper-blocked | proceeds to spawn |
| `not_found` | not absolute (bare-name resolver fallback) or missing on disk | `ProviderBinaryNotFoundError` / doctor `fail` |
| `not_executable` | present but no `X` bit for this process | `ProviderBinaryNotFoundError` / doctor `fail` |
| `quarantined` | macOS: present + executable but carries a **blocking** `com.apple.quarantine` xattr | `ProviderBinaryQuarantinedError` / doctor `fail` |

- **Preflight gate (per session-create; per turn for `claude-sdk`, `gemini`, and
  `codex exec`, §5).** At create, `runProviderPreflight` resolves the
  binary fresh and prefers the provider's live `resolvedBinary` — the exact path
  the spawn will use — so the existence gate and the spawn can no longer diverge.
  The per-turn re-check does not re-resolve: it verifies the path pinned at
  create (§5).
  A quarantined binary throws `ProviderBinaryQuarantinedError`
  (`code: PROVIDER_BINARY_QUARANTINED`), which `createSession` propagates and the
  WS layer surfaces as a `session_error` with that code (see
  [error-taxonomy.md](../error-taxonomy.md)).
- **Fresh re-resolution (no stale const).** The `resolvedBinary` accessors for
  `codex`, `gemini`, `claude-cli`, `claude-tui`, and (since #7986) `claude-sdk`
  re-resolve on every access instead of returning a frozen import-time
  `const`, so a binary that changed after boot is spawned from its current
  path.
- **Spawn-time backstop.** If a spawn still fails after preflight passed (the
  binary changed between create and turn), the catch re-verifies the attempted
  path and labels the error (quarantine vs vanished) instead of an opaque
  `ENOENT` / generic SDK text. The provider spawn sites share this via
  `labelBinarySpawnFailure`: the subprocess providers (`cli-session.js`,
  `jsonl-subprocess-session.js`, `claude-tui-session.js`,
  `codex-app-server-session.js`) on a real `child_process`/PTY spawn error, and
  (since #8030) `claude-sdk`'s in-process `SdkSession` on a pre-first-message
  turn failure, since it has no child process of its own to catch an `error`
  event from. A backstop labels a spawn that FAILS; it does not stop one that
  succeeds.
  `acp-session.js` (#8035) gets a narrower version: the configured `command`
  is operator-chosen, not a binary Chroxy resolves itself, so it is
  labeled ONLY when `command` is an absolute path — `verifyBinary` reports any
  non-absolute path as `not_found` regardless of the real cause (e.g. Node's
  own `ENOENT` for a missing `cwd`), so labeling a bare PATH-resolved command
  would misdiagnose it; a bare command's spawn failure keeps its raw text.
  An absolute command is labeled only when it is quarantined or not
  executable. A missing one keeps Node's raw `spawn <path> ENOENT`, which names
  the configured path; the generic "not found — install it" label would not.
- **Per-turn re-verification (#8035).** Preflight alone only covers session-
  create. `gemini` and `codex exec` spawn a fresh child EVERY turn
  (`jsonl-subprocess-session.js`'s `sendMessage`, the same shape `claude-sdk`
  has had since #8030) — before #8035 that per-turn spawn read a fresh,
  unverified `Klass.resolvedBinary` every time, so a create-time gate could
  pass and every subsequent turn would still run whatever the binary
  currently resolves to, gate or no gate. `_gatedSpawnBinary` (`base-session.js`)
  closes that: with a `spawnPreflight` wired (see §5), it re-runs the full
  gate against the create-time-pinned path before every spawn, exactly like
  `claude-sdk`'s per-turn re-verification; a refusal here (`PROVIDER_BINARY_PROVENANCE`,
  `PROVIDER_BINARY_QUARANTINED`, `PROVIDER_BINARY_UNVERIFIED`, …) leaves the
  session idle rather than spawning — see `_refuseTurnBeforeDispatch`.
- **`chroxy doctor`.** The provider-binary and `cloudflared` health checks report
  a quarantined binary distinctly from a missing one, with a copy-pasteable fix:
  `xattr -d com.apple.quarantine <path>` (after verifying provenance) or
  re-download.

### The quarantine flag nuance (no false positives)

The `com.apple.quarantine` xattr value is `flags;timestamp;agent;uuid`. Bit
`0x0040` (`QTN_FLAG_ASSESSMENT_OK`) is set once Gatekeeper has assessed the file
or the user approved it — such a binary launches normally. Chroxy treats a
quarantine xattr as **blocking only when that bit is clear**, so an approved
binary that still carries the xattr is not flagged. Package-manager installs
(Homebrew, `npm -g`) strip the xattr entirely and are never flagged. An
unparseable flags field is treated conservatively as blocking (a labeled,
fixable error beats a silent exec failure).

### Cross-platform behavior

The xattr probe is macOS-only. On Linux and Windows `verifyBinary` performs
exactly the existence + executable check it always did and skips the
mac-specific step cleanly — there is no equivalent Gatekeeper block to detect.

## 3. Threat model — what this does and does NOT protect against

**Protects against (P1):**
- A Gatekeeper-quarantined provider binary being spawned, then failing opaquely.
- A since-moved/removed binary being spawned from a stale cached path.
- An operator being unable to tell "quarantined/blocked" from "not installed".

**Does NOT protect against in P1 (addressed by the opt-in P2 gate, §4):**
- **Supply-chain compromise / PATH planting.** With P1 alone the daemon still
  executes whatever binary resolves first on `PATH`. A malicious binary planted
  earlier in `PATH`, or an in-place swap of a resolved binary, is spawned
  automatically. Quarantine detection is orthogonal to provenance — a planted
  binary carries no quarantine xattr. The **opt-in SHA-256 pin ledger** (§4) closes
  the in-place-swap case: a changed hash on a previously-seen path re-gates the
  binary. (A brand-new path planted earlier on `PATH` is pinned on first sight
  under trust-on-first-use, so the ledger catches *changes*, not a first-run
  plant — pair it with a controlled `PATH` for defence in depth.)
- **Signature / notarization enforcement.** P1 deliberately does **not** gate on
  `codesign --verify` / `spctl --assess`, because chroxy's bundled provider
  binaries are ad-hoc/linker-signed and `spctl` rejects them, so a hard spctl gate
  would break every un-notarized provider. §4 adds this as an **opt-in** gate for
  operators who run only notarized provider builds.

## 4. P2 — opt-in provenance verification (implemented, #6858)

The residual supply-chain surface grows materially once the orchestration epic
(#6691) auto-spawns worker sessions headless with the operator's credentials —
"the daemon runs whatever is on PATH" stops being a foreground, operator-visible
action. P2 adds two **opt-in, OFF-by-default** gates, so P1 behaviour is
byte-identical unless an operator explicitly turns one on. Implemented in
`utils/verify-provenance.js` + `binary-provenance-trust.js`, wired into
`utils/preflight.js` (provider spawn) and `tunnel/cloudflare.js` (cloudflared
spawn).

### Cross-platform SHA-256 pin ledger

`binary-provenance-trust.js` (`BinaryProvenanceLedger`) is a thin subclass of the
same `PathHashTrustLedger` that backs `skills-trust.js` / `session-preset-trust.js`
— a `path → { sha256, firstSeen, approvedAt }` map, fail-open on a corrupt/missing
file, atomic `0600` writes. Default file: `~/.chroxy/binary-trust.json` (next to
the other trust ledgers), under a `binaries` wrapper key.

- **First sight → pin + allow** (trust-on-first-use).
- **Matching hash → allow.**
- **Changed hash → re-gate.** `warn` mode logs the change and still spawns;
  `block` mode **refuses the spawn** until the operator re-approves. This catches
  an in-place binary swap regardless of code signature or quarantine state, and
  works on every platform (it is pure content hashing).

This is folded across **every spawned binary** — the provider binaries (`claude`,
`codex`, `gemini`) via preflight, and `cloudflared` via the tunnel gate — sharing
one ledger instance so pins are unified.

### macOS signature gate

When enabled, a binary that fails `spctl --assess --type execute` (Gatekeeper /
notarization) is **hard-blocked** before spawn. This is for operators who run only
notarized provider builds; chroxy's own bundled providers are ad-hoc/linker-signed
and `spctl` rejects them, which is exactly why it can only ever be opt-in. `spctl`
is invoked by its absolute SIP-protected path (`/usr/sbin/spctl`), never a PATH
lookup, so a shadowed `spctl` can't subvert the gate (same hardening as the P1
`/usr/bin/xattr` probe). The gate is **macOS-only**: `assessMacSignature()` checks
`process.platform` and returns `{ ok: true, skipped: true }` immediately on any
other platform, performing no check at all — there is no Linux or Windows
equivalent wired up yet, regardless of the `signatureGate` config value. On those
platforms `binaryProvenance` is **hash-pin-only**: the SHA-256 ledger is the entire
provenance story, with no code-signature / notarization backstop. Windows
Authenticode signature gating is tracked in #6932.

### Fail-safe semantics

When a gate is ON, a verification failure blocks (`block` mode / signature gate) or
loudly surfaces (`warn` mode) — it **never silently spawns an unverified binary**
at the point where the gate runs. For providers that spawn more than once per
session, that is only as strong as how often the gate runs: `claude-sdk`,
`gemini`, and `codex exec` all now re-run it before every turn (§5, #8035), and
`claude-cli`, `claude-tui` and `codex` app-server now re-run it before every
(re)spawn too (§5, #8038). Before #8035/#8038 only `claude-sdk` and the
`claude-tui` explicit native auth route did; every other provider verified its
binary only at create. A refusal on a respawn is NOT treated as the process
dying: nothing is spawned, no further backoff is armed, and the session sits
idle until the next spawn request re-runs the gate (see "Per-spawn refusal
semantics" after the §5 table). The
`codex` model-catalog probe closed the same gap (#8036): its no-session spawn
now runs through `SessionManager.verifyOneShotExecutable()`, the SAME verified
one-shot resolver #8030 wired for the summarizer and semantic-title generator,
generalized to take an explicit provider class. Web tasks closed the same gap
a second time (#8039): `web-task-manager.js` ran a bare `claude`, resolved by
the OS's own PATH lookup, at THREE no-session spawn sites — feature detection
(`detectFeatures`, called once at daemon start with no session or user action
involved), every `launch_web_task` (`_spawnRemoteTask`), and every teleport
(`teleportTask`) — none of them gated at all. All three now call
`verifyOneShotExecutable(CliSession)` fresh on every invocation (this class
has no create-time session to pin a path from, same as the codex probe); a
refusal degrades `detectFeatures` to "unavailable" (logged at `warn` naming
the refusal's code) and fails a launch or teleport with the gate's coded
error, surfaced through the same `task_error`/`web_task_error` paths those
operations already use for any other spawn failure — nothing is spawned in
either case. `CliSession` (`claude-cli`), not `claude-sdk`, because web tasks
always shell out to the `claude` CLI binary via `execFile`, never the
in-process Agent SDK, regardless of which provider the daemon's chat sessions
currently use. `chroxy resume` closed the same class of gap a third
time (#8061): the CLI subcommand (`cli/session-cmd.js`) ran a bare
`execFileSync('claude', ['--resume', convId, …])`, resolved by the OS's own
PATH lookup, with no existence, quarantine, or provenance check of any kind —
unlike the daemon spawns above, this is a foreground, user-invoked command
with no `SessionManager` instance to reuse, so `resolveVerifiedClaudeBinary()`
builds the provenance options bag straight from a loaded config file
(`resolveBinaryProvenanceMode` / `isBinarySignatureGateEnabled`, the same
resolvers `chroxy start` uses) through the SAME normalizer
`SessionManager._binaryProvenanceOptions()` uses
(`buildBinaryProvenanceOptions`, factored out to `utils/preflight.js` so the
two never define "the gate is off" two different ways). That config file
defaults to `chroxy resume`'s own `<configDir>/config.json` but honors `-c
<path>` (#8065 review S4), so a daemon started with `chroxy start -c <path>`
is gated from the same file it reads its own settings from — though
`CHROXY_BINARY_PROVENANCE` / `CHROXY_BINARY_SIGNATURE_GATE` still come from
THIS invocation's own environment, not a running daemon's, since a foreground
command has no way to read another process's env. An existing config file
that can't be read or parsed refuses outright rather than silently defaulting
to gates-off (#8065 review S3) — a hand-edited config.json with a trailing
comma no longer leaves `chroxy resume` ungated while `chroxy start` refuses
to boot on the identical file. The ledger opens at its default path (the
daemon's own `binary-trust.json`) only when a gate is actually on, not on
every invocation regardless (#8065 review nitpick 3 — this command runs and
exits per invocation, unlike the daemon's one long-lived ledger instance).
`runProviderPreflight(CliSession, { provenance })` then runs — `CliSession`,
not `claude-sdk`, for the same reason web tasks gate against it: `chroxy
resume` always execs the `claude` CLI directly. A refusal prints the gate
error's message and exits non-zero with nothing spawned; the binary actually
executed is the verified absolute path preflight resolved, never the bare
string `'claude'`. With gates off, the SPAWN OUTCOME for a healthy binary is
unchanged — but the command now also runs the existence/quarantine check
every other one-shot gate in this fleet runs regardless of `binaryProvenance`
mode, so a missing or quarantined `claude` now refuses with a labeled error
instead of throwing a raw `ENOENT`/`EACCES`. `chroxy start`'s dependency
checks closed the same class of gap a fourth time (#8041): `runDoctorChecks()`
(`doctor.js`) runs BEFORE any session or tunnel exists — the desktop app and
every service-manager restart hit it on every launch, unless `--skip-checks`
— and it ran the configured provider's binary (plus `claude` for
`claude-tui`) and `cloudflared` with a bare `--version` probe, with no
provenance or signature gate of its own: in `binaryProvenance.mode: 'block'`,
a binary whose pinned hash no longer matched the ledger still executed here
unchecked, even though the exact same binary would refuse a real chat session
or tunnel start. `checkBinary()` (the shared helper both the provider-binary
and `cloudflared` rows call) and `checkClaudeTuiCliVersion()` now run the
opt-in gate on the resolved path BEFORE the version-probe exec, reusing
`verifyProvenance` — the SAME function `runProviderPreflight` and the tunnel
adapter's `_verifyCloudflaredProvenance` both call, not a third
implementation. `runDoctorChecks()` resolves the mode/signatureGate once, from
config + env through `resolveBinaryProvenanceMode` / `isBinarySignatureGateEnabled`
(the same resolvers `chroxy start` / `chroxy resume` use) normalized through
the SAME `buildBinaryProvenanceOptions` helper #8065 added
(`utils/preflight.js`), and shares one lazily-constructed `binary-trust.json`
ledger (opened only when a gate is actually on, matching #8065 review nitpick
3's rationale) across every check — the provider binary, `cloudflared`, and
the `claude-tui` version-pin probe. A `block`-mode hash mismatch or a failed
signature gate now reports a `fail` doctor row naming the gate's status code
and remediation, and the binary is NEVER exec'd; `chroxy start` treats that
`fail` exactly like any other failed dependency check (a non-zero exit,
unless `--skip-checks`); a `warn`-mode issue reports a `warn` row (not only a
log line) carrying the same status. With gates off, behaviour is unchanged.
The gate runs ONLY on a path the #6708 health check confirmed healthy — never
on a not-found bare name, which would otherwise hash relative to the current
working directory and could mislabel a missing binary as a provenance
failure, or TOFU-pin an unrelated same-named file under that bare, relative
key; `checkClaudeTuiCliVersion()` shares this precondition, but only runs its
own health check when a gate is actually on, matching its pre-#8041 shape
when it's off. A blocked claude-tui-driving probe returns `null` rather than
a second `fail` row — the SAME `claude` binary's own provider-preflight row
already reports the identical refusal. `chroxy start -c <path>` gates from
THAT file's `binaryProvenance`, the same way the `chroxy resume` row above
honors its own `-c`; env vars still win over either file. `chroxy tunnel
setup` closed the same class of gap a fifth time (#8066): the interactive CLI
subcommand (`cli/tunnel-cmd.js`) ran a bare `CloudflareTunnelAdapter.checkBinary()`
— an unconditional, ungated `execFileSync('cloudflared', ['--version'])` that
executed BEFORE any prompt — and then three more bare `execFileSync('cloudflared',
…)` calls (`tunnel login`, `tunnel create`, `tunnel route dns`), all resolved by
the OS's own PATH lookup with no existence, quarantine, or provenance check of
any kind. Like `chroxy resume`, this is a foreground, user-invoked command with
no `SessionManager` to reuse, so `resolveVerifiedCloudflaredBinary()`
(`cli/tunnel-cmd.js`) builds the SAME provenance options bag from a loaded config
file through the SAME `buildBinaryProvenanceOptions` normalizer, then runs
`runProviderPreflight(ProviderClass, { provenance })` — reusing the identical
gate `chroxy resume` and the daemon's tunnel adapter both run, against a minimal
`preflight`-shaped stand-in for `cloudflared` (there is no session Provider for
a network tunnel binary) whose `binary.candidates` are `CLOUDFLARED_CANDIDATES`,
imported from `tunnel/cloudflare.js` rather than a second copy. The pre-#8066
"is it available" check ran an unconditional `--version` exec; `verifyBinary`'s
existence/quarantine check inside `runProviderPreflight` answers that question
with a `stat`, so the probe is gone entirely rather than merely moved after the
gate — every one of the THREE remaining execs (`login` / `create` / `route dns`)
now runs the verified absolute path, never the bare string `'cloudflared'`. That
config file defaults to `chroxy tunnel setup`'s own `<configDir>/config.json`
but honors a new `-c, --config <path>` option, mirroring `chroxy resume -c` and
`chroxy start -c`. A refusal prints the gate error's message and exits non-zero
with nothing spawned — the missing-binary case is reported as the
ordinary "not found" error (`ProviderBinaryNotFoundError`, never mislabeled as a
provenance failure, and — on POSIX — nothing in the current working directory
is ever hashed for a binary the #6708 health check couldn't confirm exists;
Windows's `where` searches cwd first, so this cwd-safety property does not
hold there, same as every other `resolveBinary` caller — see #8077). With gates
off, the observable spawn outcome for a healthy binary is unchanged. The §5
table lists what each provider verifies and when.
A binary that can't even be hashed is treated as unverifiable: blocked in `block`
mode, surfaced-but-allowed in `warn` mode. A `block`-mode failure throws
`ProviderBinaryProvenanceError` (`code: PROVIDER_BINARY_PROVENANCE`) from preflight,
or `TunnelBinaryProvenanceError` (`code: TUNNEL_BINARY_PROVENANCE`) from the tunnel.

### Known limitations

Most of what follows is inherent to how this design is built, not a gap left
to close — those are called out as such below. One bullet is a real, tracked
gap (#8080) that is merely *deferred*, not accepted: it stays here because it
is the same "the ledger's cross-process behavior has a window" family as
everything else on this list, and a reviewer should find it in the same
place. They're named here so they're legible to a reviewer rather than
discovered by one.

- **check→exec is not atomic (TOCTOU).** `verifyProvenance()` hashes the bytes at
  a resolved *path* (`sha256File`); the spawn that follows execs that same path a
  moment later. Those are two separate filesystem operations with an
  application-visible gap between them — Node has no `fexecve` (no way to hash an
  already-open file descriptor and then exec that exact descriptor), so there is
  no way to make "the bytes I hashed" and "the bytes that run" the same syscall.
  An attacker who can write to the resolved binary path in that window can swap in
  a different binary than the one verified. #6937 closed the *wider* version of
  this gap for `cloudflared` — `_verifyCloudflaredProvenance()` now pins the exact
  absolute path it verified (`this._resolvedCloudflaredPath` in
  `tunnel/cloudflare.js`) and `_spawnCloudflared()` execs that pinned path instead
  of re-resolving the bare `cloudflared` name off `PATH`, matching the provider
  preflight path's existing `resolvedBinary` invariant (verify-path ==
  spawn-path). That removes the *independent-double-resolution* race (verify one
  path, spawn a different one) but does not — cannot — remove the fundamental
  check-then-exec race on a single path. This is the same limitation class as the
  protected-path floor's check-time-realpath TOCTOU (#6922). The gate still raises
  the bar materially: instead of a one-time silent plant, an attacker now has to
  win a race against a live spawn. It is not, and cannot be with these OS
  primitives, an atomic guarantee — accepted and documented rather than treated as
  an open defect.
- **A flush's re-read-then-rename is not itself atomic (deferred, #8080).**
  `PathHashTrustLedger.flush()` re-reads the file, merges in only the keys
  this instance changed, then writes via temp-file-plus-`rename` (#8068).
  Those two steps are not one atomic operation: two processes can both
  re-read the same pre-flush file, each merge their own change on top, and
  then race the `rename` — the second rename wins outright, and the LOSING
  process's own changed keys are what's lost (not the winner's — both
  racers read the same pre-flush bytes, so neither one's merge actually saw
  the other's write). This is strictly narrower than the bug #8073 fixed
  elsewhere in this document — it needs two flushes landing inside the same
  read-to-rename window, not merely two flushes ever — and there is no
  file-lock helper anywhere in this codebase (`src/utils`) to close it with.
  Documented in `flush()`'s own docstring rather than solved; closing it
  would need an `O_EXCL` lockfile with stale-lock recovery, tracked as
  #8080.
- **The trust ledger is TOFU, and the ledger file itself is the trust root.** A
  path's *first* sight pins its hash automatically (`ledger.approve(path, hash)`
  inside `verifyProvenance`) with no operator gate on that initial pin —
  trust-on-first-use, not trust-on-verification. "First sight" is decided from
  the CURRENT disk state on a MISS, not a snapshot frozen at construction —
  a **hit** is still decided from memory alone, unchanged by any of this (see
  the note at the end of this bullet): `chroxy resume`
  and the daemon are two independent `BinaryProvenanceLedger` instances (and
  `SkillsTrustStore` mints a fresh instance per session) over the same file,
  each loading it once — before #8073, a `getRecord()` miss in one instance's
  own memory was treated as first sight even when a DIFFERENT instance had
  already pinned that exact path, letting that instance's first exec of a
  swapped binary through before its own next flush happened to self-heal it.
  `verifyProvenance()`'s first-sight check and `revoke()`'s "nothing to
  remove" check now call the ledger's `reload()` on a miss — a read-merge
  (never a write) using the same conflict rule `flush()` uses — before
  deciding there is genuinely nothing pinned; `SkillsTrustStore.inspect()`
  does the same on its own `_records` miss. The TOFU write itself is
  re-checked too: after `approve(path, hash, { firstSight: true })`,
  `verifyProvenance()` re-reads the record and reports `pinned` only when it
  still holds our hash — closing the narrow window where a genuine pin from
  another process lands between the `reload()` above and this `approve()`'s
  own internal re-read, which would otherwise let this call report `pinned`
  while the ledger ends up holding the OTHER process's pin. A read failure
  during the miss-refresh (corrupt bytes, EACCES/EIO) leaves every in-memory
  pin exactly as it was — the same fail-open-to-memory guarantee `flush()`
  already gave a failed re-read (#8072), not fail-open-to-empty — but it does
  not itself block: the first-sight decision then proceeds exactly as it did
  before #8073 and ALLOWS the spawn in every mode, `block` included, because
  a read failure tells the gate nothing about what disk actually holds.
  Treat an unreadable ledger as an operational incident to fix, not as an
  implicit block. An operator who wants a stronger baseline than "whatever was there the first time this ran" can pre-seed
  `~/.chroxy/binary-trust.json` out of band *before* first spawn — either
  hand-editing the `binaries` map with hashes computed on a known-good host/build,
  or calling `BinaryProvenanceLedger.approve(path, hash)` programmatically — so the
  first real spawn is checked against a hash the operator chose, not one the gate
  observed at an arbitrary first run. Because the ledger IS the trust root, its
  `0600` permission (`path-hash-trust-ledger.js`'s atomic write) is
  **integrity-relevant, not just confidentiality-relevant, on POSIX**: this file
  is user-writable by design (best-effort persistence, fail-open on a read-only
  `$HOME`), so anyone with write access to it can pin an attacker-chosen hash and
  have the gate wave a malicious binary through as "verified." On Windows the
  mode bits are best-effort/advisory, not an enforced ACL — `flush()` persists
  via `saveJsonState({ fsync: true })`, whose durable-write branch opens the temp
  file directly with `openSync(tmpPath, 'wx', 0o600)` rather than going through
  `writeFileRestricted` (the `icacls`-based owner-only-DACL writer used
  elsewhere, e.g. for credential storage), so on Windows the ledger's real
  protection is whatever ACL the surrounding `~/.chroxy` directory already
  inherited, not an explicitly restricted one. The ledger is only as
  trustworthy as the account that owns `~/.chroxy` — protecting that account is
  part of this gate's threat model, not an orthogonal concern. Refresh-on-miss
  only covers a MISS: a path this instance already has a record for is still
  decided from memory alone, with no re-read at all, exactly like before
  #8073. Two consequences an operator should know — the "remove this path's
  entry … and re-spawn" remediation text above does not reach an
  already-running daemon (it keeps blocking on its stale in-memory mismatch
  until restarted), and a re-seeded pin can make two processes disagree (one says
  `ok`, the other `hash_mismatch`) until each has re-read it on its own miss
  or flush. Both are pre-existing, not new here; #8081 tracks closing this
  hit-side gap.
- **`CHROXY_CONFIG_DIR` moves the ledger, and moves that argument with it.**
  `~/.chroxy` is the default root, not a fixed one (#7052 — see
  [`CONFIG.md`](../../packages/server/CONFIG.md#the-config-root-chroxy_config_dir)),
  so every path in this document resolves under `$CHROXY_CONFIG_DIR` when it is
  set. Because the paragraph above reduces the ledger's integrity to *the
  directory's* ACL, relocating the root onto anything writable by another
  principal — a shared volume, a group-writable mount, a bind-mounted container
  path — makes the pin ledger poisonable and the gate cosmetic. If you relocate,
  the new root needs the same owner-only protection `$HOME` gave it.

### Configuration

Both gates are OFF by default. Config block (mirrored by env overrides):

```jsonc
{
  "binaryProvenance": {
    "mode": "off",           // "off" (default) | "warn" | "block" — pin ledger
    "signatureGate": false   // macOS spctl gate; hard-blocks un-notarized builds
  }
}
```

- `CHROXY_BINARY_PROVENANCE` = `off` | `warn` | `block` (overrides `mode`)
- `CHROXY_BINARY_SIGNATURE_GATE` = `1` | `0` (overrides `signatureGate`)

Resolved by `resolveBinaryProvenanceMode()` / `isBinarySignatureGateEnabled()` in
`config.js` — both fail-closed (anything but an explicit opt-in value ⇒ off).

**Re-approving a legitimately changed binary** (e.g. after `npm i -g @openai/codex@latest`):
remove that path's entry from `~/.chroxy/binary-trust.json` (or delete the file —
it fails open to empty and re-pins every binary on next spawn). A programmatic
`revoke(path)` / `approve(path, hash)` API exists on the ledger for a future CLI /
dashboard surface.

## 5. The `claude-sdk` provider spawns the installed `claude` (#7986)

Before #7986, `claude-sdk` was the odd one out: its `preflight` verified an
installed `claude` binary, but the Agent SDK's `query()` — unless told
otherwise — resolved and spawned its OWN bundled platform binary
(`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`). Preflight and the
real spawn checked two different files. Chroxy no longer bundles that
platform package (removed from the desktop build), so `SdkSession` now sets
`pathToClaudeCodeExecutable` on every turn, before any subclass hook
(`_augmentQueryOptions`) runs. #7986 set it to a fresh `resolveClaudeBinary()`
— the SAME resolver `static get resolvedBinary` hands to preflight; since
#8030 it is the create-time path, re-verified per turn (below).

**This closed the "checked one file, ran another" gap, but #7986 alone was a
resolver-parity fix, not a per-turn re-verification — #8030 adds the latter.**
The Agent SDK execs a brand-new process on every chat turn (`claude-cli` and
`claude-tui` keep one child or PTY per session, respawned only on events: for
`claude-cli` a model switch, a permission-mode change, the next input after
Stop or a crash; for `claude-tui` a PTY death — those respawns are gated too,
closing #8038),
so "verified once at session-create" covered turn one only. Three spawn paths
now each get their own gate:

- **Chat turns.** `SessionManager` PINS the exact path create-time preflight
  verified (`verifiedBinary`, forwarded as `providerOpts.spawnPreflight`) and
  `SdkSession` calls it — `_verifyPinnedSpawn` — **before every `query()`**, not
  just the first. It re-runs the FULL gate (existence, quarantine, the
  direct-exec shim refusal, provenance, the version floor) against that EXACT
  path: `runProviderPreflight`'s `pinnedPath` option skips re-resolution
  entirely, so a `PATH` change mid-session can never redirect the spawn to a
  different binary, while a content change AT that path (an in-place
  `claude update`, quarantine, or removal) is still caught on the very next
  turn. A gate refusal never reaches `query()` — it fails closed with a typed
  error (`PROVIDER_BINARY_PROVENANCE`, `PROVIDER_BINARY_QUARANTINED`, …) that
  `SdkSession` surfaces verbatim (not through its error-text rewriter, whose
  `429`/`401` patterns a hex hash can match) and reports as a rejected,
  not-dispatched turn. Two more pre-dispatch refusals close the ways around
  the gate: an empty path (the SDK would fall back to its bundled binary), and
  a subclass `_augmentQueryOptions` hook that re-points
  `pathToClaudeCodeExecutable` after it was verified. The one-shot runner
  refuses an empty path the same way.
- **One-shots (the `summarize_session` handler, the semantic-title
  generator).** Neither has a session-create step to pin a path from, so each
  call runs the SAME preflight gate `createSession` runs, with a FRESH
  resolve, through `SessionManager.verifyOneShotExecutable()`.
  `summarize-session.js`'s `defaultRunOneShot` no longer defaults
  `resolveExecutable` to a bare, unverified `resolveClaudeBinary()` call — the
  parameter is required, and every caller must supply a verified resolver.
  `handlers/summarize-handlers.js` wires `verifyOneShotExecutable`; a
  `sessionManager` too old/stubbed to have that method fails CLOSED (throws)
  rather than silently falling back to an unverified spawn.
  `SessionManager._generateSemanticTitle` wraps whichever one-shot runner is
  in play (the real `defaultRunOneShot`, or an injected test double) with the
  same `resolveExecutable`, and logs a warning naming the session before
  rethrowing — `generateSessionTitle` otherwise swallows the runner's error
  and fails open to the truncation label, so that log line is the only trace
  a title spawn was ever refused.
- **Spawn-time backstop.** `SdkSession` now calls `labelBinarySpawnFailure`
  too, the same backstop `cli-session.js` / `jsonl-subprocess-session.js` /
  `claude-tui-session.js` / `codex-app-server-session.js` already run: when a
  turn fails BEFORE any SDK message arrived and the provider isn't
  containerised, the attempted path is re-verified and a quarantined/missing/
  not-executable binary gets the same labeled diagnosis those other providers
  give, instead of the SDK's generic "native binary … failed to launch" text.
  A failure after streaming started is never relabeled — the binary plainly
  launched fine.
- **Containerised sessions (`docker-sdk`).** These run `claude` inside the
  container through `spawnClaudeCodeProcess`. `pathToClaudeCodeExecutable`
  names the host binary, which no gate checks for a containerised provider. A
  turn that reaches `query()` without that hook — `DockerSdkSession` before
  `docker run` has returned a container id — would exec the host `claude`
  outside the container. `SdkSession` now refuses such a turn before dispatch
  with `CONTAINER_SPAWN_UNAVAILABLE`.

**Stat-identity caches keep this cheap.** A per-turn gate that re-hashed and
re-`spctl`'d on every call would add real, synchronous latency (measured on
this Mac's 215&nbsp;MB `claude`: ~100&nbsp;ms to SHA-256 hash, ~430&nbsp;ms for
`spctl --assess`) to every single turn in provenance mode. `sha256FileCached`
and `assessMacSignatureCached` (`utils/verify-provenance.js`) cache by
**stat identity** — `utils/stat-identity.js`'s `path:dev:ino:size:mtimeMs:ctimeMs`
— the same shape `probeBinaryVersion` already used, now shared rather than
duplicated, and extended with **ctime**: `utimes(2)` lets userland restore a
file's mtime to any value (including its old one) after an in-place write, but
no unprivileged call can set ctime on macOS or Linux, so a swap that tries to
hide behind a restored mtime still busts the cache. On Windows, Node reports
NTFS ChangeTime as ctime, and the file's owner can set it, so the hash cache is
off there and every Windows call hashes, as every create did before #8030. The hash cache additionally re-checks the
identity AFTER the read and only caches when it's unchanged from BEFORE — a
file that changes mid-hash is never pinned to the wrong digest. The signature
cache only ever stores a genuine PASS (`ok:true, skipped:false`); a rejection
or a skip (non-macOS) is re-assessed every call so neither is masked by a
stale result, and a stored pass expires after `SIGNATURE_CACHE_TTL_MS`
(10 minutes): a notarization ticket or Developer ID can be revoked without the
file changing, which no stat identity can see. Both are the DEFAULT `sha256File`/`assessSignature` seams
`verifyProvenance` uses, so an injected seam (every existing test) is
unaffected — the cache only activates on the real filesystem path, and
`_resetProvenanceCacheForTest()` clears both, and the cache test suites call it
before each test.

**What operators will notice.** With `binaryProvenance.mode: block`, a
`claude` auto-update (which re-points `~/.local/bin/claude` at a new build)
now refuses the NEXT TURN of every live `claude-sdk` session with
`PROVIDER_BINARY_PROVENANCE`, not only the next session create, until the new
hash is re-approved. That is the promise `block` mode makes, now kept for a
provider that spawns per turn. Since #8035 the same is true of every live
`gemini` and `codex exec` (`CHROXY_CODEX_APPSERVER=0`) session, with one
qualification: the gate hashes only the file at the pinned path. For an
npm-installed `codex` that file is the `bin/codex.js` launcher, which execs a
native binary from a separate platform package; for `gemini` it is
`bundle/gemini.js`, which loads dozens of chunk files. A change to that file
refuses the next turn, but an `npm i -g` that replaces only the native binary
or a chunk leaves the pinned hash unchanged and is not detected (#8040). In `warn`
mode the mismatch is logged on every turn until it is re-approved, since
`verifyProvenance` deliberately never re-pins a mismatch on its own.

**What is still NOT covered.** A TOCTOU window between the gate's checks and
the actual `exec()` remains, exactly as it does for every other provider this
document covers — no provider re-verifies inside the kernel's own exec call.
`forkSession` (the SDK's standalone conversation-fork helper) spawns nothing
of its own; it operates on an on-disk transcript file and was never in scope
here. And this closes the gap for `claude-sdk` specifically, but means it now
inherits the SAME exposure P1/P2 already cover for
`claude-cli`/`claude-tui`/`claude-channel`: quarantine detection, and (opt-in)
the SHA-256 pin ledger + signature gate — now re-checked every turn instead of
once. The pin covers only the bytes at the resolved path; a launcher that execs
or loads other files (npm-installed `codex`, and `gemini` however installed)
leaves those files unhashed
(#8040). Nothing provider-specific was added for the version gate below — it is
generic `runProviderPreflight` machinery any provider can opt into via
`spec.binary.minVersion` and/or `spec.binary.recommendedVersion`. The
create-time preflight call still logs the #8031 soft-floor warning as before;
`_verifyPinnedSpawn`'s per-turn re-verification passes `warnAdvisory: false` so
that same gap is not re-logged on every single turn — the `versionAdvisory`
value is still computed and returned either way, just not re-announced.

**Version gate, and where it sits relative to the other gates.** `claude-sdk`'s
version floor is a HYBRID pair (#8031), replacing the single hard
`minVersion` that #7986 originally shipped. That original design declared
`minVersion: () => sdkClaudeCodeVersion()` — the installed
`@anthropic-ai/claude-agent-sdk` package's own `claudeCodeVersion` field — as
a hard floor. That field is a **pairing**, not a minimum: it names the
`claude` CLI build the SDK release was *published alongside*, and the CLI's
patch number is its release counter, so a user on a lagging release channel
(npm `stable` trails `latest`) can be several patches behind whatever the SDK
happened to ship next to without their install being broken in any way.
Treating it as a hard floor meant every SDK bump instantly hard-blocked any
`claude` that hadn't also updated — the failure mode #8031 fixes. Now:
  - **Hard floor** — `minVersion: CLAUDE_SDK_MIN_CLI_VERSION`
    (`utils/agent-sdk-version.js`), a small, hand-raised constant reviewed
    and bumped by a maintainer, never automatically. Below it, preflight still
    throws `ProviderBinaryVersionError` exactly as before.
  - **Soft floor** — `recommendedVersion: () => sdkClaudeCodeVersion()`, the
    SDK's own pairing. At/above the hard floor but below this, preflight does
    NOT throw: it logs a warning and returns a `versionAdvisory` describing
    the gap (`{ provider, binary, path, found, recommended, remediation }`).
  - A **tripwire test** (`agent-sdk-version.test.js`) asserts
    `sdkClaudeCodeVersion() === CLAUDE_SDK_FLOOR_REVIEWED_AGAINST`, so an SDK
    bump that moves the pairing forces a maintainer to consciously re-check
    (and, if needed, raise) `CLAUDE_SDK_MIN_CLI_VERSION` rather than letting
    the hard floor silently drift further behind the SDK's own pairing.
  - Renovate throttles `@anthropic-ai/claude-agent-sdk` bumps the same way it
    already throttles `@anthropic-ai/claude-code` (`renovate.json`), so a
    lagging CLI channel gets real time to catch up between SDK bumps rather
    than the pairing moving out from under it every week.

`runProviderPreflight` probes the installed binary's version **at most once**
per call — the SAME probed version feeds both checks — and only **strictly
after** verifyBinary and the provenance gate both pass: a binary that's
missing, quarantined, or blocked by `block`-mode provenance is never exec'd
for a `--version` probe. An installed `claude` below the hard floor throws
`ProviderBinaryVersionError` (`code: PROVIDER_BINARY_VERSION`) with a
`claude update` remediation — this is a version-skew problem, not a
"reinstall from scratch" one; below the soft floor only, it warns with the
same remediation text but never blocks the session. Before either gate, a
provider that declares `binary.requiresDirectExec` (the SDK provider does,
because the Agent SDK spawns `claude` with no shell) refuses a Windows
`.cmd`/`.bat` npm shim with `ProviderBinaryUnsupportedError`
(`code: PROVIDER_BINARY_UNSUPPORTED`): such a shim can never be spawned that
way, and it is never exec'd. The probe itself
(`utils/binary-version.js#probeBinaryVersion`) is cached by stat identity
(`utils/stat-identity.js`: path + dev + ino + size + mtimeMs + ctimeMs) so a
`claude update` invalidates the cache and repeated session-creates against an
unchanged binary don't — the same shared identity helper the #8030 hash/
signature caches above now use.

**The desktop bundle no longer ships the SDK platform binary.** The prior
model bundled `@anthropic-ai/claude-agent-sdk-darwin-arm64` (and friends) so
`claude-sdk` worked without a separate `claude` install; that package is now
pruned from `packages/desktop`'s staged server, and the Mach-O bundle guard
(`scripts/find-macho.mjs`) checks for it by magic bytes, not just by
extension, so an unpruned platform binary fails the build rather than
shipping silently. Every Claude Code provider — SDK included — now requires
the same installed `claude` on the end user's machine.

### What is verified, and when

| Provider | Preflight | Per-spawn re-verification |
| --- | --- | --- |
| `claude-sdk` | create | every turn, pinned to the create-time path (#8030) |
| `gemini` | create | every turn, pinned to the create-time path (#8035) |
| `codex exec` (`CHROXY_CODEX_APPSERVER=0`, legacy) | create | every turn, pinned to the create-time path (#8035) |
| `codex` app-server (default route) | create | its one spawn per session, at `start()`, re-verified and pinned to the create-time path (#8038) |
| `claude-cli` | create | every (re)spawn, pinned to the create-time path — first spawn, model switch, permission-mode change, the next message after Stop, crash restart (#8038) |
| `claude-tui` | create | every (re)spawn, pinned to the create-time path — first spawn, each PTY respawn (≤5 backoff attempts + the #5348 fresh-conversation retry), and the revival attempt on the next input after a refusal (#8038); the explicit native auth route's own `connectionRuntimePreflight` re-check counts as the same gate |
| Containerised (`docker-sdk` and other `containerized` providers) | none on the host | none on the host — the binary runs inside the container; a `claude-sdk` turn with no in-container spawn hook is refused (`CONTAINER_SPAWN_UNAVAILABLE`, above) |
| `acp` (config-driven ACP agents) | none | none — operator-configured `command`; a spawn-failure backstop labels a quarantined or not-executable ABSOLUTE command (§2) |
| One-shots (summarizer, semantic-title generator) | n/a | a fresh full gate on every call — no create-time step to pin from |
| `codex` model-catalog probe (post-auth `available_models` refresh) | n/a | the FULL create-time preflight (existence, quarantine, the direct-exec shim refusal, provenance, credentials) fresh on every no-session probe, via `SessionManager.verifyOneShotExecutable(ProviderClass)` — the #8030 one-shot resolver generalized to take an explicit provider class (#8036); a codex install with no `OPENAI_API_KEY`/`codex login` now refuses to probe too, same as `createSession`; a refusal is TTL-cached for the same 5-minute window a success is; a live session's own probe (`CodexAppServerSession.start()`) reuses that session's already-verified client and spawns nothing new |
| Web tasks (`web-task-manager.js`) | n/a | a fresh full gate on every call, at all THREE no-session spawn sites (feature detection at daemon start, every `launch_web_task`, every teleport), via `SessionManager.verifyOneShotExecutable(CliSession)` — the same #8030/#8036 one-shot resolver the codex model-catalog probe uses; a refusal degrades feature detection to unavailable (logged at `warn`) and fails a launch/teleport with the gate's coded error — nothing is spawned either way (#8039) |
| `chroxy resume` CLI subcommand (`cli/session-cmd.js`) | n/a | a fresh full gate on every invocation, via `runProviderPreflight(CliSession, { provenance })` — no create-time step to pin from, and no daemon `SessionManager` either, so the provenance options bag is built straight from a config file (`<configDir>/config.json`, or `-c <path>`, #8065 review S4) that must be readable/parseable if it exists (#8065 review S3) and the daemon's own `binary-trust.json` ledger, opened lazily only when a gate is on (#8065 review nitpick 3); a refusal prints the gate error's message and exits non-zero with nothing spawned (#8061) |
| `chroxy start` dependency checks | n/a | a fresh provenance/signature gate on every run (`chroxy start` itself has no create-time session to pin from), via `checkBinary()` / `checkClaudeTuiCliVersion()` gating the SAME resolved path they then probe for `--version` — the configured provider's binary, `cloudflared`, and (for `claude-tui`) the version-pin probe all share one mode/signatureGate, resolved from `-c <path>`'s config (or `<configDir>/config.json`, #8065-review-S4-style — mirroring the `chroxy resume` row above) plus env, and one lazily-constructed `binary-trust.json` ledger. This is narrower than the daemon's per-provider "full gate": doctor's own existence/quarantine/shim/env-credential checks run as their own separate steps (not part of `verifyProvenance`), and the claude-tui probe only runs its existence/quarantine check when a provenance or signature gate is actually on. A refusal reports a doctor `fail` row naming the gate's status code and remediation, and `chroxy start` exits non-zero on it (unless `--skip-checks`) with nothing spawned; a `warn`-mode issue reports a `warn` row rather than only a log line (#8041, #8074) |
| `chroxy tunnel setup` CLI subcommand (`cli/tunnel-cmd.js`) | n/a | ONE gate, verified before the FIRST of three execs (`tunnel login` / `tunnel create` / `tunnel route dns`), via `runProviderPreflight(ProviderClass, { provenance })` against a minimal `preflight`-shaped stand-in for `cloudflared` — no create-time step to pin from, and no daemon `SessionManager` either, so the provenance options bag is built straight from a config file (`<configDir>/config.json`, or `-c <path>`) the same way the `chroxy resume` row above does; the pre-#8066 unconditional `--version` existence probe is gone entirely (answered by the #6708 `stat`-based health check instead), and all three execs run the SAME verified absolute path that one gate resolved. Unlike the daemon (#8030/#8038), this path does not re-verify between execs — a browser OAuth prompt sits between the `login` exec and `create`/`route dns`, an operator-paced gap the daemon's per-turn/per-spawn re-checks don't have to cross; tracked in #8078. A refusal prints the gate error's message and exits non-zero with nothing spawned (#8066) |

"Per-spawn re-verification" pins to the exact path create-time preflight
verified (when preflight ran and the provider isn't containerised) rather than
re-resolving — see `_gatedSpawnBinary` / `_verifyPinnedSpawn`. The catalog
probe has no create-time step to pin from (same as the other one-shots), so it
re-resolves AND re-verifies fresh on every call instead — the web-task spawns
closed by #8039, the `chroxy resume` gate closed by #8061, the `chroxy
start` dependency checks closed by #8041, and the `chroxy tunnel setup` gate
closed by #8066 all follow the identical pattern. A row marked "none" gets at
most the create-time check; there is no longer a known spawn that runs with
no gate of its own. Where a gate does run, it
hashes only the file at the pinned path (#8040).

**Per-spawn refusal semantics (#8038).** A gate refusal on a (re)spawn is not
treated as the process dying. `claude-cli` and `claude-tui` normally respond to
a lost child/PTY with a bounded, backing-off auto-respawn (≤5 attempts) that
gives up loudly (`respawn_exhausted` / `pty_respawn_exhausted`) if the process
keeps failing to come back — but a binary the gate refuses to launch was never
going to "come back" no matter how many times the backoff retried it, so
scheduling that timer would just burn the bounded budget into a misleading
"failed to stay alive" for a binary chroxy deliberately declined to run.
Instead: nothing is spawned, exactly one coded `error` is emitted (the gate's
own `code`, e.g. `PROVIDER_BINARY_PROVENANCE`; no error-text rewriter — a
provenance message's hex hash prefix can spuriously match a `429`/`401`
text-classification pattern), no further backoff is armed and the respawn count
resets (the next attempt is user-initiated, mirroring how a model switch
already resets it; a refused crash respawn does keep the one rolling
rate-limit slot its scheduling took), and the session sits idle — not busy, not
respawning — until something asks for a new spawn: the next input, or for
`claude-cli` also a model or permission-mode change. That spawn re-runs the
gate; an input it still refuses is rejected with the gate's code instead of
being queued. `codex` app-server has no respawn loop at all: a
refusal there throws out of `start()` before the client is created, and
`SessionManager` handles it exactly like any other `start()` failure.

**The `claude-tui` native auth route's `claude auth status` verdict is refused
the same way (#8044).** On an explicit native agent-connection session, every
PTY (re)spawn runs `claude auth status`. A logged-out host
(`NATIVE_LOGIN_REQUIRED`) or a non-first-party route (`NATIVE_AUTH_ROUTE_MISMATCH`)
is a verdict about the host, not a PTY that failed to stay up: nothing is
spawned, the native code is emitted once with its own message, no backoff is
armed, and the session stays listed and idle. The next input re-runs the check,
so a `claude login` recovers it in place. `NATIVE_AUTH_STATUS_UNVERIFIED` is
refused the same way, although it also covers the probe itself failing (its 5s
timeout, a spawn or resource error, oversized or unparseable output), which can
be transient: the trade is deliberate — the next input retries, where the old
backoff retried five times and then destroyed the session. A probe that fails
with an uncoded error (e.g. the binary vanished or was quarantined between the
gate and the probe) is refused too, as `SPAWN_REFUSED`. Before this, each
respawn re-ran the check up to five times over about 30s and then destroyed the
session with a `pty_respawn_exhausted` "failed to stay alive".

**So is the native route's post-spawn endpoint marker (#8057).** After the TUI
launches, its SessionStart hook writes a route marker. A marker reporting a
custom endpoint, token, gateway or cloud selector (`NATIVE_ENDPOINT_ROUTE_MISMATCH`)
comes from configuration, and a missing one (`NATIVE_ENDPOINT_UNVERIFIED` — the
hook never ran, or warmup ended before it wrote) is treated the same way,
matching `NATIVE_AUTH_STATUS_UNVERIFIED` above. Unlike the other refusals this
PTY did launch, so it is killed and dropped; the code is emitted once, no backoff
is armed, and the next input relaunches and re-checks. Before this, each of up
to five backoff attempts relaunched claude under the rejected route (paying the
warmup each time), emitted no coded error at all, and ended by destroying the
session with `pty_respawn_exhausted`.

The very first spawn is gated too, and a refusal there (possible only if the
binary changes in the moment between create-time preflight and the spawn)
differs by provider: `claude-tui` and `codex` app-server reject `start()`, so
session creation fails with the gate's code (a restored session is parked as a
failed restore); `claude-cli` latches the refusal like any respawn, so the
session is listed but never becomes ready, and its first input re-runs the gate
and is rejected with the code.

**The pinned per-turn gate runs in every mode, not only in `block`.** It is
wired whenever create-time preflight ran, whatever `binaryProvenance.mode`
says. In the default `off` mode it still re-checks, on every turn — and, since
#8038, on every respawn — that the pinned path exists, is executable and is
not quarantined, the direct-exec shim refusal, the version floor, and any
required credentials. A pinned binary that disappears (`nvm uninstall`, a
package removal) therefore refuses every later turn AND every later respawn
attempt with a message saying to start a new session, rather than spawning
whatever `PATH` now resolves. The same holds for respawns (#8038): a `PATH`
change after a session starts can no longer redirect a model switch, a
permission-mode change, a post-Stop revival or a crash respawn to a different
binary than create-time preflight verified. A binary replaced IN PLACE at the
pinned path is a different case: the pinned path still exists, so in `off` and
`warn` mode the respawn runs the new file; only `block` mode (a hash mismatch)
or the signature gate refuses it, and even then only the file at the pinned
path is hashed (#8040).

## 6. Operator remediation quick reference

When `chroxy doctor` or a session error reports a **quarantined** binary:

1. Confirm the file is what you expect (reinstall from a clean source and compare
   — e.g. `npm i -g @openai/codex@latest`, then `spctl --assess -vv $(which codex)`
   / inspect `codesign`).
2. Only after provenance is confirmed, clear the quarantine:
   `xattr -d com.apple.quarantine <path>` (or allow it in
   System Settings → Privacy & Security).
3. If it was an XProtect false positive, consider reporting it to Apple (Feedback
   Assistant) and the provider's maintainers.

Reading the matched XProtect signature (requires `sudo`) confirms FP vs real:
`sudo log show --last 24h --predicate 'process BEGINSWITH "XProtect"' | grep -i <binary>`.
