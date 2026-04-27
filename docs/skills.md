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

## Scope

Skills span two tiers: machine-wide global (#2957) and per-repo overlay (#3067). Per-skill metadata (author, version, trust level) and a UI toggle are planned for a future release (#2958, #2959).

## Example skill files

See [`docs/skills-examples/coding-style.md`](skills-examples/coding-style.md) for a ready-to-use starting point.
