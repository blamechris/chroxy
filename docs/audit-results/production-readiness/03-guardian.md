# Guardian Audit — Paranoid SRE

**Overall Rating: 3.2/5**

## Failure Mode Catalog

### FM-01: Orphaned Child Processes on Respawn Race
When the supervisor respawns rapidly (e.g., crash loop), the previous child process may not have fully exited. The new spawn proceeds without confirming the old PID is dead, leaving orphaned processes consuming resources.

### FM-02: EventEmitter Listener Leak on Session Destroy
Session destruction removes some listeners but not all. After 50+ session create/destroy cycles, the accumulated listeners trigger the Node.js MaxListenersExceeded warning and degrade performance.

### FM-03: Permission Timeout Race Condition (Double-Settle)
The permission timeout and the user response can resolve in the same event loop tick. Both paths attempt to settle the pending promise, leading to unpredictable behavior (the second settlement is silently ignored by the Promise spec, but side effects from both paths execute).

### FM-04: Supervisor Start Failure Doesn't Trigger Restart
If the child process fails during startup (before it signals "ready"), the supervisor does not treat this as a crash requiring restart. The system sits in a permanently broken state.

### FM-05: Expo Push API Failures Silently Dropped
When `push.js` fails to deliver a notification (network error, 429, 500 from Expo), the error is caught and discarded. No retry, no dead-letter queue, no metric. Notifications are silently lost.

### FM-06: Standby Server EADDRINUSE Retry Resets Counter
The standby health server retries binding on `EADDRINUSE`, but a transient success resets the retry counter. If the port flaps (bind succeeds then fails), the server retries indefinitely instead of escalating.

## Additional Concerns

- **Stream state not atomic on child crash**: If the child process dies mid-stream, the in-flight message state (partial content blocks, pending tool results) is left in an inconsistent state. Reconnecting clients receive stale partial data.
- **Plan mode flag not cleared on process death**: `_inPlanMode` persists across child restarts. If the child crashes during plan mode, the new session incorrectly believes it is still in plan mode.

## Verdict

The failure modes are survivable for a single-user tool where the operator can manually restart. For unattended operation (supervisor mode), FM-01 and FM-04 are the most concerning — they can leave the system in states that require manual intervention.
