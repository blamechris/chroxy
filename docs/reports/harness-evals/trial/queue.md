# Trial queue

**Status: candidates ready, owner pick pending.** The candidate list is
[`queue-candidates.md`](queue-candidates.md): 12 primary + 4 alternates, every
rejected issue listed with the rule that excluded it. The owner picks 8–12, writes
the sealed key in the vault, and the final list is entered in
`scripts/queue.json` and rendered into the four missions with
`python3 scripts/render_missions.py`.

Supervisor's suggested default (10): #8233, #8215, #7771, #8595, #8364, #8282,
#8277, #8567, #8303, #7815 — 5 bugs, 2 features, 2 cross-package, 1 test;
server, dashboard, app, store-core and protocol all touched. Dropped from the
primaries: #8188 (cosmetic, fallback branch thin) and #7612 (Linux `/proc` path
cannot be exercised natively on the Mac runs). Alternates if any pick is
rejected: #8188, #7612, #8226, #8005.

The queue must be identical in all four missions; the renderer guarantees that.
