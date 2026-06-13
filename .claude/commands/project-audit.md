# /project-audit

Launch a comprehensive multi-agent audit of the entire project. Agents with diverse perspectives analyze the codebase in parallel, then findings are synthesized into a master assessment with actionable recommendations.

Unlike `/swarm-audit` (which audits a specific document or topic), this skill audits the **whole project holistically** — architecture, code quality, security, testing, and more — with agent selection automatically tuned to the project type.

## Arguments

- `$ARGUMENTS` - Optional configuration. Space-separated tokens:
  - `agents=N` — Number of agents (default: 6, min: 4, max: 12)
  - `focus=AREA[,AREA,...]` — Comma-separated focus areas to emphasize (e.g., `focus=security,performance`)
  - `output=DIR` — Output directory for reports (default: `docs/project-audit/`)
  - `verbosity=brief|standard|detailed` — Report depth (default: `standard`)
  - `skip=AGENT[,AGENT,...]` — Comma-separated agent nicknames to exclude
  - `include=AGENT[,AGENT,...]` — Force-include specific optional agents by nickname

Examples:
```
/project-audit
/project-audit agents=8 focus=security,performance
/project-audit output=audits/pre-release verbosity=detailed
/project-audit agents=10 include=deployer,auditor
/project-audit focus=testing skip=scout
```

## Instructions

### 1. Parse Arguments

```
AGENT_COUNT = extract from agents=N (default: 6, clamp to 4–12)
FOCUS_AREAS = extract from focus=X,Y (default: empty — auto-detect all)
OUTPUT_DIR  = extract from output=DIR (default: docs/project-audit/)
VERBOSITY   = extract from verbosity=X (default: standard)
SKIP_AGENTS = extract from skip=X,Y (default: empty)
INCLUDE_AGENTS = extract from include=X,Y (default: empty)
```

### 2. Auto-Discover Project Profile

Before selecting agents, build a project profile by scanning the repository. This determines which optional agents are relevant.

**Scan these signals (read files, do NOT guess):**

| Signal | How to Detect | What It Tells Us |
|--------|---------------|------------------|
| Languages | File extensions, package files (`package.json`, `Cargo.toml`, `go.mod`, `requirements.txt`, `Gemfile`, `*.csproj`, `pom.xml`, `build.gradle`) | Primary language(s) and ecosystem |
| Framework | Config files, imports (`next.config.js`, `angular.json`, `django`, `flask`, `rails`, `spring`) | Framework-specific concerns |
| Frontend | `src/**/*.tsx`, `src/**/*.vue`, `src/**/*.svelte`, HTML templates, CSS/SCSS files | Include UX agent |
| Tests | `tests/`, `__tests__/`, `spec/`, `*.test.*`, `*.spec.*`, test config files | Testing maturity, include Testing agent |
| CI/CD | `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`, `Dockerfile`, `docker-compose.yml`, `.circleci/` | Include DevOps agent |
| Dependencies | Lock files, dependency count, outdated indicators | Include Dependencies agent |
| Docs | `docs/`, `README.md`, API docs, inline doc coverage | Include Documentation agent |
| Security surface | Auth modules, crypto usage, env files, secrets patterns, network code | Elevate Security agent priority |
| Performance indicators | Database queries, caching layers, async patterns, worker threads | Include Performance agent |
| API surface | REST routes, GraphQL schemas, gRPC protos, OpenAPI specs | API design concerns |
| Project size | File count, LOC estimate, directory depth | Calibrate agent depth |

**Build the profile object (mental model, not written):**

```
PROJECT_PROFILE = {
  name: <from package.json, Cargo.toml, etc. or directory name>,
  languages: [...],
  frameworks: [...],
  has_frontend: bool,
  has_tests: bool,
  test_coverage_estimate: low|medium|high,
  has_ci: bool,
  has_docker: bool,
  dependency_count: approximate,
  has_docs: bool,
  has_api: bool,
  security_surface: low|medium|high,
  performance_critical: bool,
  project_size: small|medium|large,
  repo_age: <from git log --reverse>,
}
```

**IMPORTANT:** Spend real effort on discovery. Read `package.json`, `README.md`, config files, and sample source files. The better the profile, the more relevant the audit. Do NOT skip this step or guess from file names alone.

### 3. Select Agent Panel

Choose AGENT_COUNT agents. Always include all 5 core agents. Fill remaining slots from the optional roster based on the project profile, FOCUS_AREAS, INCLUDE_AGENTS, and SKIP_AGENTS.

#### Core Panel (always included)

| Agent | Nickname | Lens | Personality |
|-------|----------|------|-------------|
| Code Quality | "Craftsman" | Code standards, consistency, naming, error handling, anti-patterns, tech debt | Meticulous senior engineer who has maintained codebases for decades. Reads every line. Spots inconsistencies others miss. Cares deeply about readability and maintainability. |
| Architecture | "Architect" | System design, modularity, coupling, cohesion, separation of concerns, scalability patterns | Principal engineer who designs systems for 10x growth. Evaluates whether the structure will hold as the project evolves. Identifies hidden coupling and missing abstractions. |
| Security | "Sentinel" | Vulnerabilities, input validation, auth flows, secrets management, dependency CVEs, attack surface | Paranoid security engineer who assumes every input is hostile. Checks for injection, XSS, CSRF, path traversal, credential leaks, and insecure defaults. Cross-references dependencies against known CVEs. |
| Testing | "Inspector" | Test coverage, test quality, edge cases, test architecture, CI reliability | QA architect who believes untested code is broken code. Evaluates not just coverage percentage but test quality — are the right things being tested? Are edge cases covered? Are tests brittle or robust? |
| Feature Completeness | "Strategist" | Feature gaps, user journey completeness, error states, edge case handling, polish level | Product-minded engineer who thinks from the user's perspective. Identifies missing features, incomplete flows, poor error messages, and rough edges that hurt the user experience. |

**Chroxy core-agent weighting:**
- **Sentinel** weights the bearer-token authority model (primary / pairing-bound / hook-secret classes — see `docs/security/bearer-token-authority.md`), transport E2E encryption, and credentials.json at-rest encryption. Every new HTTP route or WS handler that touches session state is in scope.
- **Inspector** weights the two mandatory CI lints — test `stateFilePath` isolation (`lint-tests-state-file-path.sh`) and `BaseSession` opt-forwarding (`lint-session-opt-forwarding.sh`) — plus the three test layers: server/protocol `node:test`, dashboard/store-core `vitest`, and the visual/E2E smoke layer (Playwright dashboard smoke + Maestro mobile flows).
- **Strategist** weights mobile UX: reconnect/ConnectionPhase resilience, touch targets, plan-approval and AskUserQuestion flows, and offline behavior.

#### Optional Roster (auto-selected based on project profile)

| Agent | Nickname | Lens | Auto-Include When | Personality |
|-------|----------|------|-------------------|-------------|
| Performance | "Profiler" | Bottlenecks, memory leaks, N+1 queries, caching opportunities, bundle size, lazy loading | `performance_critical` OR `has_frontend` OR large project | Performance engineer who profiles everything. Finds N+1 queries, unnecessary re-renders, missing indexes, bloated bundles, and synchronous operations that should be async. |
| UX/DX | "Advocate" | User experience (if frontend), developer experience (if library/tool), API ergonomics, error messages | `has_frontend` OR project is a library/CLI tool | Designer-developer hybrid who obsesses over the experience. For frontend: accessibility, responsiveness, loading states. For libraries: API intuitiveness, documentation clarity, error message helpfulness. |
| DevOps/CI | "Deployer" | CI pipeline, deployment strategy, environment parity, monitoring, alerting, infrastructure as code | `has_ci` OR `has_docker` | SRE who has been paged at 3am too many times. Evaluates CI reliability, deployment safety (rollback?), environment consistency, log quality, and monitoring coverage. |
| Documentation | "Chronicler" | README quality, API docs, inline comments, architecture decision records, onboarding experience | `has_docs` is false OR project is a library | Technical writer who judges documentation by whether a new team member can onboard in a day. Evaluates README completeness, API documentation, code comments, and whether architecture decisions are recorded. |
| Dependency Health | "Auditor" | Outdated dependencies, CVEs, license compliance, dependency weight, vendoring strategy | `dependency_count` > 20 OR `security_surface` is high | Supply chain security expert who treats every dependency as a liability. Checks for outdated packages, known vulnerabilities, license conflicts, unnecessary dependencies, and whether the dependency tree is well-managed. |
| Competitive Analysis | "Scout" | Industry standards, competing projects, missing table-stakes features, differentiation | Project is a product or library (not internal tooling) | Product strategist who knows the competitive landscape. Compares against similar projects and industry standards. Identifies table-stakes features that are missing and areas where the project could differentiate. |
| API Design | "Contract" | API consistency, REST/GraphQL conventions, versioning, error formats, pagination, rate limiting | `has_api` | API design purist who has read every RFC. Evaluates endpoint naming, HTTP method usage, error response consistency, pagination patterns, versioning strategy, and whether the API is self-documenting. |

**Chroxy domain-specific optional agents:**

| Agent | Nickname | Lens | Auto-Include When | Personality |
|-------|----------|------|-------------------|-------------|
| Expo Expert | "Expo Expert" | Expo SDK lifecycle, RN constraints, dev-client vs Expo Go, native modules (expo-speech-recognition, expo-secure-store), EAS builds, OTA | audit touches `packages/app` | Mobile engineer who has shipped many Expo apps and knows where the native seams bite. Flags dev-build-only assumptions and SDK-upgrade hazards. |
| Tunneler | "Tunneler" | Cloudflare tunnels (Quick + Named), DNS/TLS, WebSocket proxying, HTTP+WS upgrade, reconnect/health-check reliability | audit touches `tunnel/` or `ws-server.js` | Network SRE who has debugged flaky tunnels at 3am. Knows WsServer must be an HTTP+WS upgrade (not standalone WS) and that the app health-checks before connecting. |
| Protocol Steward | "Steward" | Zod schema consistency and wire-contract drift across server ↔ dashboard ↔ app, schemaVersion bounds, prototype-pollution hardening | audit touches `packages/protocol` or `packages/store-core` | Contract purist who diffs every emitter against every consumer of the WS protocol. Catches a server field that no schema validates and a schema no client reads. |
| Tauri Smith | "Smith" | Tauri v2 packaging, CSP/nonce, launchd cwd, code-signing/notarization, Rust↔web bridge | audit touches `packages/desktop` | Desktop-platform engineer who knows Tauri-spawned servers run with `cwd=/` and a minimal PATH, and that signing belongs in `build.rs`. |

#### Selection Algorithm

```
1. Start with 5 core agents
2. Remove any core agents in SKIP_AGENTS (minimum 3 core agents — refuse if user tries to skip more)
3. Force-add any agents in INCLUDE_AGENTS
4. For remaining slots (AGENT_COUNT - current count):
   a. Score each optional agent by relevance to PROJECT_PROFILE
   b. Boost score +2 for agents whose lens matches a FOCUS_AREA
   c. Select highest-scoring agents until slots are filled
5. Remove any optional agents in SKIP_AGENTS
6. Final panel size may be less than AGENT_COUNT if SKIP reduces it
```

**Tell the user which agents were selected and why** before launching the swarm.

### 4. Create Output Directory

```bash
mkdir -p "${OUTPUT_DIR}"
```

If the directory already contains a previous audit, warn the user and ask whether to overwrite or create a timestamped subdirectory (e.g., `docs/project-audit/YYYY-MM-DD/`).

### 5. Launch Agent Swarm

Launch ALL agents in parallel using the Task tool. Each agent receives:

1. The full project profile (languages, frameworks, size, etc.)
2. Their specific persona, lens, and evaluation criteria
3. Instructions to explore the actual codebase thoroughly
4. A structured report format to follow

**Agent prompt template:**

```
You are **"{NICKNAME}"** — {PERSONALITY}

You are auditing a project from the lens of **{LENS}**.

## Project Profile
{PROJECT_PROFILE_SUMMARY}

## Your Audit Scope

You MUST explore the codebase thoroughly. Read source files, configuration, tests, and documentation. Do NOT base your audit on file names alone.

### Exploration Strategy
0. **Use repo-memory first to save tokens** (this repo has it, ~1,500 files pre-indexed): `get_project_map` for structure, `get_file_summary`/`batch_file_summaries` to scan files (~50 tokens each vs ~800 for a full Read), `search_by_purpose` to find files by concept, `get_dependency_graph` to trace impact. `Read` files in full only for exact implementation/control flow or when a summary returns `suggestFullRead: true`.
1. Start with entry points: main files, index files, app entry, CLI entry
2. Trace key flows end-to-end (at least 2-3 major flows)
3. Read configuration and build files
4. Sample at least 5-10 source files across different modules
5. Read test files to understand what IS and ISN'T tested
6. Check for patterns: are conventions consistent across the codebase?

### Report Structure

#### Executive Summary
2-3 sentences: overall assessment from your lens.

#### Ratings

Rate each area on your lens (1-5 scale):

| Area | Rating | Evidence |
|------|--------|----------|
| {area relevant to lens} | X/5 | Specific file:line references |
| ... | ... | ... |

#### Top Findings
Rank your top 5-8 findings by severity. Each finding MUST include:
1. **Severity**: Critical / Major / Minor / Nitpick
2. **Finding**: Clear description
3. **Evidence**: Specific file paths and line numbers. Quote relevant code.
4. **Impact**: What goes wrong if this isn't fixed
5. **Recommendation**: Concrete fix (not "consider improving")

#### Strengths
What this project does WELL from your lens. Be specific — cite files and patterns.

#### Actionable Recommendations
Ordered list of concrete next steps. Each item must be specific enough to become a GitHub issue. Include:
- What to do (imperative verb)
- Where to do it (file paths)
- Why it matters (impact)
- Effort estimate: S (< 1 hour) / M (1-4 hours) / L (4-16 hours) / XL (> 16 hours)

#### Overall Rating
Single rating X.X/5 with one-paragraph justification.

## Rules
- READ actual source code. Verify everything against the codebase.
- Be specific. "This might be a problem" is worthless. "src/auth.js:42 uses MD5 for password hashing" is useful.
- Rate honestly. 3/5 means "adequate." 5/5 means "exemplary — I would showcase this." 1/5 means "actively harmful."
- Be opinionated. Strong views, loosely held. Do not hedge everything.
- Your recommendations must be actionable enough to become GitHub issues.

## Verbosity: {VERBOSITY}
- brief: Top 5 findings only, minimal evidence, skip Strengths section
- standard: Full report as described above
- detailed: Full report plus additional deep-dives into any area rated <= 2/5. Include code snippets for every finding.
```

**Batching:** Launch agents in parallel batches. First batch of up to 5 agents, then remaining agents in a second batch. Do NOT run agents in the background — use foreground Task calls so output returns directly.

### 6. Write Individual Reports

After all agents return, write each report to its own file:

```
${OUTPUT_DIR}/
  00-master-assessment.md    <- You write this (step 7)
  01-craftsman.md            <- Code Quality
  02-architect.md            <- Architecture
  03-sentinel.md             <- Security
  04-inspector.md            <- Testing
  05-strategist.md           <- Feature Completeness
  06-{nickname}.md           <- Optional agents
  ...
```

Each file starts with:

```markdown
# {Nickname}'s Audit: {Project Name}

**Agent**: {Nickname} — {one-line personality summary}
**Lens**: {lens description}
**Overall Rating**: X.X / 5
**Date**: {today}
**Verbosity**: {verbosity level}

---
```

### 7. Write Master Assessment

Create `00-master-assessment.md` that synthesizes ALL agent findings into a unified assessment.

#### Required Sections

**a. Project Profile Summary**

Concise overview: name, languages, frameworks, size, what it does, project maturity.

**b. Auditor Panel**

| Agent | Lens | Rating | Key Finding |
|-------|------|--------|-------------|
| Craftsman | Code Quality | X.X/5 | One-sentence headline |
| Architect | Architecture | X.X/5 | One-sentence headline |
| ... | ... | ... | ... |

**Aggregate Rating**: Weighted average (core agents 1.0x, optional agents 0.8x).

**c. Risk Heatmap**

ASCII grid mapping identified risks by likelihood vs. impact:

```
                    IMPACT
            Low      Medium     High     Critical
         ┌────────┬──────────┬────────┬──────────┐
  Likely  │        │          │ ██ R3  │ ██ R1    │
         ├────────┼──────────┼────────┼──────────┤
 Possible │        │ ░░ R5    │ ░░ R4  │ ██ R2    │
         ├────────┼──────────┼────────┼──────────┤
 Unlikely │ ·· R7  │ ·· R6    │        │ ░░ R8    │
         └────────┴──────────┴────────┴──────────┘

██ = Immediate action   ░░ = Plan to address   ·· = Monitor
```

Map each risk ID (R1, R2, ...) to a description below the grid.

**d. Consensus Findings**

Findings where 3+ agents independently identified the same issue. These are highest confidence. For each:
- What agents agree on
- Supporting evidence from multiple reports
- Recommended action
- Priority: P0 (fix now) / P1 (fix this sprint) / P2 (fix this quarter) / P3 (backlog)

**e. Contested Points**

Findings where agents disagree. Present each position with the agent's name. Include your synthesis of who is right and why — do not just list opinions.

**f. Strengths**

What the project does well, as identified across multiple agents. Grouped by theme.

**g. Critical Path: Top 10 Recommendations**

Synthesized and deduplicated from all agent recommendations. Ordered by priority, not by agent. Each recommendation includes:

| # | Recommendation | Priority | Effort | Agents | Impact |
|---|---------------|----------|--------|--------|--------|
| 1 | Imperative description | P0-P3 | S/M/L/XL | Who flagged it | What improves |
| 2 | ... | ... | ... | ... | ... |

**h. Implementation Roadmap**

Group the top 10 into a phased plan:

**Phase 1 — Immediate (this week):** P0 items, quick wins (S/M effort)
**Phase 2 — Short-term (this month):** P1 items, medium effort
**Phase 3 — Medium-term (this quarter):** P2 items, larger efforts
**Phase 4 — Long-term (backlog):** P3 items, strategic improvements

For each phase, list:
- What to do (linked to recommendation #)
- Dependencies (which items unblock others)
- Expected outcome

**i. Final Verdict**

One of:
- **Ship It** — Project is solid. Address minor findings at your pace.
- **Ship With Fixes** — Project is good but has specific issues that should be fixed before/alongside the next release.
- **Needs Work** — Significant issues identified. Address Phase 1 items before expanding scope.
- **Rethink** — Fundamental concerns raised. Consider architectural changes before further investment.

One-paragraph justification with the aggregate rating.

**j. Appendix: Agent Reports**

Table linking to each individual report file.

| Agent | File | Rating |
|-------|------|--------|
| Craftsman | [01-craftsman.md](./01-craftsman.md) | X.X/5 |
| ... | ... | ... |

### 8. Optionally Generate Issues

After writing the master assessment, ask the user:

> "Would you like me to create GitHub issues for the top N recommendations? I can create them with appropriate labels and link them to the audit."

If yes, use this format for each issue:

```bash
gh issue create \
  --title "type(scope): recommendation title" \
  --label "enhancement" \
  --label "from-audit" \
  --body "$(cat <<'EOF'
## Context

Identified during project audit on {DATE}.
**Source:** {OUTPUT_DIR}/00-master-assessment.md — Recommendation #{N}
**Priority:** {P0-P3}
**Effort:** {S/M/L/XL}

## Agents Who Flagged This

{List of agents and their specific findings}

## Description

{Detailed description of what needs to change and why}

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Evidence

{File:line references from agent reports}
EOF
)"
```

**Chroxy issue/commit conventions:** create issues with a `from-audit` label. Title findings as `type(scope): summary` using chroxy's types (feat/fix/refactor/docs/test/chore/style/perf) and scopes (server/app/desktop/tunnel/ws/cli/ci/docs). Per the Zero Attribution Policy, **never** add any AI/Claude attribution to issues, commits, or PR bodies.

### 9. Commit Results

Stage and commit all audit files:

```bash
git add "${OUTPUT_DIR}/"
git commit -m "docs: project audit (${AGENT_COUNT} agents, aggregate ${AGGREGATE_RATING}/5)

Agents: ${AGENT_NICKNAMES_COMMA_SEPARATED}
Verdict: ${VERDICT}
Top finding: ${TOP_CONSENSUS_FINDING_SUMMARY}
"
```

Do NOT push unless explicitly asked.

### 10. Report to User

Output a concise summary:

```markdown
## Project Audit Complete

| Metric | Value |
|--------|-------|
| Agents | ${AGENT_COUNT} (${CORE_COUNT} core + ${OPTIONAL_COUNT} optional) |
| Aggregate Rating | ${AGGREGATE_RATING} / 5 |
| Verdict | ${VERDICT} |
| Reports | ${OUTPUT_DIR}/ |

### Agent Ratings

| Agent | Rating | Top Finding |
|-------|--------|-------------|
| Craftsman | X.X/5 | ... |
| ... | ... | ... |

### Top 3 Consensus Findings
1. ...
2. ...
3. ...

### Top Contested Point
...

### Recommended Next Action
...
```

## Configuration

### Rating Scale

| Rating | Meaning |
|:------:|---------|
| 5/5 | Exemplary. Would showcase this as a reference implementation. |
| 4/5 | Good. Minor issues that do not block progress. |
| 3/5 | Adequate. Works but has gaps worth addressing. |
| 2/5 | Concerning. Significant issues that will cause problems at scale. |
| 1/5 | Fundamentally broken. Needs rethinking, not patching. |

**Chroxy grading criteria:**
- **Sentinel** weights the bearer-token authority model, transport E2E encryption, and credentials.json at-rest encryption (OS-keychain key); any new endpoint touching session state must be checked against `docs/security/bearer-token-authority.md`.
- **Profiler** weights WebSocket streaming and large-output handling (stream parsing, background-shell reaping, message-id collisions).
- **Inspector** weights the mandatory CI lints (test `stateFilePath` isolation, `BaseSession` opt-forwarding) and gives extra weight to the visual-smoke / Maestro layers, which lag the unit layer.
- **Advocate** (if included) weights mobile reconnect resilience and touch ergonomics; **Tunneler** weights tunnel/WS reliability under drops.

### Agent Behavior Rules

- Agents MUST read actual source code — at least 5-10 files across different modules
- Agents MUST provide file:line references for every finding
- Agents MUST rate each area independently with evidence
- Agents MUST end with actionable recommendations that could become GitHub issues
- Agents MUST include effort estimates (S/M/L/XL) for every recommendation
- Agents should be opinionated, not diplomatic — strong views, loosely held
- Agents should acknowledge strengths, not just problems — a balanced audit is more credible

### Verbosity Levels

| Level | Individual Reports | Master Assessment |
|-------|-------------------|-------------------|
| brief | Top 5 findings, minimal evidence, no Strengths section | Ratings table, consensus findings, top 5 recommendations |
| standard | Full report as specified | Full report as specified |
| detailed | Full report + deep-dives on low-rated areas with code snippets | Full report + expanded implementation roadmap with code examples |

## Customization

### Adding Custom Agent Personas

To add a custom agent, include it in your `INCLUDE_AGENTS` with a description in the arguments. Or, to make it permanent, create a `.claude/audit-agents.json` file:

```json
{
  "custom_agents": [
    {
      "nickname": "Regulator",
      "lens": "GDPR compliance, data privacy, consent flows, data retention",
      "personality": "Privacy lawyer turned engineer who reads every data flow for compliance violations.",
      "auto_include_when": "Project handles personal data or has EU users",
      "detect_signals": ["gdpr", "privacy", "consent", "personal data", "user data"]
    }
  ]
}
```

### Project-Level Defaults

Create `.claude/audit-config.json` to set defaults for this project:

```json
{
  "default_agents": 8,
  "default_focus": ["security", "performance"],
  "default_verbosity": "detailed",
  "always_include": ["deployer", "auditor"],
  "always_skip": ["scout"],
  "output_dir": "docs/audits/"
}
```

## Examples

```
/project-audit
/project-audit agents=8
/project-audit focus=security
/project-audit agents=10 focus=security,performance verbosity=detailed
/project-audit output=audits/pre-launch agents=12
/project-audit skip=scout,chronicler
/project-audit include=deployer verbosity=brief
```

<!-- skill-templates: project-audit aae4d65 2026-06-06 -->
