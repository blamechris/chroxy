# Running a backlog through agent-control

Use an external MCP host as the planner and ordinary Chroxy sessions as executors.
The [agent-control adapter](agent-control.md) provides the same seven tools to any
MCP host; provider selection stays in Chroxy's existing provider registry.

## Dispatch contract

Start with one issue per isolated branch/worktree. Before dispatch, refresh the
issue's open state and check both maintainer and external PRs for existing coverage.
Give the executor a concrete brief containing:

- Issue URL, current failure, and expected behavior.
- Permitted files and any explicitly excluded changes.
- Acceptance criteria and the relevant validation commands.
- For a changed guard, a mutation that must produce a clear, prompt test failure.
- Required evidence: final diff, actual command exit codes, and any unresolved limitation.

Record the requested model separately from the daemon's observed model. A null
observation means unknown. For providers whose daemon metadata is incomplete,
independent native runtime evidence can inform an explicit planner decision to
use `acknowledgeModelMismatch`; it must not be represented as a daemon observation.

Keep the `clientMessageId`, final acknowledgement, and event cursor with the
planner's working record. An accepted acknowledgement records input admission,
not task completion. If delivery is uncertain, inspect evidence before deciding
whether a deliberate retry is appropriate; the adapter does not retry mutations.
Event cursors belong to one connection epoch and report a gap after reconnect.

The planner reviews the final diff, runs relevant checks, and creates a draft PR.
Use the repository's review and merge gates. Interactive merges require the user's
explicit confirmation.

## First-wave candidates

These issues were checked open on 2026-09-18. Refresh their state and PR coverage
before dispatch; this is a proposed queue, not a completion report.

| Order | Issue | Bounded executor task | Review evidence |
|---|---|---|---|
| 1 | [#7815](https://github.com/blamechris/chroxy/issues/7815) | Remove doctor-test dependence on fixed ports 59123 and 59124 using controlled listeners on OS-assigned ports. | Passing doctor suite with the old ports deliberately held; restore the old assertions and demonstrate prompt failure. |
| 2 | [#7811](https://github.com/blamechris/chroxy/issues/7811) | Use the effective roster provider for permission-mode descriptions at both send sites while preserving discovery's no-session behavior. | Codex-default fixtures assert actual description text; reverting either changed site goes red. |
| 3 | [#7847](https://github.com/blamechris/chroxy/issues/7847) | Recognize the exact five-fragment unknown-resume diagnostic while keeping transcript matching narrow. | Positive wrapped fixture, negative ordinary transcript text, one-shot fallback, and a clear mutation failure. |

Begin serially. Increase executor concurrency only after each session has isolated
files and a clear review owner, and the planner can reliably reconcile acknowledgements,
permission requests, and reconnect gaps. A native coding-agent fork still needs an
explicit scope; it does not gain a durable Chroxy task identity through this adapter.

## Building the durable layer

The current adapter supplies transport and bounded observations. Build persistent
coordination in the existing design areas, keeping the MCP tools as a client surface:

1. [#7823](https://github.com/blamechris/chroxy/issues/7823): durable task/handoff identity,
   so ownership and task state survive a restarted planner or daemon.
2. [#7437](https://github.com/blamechris/chroxy/issues/7437): mailbox delivery and wakeups,
   so an idle planner can receive actionable executor updates.
3. [#6691](https://github.com/blamechris/chroxy/issues/6691): orchestration inside the daemon,
   building on durable identity rather than adding a second task database to the MCP process.

Provider-specific execution, external-host coordination, and durable task state have
different owners. Preserve that separation so Codex, Claude Code, Gemini, and other
hosts can use the same session and task contracts without coupling the daemon to one host.
