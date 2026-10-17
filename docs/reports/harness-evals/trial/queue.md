# Trial queue

**Status: not yet set.** A candidate list (12 primary + 4 alternates, with the
rule that excluded every rejected issue) is being prepared from the open backlog
under the rules in `PROTOCOL.md` §5. The owner picks 8–12 from it, writes the
sealed key in the vault, and the final list is entered in
`scripts/queue.json` and rendered into the four missions with
`python3 scripts/render_missions.py`.

The queue must be identical in all four missions; the renderer guarantees that.
