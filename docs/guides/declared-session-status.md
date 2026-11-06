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
Internal decision lifecycle timestamps are saved alongside the declaration,
including the last ended lifetime after a clear; callers cannot supply this
metadata.

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

Bold structural labels, whitespace and CRLF are accepted. Literal underscores
and asterisks inside summaries, decisions and task text are preserved. The four
slots must be present
in order. Indented task bullets may follow the in-flight slot. The final `Next`
line retains its task text and maps `🟢 RUNNING`, `⚪ IDLE`, `🔴 BLOCKED`, and
`🟠 FAILED` to `running`, `idle`, `blocked`, and `stalled`. An unsupported token
is recorded as `unknown`; Chroxy does not guess that work is done. A standalone
trailing `Next:` line is a compatibility alias and carries no decision change.

A declaration is applied from the latest complete assistant response at
provider-reported normal completion. SDK and Claude CLI full assistant records join the text blocks of
that message; Codex uses completed assistant items independently of its display
stream. Gemini CLI 0.46 assistant `message` deltas form one bounded response up
to its next tool request or result. A later response without a valid declaration
replaces the parsed candidate. A separate internal success flag gates application
at the result; stop, failure and interrupted or truncated outcomes discard it.
SDK responses and terminal events carry an internal immutable request identity.
A superseded query's accounting result still records usage, but cannot apply,
replace or discard the successor's declaration candidate. These identities stay
in memory and are separate from the public status model.
SDK completion also checks the existing session-sticky sidecar stdin-disabled
flag. Known input-channel loss vetoes declaration application until the session
is restarted; the session-wide callback receives no fabricated query identity.

Gemini limit, loop-stop and blocked diagnostics veto declaration application,
even if a later result says success. Informational warnings remain distinct.
Gemini CLI 0.46 also has a native stop path that emits the same success result
without a stream-json diagnostic; that wire cannot distinguish the stop from
normal completion. Chroxy uses the provider-reported completion in that case and
does not invent a missing stop signal.

Deltas, user/system messages,
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

Session decisions appear in attention counts and Control Room even while another
session is selected. Live delivery shares only bounded declared status and the
stable session-decision activity; response text and other work remain scoped to
session viewers. The session list includes optional server-authored
`decisionActivity` lifetime metadata (`startedAt` when pending, `endedAt` as the
last clear fence). Reconnect uses those original times to restore or clear only
the decision, preserving permissions and other activity. Status write callers
cannot supply this metadata. Older servers omitting it leave local activity alone.
