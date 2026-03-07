# Audit Report Retention Policy

## Policy

Audit reports follow a **retain-latest, archive-old** model:

1. **Keep the latest audit** in `docs/architecture/audit-results/` — it reflects current codebase state and informs ongoing work.
2. **Remove completed audits** from the working tree once all action items are closed. The reports remain in git history for reference.
3. **One audit directory at a time** — when a new audit is performed, the previous one is removed from `docs/` as part of the same PR that adds the new results.

## Rationale

- Audit docs are one-shot artifacts — valuable when action items are open, but become stale quickly.
- Git history preserves the full record. Anyone needing a past audit can check out the relevant commit.
- Keeping all audits in the working tree inflates repo size and clutters `docs/` with outdated information.

## Where Audits Live

| Location | Purpose |
|----------|---------|
| `docs/architecture/audit-results/` | Current/latest audit reports |
| Git history | Archived audits (searchable via `git log --all -- docs/audit*`) |

## When to Archive

Archive (remove from working tree) when:
- All issues created from the audit are closed or triaged
- A newer audit supersedes it
- The audit is older than 30 days and has no open action items
