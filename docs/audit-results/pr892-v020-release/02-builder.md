# Builder Agent Report — PR #892 (v0.2.0 Release)

**Perspective:** Builder — focus on what is needed to ship, identify blockers vs. polish
**Rating: 3 / 5**

---

## Summary

The PR is a meaningful step toward a shippable v0.2.0. The core PTY removal is done and the version numbers are bumped in the right places. However, there are several items that will cause the first actual release to fail or produce incorrect output. These are not polish — they are correctness issues that will surface the moment someone runs the release pipeline or installs the published package.

---

## Findings

### 1. Tauri Signing Config — Release Blocker

In `packages/desktop/src-tauri/tauri.conf.json`, the macOS signing block uses literal `$VAR` strings:

```json
"signingIdentity": "$APPLE_SIGNING_IDENTITY",
"certificate": "$APPLE_CERTIFICATE",
"certificatePassword": "$APPLE_CERTIFICATE_PASSWORD"
```

Tauri v2 does not interpolate environment variables in `tauri.conf.json` at build time. These strings will be passed verbatim to `codesign`, which will fail. The release workflow sets these as environment variables on the runner, but that does not help if Tauri never reads them from the environment.

This is a **release blocker**. Signed desktop builds will not work.

**Fix:** Use Tauri's `beforeBuildCommand` to generate the config from a template, or use the `APPLE_SIGNING_IDENTITY` via the Tauri CLI's `--config` override flag at build time.

### 2. cli.js Hardcodes Version 0.1.0

In `packages/server/src/cli.js`, line 20 (approximately):

```js
.version('0.1.0')
```

The `package.json` for the server package now says `0.2.0`, but `chroxy --version` will still report `0.1.0`. This will confuse users and support workflows where version numbers matter.

**Fix:** Read the version dynamically:

```js
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { version } = require('../../package.json')
// ...
.version(version)
```

### 3. service.js Line 191 Still References node-pty

In `packages/server/src/service.js` around line 191, an error message or comment reads:

> "node-pty does not compile on Node 25"

This is a stale comment from the PTY era. The `node-pty` dependency was removed in this PR. The error message is now misleading — it references a dependency that is no longer in the project.

**Fix:** Remove or update the comment/error message.

### 4. Three describe.skip Tombstones (~300 Lines of Dead Test Code)

In `packages/server/tests/ws-server.test.js`, there are three `describe.skip` blocks covering PTY-related tests:

- `describe.skip('PTY session management', ...)` — approximately 100 lines
- `describe.skip('terminal output handling', ...)` — approximately 100 lines
- `describe.skip('session attach/detach', ...)` — approximately 100 lines

These blocks are not being skipped temporarily pending a fix — the functionality they test was deleted. They are tombstones. They inflate the test file, they do not run, and they create false confidence that someone is tracking these cases.

**Fix:** Delete the blocks entirely. If the test patterns are useful for reference, they belong in a commit message or PR description, not in the live test suite.

### 5. Dockerfile App Stub Still Says 0.1.0

In `packages/server/Dockerfile` (or equivalent), a label or `ENV` line reads:

```dockerfile
LABEL version="0.1.0"
```

or equivalent. The Dockerfile was not updated as part of the version bump.

**Fix:** Update to `0.2.0` or, better, parameterize it from `package.json` via build args.

---

## What Was Done Well

- PTY server entrypoint (`server.js`) removal appears complete.
- The `--terminal` CLI flag is removed.
- `package.json` version bumps are in the right packages.
- The CI workflow for tests is not broken.

---

## Prioritization

| Finding | Type | Blocks Release? |
|---------|------|-----------------|
| Tauri signing config | Bug | Yes — signed builds fail |
| cli.js version hardcoded | Bug | Yes — wrong version output |
| service.js stale comment | Cleanup | No |
| describe.skip tombstones | Cleanup | No |
| Dockerfile version | Cleanup | No |

---

## Conclusion

Two items block a clean release: the Tauri signing config and the hardcoded version in `cli.js`. The rest are cleanup debt that should be paid before the v0.2.0 tag is cut, not after. The PR is mergeable if the two blockers are addressed in a follow-up commit before the tag.

**Rating: 3/5** — the hard work is done, but two correctness bugs need fixing before the release tag.
