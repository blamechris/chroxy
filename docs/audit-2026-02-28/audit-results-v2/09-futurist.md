# Futurist's Audit: Desktop Architecture Audit

**Agent**: Futurist -- Technical architect who thinks in 2-year timelines
**Overall Rating**: 3.5 / 5
**Date**: 2026-02-28

---

## Section-by-Section Ratings

| Section | Rating | Key Issue |
|---------|--------|-----------|
| Message Synchronization | 3.5/5 | EventNormalizer pattern is extensible; ring buffer uses O(n) `Array.shift()` |
| Repository & Session Mgmt | 3/5 | Provider registry is crown jewel; state file will hit wall at 10+ sessions |
| Tunnel Implementation | 4/5 | Production-grade recovery; adapter pattern is future-proof |
| WebSocket Layer | 3/5 | Zod discriminatedUnion is right approach; broadcast is O(N) per client |
| Data Flow Diagram | 4.5/5 | Clean layered architecture supports independent optimization |
| Proposed Protocol | 3/5 | Correct direction; history storage must change before protocol can evolve |

## Top 5 Findings

### 1. Provider Registry is the Crown Jewel (POSITIVE, 5/5)
`providers.js` (121 lines): textbook strategy pattern with capability introspection. Adding a new AI backend requires implementing the EventEmitter interface and calling `registerProvider()`. Will support 5-10 providers without modification.

### 2. Single-Token Auth Cannot Scale to Multi-User (CRITICAL, 1/5)
No concept of user identity anywhere. `ws-server.js` validates one global token. Sessions, costs, permissions have no `userId` dimension. Multi-user requires 4-6 weeks touching SessionManager, WsServer, auth, persistence, and all clients.

### 3. State Persistence Will Hit a Wall (HIGH)
`session-manager.js:305-345`: serializes ALL sessions' full histories as one JSON file. 10 sessions * 500 msgs * 50KB = potentially 250MB. Written every 2 seconds via debounce. Needs SQLite or append-only log within 6 months.

### 4. EVENT_MAP Has No Extension Point (MEDIUM)
`event-normalizer.js:20`: static `const` object literal. No `registerEventMapping()`. Adding custom events requires modifying the file directly. 30-minute fix to make it a Map with a registration function.

### 5. Desktop Rust Code Has No Command Bridge (GAP)
Zero `#[tauri::command]` handlers. `withGlobalTauri: false`. WebView cannot invoke Rust logic. Every proposed desktop feature depends on building this foundation first (~1 week).

## Technical Debt Forecast

### 6-Month Horizon
| Item | Priority | Effort |
|------|----------|--------|
| Replace JSON state file with SQLite | High | 2 weeks |
| Add Tauri command bridge | High | 1 week |
| Implement differential sync | High | 2 weeks |
| Add `registerEventMapping()` | Medium | 2 days |
| Fix ring buffer O(n) to O(1) | Medium | 1 day |

### 12-Month Horizon
| Item | Priority | Effort |
|------|----------|--------|
| User identity and multi-user auth | High | 4-6 weeks |
| Plugin system | High | 3-4 weeks |
| RBAC and audit logging | Medium | 3 weeks |
| Multi-tunnel support | Low | 2 weeks |

## Verdict
Architecturally sound for single-user scope, with several abstractions (provider registry, event normalizer, tunnel adapter) that are genuinely future-proof. Main liabilities: single-user auth model, monolithic state file, and desktop's missing command bridge. The foundations are right; the extension points just need to be opened up. Critical path for next 6 months: (1) Tauri command bridge, (2) SQLite persistence, (3) differential sync.
