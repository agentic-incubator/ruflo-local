# live-routing-gateway — cutting the proven Node loop over to live traffic

*Research note. Last validated: 2026-07-05.*

> **Delivery status (2026-07-05):** parked as its own standalone autopilot plan,
> `live-routing-cutover` — at `.autopilot/queued/live-routing-cutover.pipeline.yml`. Promote
> to run. Independent of `ruvector-gateway` (Rust) and `corpus-durability`.

**TL;DR** — An audit of `ruvector-gateway-rationale.md` against the actual code (2026-07-05)
found that `router.mjs`, `reflex.mjs`, and `recorder.mjs` are **not** in the live request
path, despite being described that way in that doc's §2 diagram and Layer-2 table. Every one
of those modules' own `STATUS` headers says so explicitly: *"reference/overlay code — runs
in unit tests + offline/shadow tooling, NOT in the live request path."* Live traffic today is
served entirely by LiteLLM's (or bifrost's/helicone's) native config: static error-triggered
fallbacks, hard-stop budgets, and the `tier-private` alias's absence from the fallback chain.
None of the decision engine the last ten autopilot phases built — category floors,
budget-steered demotion, quality-based escalation, DRACO corpus logging — has ever run against
a real request. This plan cuts it over: a thin, always-on Node gateway that actually fronts
whichever `:4000` provider is active, wiring the proven modules into the real request path so
the design can be traced and proven at runtime, not just asserted in docs.

---

## Evidence legend

| Tag | Meaning |
|-----|---------|
| ✅ **Confirmed** | Grounded in a file in this repo, cited by path:line. |
| ⚠️ **Contradiction found** | A doc/pipeline claim that does not match the cited code. |

**Sources (grounded 2026-07-05):**
- ⚠️ `docs/research/ruvector-gateway-rationale.md` §2–§5 — depicts `router.mjs`/`reflex.mjs`/
  `recorder.mjs` inside the live "NODE OVERLAY... per request" hot path.
- ✅ `scripts/lib/router.mjs:6-8`, `scripts/lib/reflex.mjs:10-12`, `scripts/lib/recorder.mjs:4-6`
  — each module's own header: *"NOT in the live request path (live traffic is served by the
  gateway / LiteLLM config)."*
- ✅ `docs/guide/reference/tiers-and-routing.md:36` — "that overlay is reference code, not yet
  wired into the live request path... On live traffic, the gateway alias is what holds the pin."
- ⚠️ `.autopilot/pipeline.yml:181,193` (phase 7 goal/conventions) — asserts "per-request
  locality is ALREADY enforced at runtime... router.mjs `pinnedPrivate`... correctly and
  tested" — same false claim, restated in the phase notes that drove phases 7–10.
- ✅ `config/gateways/litellm-config.yaml:109-127` — the actual live mechanism: a static
  `fallbacks:` ladder (error/timeout-triggered only), per-deployment `max_budget` hard-stops,
  `callbacks: ["prometheus","otel"]` (metrics only, no custom callback into any `.mjs`).
- ✅ `docker-compose.yml:62-149` — `litellm`/`bifrost`/`helicone` each bind host `:4000`
  directly; mutually exclusive via `COMPOSE_PROFILES`, no decision layer in front of any of them.
- ✅ `docs/guide/reference/architecture-rfc.md:88` — Path 2 (the thing this plan cuts over) is
  itself flagged **"moderate risk (touches hot path)"** — the risk was known, the cutover was
  deliberately deferred, never scheduled.

---

## 1. Why this exists — the gap, precisely

The autopilot pipeline built a full decision engine (per-category router, safe-reflex judge,
DRACO corpus recorder, KRR trainer, shadow challenger, evidence-gated promotion gate,
anti-overfitting proofs, an offline three-way bake-off vs `@metaharness/router`) across ten
phases, all real, all unit-tested, all `node --check`-clean. But every phase's Definition of
Done checked that the code **exists and parses and passes unit tests** — never that a live
request passes through it. The result: a fully-built, fully-tested engine that has never once
touched real traffic, described in multiple docs as if it had.

This isn't a code defect — it's a narration defect compounding a real architectural gap. The
design (`routing-refactor-decisions.md` D3/D4) deliberately treats "prove it in Node" as a
prerequisite before the riskier Rust rewrite (Path 4). But "proven in Node" has only ever
meant unit tests + offline corpus replay — there was never a live-fire integration point to
clear that bar against, because nothing in this repo intercepts `:4000` traffic except the
gateway container itself (no LiteLLM custom callback, no proxy, no sidecar). This plan builds
that integration point.

## 2. Request path — WITHOUT this plan (today, actually)

```
          ┌─────────┐
          │  agent  │
          └────┬────┘
               │  (1) request, model=tier-fast/heavy/frontier/private (caller must already know)
               ▼
  ┌───────────────────────────────────────────────┐
  │  litellm / bifrost / helicone  :4000            │  ← the ONLY thing making a live decision:
  │  static fallbacks (error-only) · hard-stop      │    "does this deployment still have budget?"
  │  budgets · prometheus/otel callbacks            │    "did the call error/timeout?"
  └───────────────────────┬─────────────────────────┘
                          ▼
           ┌──────────────────────────────┐
           │ ollama · vllm · frontier(cloud)│
           └──────────────────────────────┘

  Node overlay (router.mjs, reflex.mjs, recorder.mjs, budget-snapshot.mjs, ...): exercised ONLY
  by node --test and the offline train/challenger/promotion-gate/metaharness-eval pipeline.
  Zero live requests ever pass through it.
```

## 3. Request path — WITH this plan (the cutover)

```
          ┌─────────┐
          │  agent  │
          └────┬────┘
               │  (1) ONE request → route-gateway :4000 (was litellm/bifrost/helicone's seam)
               ▼
  ┌────────────────────────────────────────────────────────┐
  │  route-gateway  (Node, always-on, fronts GATEWAY_UPSTREAM_URL)│
  │                                                          │
  │   explicit tier / pinnedPrivate → passthrough, no routing (fail-closed pin, unchanged)│
  │   router.mjs route() → tier (category from metadata.agentType, budget-steered)│
  │   forward to upstream (internal-only now) → response                    │
  │   reflex.mjs verify-then-escalate on scorable tiers                     │
  │   recorder.mjs async DRACO row  +  OTel span (ruflo.route.*)            │
  └───────────────────────┬──────────────────────────────────┘
                          │  (2) resolved + possibly escalated response
                          ▼
              ┌───────────────────────────┐
              │ litellm/bifrost/helicone   │  now INTERNAL-ONLY (no host :4000 bind)
              │ (whichever profile active) │  STAYS — providers, budgets, failover
              └───────────┬───────────────┘
                          ▼
           ┌──────────────────────────────┐
           │ ollama · vllm · frontier(cloud)│  STAYS
           └──────────────────────────────┘
```

## 4. What actually changes

| Piece | Without | With this plan |
|---|---|---|
| Host `:4000` binding | `litellm`/`bifrost`/`helicone` (whichever profile) | `route-gateway` (always-on, no profile gate); the three providers move to internal-only, selected via `GATEWAY_UPSTREAM_URL` |
| `router.mjs` | reference code, tests only | **live** — decides tier per request |
| `reflex.mjs` | reference code, tests only | **live** — verifies/escalates the served answer |
| `recorder.mjs` | reference code, tests only | **live** — async DRACO row per request |
| `train-router.mjs`/`challenger.mjs`/`promotion-gate.mjs`/`metaharness-eval.mjs` | offline | **unchanged, still offline** — the per-question learner stays a shadow challenger behind the promotion gate (D4); this plan only cuts the per-category champion live |
| Privacy pin (`tier-private`) | held by the gateway alias's absent fallback entry | held **twice**: still absent from every provider's fallback chain, AND `route-gateway`'s explicit-tier passthrough short-circuits before any routing/scoring logic runs |
| Observability | `gen_ai.*` spans only | adds `ruflo.route.{tier,floor,category,budget_rung,escalated,judge_score}` spans |

## 5. Component & responsibility (new)

| Component | Responsibility |
|---|---|
| `scripts/gateway-server.mjs` (**new**) | Node HTTP server on `:4000`; orchestrates router→forward→reflex→record→span per request; explicit-tier/pinnedPrivate passthrough short-circuit |
| `route-gateway` (**new** docker-compose service) | always-on, no profile gate (like `otel-collector`); env `GATEWAY_UPSTREAM_URL` selects the live provider underneath |
| `litellm`/`bifrost`/`helicone` | **unchanged internally** — drop only their host `:4000` port mapping |
| `router.mjs`/`reflex.mjs`/`recorder.mjs`/`budget-snapshot.mjs` | **unchanged code** — same modules, now actually called from `gateway-server.mjs` instead of only from tests |

## 6. When you'd build it

**Now.** This is the prerequisite the `ruvector-gateway` (Rust, Path 4) plan's own goal text
implicitly assumes already happened ("promote the *proven* Node routing loop") — it wasn't
proven live, only in tests. Building the Rust sidecar before this ships would mean rewriting
unproven logic in a second, harder-to-debug language. Skip this only if the decision is to
keep the Node overlay permanently reference-only — in which case every doc claiming otherwise
(§2 of `ruvector-gateway-rationale.md`, `.autopilot/pipeline.yml:181,193`) needs correcting
instead, which this plan's last phase also does either way.

---

## See also

- `docs/research/ruvector-gateway-rationale.md` — the Rust Path-4 sidecar this plan is the
  honest prerequisite for.
- `docs/research/routing-refactor-decisions.md` — D1–D6, the original phasing this plan
  completes the missing cutover step of.
- `docs/guide/reference/tiers-and-routing.md` — the tier vocabulary + the privacy-pin caveat
  this plan resolves (it already correctly flagged the gap).
- `.autopilot/queued/live-routing-cutover.pipeline.yml` — the plan that builds this.
