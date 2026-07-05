# ruvector-gateway — why, and what it removes

*Research note. Last validated: 2026-07-05.*

> **Delivery status (2026-07-05):** this work is now its **own standalone autopilot plan**,
> `ruvector-gateway` — parked at `.autopilot/queued/ruvector-gateway.pipeline.yml` (was phase 11 of
> the `local-first-learned-routing` pipeline, which is complete at phases 0–10). Its sibling split,
> `corpus-durability` (was phase 12), is unrelated. Promote the queued plan to run it.

**TL;DR** — The `ruvector-gateway` (its own `ruvector-gateway` plan, the RFC's **Path 4**) is **not new
capability** — it is the *already-proven* Node routing loop, **compiled into one native Rust hop**.
Today the learned-routing loop lives in ~14 JavaScript modules (`scripts/lib/*.mjs`) invoked
*around* each request, with LiteLLM as a *separate* serving proxy. The gateway collapses **decide →
budget-steer → judge → record → serve-handoff** into a single in-process Rust decision (tiny-dancer
FastGRNN + HNSW route cache + budget ledger + OTel) that **fronts** LiteLLM at `:4000`, making the
**same decisions** at **< 5 ms** (heuristic) / **< 25 ms** (neural incl. embedding). It is **optional
and gated**: build it only once the loop is proven (phases 1–10 ✓) *and* request volume justifies the
latency/footprint win. Nothing is deleted from the *system* — the per-request JavaScript hops leave
the **request path** and the offline learning stays on the **training path**.

---

## Evidence legend

| Tag | Meaning |
|-----|---------|
| ✅ **Confirmed** | Grounded in a cited rUv source path (RuvNet brain) or a file in this repo. |
| 🟡 **Target** | A `ruvector-gateway`-plan acceptance target (asserted by the gate when the sidecar is built), not yet measured here. |

**Sources (grounded 2026-07-05):**
- ✅ `@ruvector/tiny-dancer`@0.1.22 — `ruvector/npm/packages/tiny-dancer/package.json`: "FastGRNN-based
  intelligent routing with circuit breaker, uncertainty estimation, hot-reload."
- ✅ `ruvector/docs/adr/ADR-252-fastgrnn-training-pipeline.md` (**ACCEPTED**): DRACO matrix →
  trained `.safetensors` → native routing inference on 8 platforms (the train→load loop).
- ✅ `agentic-flow/src/routing/TinyDancerRouter.ts`: "**< 5 ms routing decisions**, 99.9% uptime with
  circuit breaker," `route(Float32Array) → RouteResult`, batch routing, hot-reload.
- ✅ This repo — `docs/guide/reference/architecture-rfc.md` §Paths: **Path 4** = "Rust sidecar gateway
  from ruvector crates… promote the FastGRNN router + HNSW cache into a standalone `ruvector-gateway`.
  Best latency/footprint; G1–G5. 10–16 pw. Natural phase-2 evolution of Path 2." FastGRNN µs-scale
  inference + HNSW route cache = "shipped (ruvector crates)."
- ✅ This repo — `.autopilot/queued/ruvector-gateway.pipeline.yml` (phase 0; deliverables + `< 5 ms`/`< 25 ms` targets),
  `docker-compose.yml` (the current `:4000` gateway variants), `scripts/lib/*.mjs` (the Node loop).

---

## 1. Why it, versus everything we already have

| What we have today | Its limit at volume | What the gateway adds |
|---|---|---|
| **Node overlay** (`router.mjs`, `reflex.mjs`, `recorder.mjs`, `train-router.mjs`) — the decision brain | JS per-request; embed + k-NN + judge are multiple async hops; cold-start + GC jitter | The *same* logic as native FastGRNN inference in one process → µs–ms decisions, hot-reload weights, circuit breaker |
| **LiteLLM** `:4000` — serving substrate (providers, budgets, failover, metrics) | Great at *serving*, blind to *why* a tier was picked; routing decided out-of-band in Node | Gateway owns the *decision* + a fast in-memory budget-steer, then hands the resolved tier to LiteLLM to serve — one seam, no round-trip to a JS sidecar |
| **ruflo** (npx/MCP) — complexity + bandit/neural router | Client-side; per-model bandit labels blur once a gateway picks the physical model | A single authoritative routing point co-located with the budget ledger and OTel spans |
| **RVF corpus + KRR model** (`.ruvector/*`) | Trained/consumed in JS | tiny-dancer consumes the *same* DRACO matrix → `.safetensors` (ADR-252) for native inference |

It does **NOT** replace LiteLLM's provider/budget/failover maturity — it **fronts** it. It is mutually
exclusive with the other `:4000` gateways (LiteLLM / bifrost / helicone), selected by a compose
profile — never a second bind.

---

## 2. Request path — WITHOUT the gateway (today, the Node loop)

```
          ┌─────────┐
          │  agent  │
          └────┬────┘
               │  (1) request
               ▼
  ┌───────────────────────────────────────────────┐
  │  NODE OVERLAY  (scripts/lib/*.mjs, per request)│   ◄── all JS, multi-hop
  │                                                │
  │   router.mjs ──reads── budget-snapshot.mjs     │   (2) decide tier
  │       │                                         │
  │       ▼                                         │
  │   gateway-client.mjs ───────────┐               │   (3) serve call
  │                                 │               │
  │   reflex.mjs ─► verify-escalate.mjs ──┐         │   (5) judge ROUND-TRIP
  │                                 │     │         │
  │   recorder.mjs ─► ruvllm embed ─┼─► .rvf        │   (6) embed + record
  └─────────────────────────────────┼─────┼─────────┘
                                    │     │
                          (3)(5)    ▼     ▼  (extra gateway hop for the judge)
                        ┌───────────────────────────┐
                        │   LiteLLM  :4000          │   serving substrate
                        │  aliases · budgets ·      │
                        │  failover · retries · OTel│
                        └───────────┬───────────────┘
                                    ▼
                     ┌──────────────────────────────┐
                     │ ollama · vllm · frontier(cloud)│
                     └──────────────────────────────┘

  hot path/request:  JS route  +  JS→LiteLLM  +  JS judge round-trip  +  JS embed/record
```

## 3. Request path — WITH the gateway (Path 4, the promoted loop)

```
          ┌─────────┐
          │  agent  │
          └────┬────┘
               │  (1) ONE request
               ▼
  ┌───────────────────────────────────────────────┐
  │  ruvector-gateway  :4000   (Rust sidecar)      │   ◄── one native hop, <5ms/<25ms
  │                                                │
  │   HNSW route cache → FastGRNN route (µs)       │   ← was router.mjs + ruflo
  │   budget ledger (in-mem) → steer/demote        │   ← was budget-snapshot.mjs
  │   judge-steer (in-proc)                        │   ← was reflex.mjs round-trip
  │   record row + OTel span                       │   ← was recorder.mjs hot path
  └───────────────────────┬────────────────────────┘
                          │  (2) resolved tier
                          ▼
              ┌───────────────────────────┐
              │   LiteLLM  :4000 (fronted)│   STAYS — provider budgets,
              │   budgets · failover · OTel│   failover, serving
              └───────────┬───────────────┘
                          ▼
           ┌──────────────────────────────┐
           │ ollama · vllm · frontier(cloud)│   STAYS
           └──────────────────────────────┘

  hot path/request:  ONE native Rust call  →  LiteLLM serve
```

## 4. What actually changed (removed vs. kept)

| Piece | Without | With gateway |
|---|---|---|
| `router.mjs` + `budget-snapshot.mjs` | JS decision + budget read, per request | **absorbed** → FastGRNN + in-mem budget ledger (native) |
| `reflex.mjs` judge | extra **round-trip back through the gateway** | **absorbed** → in-process judge-steer |
| `recorder.mjs` (hot path) | JS embed + `.rvf` write inline | **absorbed** → native record + OTel |
| `gateway-client.mjs` indirection | client → JS → LiteLLM | **removed** → client → gateway direct |
| **LiteLLM, Ollama/vLLM, frontier** | serving substrate | **kept** (gateway *fronts* LiteLLM) |
| **Prometheus / Grafana** | metrics | **kept** (gateway exports OTel) |
| `train-router` · `challenger` · `promotion-gate` · `metaharness-eval` · `backup-corpus` | offline, **not** on hot path | **kept, unchanged** — they train the model the gateway loads |

**Net removed from the hot path:** the four Node round-trips (route, budget read, judge, record) and
the JS→LiteLLM indirection — collapsed into **one Rust hop**. **Net kept:** everything that *serves*
(LiteLLM + models), *observes* (Prometheus/Grafana), and *trains offline* (the promotion pipeline).
It is a **relocation of the decision loop into native code**, not a deletion of capability.

> **The one nuance:** JS leaves the **request path**, not the **training path**. The offline modules
> (`promotion-gate`, `train-router`, `challenger`, …) still run in Node between deployments — they
> produce the `.safetensors`/model artifact the Rust gateway **hot-reloads** (ADR-252's
> DRACO → trained-model → native-inference loop). ✅

---

## 5. Full component & responsibility breakdown

**Layer 1 — Serving substrate** (Docker Compose; one `:4000` gateway active at a time)

| Component | Responsibility | Gateway's effect |
|---|---|---|
| `ollama` | Serves local models (tier-fast/heavy/private physical models) | unchanged |
| `vllm` | Optional higher-throughput local serving (tier-heavy) | unchanged |
| `litellm` `:4000` | OpenAI-compat gateway: tier aliases, fall-through ladder, per-deployment budgets, retries, Prometheus/OTel callbacks | **fronted** by the sidecar |
| `bifrost` / `helicone` | Alternative `:4000` gateway variants (mutually exclusive) | peers of the ruvector-gateway variant |
| `routellm` `:6060` | Optional MF router — the explicit 90/10 strong-model dial | orthogonal (an alternate decider) |

**Layer 2 — Decision & learning overlay** (`scripts/lib/*.mjs`, Node — the loop the gateway promotes)

| Module | Responsibility |
|---|---|
| `config.mjs` / `gateway-client.mjs` | env surface (`CLAUDE_FLOW_ROUTER_*`, `JUDGE_MODEL`) · OpenAI-compat fetch (no curl) |
| `router.mjs` | **Per-category champion**: tier floors + budget demotion + `pinnedPrivate` local-only lane |
| `reflex.mjs` | **Safe reflex**: verify-then-escalate a local answer; fail-closed privacy pin (tier-private never scored off-box) |
| `verify-escalate.mjs` / `reward.mjs` | FrugalGPT judge (position-swap, rubric) · quality+cost+latency → scalar reward |
| `budget-snapshot.mjs` | budget utilization → steering rungs (demote/mask frontier) |
| `recorder.mjs` | Writes the DRACO corpus row (embedding + **real success/negative**, prompt_hash only) |
| `train-router.mjs` / `challenger.mjs` | KRR `TrainedRouter` · shadow challenger (never serves) |
| `promotion-gate.mjs` | Champion/challenger gate: frozen held-out + significance + overfit guard + auto-rollback + receipt replay |
| `metaharness-eval.mjs` | **Offline** comparator vs `@metaharness/router` (never a 2nd live learner) |
| `backup-corpus.mjs` (`corpus-durability` plan) | WAL-safe corpus snapshot + rotation |

**Layer 3 — External brains & memory**

| Component | Responsibility |
|---|---|
| `@ruvector/rvf` | The real `.rvf` routing corpus store (HNSW-indexed, crash-safe) |
| `@ruvector/ruvllm` | In-process prompt embedder (no argv leak) |
| `@ruvector/tiny-dancer` | **Native FastGRNN router** — the engine the Rust gateway embeds ✅ |
| `.ruvector/routing-corpus.rvf` · `router-model.json` · `tests/promotion-eval-frozen-v1.json` | DRACO corpus · trained model · frozen held-out eval set |

**Layer 4 — Observability**

| Component | Responsibility |
|---|---|
| `prometheus` / `grafana` | Spend, tier shares, fallback events, latency panels |
| `otel-collector` | OpenTelemetry GenAI spans |

**Layer 5 — The proposed sidecar** (the `ruvector-gateway` plan)

| Component | Responsibility |
|---|---|
| **`ruvector-gateway`** (Rust) | Embeds the promoted router (tiny-dancer FastGRNN + HNSW route cache), an in-memory **budget ledger**, and **OTel export**; exposes the OpenAI-compat `:4000` seam behind a compose profile; verified to make the **same tier decisions** as the Node loop at 🟡 < 5 ms / < 25 ms |

---

## 6. When you'd actually build it

- **Build** when: request volume is high enough that JS-loop routing latency/footprint matters, and
  the loop is proven (phases 1–10 done ✅). The RFC scopes it at **10–16 person-weeks**, explicitly
  *"if request volume ever justifies it."*
- **Skip** when: you're still iterating on routing logic (JS is faster to change), or volume is low —
  LiteLLM + the Node loop already deliver correctness, budgets, and metrics. Path 4 is the
  performance **end-state**, not a prerequisite.

---

## See also

- `docs/guide/reference/architecture-rfc.md` — the full 5-path decision (Path 4 = this sidecar).
- `docs/guide/reference/gateway-variants.md` — the `:4000` gateway options and when-to-pick-which.
- `docs/research/routing-refactor-decisions.md` — D1–D6 decisions + the autopilot phase log.
- `docs/research/metaharness-and-ruflo-local.md` — the two-routers caveat (never run two live learners).
- `.autopilot/queued/ruvector-gateway.pipeline.yml` — the standalone plan that builds this (promote to run).
