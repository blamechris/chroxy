# Runtime skills (session-injected)

> **Heads up — "skills" means two unrelated things in Chroxy.** This page is about **runtime skills**: Markdown files in `~/.chroxy/skills/` that Chroxy injects into the model's prompt at session start, so any provider applies your conventions. They're a runtime, provider-agnostic feature and need a running Chroxy session (they have nothing to do with Claude Code's own `.claude/skills/`).
>
> The *other* "skills" are the **dev-workflow `/skill` registry** — authoring/reviewing commands like `/full-review` that are compiled into each coding agent's native format for people *building* Chroxy. Those are a contributor tool with no runtime role. See **[dev-workflow skills](dev-workflow-skills.md)** and the side-by-side **[comparison table](dev-workflow-skills.md#two-things-called-skills)**.

Runtime skills are reusable instruction snippets that Chroxy injects into every session you start. They let you encode personal conventions, project standards, or any recurring guidance once and have every provider (Claude SDK, Claude CLI, Codex, Gemini) automatically apply it.

## Where skill files live

Chroxy looks for skills in two places, then merges them at session start:

1. **Global** — `~/.chroxy/skills/*.md` — applied to every session on this machine.
2. **Repo overlay** — `<repo>/.chroxy/skills/*.md` — discovered by walking up from the session's working directory (same lookup pattern as `.git`). Applied only to sessions started inside that repo.

```
~/.chroxy/skills/                   # global, every session
├── coding-style.md
└── debugging-approach.md

my-project/.chroxy/skills/          # repo overlay, only sessions in my-project
├── coding-style.md                 # overrides the global file with the same name
└── commit-format.md
```

Create either directory if it does not exist:

```bash
mkdir -p ~/.chroxy/skills            # global
mkdir -p .chroxy/skills              # repo overlay (run from repo root)
```

When a global file and a repo file share the same filename, the **repo file wins** — treat it as an override, not an addition. Filename-based dedup keeps the rule predictable.

> **Trust note.** Repo-overlay skills are auto-loaded any time you start a session inside that repo's tree, and their content is injected directly into the model's system prompt. That means cloning or opening an *untrusted* repo can shape model behaviour — including potential prompt injection or guidance to exfiltrate data via tool calls. Treat `<repo>/.chroxy/skills/` like any other code in the repo: review it before working in an unfamiliar checkout, and avoid running Chroxy inside repos you don't trust. To opt out for a session, run Chroxy from a `cwd` that has no `.chroxy/skills/` in any ancestor (or temporarily rename the directory). A first-class trust model with provenance and per-skill enable/disable is tracked in #2959.

## Writing a skill

A skill file is Markdown. The filename (without `.md`) becomes the skill name, and the first non-empty line is used as a short description in the `list_skills` response.

**Frontmatter is optional.** A bare Markdown file (no frontmatter) works as-is — but you can add a YAML frontmatter block to scope or tune the skill (see [Frontmatter & provider scoping](#frontmatter--provider-scoping) below).

Example — `~/.chroxy/skills/coding-style.md`:

```markdown
Prefer explicit error handling over silent failures.

- Always propagate errors to the caller; do not swallow exceptions.
- Use descriptive variable names — prefer `userRecord` over `u`.
- Keep functions focused: one responsibility per function.
```

## Frontmatter & provider scoping

An optional YAML frontmatter block (a `---`-fenced header at the very top of the file) tunes how and when a skill is injected. Only these keys are recognized — anything else is dropped, and malformed frontmatter falls back to loading the body as a plain skill:

| Key | Purpose |
|-----|---------|
| `providers` | **Scope the skill to specific providers.** A list of provider ids — e.g. `providers: [claude-sdk, codex]` — includes the skill only for sessions on one of those providers. Omit it to apply to all. Matching is exact against the session's provider id (the registry key from `providers.js`, e.g. `claude-sdk`), except the alias `claude` matches any `claude-*` provider. |
| `activation` | `auto` (default) or `manual`. A `manual` skill is only injected when a client explicitly activates it by name. |
| `injection` | `prepend` (before the first user message — the Codex/Gemini default), `append` (added to the system prompt — the Claude SDK default), or `system` (synonym for `append`). |
| `priority` | A number used by the size-budget pruner to decide which skills to keep when the combined skill text would exceed the budget. |
| `name` / `description` | Override the derived name / first-line description. |
| `allowed-tools` | Reserved metadata (declares the tools a skill expects). |

Example — a skill that only applies to Codex sessions and is injected before the first message:

```markdown
---
providers: [codex]
injection: prepend
---
When using the shell tool, prefer `rg` over `grep` for searches.
```

## Disabling a skill

Rename the file to end in `.disabled.md` instead of `.md`:

```bash
mv ~/.chroxy/skills/coding-style.md ~/.chroxy/skills/coding-style.disabled.md
```

Rename it back to re-enable it. No restart required — skills are loaded fresh at session start.

## How injection works per provider

| Provider | Injection method |
|----------|-----------------|
| Claude SDK (`sdk` / Docker) | Appended to the session system prompt via `systemPrompt.append` |
| Claude CLI (`cli`) | Passed as `--append-system-prompt` when the CLI process starts |
| Codex | Prepended to the first user message of the session |
| Gemini | Prepended to the first user message of the session |

Skills are combined under a `# User skills` header, separated by `---` dividers, and only sent once per session.

## Listing active skills

Send a `list_skills` WebSocket message from any connected client to receive the current skill list. The server replies with a `skills_list` message containing each skill's name, description, and `source` (`"global"` or `"repo"`) so clients can show which tier the skill came from. If no session is active, only global skills are returned (the repo overlay is per-session).

## Sharing skills

Because skills are plain files in a directory, sharing them is straightforward:

```bash
# Share global skills via git
cd ~/.chroxy/skills
git init
git remote add origin git@github.com:you/my-chroxy-skills.git
git push -u origin main

# Pull on another machine
git clone git@github.com:you/my-chroxy-skills.git ~/.chroxy/skills
```

Repo-overlay skills (`<repo>/.chroxy/skills/`) are intended to live alongside the project — commit them to the repo so every contributor's Chroxy session inherits the same conventions automatically.

## Community namespace

Skills shared by third parties live under a `community/<author>/` subdirectory of any skills root:

```
~/.chroxy/skills/
├── coding-style.md
└── community/
    └── alice/
        ├── typescript-conventions.md
        └── review-checklist.md
```

Community skills are subject to a first-activation trust prompt — Chroxy will not inject them until you explicitly grant trust for the author. This prevents a cloned or downloaded skill set from silently influencing the model's behaviour without your consent.

### Linux case-sensitivity requirement

**Always name the directory `community/` in lowercase.** The behaviour differs by platform:

- **macOS and Windows** — filesystems are case-insensitive by default. `Community/`, `COMMUNITY/`, and `community/` all refer to the same directory and are all recognised as the community namespace.
- **Linux** — the filesystem is case-sensitive. Only the exact name `community/` is recognised. A directory named `Community/` or `COMMUNITY/` on Linux is silently skipped: the loader does not recurse into it, so any skills inside (e.g. `Community/alice/foo.md`) are **not loaded at all** — they neither appear as community skills nor as ordinary top-level skills, and no warning is emitted. Top-level skill files alongside the wrongly-cased directory continue to load as normal.

Using lowercase `community/` everywhere is the portable convention that works on all platforms. If your community skills are unexpectedly missing on a Linux machine, check the directory name first.

### Trust file migration between platforms

The trust ledger (`~/.chroxy/skills-trust.json`) stores path-based grant records under a `by-path` map. The JSON property names (the lookup keys) are written **verbatim** as returned by `fs.realpathSync()` at the moment trust was granted, and looked up verbatim on subsequent activations. Chroxy does not lowercase or otherwise normalise these keys. What makes them differ between platforms is the underlying filesystem: on case-insensitive filesystems (typically macOS APFS/HFS+ and Windows NTFS by default) `realpathSync` returns the canonical on-disk casing recorded at file-creation time, regardless of the casing the caller passed in; on case-sensitive filesystems (typically Linux ext4/btrfs/xfs) `realpathSync` returns the path verbatim as it exists on disk. Either way, the key that lands in `by-path` is whatever `realpathSync` produced.

(The `_normalizePathKey` helper that lowercases keys on macOS/Windows is applied only to the legacy per-skill `skills` records map — used for the SHA-256 tamper-detection ledger — not to the community-trust `by-path` index.)

If you copy your `skills-trust.json` from macOS to Linux (or vice versa), the `by-path` keys in the ledger may no longer match the real paths on the new machine, because the canonical casing on the source filesystem can differ from the casing recorded on the destination. The result is that previously-trusted community skills appear as pending and require re-trust on the destination system. The `by-author` index is unaffected by this (author names are not path-cased), so author-level grants survive the migration — only path-level grants are at risk.

**Workaround when migrating between platforms:** after copying the file, either re-trust affected skills through the UI, or manually edit `skills-trust.json` and update the **property names** in the `by-path` object to match the realpath casing on the destination machine. For example, if the source key is `"/users/alice/.chroxy/skills/community/bob/style.md"` but `realpathSync` on the destination resolves the file to `"/Users/alice/.chroxy/skills/community/bob/style.md"`, rename the property name accordingly; the `grantedAt` value inside the record does not need to be edited.

## Scope

Skills span two tiers: machine-wide global (#2957) and per-repo overlay (#3067). Per-skill metadata (author, version, trust level) and a UI toggle are planned for a future release (#2958, #2959).

## Example skill files

See [`docs/skills-examples/coding-style.md`](skills-examples/coding-style.md) for a ready-to-use starting point.
