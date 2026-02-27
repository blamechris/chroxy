# Futurist's Audit: Full Codebase Health Post-v0.2.0

**Agent**: Futurist -- Technical architect who thinks 6-12 months ahead
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-26

## Section Ratings

| Area | Rating | Key Issue |
|------|--------|-----------|
| Server Architecture | 4/5 | ws-server.js approaching God object; provider pattern is solid |
| Protocol Design | 3/5 | Version negotiation is one-way; no shared protocol package |
| App Architecture | 3.5/5 | Zustand monolith (75+ fields); dual state pattern fragile |
| Desktop Architecture | 3/5 | No auto-update; macOS only; third protocol implementation |
| Build/Deploy | 3.5/5 | No integration tests in CI; no coverage reporting |
| Documentation | 4/5 | Excellent CLAUDE.md; no ADRs for architectural decisions |

## Top 5 Findings

1. **Protocol duplication without shared contract** — 3 independent WS implementations (server, app, dashboard) with manually-synced version constants
2. **Zustand store monolith won't scale** — 75+ fields in flat store; dual state pattern requires manual sync of 8+ fields
3. **Single-user architecture blocks multi-user** — one token, global session limits, single state file
4. **handleMessage is a 1400-line switch** (message-handler.ts) — testing bottleneck, extension bottleneck
5. **Protocol version negotiation insufficient** — one-way, single integer, no client version sent, no forced disconnect on incompatibility

## Growth Recommendations (by timeframe)

| When | What |
|------|------|
| Immediate | Add protocolVersion to auth message schema |
| 1-2 months | Extract packages/protocol/ with shared types and schemas |
| 3-6 months | Split Zustand into slices; decompose handleMessage into handler registry |
| 6-12 months | User abstraction for multi-user support (if needed) |

## Verdict

Well-engineered v0.2.0 with clean provider/adapter patterns and solid security. But "single-developer, single-user" assumptions are creating compounding debt: three independent protocol implementations, a monolithic store, and one-way version negotiation. The highest-leverage investment is a shared protocol package — it's the foundation for all other improvements.
