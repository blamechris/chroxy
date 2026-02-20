# Builder's Audit: Happy vs Chroxy Architecture

**Agent**: Builder -- Pragmatic full-stack dev who estimates effort and maps file-by-file changes
**Overall Rating**: 4.2 / 5
**Date**: 2026-02-19

---

## Section-by-Section Ratings

| # | Section | Rating | Notes |
|---|---------|--------|-------|
| 1 | Topology | 4/5 | Clear diagrams, good mental model for developers |
| 2 | Wire Protocol | 5/5 | Thorough enumeration, actionable comparison |
| 3 | Ordering | 5/5 | Correctly identifies the gap and the solution is straightforward |
| 4 | Providers | 4/5 | Registry pattern well-described, multi-provider effort realistic |
| 5 | Connectivity | 4/5 | Fair comparison, though relay complexity is understated |
| 6 | Events | 5/5 | Event flow mapping is accurate and useful for implementation |
| 7 | Encryption | 4/5 | Technically accurate, threat model context missing |
| 8 | State | 4/5 | Ring buffer limitations real, persistence path clear |
| 9 | RPC | 3/5 | Overvalues RPC — Chroxy's read-only approach is intentional, not a gap |
| 10 | Feature Matrix | 5/5 | Actionable comparison, good for prioritization |

---

## Adoption Priority Matrix

| Feature | Effort | Impact | Risk | Verdict |
|---------|--------|--------|------|---------|
| Sequence numbers | 3-5 days | High | Low | **DO IT** — highest ROI improvement |
| SQLite persistence | 4-6 days | High | Medium | **DO IT** — replaces fragile JSON, unlocks unlimited history |
| Multi-provider (Codex) | 5-8 days/provider | Medium | Medium | **DEFER** — registry ready, add when users ask |
| Zod schemas | 2-3 days | Medium | Low | **DO IT** — catches protocol drift early |
| Relay mode | 10-15 days | Medium | High | **DEFER** — massive complexity, unclear demand |

---

## File-by-File Change Maps

### Adoption 1: Sequence Numbers (3-5 days)

**Day 1: MVP — outbound sequence numbers only**

`packages/server/src/ws-server.js`:
```javascript
// Add to WsServer class
_seq = 0

// Modify _send() to inject seq
_send(ws, type, payload) {
  const msg = { type, seq: ++this._seq, ...payload }
  // ... existing send logic
}

// Add gap detection on inbound (optional)
_onMessage(ws, data) {
  if (data.seq && data.seq !== this._lastClientSeq + 1) {
    this._log(`Gap detected: expected ${this._lastClientSeq + 1}, got ${data.seq}`)
  }
  this._lastClientSeq = data.seq || this._lastClientSeq
  // ... existing handler
}
```

`packages/app/src/stores/connection.ts`:
```typescript
// Add to connection store
lastServerSeq: 0,

// Update message handler
onMessage(msg) {
  if (msg.seq) {
    if (msg.seq !== get().lastServerSeq + 1) {
      console.warn(`Sequence gap: expected ${get().lastServerSeq + 1}, got ${msg.seq}`)
    }
    set({ lastServerSeq: msg.seq })
  }
  // ... existing handler
}
```

**Day 2-3: Reconnect catch-up**

`packages/server/src/session-manager.js`:
```javascript
// Modify _replayHistory to accept lastSeq parameter
_replayHistory(ws, lastSeq = 0) {
  const missed = this._history.filter(msg => msg.seq > lastSeq)
  for (const msg of missed) {
    this._ws._send(ws, msg.type, msg)
  }
}
```

`packages/app/src/stores/connection.ts`:
```typescript
// Send lastSeq on reconnect
onReconnect() {
  ws.send(JSON.stringify({
    type: 'reconnect',
    lastSeq: get().lastServerSeq
  }))
}
```

**Day 4-5: Tests and edge cases**

New file `packages/server/test/sequence.test.js`:
- Gap detection test
- Reconnect replay test
- Sequence overflow test (reset at Number.MAX_SAFE_INTEGER)
- Multi-client sequence isolation test

### Adoption 2: SQLite Persistence (4-6 days)

**Why SQLite, not Postgres**: Chroxy is a single-user tool running on a dev machine. SQLite gives ACID transactions, indexed queries, and crash recovery with zero ops overhead. No daemon, no connection string, no backup scripts. The database is a single file next to the existing JSON files.

**Day 1-2: Schema and migration**

New file `packages/server/src/sqlite-store.js`:
```javascript
import Database from 'better-sqlite3'

export class SqliteStore {
  constructor(dbPath) {
    this.db = new Database(dbPath)
    this._migrate()
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        provider TEXT DEFAULT 'claude',
        model TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_seq
        ON messages(session_id, seq);
    `)
  }

  appendMessage(sessionId, type, payload, seq) {
    this.db.prepare(
      'INSERT INTO messages (session_id, seq, type, payload) VALUES (?, ?, ?, ?)'
    ).run(sessionId, seq, type, JSON.stringify(payload))
  }

  getMessagesSince(sessionId, seq) {
    return this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq'
    ).all(sessionId, seq).map(row => ({
      ...JSON.parse(row.payload),
      seq: row.seq,
      type: row.type
    }))
  }

  getRecentMessages(sessionId, limit = 100) {
    return this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
    ).all(sessionId, limit).reverse().map(row => ({
      ...JSON.parse(row.payload),
      seq: row.seq,
      type: row.type
    }))
  }
}
```

**Day 3-4: Integration**

`packages/server/src/session-manager.js`:
- Replace `_history` ring buffer with `SqliteStore` calls
- Replace `_persistDebounce` with immediate SQLite writes (SQLite handles concurrency)
- Keep ring buffer as in-memory cache for hot path (last 50 messages)

`packages/server/src/config.js`:
- Add `dbPath` config option (default: `~/.chroxy/chroxy.db`)

**Day 5-6: Migration and tests**

New file `packages/server/src/migrate-json-to-sqlite.js`:
- Read existing JSON session files
- Insert into SQLite
- Rename JSON files to `.json.bak`

New file `packages/server/test/sqlite-store.test.js`:
- CRUD operations
- Sequence-based queries
- Concurrent write safety
- Migration from JSON

### Adoption 3: Multi-Provider Codex (5-8 days per provider)

`packages/server/src/providers.js`:
- Already has registry pattern — add new provider entry
- Each provider needs: `createSession()`, `sendMessage()`, `interrupt()`, `getModels()`

New file `packages/server/src/providers/codex-session.js`:
- Wrap OpenAI Codex CLI (`codex -p --output-format stream-json`)
- Map Codex events to Chroxy's internal event format
- Handle permission model differences (Codex has suggest/auto-edit/full-auto)

`packages/server/src/session-manager.js`:
- Modify `_createSession()` to pass provider to session factory
- Ensure event normalization layer handles provider-specific events

**Key risk**: Each provider has different event formats, permission models, and capabilities. The normalization layer is the hard part, not the provider wrapper.

### Adoption 4: Zod Schemas (2-3 days)

New file `packages/server/src/protocol-schema.js`:
```javascript
import { z } from 'zod'

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), content: z.string(), sessionId: z.string().optional() }),
  z.object({ type: z.literal('permission_response'), id: z.string(), allowed: z.boolean() }),
  z.object({ type: z.literal('heartbeat') }),
  // ... all client message types
])

export const ServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), version: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal('stream_delta'), content: z.string(), seq: z.number().optional() }),
  // ... all server message types
])
```

`packages/server/src/ws-server.js`:
- Add `ClientMessage.safeParse()` on inbound messages
- Log validation errors, don't reject (backward compatibility)

`packages/app/src/stores/connection.ts`:
- Add `ServerMessage.safeParse()` on inbound messages
- TypeScript types derived from Zod schemas

### Adoption 5: Relay Mode (10-15 days) — DEFER

**This is the highest-risk adoption.** Adding relay mode means:

- New infrastructure: relay server (Node.js + WebSocket), message queue (Redis or in-memory), persistence (SQLite or Postgres)
- New auth flow: relay registration, agent authentication, client authentication
- New failure modes: relay down, agent disconnected, message ordering across relay hops
- New security surface: relay sees all metadata, needs its own E2E encryption

**However, relay can coexist with tunnel via a tunnel registry pattern:**

`packages/server/src/tunnel-registry.js`:
```javascript
// Abstract interface for connectivity
export class TunnelRegistry {
  async register(serverId, tunnelUrl) { /* ... */ }
  async lookup(serverId) { /* ... */ }
  async deregister(serverId) { /* ... */ }
}

// CloudflareTunnelRegistry - current behavior
// RelayTunnelRegistry - future relay mode
```

This way, relay mode is an alternative connectivity strategy, not a replacement for the tunnel. The app doesn't need to know which mode is active — it connects to a URL either way.

**Recommendation**: Design the `TunnelRegistry` interface now (1 day). Implement relay mode only if user demand materializes.

---

## Additional Observations

### What the Document Gets Right
- The topology diagrams are clear and accurate
- The event flow comparison is genuinely useful for understanding the differences
- The encryption comparison is technically correct (even if framing is biased)
- Identifying sequence numbers as a gap is the single most actionable finding

### What the Document Gets Wrong
- Treats relay features as universally desirable (they're not for single-user)
- Understates relay operational complexity (Postgres, Redis, monitoring, on-call)
- Overstates Chroxy's gaps (message count, permission count, offline resilience)
- Doesn't account for development velocity — Chroxy ships faster because it's simpler

### Build vs Buy Analysis
- Sequence numbers: Build (straightforward, 3-5 days)
- SQLite: Build with `better-sqlite3` (well-tested, zero config)
- Multi-provider: Build per-provider wrappers (each is unique)
- Relay mode: Don't build unless demand proves it
- Zod: Buy (`zod` package, 2-3 days integration)

---

## Verdict

The document is highly actionable from a builder's perspective. It correctly identifies the highest-value improvements (sequence numbers, persistence, schema validation) and provides enough architectural context to estimate effort. The relay analysis is useful as a "know your competitor" exercise but should not drive Chroxy's roadmap. Build for the single-user case first, extend when demand proves the multi-user case.

The recommended build order is: sequence numbers (highest ROI, lowest risk) → Zod schemas (catches bugs early) → SQLite persistence (unlocks unlimited history) → multi-provider (only when users ask) → relay mode (probably never).
