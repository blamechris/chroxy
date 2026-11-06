# Declared session status

A session can declare its intent separately from Chroxy's observed provider activity.
`isBusy`, provider liveness, permissions and restart behavior keep their existing
meaning. A declaration does not start work or approve anything.

The optional `declaredStatus` on each session-list entry contains `state`, a
`summary` of at most 280 characters, optional `next`, `blockedOn`, `etaMinutes`
and `decision`, and server-assigned `updatedAt` (epoch milliseconds) and `source`
(`marker`, `api` or `hook`). States are `running`, `idle`, `blocked`, `stalled`,
`done`, and `unknown`. Status updates broadcast `session_status` with the session
id and this same object. Session-info delivery replays it alongside the activity
snapshot. Both survive daemon recovery in the existing session-state file.

## Assistant declarations

At the end of a completed assistant message, use either a standalone marker:

```text
[chroxy-status] running: Verifying the final commit
```

Or the established four-slot footer:

```text
**Status:**
- ✅ Tests passed
- 🔄 none
- ⛔ Waiting on a target
- 🔶 DECISION: Choose production or staging; recommend staging

**Next:** 🔴 BLOCKED — Choose the target OWNER: Chris
```

Bold Markdown, whitespace and CRLF are accepted. The four slots must be present
in order. Indented task bullets may follow the in-flight slot. The final `Next`
line retains its task text and maps `🟢 RUNNING`, `⚪ IDLE`, `🔴 BLOCKED`, and
`🟠 FAILED` to `running`, `idle`, `blocked`, and `stalled`. An unsupported token
is recorded as `unknown`; Chroxy does not guess that work is done. A standalone
trailing `Next:` line is a compatibility alias and carries no decision change.

Only the latest complete assistant response of a normally completed turn is considered. A bounded parsed candidate waits for the result; stop, failure and interrupted or truncated outcomes discard it. Deltas, user/system messages,
reasoning, oversized or truncated responses, quoted or fenced code, marked
examples, malformed footers and declarations followed by narrative are ignored.
Extraction is deterministic, limited to 128 Ki characters, and never asks a model
to repair output. Within a message only the final declaration is current.

A nonempty decision other than case-insensitive `none` creates or updates one
stable `decision:session` activity entry, with kind `decision` and status
`blocked`. Control Room, the header attention count and the desktop badge use
this existing activity pipeline. A normal turn ending, a reconnect, a later
message without a valid footer, or a status update without a decision cannot
silently clear it. An explicit `DECISION: none` ends only this session decision;
permission requests and questions remain independent.

## HTTP and hook updates

`POST /api/sessions/:id/status` accepts a JSON declaration with `state`, `summary`
and the optional fields above. The primary bearer token or a pairing token bound
to exactly that session may write. Unbound pairing, sibling-session, hook and
ingest credentials are refused by this route. Successful replies are
`{ "ok": true, "declaredStatus": { ... } }`. Invalid fields return 400, missing
sessions 404, unauthorized callers 403, and bodies over 4096 bytes 413. Callers
cannot supply `source` or `updatedAt`.

The existing ingest-secret-only `POST /api/events` also accepts `type: "status"`.
Its envelope must name an exact managed `sessionId`, with declaration fields in
flat `data` and the usual `source` and `ts`. Unknown or absent targets are refused.
This write-only path sets status source to `hook`; it grants no session reads,
input, permission responses or execution. API/hook `decision: "none"` explicitly
clears the same decision; omitting `decision` preserves it.
