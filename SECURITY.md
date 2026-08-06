# Security Policy

Chroxy's daemon exposes your dev machine's AI coding sessions — and an embedded user
shell — over a tunnel, so it handles real authority: bearer tokens, permission decisions,
encrypted transport, and spawned provider binaries. Vulnerability reports are welcome and
taken seriously.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting.** It is the only channel this project
supports:

- **[Open a security advisory](https://github.com/blamechris/chroxy/security/advisories/new)**
- or: the repository's **Security** tab → **Report a vulnerability**

Please do **not** open a public issue, pull request, or discussion for a suspected
vulnerability. Public disclosure before a fix is available puts every deployment at risk.

### What to include

The more of this you can provide, the faster the triage:

- The affected component (`packages/server`, `packages/app`, `packages/dashboard`,
  `packages/desktop`, …) and version or commit SHA
- A description of the vulnerability and its impact
- Steps to reproduce, or a proof-of-concept
- Any suggested remediation

### What to expect

This is a single-maintainer project, so the timelines below are goals rather than
guarantees:

| Stage | Goal |
|-------|------|
| Acknowledgement of your report | Within 7 days |
| Initial assessment and severity triage | Within 14 days |
| Status updates while a fix is in progress | At least every 14 days |

Reports are handled through the advisory thread, so you can follow progress there. Once a
fix is released, the advisory is published and the reporter is credited unless they ask to
remain anonymous.

## Supported versions

Chroxy is pre-1.0. Security fixes land on `main`; there are no maintained release branches
and no backports.

| Version | Supported |
|---------|-----------|
| `main` | Yes |
| [Latest release](https://github.com/blamechris/chroxy/releases/latest) | Yes — fixes arrive via the next release |
| Older releases, forks, pinned commits | No — update to pick up fixes |

## Scope

The security model is documented in [`docs/security/`](docs/security/) — reports that
engage with it are the fastest to triage:

- [Bearer-token authority](docs/security/bearer-token-authority.md) — the token classes
  (primary / pairing-bound / hook secret) and what each one grants
- [Permission floor](docs/security/permission-floor.md) — the protected-path / secret-read
  floor that must hold in **every** permission mode, on both the in-process and the
  hook-routed pipeline
- [Encryption threat model](docs/security/encryption-threat-model.md) — transport-layer key
  exchange and message encryption
- [Credentials at rest](docs/security/credentials-at-rest.md) — OS-keychain-backed secret
  storage (macOS Keychain / Linux libsecret / Windows DPAPI)
- [Spawned-binary provenance](docs/security/spawned-binary-provenance.md) — provider-binary
  integrity and the supply-chain threat model

In scope, in particular:

- **Auth bypass** — reaching session state, the dashboard, or the embedded user shell
  without a valid token, or escalating a lesser token class (pairing-bound, hook secret) to
  primary authority
- **Permission-floor bypass** — including under deliberately lenient permission modes
  (`auto`, `acceptEdits`, a broad allow rule): the floor is designed to hold there, so a
  hole in it is a vulnerability, not a configuration choice
- **Transport** — breaking or downgrading the end-to-end encryption over the tunnel
- **Isolation escape** — escaping a Docker-container or worktree-isolated session into the
  host
- **Binary provenance** — getting the daemon to spawn or trust a tampered provider binary

Out of scope:

- Deployments with documented safeguards explicitly disabled (e.g. `--no-auth`, which is a
  local-development affordance)
- Findings that require a pre-existing compromise of the host or the operator's credentials
- Vulnerabilities in third-party dependencies with no exploitable path through this
  codebase — report those upstream
- Automated scanner output submitted without a demonstrated impact

## Safe harbor

Good-faith security research under this policy is welcome. A local build and your own
daemon are enough to demonstrate anything in scope — do not test against other people's
machines, sessions, or data, do not degrade service for others, and allow a reasonable
window to remediate before disclosing publicly.
