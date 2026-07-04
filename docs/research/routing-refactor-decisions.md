# Routing Refactor — Decision Record

> **Last validated:** 2026-07-04
> **Status:** agreed direction (design record, not yet implemented)
> **Companion docs:** `local-first-escalation-vision.md` (the plain-language why),
> `architecture-rfc.md` (the technical RFC), `metaharness-and-ruflo-local.md` (the
> metaharness composition), `limitations-and-mitigations.md` (the guided-router §12 gaps).
> Grounding for rUv capabilities cited inline; ruflo internals cited from this repo's own
> code-level audit (`evidence-appendix.md`).

## Purpose

Turn the repo's **local-first, escalate-on-low-quality** vision into a concrete refactor
plan. The goal: ask the free local model first, pay for a frontier model only when the
local answer scores poorly, and get smarter over time about which requests to send where —
with **one decider**, the **judge wired into the loop**, and an **automated, evidence-gated
switch** from coarse to fine routing.

## The component map (who owns what)

| Concern | Owner after refactor |
|---|---|
| **Tiering** — which tier answers | ruflo's router (the one brain) |
| **Gateway** — alias → physical model, failover, caps | LiteLLM (stays dumb, unchanged) |
| **Quality / scoring** — is the answer good? | `verify-escalate` judge, re-homed to `.mjs`, called in-loop |
| **Escalation** — act on a low score | the safe reflex (score < bar → frontier) |
| **Budget / cost** — steer, not just alert | `budget-snapshot` as a routing input |
| **Privacy** — never leaves the box | `tier-private` (unchanged invariant) |
| **Learning** — predict escalation before spending it | ruflo neural router + SelfEvolvingRouter gate |

## Decisions

### D1 — One brain: ruflo's built-in learner
**Decision:** the learned routing decision lives in **ruflo's** router (the ruvector-powered
neural router + Thompson bandit), not a second upstream picker.
**Why:** running two learners (ruflo + metaharness) makes each one's per-model labels blur
(`metaharness-and-ruflo-local.md:186-202`). One brain keeps the learning signal clean and
uses what ruflo already ships. Metaharness composition stays a **deferred option** (see
Deferred), not the starting architecture.
**Prerequisite:** reconcile the ruflo version pin — this repo pins `ruflo@3.5.18`
(`.claude/settings.json`), but the native training path fix (ruflo #2549) landed in **3.18.1**.
Step zero is bumping that pin, or the fixed native path isn't in the build we invoke.

### D2 — Node/`.mjs` runtime for the reward/verify/budget logic
**Decision:** rewrite the four bash scripts (`verify-escalate.sh`, `budget-snapshot.sh`,
`bench-gateway.sh`, `quality-regression.sh`) as **Node `.mjs` modules**.
**Why:** ruflo is a TypeScript/Node stack and already runs ONNX embeddings in-process at
<10ms (`ruflo-primer#1`). `.mjs` runs on Linux/macOS/Windows with no bash/`jq`/`curl`
dependency, and — decisively — lets the **judge run in-process** so its score is a function
return, not a subprocess to parse. That is what takes the judge off the bench.
**Rust:** held in reserve for a future standalone gateway sidecar (Path 4), not now.

### D3 — Ship the safe reflex first (correctness before cleverness)
**Decision:** phase 1 is the reactive reflex: run local → judge scores the response → if
`score < bar`, escalate to frontier. No embedding, no category, no trained model.
**Why:** it directly fixes the core defect ("a local model that confidently answers wrong is
served", `limitations-and-mitigations.md:16`) and delivers value on day one with zero
learning. The reflex is a **correctness guarantee**; the learner is a later **efficiency**
optimization that makes the reflex fire less often — it never replaces it.

### D4 — Per-category first, then per-question, via an automated promotion gate
**Decision:** start routing **per-category** (task class / agent-type tier floors, no
embedding on the hot path), and **graduate to per-question** (embedding-based per-prompt
routing) automatically once the corpus proves it out.
**Why & how:** ruflo ships a **`SelfEvolvingRouter` promotion gate** fed by
`router-parallel-recorder.ts` (this repo's `evidence-appendix.md`). The per-question router
runs in **shadow** (champion/challenger): it records what it *would* pick without serving it;
a gate periodically checks whether the challenger's quality-per-dollar beats the live router
by a real margin on enough samples, and **auto-promotes** it (with auto-rollback on
regression). The switch is gated on measured outcomes, not a manual flag or a hunch.
**Cold-start:** rUv's DRACO results (ADR-040/043) show a learned router beats the best fixed
model at n≈20 and improves monotonically with data; the ~92% oracle ceiling at n=20 is a
data limit, not a pipeline failure. Traffic is always served by the proven champion while
the challenger trains, so cold-start carries no user-facing risk. Seed offline from
`tests/quality-prompts.jsonl` to shorten it.

### D5 — Log embeddings from day one (the no-backfill rule)
**Decision:** even in phase 1 (per-category), record the full DRACO-shaped row per request:
`{prompt, embedding, category, tier chosen, judge score, cost, latency, escalated?}`.
**Why:** per-category routing doesn't *need* the embedding to decide, but storing it means the
training corpus for the per-question router already exists when the gate wants it — **zero
backfill**. This single rule is what makes per-category-first scaffolding rather than a detour.

### D6 — Stay tier-schema v1 now, adopt v2 at promotion
**Decision:** keep `config/routing/ruflo-tiers.json` at **schema v1** through phase 1 and early phase 2;
adopt the RFC's **v2** (per-request `locality`/`base_url`) when the promotion gate fires and
we want per-request locality control.
**Why:** per-category + reflex live happily on v1 (respects the autopilot DoD invariant).
Per-question routing among the existing four aliases also works on v1; only finer per-request
locality *requires* v2. So the v1→v2 migration rides along with the coarse→fine promotion —
not a hard upfront prerequisite.

## Phasing

**Phase 1 — Safe reflex + per-category (v1, no learning on the hot path)**
- Re-home the judge to `verify-escalate.mjs`; call it in-loop; low score → escalate.
- Route per-category via tier floors; feed `budget-snapshot` in as a steering input.
- Start the trajectory recorder logging full DRACO rows **including embeddings** (D5).
- Reconcile the ruflo version pin (D1 prerequisite).

**Phase 2 — Per-question learner in shadow, auto-promoted**
- Train the per-question router (KRR `TrainedRouter`, portable JSON — ADR-043; native
  tiny-dancer optional) on the logged corpus, seeded by the eval set.
- Run it as the challenger; wire the `SelfEvolvingRouter` promotion gate (D4).
- On promotion, optionally migrate to tier-schema v2 for per-request locality (D6).

## Deferred (explicitly not now)

- **Metaharness composition** — `@metaharness/router` as an upstream cost-optimal picker
  (ADR-073). Revisit only if we want a decider outside ruflo; requires disabling ruflo's
  learner to avoid two-brain label blur.
- **Rust `ruvector-gateway` sidecar (Path 4)** — standalone tiny-dancer FastGRNN + HNSW
  gateway. The performance end-state; premature until the loop is proven in Node.

## Verification (how we'll know each phase works)

- **Phase 1:** force a known-bad local answer → judge scores it below bar → request escalates
  to frontier and the good answer is served; confirm a DRACO row (with embedding) is logged.
- **Phase 2:** replay the logged corpus offline → challenger's quality-per-dollar vs champion
  vs the per-question oracle; confirm the gate promotes only when the margin + sample
  thresholds are met, and auto-rolls-back on an injected regression.
