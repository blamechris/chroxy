# Chroxy Pages — design

Publish a generated HTML artifact (a status report, a diff summary, an agent-built
page) to an **unguessable URL served from the user's own daemon** over the
Cloudflare tunnel they already run — viewable on any device, no GitHub, no
external host.

```
chroxy publish report.html
→ https://<your-tunnel>.trycloudflare.com/p/Xa9f8k2…/
```

This is the self-hosted equivalent of "agent makes a hosted page": the page is
served from infrastructure the user controls, which matches the product goal of
*feeling native to your own system* rather than a third-party host.

## Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Hosting | **Native chroxy-served** over the existing HTTP server + tunnel | ~90% of the infra (HTTP router, tunnel, auth) already exists; served from the user's machine |
| Access control | **Unguessable share link** (per-page random slug) | Open on any device with no token; link = capability |
| Page content | **Static-only (no JS / no network) by default** | Makes share-links safe under chroxy's cookie auth (see Security); perfect for reports |

GitHub Pages export and Quartz vault were considered and deferred to follow-ups
(permanence/portability at the cost of an external repo + build step).

## Architecture

- **Storage:** `~/.chroxy/pages/<slug>/` (respects `CHROXY_CONFIG_DIR`), entry
  `index.html` plus optional co-located assets. A manifest
  `~/.chroxy/pages/index.json` (atomic temp+rename write) tracks
  `{ slug, title, createdAt, bytes, entry }`.
- **Slug = capability:** `crypto.randomBytes(16)` → base64url (~22 chars),
  cryptographically random, never sequential. The link is the access grant.
- **Serve route:** `GET /p/<slug>/<path?>` in `http-routes.js`, **intentionally
  unauthenticated** (that is the share model), registered in the public-route
  section alongside `/health` and `/connect`.

## Security model (the crux)

chroxy auth accepts a `chroxy_auth` **cookie** (ws-server.js `_validateBearerAuth`),
not only header/query tokens. A page served same-origin as the dashboard, opened
in a browser that holds that cookie, could otherwise `fetch()` authed `/api/*`
endpoints with the operator's ambient credential. Layered mitigations:

1. **Static-only CSP on every served response:**
   `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:; connect-src 'none'; script-src 'none'; sandbox;`
   plus `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`,
   `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
   `connect-src 'none'` + `script-src 'none'` mean a served page **cannot run JS
   or make network calls** → the cookie-credential risk is neutralized. Interactive
   pages would be an explicit opt-in on an isolated origin (follow-up).
2. **Strict containment:** the slug is validated against the base64url charset
   *and* must exist in the manifest before any filesystem access (never serve an
   arbitrary path). The resolved file path is asserted to stay under
   `~/.chroxy/pages/<slug>/`; `..`, absolute paths, and symlinks that escape the
   page directory are rejected.
3. **Rate-limit** the public route via the existing `getRateLimitKey` + limiter.
4. **Disk hygiene:** per-page and total-size caps reject oversized publishes;
   `chroxy pages rm <slug>` revokes a link instantly (deletes the dir + manifest entry).
5. New token class **"page share slug"** documented in
   `docs/security/bearer-token-authority.md`.
6. **Serve-side size ceiling** — the per-page byte cap is re-checked on serve
   (`statSync` vs `maxPageBytes`), not only at publish time, so a file that ever
   grows past the cap can't be read unbounded into memory.

**Accepted risk:** `GET /p/<guess>` returns `301` for an existing slug and `404`
for a missing one — a slug-existence oracle. Against 128-bit random slugs under
the per-IP rate limit this is academic (you cannot enumerate the space), so it is
accepted rather than masked.

## Publish & manage flow

- **CLI:** `chroxy publish <file|dir> [--title "…"]` → copy in, mint slug, print
  the full tunnel URL (or the LAN/local URL with a note when no tunnel is up).
  `chroxy pages list` / `chroxy pages rm <slug>`.
- **Server endpoint:** `POST /api/pages` (bearer-gated) `{ title, html | sourcePath }`
  → `{ slug, url }`, so the **agent** can publish from its own shell and the
  dashboard can wire a "Publish" button to the same endpoint.

## Scope

**MVP (this epic):**
- PR-1 — core serve + security: `pages-store.js` (manifest, slug, containment,
  size caps), the `/p/<slug>` route with CSP/security headers, tests, security-doc
  update. *(security-sensitive — adversarial review)*
- PR-2 — publish surface: `POST /api/pages` endpoint + `chroxy publish` /
  `chroxy pages list|rm` CLI + tests.

**Follow-ups (separate issues):**
- Dashboard "Pages" panel (list, copy-link, delete) + a "Publish this artifact" button.
- GitHub Pages export target.
- Quartz vault target.
- Interactive / JS pages served from an isolated origin.

## Testing

Path-traversal rejection (encoded `..`, symlink escape) · unknown/malformed slug
→ 404 · correct MIME + all security headers present on served responses · manifest
CRUD · size-cap rejection · rate-limit behaviour · `CHROXY_CONFIG_DIR` redirection
so tests never touch the real `~/.chroxy`.

## Out of scope (explicitly)

Custom domains · page versioning/editing · interactive JS pages (until the
isolated-origin follow-up) · the terminal input-latency / native-feel workstream
(tracked separately — Pages does not address it).
