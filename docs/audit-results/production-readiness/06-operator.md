# Operator Audit — On-Call SRE

**Overall Rating: 3.5/5**

## Key Findings

### 1. Silent Error Swallowing (7+ Instances)
At least 7 empty `.catch(() => {})` blocks across the codebase. These create silent failures that are invisible to operators. When something breaks in these paths, there is zero signal — no log, no metric, no alert.

### 2. Expo Push Has No Retry or Circuit Breaker
Push notification delivery is fire-and-forget. If the Expo Push API returns an error or is unreachable, the notification is permanently lost. No retry queue, no circuit breaker to stop hammering a down service, no metric tracking delivery success rate.

### 3. Tunnel Verification Proceeds Silently After 10 Failures
The tunnel verification loop retries 10 times, then proceeds as if the tunnel is healthy. No warning is logged. The QR code is displayed with a potentially non-functional URL.

### 4. No Request Correlation IDs
Messages flow through multiple components (WS server, session manager, session, child process) with no correlation ID linking them. Tracing a single user action through server logs requires timestamp matching and guesswork.

### 5. No Backpressure or Rate Limiter Metrics Logged
The rate limiter silently drops messages without logging. Backpressure state (WebSocket buffer depth, pending message count) is never recorded. An operator cannot distinguish "client stopped sending" from "rate limiter is dropping everything."

## What's Good

- **Logger design**: The logger module is well-structured with appropriate levels and context.
- **Session lifecycle tracking**: Session create/destroy events are logged with session IDs and timing.
- **Crash handlers**: SIGTERM/SIGINT handlers exist and attempt graceful shutdown.

## Verdict

Operability is the weakest dimension of the system. The server works well when everything is working. When things go wrong — push failures, tunnel issues, resource exhaustion — there is insufficient signal to diagnose problems without attaching a debugger. Adding structured logging to the silent-catch paths and basic metrics would significantly improve on-call experience.
