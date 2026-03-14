# Builder Audit — Pragmatic Full-Stack Dev

**Overall Rating: 3.2/5**

## Key Findings

### 1. Missing Global Error Handlers on HTTP/WS Servers
Neither the HTTP server nor the WebSocket server has a `.on('error')` handler. An `EADDRINUSE` or socket error crashes the process with an unhandled exception instead of graceful recovery.

### 2. Unhandled Promise Rejections Lack Diagnostic Context
Several `catch` blocks either swallow errors entirely or log only the message without stack traces, request context, or session IDs. Debugging production issues from these logs is impractical.

### 3. Config Validation Too Permissive
No range checks on critical parameters:
- `port` accepts negative numbers or values above 65535
- `maxSessions` has no upper bound
- `sessionTimeout` accepts zero or negative values
Any of these would cause confusing downstream failures.

### 4. Supervisor Deploy Rollback Has No Circuit Breaker
If a deploy fails and rollback also fails, the supervisor retries the full deploy cycle indefinitely. No mechanism to halt after N consecutive rollback failures.

### 5. Permission Responses Exempt from Rate Limiting
The rate limiter applies to general messages but not permission responses. A malicious client could flood permission responses to overwhelm the session process.

## Additional Issues

- **push.js fetch has no timeout**: If the Expo Push API hangs, the fetch call blocks indefinitely. No `AbortController` or timeout wrapper.
- **Auth timeout cleanup not atomic**: The auth timeout fires and cleans up the connection, but if auth succeeds in the same tick, both paths execute.
- **No backpressure monitoring**: WebSocket `bufferedAmount` is never checked. Fast producers can exhaust memory.

## Verdict

Solid architecture for a single-user dev tool. The gaps are all in hardening — error boundaries, input validation, and resource limits that matter when the system runs unattended or faces adversarial input.
