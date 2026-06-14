> **Ported to `main` and verified 2026-06-14 (blamechris).** Re-checked every load-bearing
> *internal* claim against `main` at port time: the default provider was `claude-sdk`
> (`server-cli.js:531`), the `billing-class.js` era boundary
> (`PROGRAMMATIC_CREDIT_ERA_START = Date.UTC(2026,5,15)` — **on/after** which claude-sdk/claude-cli
> flip to programmatic-credit and before which they still bill as flat subscription; claude-tui is
> subscription in both eras), and the `docs/providers.md:9` "bypasses the programmatic credit
> pool" copy — all confirmed. One correction: **#3951 (channels spike) is CLOSED**, so rec #5's
> durable-successor work lives in its impl sub-issues (#3952–#3956), not the spike.
> External/competitor claims are trusted at the confidence levels the doc states.
>
> **Decisions taken 2026-06-14 (after this audit).** The "decide today" items in the BLUF were
> acted on the same day — this audit is the point-in-time analysis that informed them, kept as the
> record:
> - **Default provider flipped `claude-sdk` → `claude-tui`** (the audit's BLUF #2 gap). This is
>   **Option B**, which the audit explicitly leans *against* (it productizes the ToS-adverse
>   loophole, §Part 1 Model B). Chosen deliberately to keep zero-config setups off the metered
>   programmatic-credit pool at the cutover; BYOK remains the guaranteed-billing fallback.
>   #5819 → PR #5822 (merged). The default now lives in one place (`@chroxy/protocol`
>   `DEFAULT_PROVIDER`) — #5823 → PR #5824 (merged).
> - **Honest billing copy shipped** — README + `docs/providers.md` now hedge the subscription
>   bet as best-effort/not-guaranteed rather than asserting it. PR #5820 (merged).
> - **`chroxy doctor` billing canary** to detect reclassification (claude-tui drawing
>   programmatic cost = the bet broke) — PR #5821.
> - **The durable successor remains `claude --channels`** (rec #4 / #5), not a better scrape.

---

# Audit: Chroxy's June‑15 Subscription‑Billing Strategy

> **Prepared:** 2026‑06‑14 (one day before the Anthropic cutover) · **Origin:** ported from an ephemeral investigation branch
> **Method:** multi‑agent research — codebase cartography + 6 web/competitor research personas + chroxy issue‑tracker review.
> **Scope of the question:** Is driving the interactive `claude` TUI under a PTY the *best* way to preserve subscription billing after June 15 — and is there a tmux / terminal‑multiplexer approach that's better? What do competitors (Happy, code‑puppy, …) do?
> **Honesty note:** every load‑bearing external claim is cited; items that could not be verified against a primary source are tagged **[UNVERIFIED]**.

---

## Executive summary (BLUF)

1. **The premise is half‑right, and the load‑bearing half is a loophole on borrowed time.** The June‑15 change is real and Anthropic‑confirmed (interactive terminal Claude Code *does* stay on the subscription). But chroxy's bet — that a **daemon‑driven** interactive TUI bills as "interactive" — is exactly the maneuver Anthropic's own coverage list names ("third‑party apps that authenticate with your Claude subscription") and that the single most on‑point precedent (`multica#2815`, evaluating an identical PTY‑TUI PR) says **does not shift billing buckets**. It probably works *mechanically* on June 16; it is **not durable and is ToS‑adverse**.

2. **The most urgent gap is unrelated to the mechanism: the default provider is still `claude-sdk`.** Out of the box, tomorrow, default sessions draw metered credits (Pro = $20/mo, no rollover). `claude-tui` is built, hardened (epic #5338 gate essentially complete), and documented — but **opt‑in only**, with **no issue or PR on record** to flip the default or prompt existing users. Decide this today.

3. **node‑pty is fine; the audit's scary findings are already fixed.** The only structural win left is *process persistence + crash isolation*, and the way to get it is **not** plain `tmux send-keys` (that's *worse* — Anthropic's own Agent Teams tmux backend hit send‑keys races) but the **claude‑squad hybrid**: host `claude` in a detached multiplexer (`abduco`/`tmux -d`) and attach node‑pty to it. Worth doing, not urgent.

4. **The real strategic successor is `claude --channels`, not a better scrape.** Same subscription ride, but a *documented Anthropic MCP protocol* with streaming + first‑party permission relay instead of a visual scrape. Already spiked + scaffolded (#3951). That, plus honest billing copy, is the durable play.

5. **Competitors validate the technique but none has a durability answer — and chroxy is the most deliberate player.** Happy (closest competitor) actually runs its *remote* path on the soon‑to‑be‑metered Agent SDK and has shipped no mitigation; code‑puppy sidesteps entirely with BYOK. Chroxy is alone in having a billing‑class engine, a hardened interactive provider, and a channels successor — and is also the one most exposed by its own marketing.

---

## Part 1 — Is the premise sound? (Reframe)

The original question ("is the TUI the best way?") is downstream of a bigger one: **does *any* interactive‑wrapper approach survive June 15, and at what account risk?**

**The change is confirmed by Anthropic's own support article** ([support.claude.com/articles/15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). Effective **June 15, 2026**, a separate monthly **Agent SDK credit** ($20 Pro / $100 Max 5x / $200 Max 20x, full API rates, **no rollover**, claim‑once) covers:

- Claude Agent SDK (Python/TS)
- `claude -p` (non‑interactive mode)
- Claude Code GitHub Actions
- **"Third‑party apps that authenticate with your Claude subscription through the Agent SDK"**

Stays on the subscription: *"Interactive Claude Code in the terminal or IDE,"* web/desktop/mobile chat, Cowork.

### Two competing models of how billing is decided

The strategy lives or dies on which model is true:

| | **Model A — mechanistic** (chroxy's bet) | **Model B — behavioral / account‑level** |
|---|---|---|
| Billing keys on… | the `--print`/SDK **code path** of the spawned process | the **auth method + behavior** (automation patterns, datacenter IPs, missing telemetry) |
| Evidence for | `claude-code#43333`: `-p` flips billing even with OAuth → *not* using `-p` (interactive) uses the subscription path. Chroxy's May proxy spike observed interactive `claude` sending an **OAuth subscription bearer** with `(external, cli)` UA. | `multica#2815`: *"the daemon still spawns its own claude process, which Anthropic classifies as programmatic regardless of whether the binary renders a TUI."* Anthropic's coverage list explicitly names third‑party subscription‑auth apps. Jan–Apr 2026 OpenClaw enforcement. |
| Implication | Works on June 16. | Already in‑scope for metering; enforcement‑exposed. |

**Honest verdict:** On day one, Model A probably holds — an interactive `claude` (no `-p`) mechanically uses the subscription code path even when keystroke‑driven, so chroxy likely *does* still bill as subscription on June 16. **But** it falls squarely inside the *class* Anthropic's policy targets, the most analogous project says it doesn't even work, and Anthropic has a **demonstrated** enforcement apparatus it "reserves the right to … enforce … without prior notice":

- Jan 2026 silent server‑side block broke OpenClaw/OpenCode/Cline/Roo/Goose overnight.
- **Detection of exactly this class of trick:** OpenCode was caught spoofing the `claude-code-20250219` beta header; Anthropic "tightened our safeguards against spoofing the Claude Code harness" (named MTS, Thariq Shihipar).
- Token binding: *"This credential is only authorized for use with Claude Code and cannot be used for other API requests."*
- **Datacenter‑IP flagging** — directly relevant, since chroxy daemons typically run on cloud dev boxes behind Cloudflare tunnels (the Hetzner/Cloudflare ranges cited in `claude-code#21678`); bans within 20 minutes are documented.

**ToS basis** ([anthropic.com/legal/terms](https://www.anthropic.com/legal/terms) §3): accessing the Services "through automated or non‑human means… *Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it.*"

> ⚠️ **Concrete finding (action item).** `docs/providers.md:9` and the README assert `claude-tui` *"bills as your Claude subscription's interactive allowance and **bypasses the programmatic credit pool**"* — stated as settled fact. The evidence does **not** support stating it as fact; it's an unverified, contested, ToS‑adverse bet. Soften this copy before June 15.

---

## Part 2 — Time‑critical gap (decide today)

At audit time, `packages/server/src/server-cli.js:531` → `const providerType = config.provider || 'claude-sdk'`. The **default was `claude-sdk`**, one of the two providers `billing-class.js` flips to `programmatic-credit` **on/after** the `Date.UTC(2026, 5, 15)` boundary (before it, claude-sdk/claude-cli still bill as flat subscription). `docs/providers.md` framed `claude-sdk` as *"the right choice for most users."* **(Resolved since — the default was flipped to `claude-tui` and now lives in `@chroxy/protocol` `DEFAULT_PROVIDER`; see the "Decisions taken" addendum at the top.)**

- Epic **#5338** (TUI hardening) migration gate — Phases 0–4 + WP‑3.1/4.1 — is **essentially complete** (verified: `--resume`, per‑session respawn, daemon‑crash guard, and auth‑failure detection all landed). `claude-tui` is *ready* to be primary by chroxy's own gate.
- Yet **no issue or PR** flips the default or prompts existing users at the boundary (PR search empty).

**Independent of the durability debate:** even if you steer users to BYOK instead of the TUI, *something* must change before tomorrow, because the silent default is "metered credits."

---

## Part 3 — Is the TUI the best *mechanism*? (node‑pty vs tmux vs channels)

**Reality‑check first — three of the scariest items from the 2026‑06‑07 audit are already fixed in current code** (verified against `claude-tui-session.js`, not the stale doc):

| Audit finding (as written) | Current reality | Anchor |
|---|---|---|
| "interactive `claude` has no resume / context lost on restart" | `--resume` works; `resumeSessionId` persisted; respawn replays it | `claude-tui-session.js:946, 1430‑1432`, `resume:true` |
| "one PTY death bricks the session" | per‑session bounded respawn + drop‑and‑retry‑FRESH | `:1150, 1286‑1342` (#5315/#5348) |
| "PTY error crashes whole daemon" | 2‑listener guard pushes node‑pty's `listeners('error').length ≥ 2` | `:1506‑1522` |

**What node‑pty *structurally cannot* fix:** the live `claude` dies with the daemon. `--resume` is a *cold* re‑warm (re‑onboarding, lost in‑flight turn, long‑context focus loss). Only a **detached multiplexer** makes `claude` outlive the daemon so re‑attach is a *warm, live* handshake.

| Option | Persistence | Crash‑isolation | Form‑keystroke reliability | Verdict |
|---|---|---|---|---|
| **node‑pty (today)** | ❌ cold `--resume` only | ⚠️ mitigated (couples to node‑pty internals) | ✅ raw bytes, throttle, bracketed‑paste | Fine; baseline |
| **plain `tmux send-keys`** | ✅ | ✅ | ❌ **worse** — drops/races ([tmux#1185](https://github.com/tmux/tmux/issues/1185)); Anthropic's own Agent Teams tmux backend hit this ([cc#23513](https://github.com/anthropics/claude-code/issues/23513)) | **Reject** |
| **tmux `-CC` control mode** | ✅ | ✅ | ⚠️ same send‑keys input path | Reject — parser for a result channel you don't consume (capture is via hook files) |
| **claude‑squad hybrid** (`tmux -d`/`abduco -c` host + node‑pty attach) | ✅ by construction | ✅ separate process | ✅ **preserves node‑pty write path verbatim** | ✅ **Recommended** if pursuing persistence |
| **`abduco`/`dtach`** | ✅ | ✅ | ✅ (writes go to attached PTY) | ✅ Lightest fit; pure detach |
| **expect/pexpect** | ❌ | — | ⚠️ paradigm mismatch | Reject — chroxy derives turn state from **hook files**, not screen patterns |
| **ttyd/gotty** | — | — | — | Reject — chroxy already has the WS/xterm layer |

Key nuances:
- **Output capture is transport‑independent.** Results come from Claude Code **hook files** (`Stop`/`PreToolUse`/`PostToolUse` JSON polled ~150ms), not ANSI scraping. A multiplexer changes nothing here.
- **Billing stays invariant** under any multiplexer (same interactive `claude` child) — **with one footgun:** the `delete env.ANTHROPIC_API_KEY` scrub (`claude-tui-session.js:1392`) must apply to the **inner** `claude`, or it silently reclassifies to metered API billing. The hybrid (env on `new-session`/`abduco -c`) avoids this cleanly.
- The two **still‑open** probes #5331 (form bytes coupled to a hardcoded 120×30 geometry) and #5337 (sync `readdirSync`/`readFileSync` poll → cross‑session head‑of‑line blocking) are *artifacts of the scrape‑and‑poll mechanism*; a structured transport (channels) eliminates both by construction; async‑fs fixes #5337 regardless.

**The strategic answer is `claude --channels`, not a better terminal trick.** Same subscription ride, but a documented MCP protocol + streaming + first‑party permission relay. Research‑preview; doesn't solve model/permission‑mode switching, so ship parallel, not as a `claude-tui` replacement — but it's the durable direction. (Anthropic's own **`claude --remote-control`** is a first‑party "mini‑chroxy"; already dispositioned in #3951 as "track as competition, not adopt" — correct: single‑provider, no self‑hosted transport.)

---

## Part 4 — What competitors do

Three structural camps. **Only Camp 1 shares chroxy's June‑15 exposure.**

| Tool | Transport | Billing | Post‑June‑15 | Same bet as chroxy? |
|---|---|---|---|---|
| **Happy** (slopus/happy) | **Local mode:** wraps interactive `claude`. **Remote mode (the product):** bundled **Agent SDK** (`@anthropic-ai/claude-agent-sdk ^0.2.96`, [#1356](https://github.com/slopus/happy/issues/1356)) | User's `claude` login (sub) / SDK | **Remote path is metered** (SDK); unmitigated | ⚠️ Partial — *exposed*, not escaping |
| **claude‑squad** | **tmux** + git worktrees, interactive `claude` | Sub or BYOK | Subscription (interactive) | ✅ (tmux variant) |
| **ccmanager** | **PTY** (Bun) + `@xterm/headless`, interactive `claude` | Sub or BYOK | Subscription (interactive) | ✅ (PTY, deliberately no tmux) |
| **Crystal** (deprecated) | node‑pty + bundled `@anthropic-ai/claude-code` | Sub or BYOK | Subscription | ✅ |
| **Conductor** | Runs your local Claude Code harness, worktrees | Sub **or** BYOK | Press names it among affected Agent‑SDK apps | ✅ (exposed) |
| **Sculptor** (Imbue) | Claude Code in Docker containers | Sub **or** API key | Metered when sub‑authed | ✅ |
| **VibeTunnel** | Generic PTY→browser proxy (agent‑agnostic) | Inherits the shell | Unaffected | Indirect |
| **Terragon/Terry** (defunct) | **`claude -p` headless** in E2B sandboxes | Connected sub OAuth / BYOK / vendor credits | Would've been metered (defunct since Feb 2026) | ❌ (`-p`) |
| **code‑puppy** | **Own agent loop (Pydantic AI)**, 65+ providers via models.dev | **BYOK API keys** | **Sidesteps entirely** | ❌ |
| **sketch.dev** (retired) | Own agent loop, raw Anthropic API | BYOK API key | Sidesteps | ❌ |
| **tmuxai** | tmux to drive *other* tools; own LLM loop | BYOK (OpenRouter default) | Sidesteps | ❌ |
| **Omnara** | **Claude Agent SDK** | Sub underneath | **Metered** (SDK app) | ❌ |
| **Async** (bkdevs) | **Claude Agent SDK** in Cloud Run | Vendor‑hosted keys + Stripe | Vendor billing | ❌ |
| **Cursor bg / Amp / Jules / Devin** | Vendor cloud + **vendor‑hosted credits** | Vendor billing | Untouched | ❌ |

### The two you named

- **Happy Coder** — your closest competitor, and **more exposed than chroxy, not less**. Its **remote mode** (the entire phone‑driving value prop) *"runs via the bundled `@anthropic-ai/claude-agent-sdk`"* ([#1356](https://github.com/slopus/happy/issues/1356)); only **local mode** rides the interactive subscription. The split already bites ([#120](https://github.com/slopus/happy/issues/120): *"on the terminal it works with my Claude Max plan… browser/mobile uses the API key"*), and there is **no published June‑15 mitigation**. Ban anxiety is concrete and unanswered there too ([discussion #502](https://github.com/slopus/happy/discussions/502): *"I really liked this project but have stopped using it for fear of getting my account banned"*). **Implication: chroxy's `claude-tui` is a genuine differentiator Happy lacks** — you saw the headless‑metering problem and built an interactive escape; Happy's remote sessions will simply start burning metered credits tomorrow.
- **code‑puppy** — the *opposite* architecture: never wraps Claude Code, never uses the subscription; a BYOK multi‑model agent (Pydantic AI). It "handles" June 15 by being **immune** to it — the same answer as chroxy's own workarounds #1 (`ANTHROPIC_API_KEY`) and #2 (provider switch).

**Synthesis:** the interactive‑wrapper technique is community‑validated (it's the HN‑converged answer per #3902), but **no competitor has a published durability/ToS answer** — they're all quietly riding the loophole, and the closest one (Happy) hasn't even applied it to its remote path. Chroxy is simultaneously the **most sophisticated** (billing‑class engine, hardened provider, channels successor, decision docs) and the **most exposed by its own marketing** (asserting "bypasses the programmatic credit pool" as fact).

---

## Part 5 — Persona panel (broad‑view verdicts)

- **Billing/Policy Skeptic:** *"You're productizing a loophole Anthropic has already shown it detects, blocks, then bans — and writing it into your docs as fact. Biggest risk isn't the credits, it's a user's account. Design for BYOK/metered as the supported default; ship the TUI as an explicitly‑flagged, user‑owns‑the‑risk option."*
- **Terminal‑Internals Engineer:** *"node‑pty is fine and your audit debt is mostly paid. Don't touch the form driver. For the persistence win, host `claude` in `abduco`/`tmux -d` and attach node‑pty — the only thing a multiplexer buys by construction. Plain send‑keys is a regression."*
- **Anthropic‑Sanctioned‑Path Analyst:** *"`--channels` is the same subscription ride with a documented contract, streaming, and first‑party permission relay — the only path here that gets *more* stable over time. Sequence it as the strategic successor; keep TUI as the conservative fallback."*
- **Competitive Analyst:** *"Everybody in your lane makes the same bet and nobody thought it through as hard as you. Happy is the one to watch, and it's *behind* you. Your moat is the billing‑class engine + channels + honest UX — lean into it."*
- **Product Minimalist:** *"Most chroxy users are one human typing on a phone — the antithesis of the automation Anthropic is metering. Make that case to Anthropic (workaround #7) and make the BYOK path one tap, so when the loophole closes, nobody's stranded."*

---

## Part 6 — Recommendations (prioritized)

**Before June 15 (hours):**
1. **Resolve the default‑provider question.** Either (a) flip the default to `claude-tui` *if* you accept the loophole bet, or (b) keep `claude-sdk` default but add a one‑time **boundary notice** ("programmatic credits start today — switch to `claude-tui` for subscription billing, or set `ANTHROPIC_API_KEY`"). Don't let "silent metered" be the default. File the tracking issue now.
2. **Soften the billing copy** (`providers.md` / README) from "bypasses the programmatic credit pool" (asserted fact) to a hedged framing ("drives the interactive CLI, which *today* bills against your subscription's interactive allowance; Anthropic may reclassify or enforce against third‑party automation — best‑effort, not guaranteed").

**Short term (this sprint):**
3. **Make BYOK a first‑class, one‑tap fallback** in the dashboard New‑Session modal and the app — so when the loophole closes (or a user is flagged), the off‑ramp is trivial.
4. **Add a `chroxy doctor` billing canary** (your own proxy‑spike doc recommended this): detect if interactive `claude-tui` sessions start reporting `total_cost_usd`/credit‑pool billing post‑June‑15 (early warning the loophole closed), plus a datacenter‑IP/Cloudflare‑egress warning (a documented ban signal).

**Medium term (strategic):**
5. **Resume the `claude --channels` provider** (#3951 subs #3952–#3956) — the durable subscription‑billed transport. Land the bridge behind the research‑preview flag.
6. **Consider the abduco/tmux hybrid for `claude-tui`** for warm cross‑restart persistence — after #5331/#5337; a quality win, not a billing/urgency item.
7. **Open the Anthropic conversation** (workaround #7): chroxy is one‑human‑per‑session remote use, not CI automation. Ask for guidance/carve‑out.

---

## Part 7 — Sources & confidence

**Primary (Anthropic):** [support.claude.com/articles/15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) (credit mechanics, verbatim) · [anthropic.com/legal/terms §3](https://www.anthropic.com/legal/terms) (automation clause) · [code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance) ("ordinary individual usage" / enforcement) · [claude-code#43333](https://github.com/anthropics/claude-code/issues/43333) (`-p` is the billing discriminator).

**Most on‑point precedent:** [multica-ai/multica#2815](https://github.com/multica-ai/multica/issues/2815) — identical PTY‑TUI daemon PR, "does not shift billing buckets." Also [agentclientprotocol/claude-agent-acp#658](https://github.com/agentclientprotocol/claude-agent-acp/issues/658).

**Mechanism:** [node-pty#178/#214/#466](https://github.com/microsoft/node-pty/issues/466) (EIO / V8 crash on exit) · [tmux#1185](https://github.com/tmux/tmux/issues/1185) + [claude-code#23513](https://github.com/anthropics/claude-code/issues/23513) (send‑keys races) · [claude-squad](https://github.com/smtg-ai/claude-squad) · [ccmanager](https://github.com/kbwo/ccmanager) · [abduco](https://github.com/martanne/abduco) · [pexpect](https://github.com/pexpect/pexpect) · [tmux Control‑Mode](https://github.com/tmux/tmux/wiki/Control-Mode).

**Competitors:** [slopus/happy](https://github.com/slopus/happy) (+ [#1356](https://github.com/slopus/happy/issues/1356), [#120](https://github.com/slopus/happy/issues/120), [#502](https://github.com/slopus/happy/discussions/502)) · [code_puppy](https://github.com/mpfaffenberger/code_puppy) · [boldsoftware/sketch](https://github.com/boldsoftware/sketch) · [imbue sculptor](https://imbue.com/sculptor-announce/) · [conductor.build](https://www.conductor.build/) · [terragon-oss](https://github.com/terragon-labs/terragon-oss) · [async-server](https://github.com/bkdevs/async-server) · [ampcode](https://ampcode.com/news/amp-free-frontier).

**Internal:** issues #3902 (canonical workaround design), #3951 (channels), #5338 (hardening epic), #5629/#5630/#5665 (billing copy), #5331/#5337 (open probes); `billing-class.js`, `claude-tui-session.js`, `providers.js`, `docs/decisions/2026-05-claude-tui-proxy-spike.md`, `docs/architecture/claude-channels-provider-spike.md`.

**What could NOT be verified (flagged honestly):** whether a PTY‑interactive session *empirically* draws from the subscription vs credit pool on/after June 15 (no public billing‑dashboard proof either way; better‑reasoned sources say it's classified programmatic); the exact `(external, cli)` vs `(external, sdk-cli)` UA→billing linkage (chroxy's spike observed the UA; nobody confirms Anthropic *bills* on it); any Anthropic statement that *specifically* blesses or forbids the PTY path (the conclusion rests on the coverage list + ToS §3 + enforcement precedent + `multica#2815`, not a verbatim PTY ruling).
