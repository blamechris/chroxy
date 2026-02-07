# QA Audit Log

Living record of manual QA testing against the [smoke test checklist](smoke-test.md). Coverage matrix shows at-a-glance status; test history provides the full audit trail.

**Status values:** `PASS` | `FAIL` | `PARTIAL` | `STALE` | `--` (untested)

---

## Coverage Matrix

| Scope | Status | Last Tested | SHA | Tester | Notes |
|---|---|---|---|---|---|
| Regression Baseline | PASS | 2026-02-06 | `5f35b9a` | Chris | |
| Connection | -- | | | | |
| Chat | PASS | 2026-02-06 | `5f35b9a` | Chris | Basic streaming verified |
| Permissions | -- | | | | |
| Model Switching | -- | | | | |
| Cost/Usage Display | -- | | | | |
| No-Auth Mode | -- | | | | |
| Message Selection | -- | | | | |
| Input Modes | -- | | | | |
| Terminal (PTY) | -- | | | | |
| Shutdown/Cleanup | -- | | | | |
| Edge Cases | -- | | | | |

---

## Test History

### 2026-02-06 -- Chris @ `5f35b9a` (v0.1.0)

**Scopes Tested:**

| Scope | Result | Notes |
|---|---|---|
| Regression Baseline | PASS | Server starts, QR scans, chat works |
| Chat | PASS | Streaming response verified |

**Device/Platform:** iPhone, Expo Go
**Server Mode:** CLI headless (default)

**Notes:**
- Initial QA audit log entry after PR #35 merge
