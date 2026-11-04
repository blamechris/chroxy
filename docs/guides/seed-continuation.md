# Continue from a handoff seed

A successful `session-seed.py write` can announce a handoff to a running daemon.
The dashboard shows **Wave complete — next session ready**, the absolute seed
path and the session folder. **Continue from seed** opens the normal session
picker in that folder. After creation, the path is staged as an editable message
in the composer. Review or change it, then press Send when ready.

This path does not summarize a conversation or call a model. The announcement
and dashboard carry path strings only; the daemon checks filesystem metadata
without reading the seed body. Cancelling the picker or opening a plain new
session clears the pending seed.

The writer is maintained in `blamechris/skill-templates`, at
`assets/scripts/session-seed.py`. Its announcement uses the same discovery knobs
as `chroxy-hooks`: `CHROXY_CONFIG_DIR` (default `~/.chroxy`), `config.json` host and
port, and the daemon's same-user, mode-0600 `ingest-secret`. Environment overrides
are `CHROXY_INGEST_URL` and `CHROXY_INGEST_SECRET`. Wildcard bind hosts resolve to
loopback. Plain HTTP endpoints must be loopback; an explicit remote endpoint
requires HTTPS. `CHROXY_SEED_ANNOUNCE=0` disables announcements. A linked worktree
announces its main checkout folder so continuation survives worktree teardown.

The writer announces only after its canonical proof succeeds. It makes one
request, with a 250 ms socket timeout and a 750 ms total child-process deadline
covering configuration reads and DNS too. Missing credentials, an offline daemon,
HTTP errors, redirects and timeouts leave the seed, writer output and successful
exit unchanged. There is no retry queue. Unproved test writes and pulse-only
metadata refreshes do not announce a completed wave.

The authenticated contract is:

```json
{
  "source": "session-seed",
  "type": "wave_complete",
  "ts": 1793491200000,
  "data": {
    "seedPath": "/vault/handoffs/NEXT-demo.md",
    "cwd": "/projects/demo"
  }
}
```

`POST /api/events` accepts the ingest bearer secret only. The `wave_complete`
event requires source `session-seed`, absolute `seedPath` and `cwd` strings of at
most 4096 characters, and no extra data fields. It sends the notification
pipeline a `continuation` category with category ID `continuation`. Its setting
appears as **Session continuation**; category preferences and quiet hours apply,
and it does not bypass quiet hours by default. Mobile action execution is a
separate feature; this dashboard flow always leaves Send to the operator.

`GET /api/continuations` is a global, primary-bearer-only, read-only endpoint.
The ingest secret and session-bound tokens cannot list these paths. The dashboard
refreshes it while connected and visible, every 15 seconds and on focus, and
checks again before opening the session picker. Metadata checks run in a dedicated
child with a 200 ms deadline and one-child concurrency limit; timeouts offer the
manual path. Expired entries skip filesystem probes. Notification muting does not hide
the dashboard list.

Opportunities last for the current daemon lifetime, with at most 50 paths retained.
Redelivery of the same path and timestamp does not duplicate a row, resend push
or extend its freshness. A newer announcement replaces that path's row. Missing
files or folders, changed seed metadata and announcements older than 30 minutes
disable Continue and retain the selectable path for manual recovery. A failed
recheck also leaves the path visible and creates no session. After a daemon
restart, use the writer's printed path manually or write a fresh seed. There is
a small interval between the final metadata check and eventual user Send;
the provider reports a file that disappears during that interval just as it would
for a manually pasted path.
