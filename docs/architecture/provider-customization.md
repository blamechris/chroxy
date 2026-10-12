# Provider customization capability seam

Chroxy reports customization as an adapter contract, not as a promise that a
provider obeyed prompt text. Runtime information distinguishes documented
native discovery, Chroxy-added delivery channels, and live evidence. An
unmeasured or unobservable fact is `unknown`; instructional text is not a tool
constraint.

## Definition

`ProviderCustomizationDescriptorSchema` in
`packages/protocol/src/schemas/server/session.ts` defines bounded vocabularies
for native files, delivery and precedence; Chroxy channels and lifetime;
native skills and runtime toggles; tool constraints and policy decisions;
memory, MCP discovery/callability, separate byte budgets, and egress. Native
document, runtime-skill, and compiled-project budgets are deliberately separate.

The dependency-free pure compiler in
`packages/server/src/instruction-policy-compiler.js` accepts ordered
sources and explicit targets. It preserves complete source bytes and order,
records source hashes plus exact per-rule end-byte offsets, and fails closed when a required rule is
missing, malformed, duplicated, partial, or outside the target's UTF-8 budget.
Ordinary unannotated AGENTS files remain supported as one whole-document module.
Compiled policy remains instructional text; its metadata does not claim runtime
enforcement.

## Provider

Every registered provider class exposes a schema-validated static descriptor.
Registration rejects missing or invalid descriptors, including hidden aliases,
lazy Docker providers, and configured compatible endpoints. The live session
may add only observed binary/capability facts. Codex app-server version and
capabilities come from its initialize handshake; absence of equivalent evidence
is reported as `unknown`.

API-driven BYOK providers do not discover vendor instruction files. On startup,
Chroxy safely reads the optional machine fleet source followed by authored
AGENTS files from repository root to cwd, compiles them in memory, and places
the verified projection before the session preamble, context hint, and runtime
skills on every API turn. No generated authored-source mirror is committed.
Docker BYOK does not claim this delivery until its host/container cwd mapping is
verified. Native Claude, Codex, Gemini, ACP, and shell drivers receive no extra
compiled project copy.

## Consumer

`provider_runtime_info` is emitted by the production session-info path on
connect, reconnect, switch, and late subscription, then refreshed when provider
startup reaches `ready` so handshake and compiled-policy facts replace an
initial unknown snapshot in the same tab. Store-core mirrors it per session and
clears it when the transport closes. Clients see only bounded metadata (source
IDs, hashes, sizes, per-rule end offsets, budget, and included required rule
IDs), never source bodies or private absolute paths.

The authored root `AGENTS.md` remains the source. `CLAUDE.md` and `GEMINI.md`
remain thin imports. This supersedes the earlier #7835 generated-AGENTS wording:
the only additions to the authored file are stable required-rule marker lines,
and removing those marker lines reproduces the previous file byte-for-byte.

## Native contracts and limits

- [Codex AGENTS.md discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
  documents home override/AGENTS selection, root-to-cwd precedence, one file per
  directory, a configurable fallback list, and a 32 KiB default project-doc
  limit. The installed machine's independently measured 98,304-byte effective
  cap is not a portable Codex default, so the runtime descriptor leaves the
  native budget unknown until measured.
- [Claude memory](https://code.claude.com/docs/en/memory) documents native
  CLAUDE.md content as a user message after the system prompt. Chroxy's
  `--append-system-prompt` path is a separate system-level channel.
- [Gemini CLI context files](https://geminicli.com/docs/cli/gemini-md/) documents
  global-to-workspace discovery plus just-in-time context. The message role and
  live loading state remain unknown without runtime evidence.

Runtime skills use their existing independent prune budget. They are not
required project policy and are not counted as native provider documents.
