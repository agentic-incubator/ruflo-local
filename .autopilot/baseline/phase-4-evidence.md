# Phase 4 — evidence: per-category champion + budget steering + ruflo route()

Feature: `local-first-learned-routing` · mode: `pr_ci` · gate: **PASSED** (2026-07-04)

Routes per-category as the champion on tier-schema v1: `ruflo route()` picks the agent/
category, the policy maps agent → tier floor, and the budget snapshot STEERS frontier
(demote → mask) — never below the floor.

## What shipped
- `scripts/lib/router.mjs` — floors + difficulty target + budget steering + the ruflo `route()` product-path bridge.
- `scripts/lib/__tests__/router.test.mjs` — 25 node:test cases.

## Grounding correction (rUv priors are stale)
`ruflo route <task>` is a **Q-learning AGENT router** (returns `Architect`/`Coder`/
`Reviewer`/…), **not** a model-tier router — verified by running it. So the first cut
(grepping stdout for tier names) would always miss. Corrected the architecture: ruflo
picks the **agent**, `router-policy.example.json`'s `tier_floor_by_agent_type` maps agent
→ floor, and this router applies difficulty + budget on top. The bridge parses the agent
id (`Agent: Architect (architect)` → `architect`).

## Definition of Done — green
- `jq ._meta.schema_version == 1` (ruflo-tiers.json) — v1 invariant holds ✅
- `node --check scripts/lib/router.mjs` ✅
- `node --test .../router.test.mjs` → 25/25 ✅ (floors · demote→mask · fail-closed · private lane)
- grep `tier_floor` in policy ✅ · grep `budget` in router.mjs ✅ · no `TODO|FIXME` ✅
- full suite **126/126** ✅ · lint ✅ · build ✅

## Tier-3 adversarial review — outcome
`qe-code-reviewer` confirmed **floors HOLD and privacy is AIRTIGHT**, and found budget
fail-opens (all fixed before merge):
- **#1 HIGH (metrics fail-open) — FIXED**: `route()` ignored `metrics_available`; a failed `/metrics` scrape returned rung `"0"` → frontier served during a blind budget window. Now `budgetSteer` **fails CLOSED** (masks frontier) when metrics are unavailable.
- **#2 HIGH (rung `0.25` band) — FIXED**: the demote condition omitted `"0.25"` (util 0.5–0.75), so frontier kept serving through the first ramp quarter. Now **any** non-zero rung demotes (RFC ramp starts at util 0.5).
- **#3 MEDIUM (ruflo bridge misread) — FIXED** by the grounding correction: the bridge parses the AGENT id, not a ladder-first tier substring.
- **#4 LOW (task→argv) — MITIGATED/documented**: the bridge runs only when `agentType` is omitted; a pinned-private task never reaches it, and callers can pass `agentType` to skip ruflo entirely.
- **#5 (test gaps) — FIXED**: added rung `0.25`/`0.75`, metrics-fail-closed, off-ladder target, unknown-agent-end-to-end, and ruflo-agent-parse tests.

## Gate summary
- Tier 1: lint ✅ · build ✅ · test 126/126 ✅ · security invariants ✅ (tier-private never scored/demoted off-box; budget fails closed).
- Tier 2: DoD green.
- Tier 3: reviewed; #1–#3,#5 fixed, #4 mitigated.
- test_integration (live smoke): deferred — the router is exercised by unit tests with injected ruflo/budget; live `ruflo route()` + gateway wiring is validated end-to-end in a later integration pass.
