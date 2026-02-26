# Adversary's Audit: Chroxy Codebase Re-Baseline

**Agent**: Adversary — Red team specialist who probes for exploitable vulnerabilities and abuse vectors
**Overall Rating**: 3 / 5
**Date**: 2026-02-26

---

## Section Ratings

| Area | Rating | Notes |
|------|--------|-------|
| Server | 3/5 | Auth is solid; several input validation and resource limit gaps |
| App | 3.5/5 | E2E encryption and biometric lock are strong defenses |
| Desktop | 2.5/5 | Dashboard is the weakest attack surface — no CSP, token in page |
| WS Protocol | 3/5 | Schema validation is a good first line, but bypasses exist |
| Authentication | 4/5 | Token-based auth with rotation; broadcast issue on rotation |
| Input Validation | 2.5/5 | Minimal validation beyond schema; prompt injection not addressed |
| Network Security | 3.5/5 | Cloudflare tunnel provides TLS; no certificate pinning in app |
| Data Protection | 3.5/5 | E2E encryption covers WS; local storage and logs are unprotected |

---

## Top 5 Findings

### 1. HIGH: Token Broadcast on Rotation Exposes New Token to All Connected Clients

**Severity**: High
**Status**: Open

When the API token is rotated (via settings or CLI), the server broadcasts the new token to all currently connected WebSocket clients. If an attacker has an active connection using a stolen token, they receive the new token as well, defeating the purpose of rotation.

**Evidence**:
- `ws-server.js` — token rotation handler broadcasts `token_updated` message to all authenticated clients
- The message includes the new token value in plaintext (within the E2E encrypted channel)
- No mechanism to selectively exclude clients or require re-authentication on rotation
- An attacker who obtained the previous token maintains persistent access through rotation

**Attack scenario**:
1. Attacker obtains API token (e.g., from logs, shoulder surfing QR code)
2. Attacker connects via WebSocket, authenticates with stolen token
3. Legitimate user notices suspicious activity, rotates the token
4. Server broadcasts new token to all clients, including the attacker
5. Attacker now has the new token and maintains access

**Recommendation**: Token rotation should invalidate all existing sessions immediately. Require all clients to re-authenticate with the new token. Do not broadcast the new token — instead, send a `token_rotated` event that forces clients to disconnect. The legitimate user re-enters the new token manually or scans a new QR code.

---

### 2. list_conversations and resume_conversation Bypass Schema Validation (Information Disclosure Risk)

**Severity**: High
**Status**: Open (broken, but security-relevant when fixed)

While the schema validation bug currently prevents these handlers from executing, when fixed, the `list_conversations` handler will return a list of all conversation files on the server machine, including metadata (titles, timestamps, file paths). The `resume_conversation` handler will load and transmit full conversation contents.

**Evidence**:
- `ws-message-handlers.js:427-440` — `list_conversations` calls the conversation scanner, returns file paths and metadata
- `ws-message-handlers.js:441-473` — `resume_conversation` loads conversation content from disk
- `conversation-scanner.js` — scans the Claude projects directory recursively
- No per-conversation access control — any authenticated client can list and read all conversations

**Security concern**: Once the schema bug is fixed, any authenticated client gains read access to the user's entire Claude conversation history. In a scenario where the token is compromised (see Finding #1), this exposes potentially sensitive data from past sessions.

**Recommendation**: Before fixing the schema bug, consider whether conversation history should require an additional authorization step (e.g., biometric confirmation on the app side). At minimum, add rate limiting to `list_conversations` and logging for `resume_conversation` access.

---

### 3. HIGH: launch_web_task Accepts Unbounded Prompt Text

**Severity**: High
**Status**: Open

The `launch_web_task` message handler accepts a `prompt` field with no length validation. An attacker (or a misbehaving client) can send an arbitrarily large prompt, which is passed directly to the Claude Code SDK. This could cause excessive memory allocation, slow processing, or unexpected billing.

**Evidence**:
- `ws-message-handlers.js` — `launch_web_task` handler reads `message.prompt` without length check
- `ws-schemas.js` — schema defines `prompt` as `z.string()` with no `.max()` constraint
- No server-side middleware enforcing a maximum message size on the WebSocket connection
- The prompt is forwarded to the SDK session, which may allocate proportional resources

**Attack scenario**:
1. Attacker connects with a valid token
2. Sends `launch_web_task` with a 100MB prompt string
3. Server attempts to process and forward to SDK, consuming memory and CPU
4. Repeated sends can exhaust server resources (denial of service)

**Recommendation**: Add a `.max(100000)` constraint to the prompt schema (100KB is generous for any reasonable prompt). Add a maximum WebSocket message size at the transport level (e.g., `maxPayload` option in the ws library). Log and reject oversized messages.

---

### 4. listDirectory Handler Exposes Entire Home Directory Tree

**Severity**: Medium
**Status**: Open

The `listDirectory` WebSocket handler (used by the dashboard for file browsing) accepts a path parameter and returns directory listings. There is no path restriction — any authenticated client can list any directory readable by the server process, including the user's home directory, `.ssh`, `.aws`, and other sensitive locations.

**Evidence**:
- `ws-message-handlers.js` — `listDirectory` handler calls `fs.readdir` on the provided path
- No allowlist of permitted directories
- No check that the path is within the project directory or workspace
- Path traversal via `../` sequences is not blocked (though the path is resolved, relative paths still navigate the full filesystem)

**Attack scenario**:
1. Attacker with a valid token sends `listDirectory` with path `/Users/victim/.ssh/`
2. Server returns the directory listing, revealing key file names
3. Attacker uses the file browser to map out sensitive directories

**Recommendation**: Restrict `listDirectory` to the current project directory and its descendants. Resolve the path and verify it starts with the allowed root before reading. Alternatively, maintain an explicit allowlist of browsable directories.

---

### 5. ENOENT Fallback in File Handlers Creates Path Traversal Risk

**Severity**: Medium
**Status**: Open

Several file-handling paths in the server use a pattern where an `ENOENT` error triggers a fallback to an alternative path or a parent directory search. If the fallback logic does not re-validate the resolved path, an attacker could craft a path that fails the initial read but resolves to a sensitive location in the fallback.

**Evidence**:
- Multiple handlers catch `ENOENT` and retry with modified paths
- Fallback paths are constructed by manipulating the original user-supplied path (e.g., stripping components, prepending directories)
- No consistent re-validation of the fallback path against an allowlist
- The pattern appears in file serving and project directory resolution

**Attack scenario**:
1. Attacker sends a path like `../../etc/passwd` (initial read fails with ENOENT on the prefixed path)
2. Fallback logic strips the prefix or resolves differently
3. If the fallback resolves to a valid sensitive path and the read succeeds, contents are returned

**Recommendation**: Validate the resolved path against an allowlist after every resolution step, including fallbacks. Use a single `isWithinAllowedRoot(resolvedPath)` check that runs on the final resolved path before any file I/O.

---

## Verdict

Chroxy's security posture is mixed. The fundamentals are right — token-based authentication, E2E encryption over the WebSocket channel, biometric lock on the app, and Cloudflare tunnel providing TLS. These are real defenses that protect against the most common attack vectors. The weaknesses are in the details: token rotation that broadcasts to attackers, unbounded input sizes, and file browsing without path restrictions. The conversation history feature, once its schema bug is fixed, will expose the user's entire Claude conversation history to any authenticated client with no additional authorization. The most actionable fixes are: (1) change token rotation to invalidate sessions rather than broadcast, (2) add input size limits to all schema fields, and (3) restrict file browsing to the project directory. These are straightforward changes that significantly reduce the attack surface.
