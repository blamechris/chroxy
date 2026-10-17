# Trial queue

**Status: set (2026-10-17).** The owner approved the supervisor's suggested default
from [`queue-candidates.md`](queue-candidates.md). The list lives in
`scripts/queue.json` and is rendered identically into all four missions by
`python3 scripts/render_missions.py`.

| # | Issue | Type |
|---|---|---|
| 8233 | `chroxy doctor` ignores the configured port | bug, server |
| 8215 | `isLoopbackHost` accepts non-loopback mapped addresses | bug, server |
| 7771 | `updateContextWindow` admits NaN | bug, server |
| 8595 | custom model collision labels repeat pinned descriptors | bug, store-core |
| 8364 | lone tool bubble / detail modal show no terminated state | bug, app |
| 8282 | record the stream kind on history entries | feature, server + protocol |
| 8277 | Settings hides dormant provider override, no migration notice | feature, dashboard |
| 8567 | `DEFAULT_BYPASS_CATEGORIES` hand-copied in both clients | cross, protocol + 3 clients |
| 8303 | Browse is `$HOME`-only while Create honours `workspaceRoots` | cross, server + dashboard |
| 7815 | doctor test hardcodes port 59123 | test, server tests |

Stratification: 5 bugs, 2 features, 2 cross-package, 1 test. Note for graders:
#8233 and #7815 both touch doctor port handling (`cli/doctor-cmd.js` and
`tests/doctor.test.js`), so a run may reasonably sequence or combine them; record
which it did.

**Sealed key:** the owner writes one private note per issue in the vault before
run 1 (PROTOCOL.md §5). Nothing from it enters this repository until step 11.
