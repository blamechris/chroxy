# Skills

Skills are reusable instruction snippets that Chroxy injects into every session you start. They let you encode personal conventions, project standards, or any recurring guidance once and have every provider (Claude SDK, Claude CLI, Codex, Gemini) automatically apply it.

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

A skill file is just Markdown — no frontmatter, no special syntax required. The filename (without `.md`) becomes the skill name. The first non-empty line is used as a short description in the `list_skills` response.

Example — `~/.chroxy/skills/coding-style.md`:

```markdown
Prefer explicit error handling over silent failures.

- Always propagate errors to the caller; do not swallow exceptions.
- Use descriptive variable names — prefer `userRecord` over `u`.
- Keep functions focused: one responsibility per function.
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
- **Linux** — the filesystem is case-sensitive. Only the exact name `community/` is recognised. A directory named `Community/` or `COMMUNITY/` on Linux is silently treated as an ordinary top-level skills directory and is **not** subject to the community trust gate — its skills are either loaded without a trust prompt or rejected, depending on configuration.

Using lowercase `community/` everywhere is the portable convention that works on all platforms.

### Trust file migration between platforms

The trust ledger (`~/.chroxy/skills-trust.json`) stores path-based grant records. On macOS and Windows the stored paths are lowercased; on Linux they are stored verbatim as resolved by the filesystem.

If you copy your `skills-trust.json` from macOS to Linux (or vice versa), the `by-path` keys in the ledger may no longer match the real paths on the new machine. The result is that previously-trusted community skills appear as pending and require re-trust on the destination system. The `by-author` index is unaffected by this (author names are not path-cased), so author-level grants survive the migration — only path-level grants are at risk.

**Workaround when migrating from macOS to Linux:** after copying the file, either re-trust affected skills through the UI, or manually edit `skills-trust.json` and update the `by-path` keys to match the verbatim paths on the Linux machine.

## Scope

Skills span two tiers: machine-wide global (#2957) and per-repo overlay (#3067). Per-skill metadata (author, version, trust level) and a UI toggle are planned for a future release (#2958, #2959).

## Example skill files

See [`docs/skills-examples/coding-style.md`](skills-examples/coding-style.md) for a ready-to-use starting point.
