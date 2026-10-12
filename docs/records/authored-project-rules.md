# Authored project rules

The project contract is authored in `AGENTS.md`. Claude loads `CLAUDE.md`, whose
only instruction is `@AGENTS.md`; Gemini loads `GEMINI.md`, whose only instruction
is `@./AGENTS.md`. Codex discovers `AGENTS.md` directly. This migration addresses
#8577 without changing runtime provider code, installed skills or model defaults.

## Rule preservation inventory

The previous `CLAUDE.md` body moved into `AGENTS.md`. All twelve project sections
and their operative content remain: Project Overview; Critical Dev Notes; PRIME
Compatibility and Authority; Session Start Protocol; Git Workflow; Code Style;
Testing Conventions; Architecture; Dev Commands; UI Verification with Maestro;
Repo Memory MCP; and Reference. The Skills subsection remains in Session Start
Protocol, including every native-target, compilation and install-on-miss rule.

The only source-text changes are mechanical:

- Replace the Claude development title/preamble with a project title and an
  authored-source/host-tooling explanation. Preserve the existing instruction
  to apply equivalent tooling for the current host.
- Call the old “AGENTS mirror” the “project contract”; retain the warning that
  project files do not prove global instruction loading or native skill discovery.
- Read `AGENTS.md` directly in the startup protocol.
- Point the skill customization description and contributor docs at `AGENTS.md`.
- Replace obsolete generated-mirror/drift wording in the skill compiler paragraph
  with compiled-artifact wording. Preserve all its compiler requirements.

An exact comparison of the old body after these substitutions against the new
source confirmed that everything else is unchanged. The obsolete generated header
is removed. There are no remaining separate Claude-only project instructions to
append to the thin adapter; Claude-specific tooling guidance remains available to
every host through the shared contract.

## Retired consumers and replacements

| Consumer | Change |
| --- | --- |
| `scripts/gen-agents-md.mjs` | Removed; authored instructions must never be regenerated from an adapter. |
| `scripts/__tests__/gen-agents-md.test.mjs` | Removed mirror/renderer/entry-point regressions; source, adapter and size regressions now run in `check-project-rules.test.mjs`. Shared entry-point behavior retains its own suite. |
| Scripts Tests generated-mirror drift step | Replaced by the real project-rules CLI and its executable regression suite. |
| `scripts/bump-version.sh` | Edits and verifies the authored source's two version references directly; does not mutate either adapter. A missing authored source with a remaining adapter fails. Minimal trees with no instructions still work. |
| `scripts/__tests__/bump-version.test.sh` | Removed eight cases for the retired generator and its shell fixture helper; retained direct source-format, version and awkward-path tests, plus a missing-source/remaining-adapter regression. Its case floor is 26. |
| Shared fixture helper | Remains shared by compiler and project-rule tests; the missing-dependency staging regression remains covered. |
| Dev-workflow docs and PRIME fixture checklist | Read the authored source and invoke the replacement checks. |

Historical references in `docs/false-safety-guards.md`, the fixture's previous
evidence summary and a fixture-helper comment remain as records of the former
generator's defects. They are not live generation instructions. Installed skill
sources and compiled targets are unchanged; references to the Claude project file
remain backed by its import. Skill refresh is a separate authorized action.

## Portable guard and live verification

Run these dependency-free checks with Node 22:

```sh
node scripts/check-project-rules.mjs
node scripts/__tests__/check-project-rules.test.mjs
bash scripts/__tests__/bump-version.test.sh
node scripts/compile-skill-targets.mjs --check
```

The portable guard checks that the source is authored, that all project sections
remain, and that each adapter contains exactly its approved import. It inventories
Git project files and checks every nested `AGENTS.md` ancestor chain, including
ignored instruction files in inventoried project directories. It refuses
override files, project Codex/Gemini settings and nested host adapters whose loading
precedence it cannot certify. Rule files must be nonempty, regular UTF-8 files.

The supported Codex cap is **98,304 bytes**. CI allocates **49,152 bytes** to machine
rules, counts each project file's UTF-8 bytes and Codex's **23-byte** separators,
and requires at least **2,048 bytes** of remaining capacity on every chain. This
conservative machine allocation keeps CI independent of private machine content.
Machines with larger roots need a deliberate budget review; the guard does not
rewrite their instructions or configuration.

To measure a local root instead of the portable allocation:

```sh
node scripts/check-project-rules.mjs --machine "$HOME/.fleet/AGENTS.md"
```

`--root /absolute/project/path` selects an explicit project for fixture or checkout
checks. A successful execution prints `PROJECT_RULES_OK`. An unreadable input,
failed inventory, unsupported layer, bad adapter or insufficient margin exits 1
with a diagnostic. The tests run the CLI in disposable Git repositories and prove
positive and negative cases, including an exact-margin chain and one-byte overflow.

This checks the repository's supported contract and budget. It does not inspect
machine configuration or certify runtime loading. Run `fleet-check.py` from the
actual session directory and verify fresh authenticated host sessions separately;
imports, invocation flags, trust and instruction injection still need live evidence.
