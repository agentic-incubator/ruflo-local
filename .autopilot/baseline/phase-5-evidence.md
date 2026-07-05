# Phase 5 — evidence: per-question challenger + evidence-gated promotion (risk_phase)

Feature: `local-first-learned-routing` · mode: `pr_ci` · **risk_phase** · gate: **PASSED** (2026-07-05)

Adds the per-question learned router as a **shadow challenger** and an **evidence-gated
promotion** with auto-rollback — ruflo's SelfEvolvingRouter pattern, grounded in ruvnet
ADR-073 (@metaharness/router KRR TrainedRouter) + ADR-072/076 (statistical promotion gate).

## What shipped
- `scripts/lib/train-router.mjs` — KRR TrainedRouter → portable JSON (`candidates` + `alpha`), seeded from `tests/quality-prompts.jsonl`.
- `scripts/lib/challenger.mjs` — runs the trained router in SHADOW (records the would-pick, never serves).
- `scripts/lib/promotion-gate.mjs` — champion/challenger gate + auto-rollback.
- `scripts/lib/__tests__/promotion.test.mjs` — 17 node:test cases.

## Definition of Done — green
- `node --check` all 3 ✅
- `train-router --seed … --out …` → artifact with `.candidates` + `.alpha` ✅
- `node --test promotion.test.mjs` → 17/17 ✅ (replay · no-promote-thin · rollback · shadow-only)
- grep `rollback` · grep `shadow` · no `TODO|FIXME` ✅ · full suite **143/143** · lint · build

## Honest cold-start (matches ADR-201 H5)
The seed is tiny (n≈15, task_class only). The challenger TIES, not beats, the champion → the
gate correctly refuses to promote. That is the designed, correct outcome, not a failure.

## Tier-3 + Tier-4 adversarial review — a CRITICAL was caught and fixed
`qe-code-reviewer` confirmed the shadow return-value invariant and KRR soundness, but found the
GATE itself broken. All substantive findings fixed before merge:
- **F1 CRITICAL — FIXED**: a raw quality-per-dollar gate with a ~$0 cost floor let cost dominate quality — a 0.10-quality **free** router would promote over a 0.95-quality paid champion, and could never roll back. Replaced with the DRACO discipline: promote only on an **absolute quality bar** + **no quality regression (CI lower bound)** + a **real efficiency win (CI)**. Rollback is now **quality-based (scale-free)**, so a garbage free router can't promote and a promoted regressor rolls back. (Verified by a dedicated F1 test.)
- **F2 HIGH — FIXED**: zero-variance bursts collapsed the CI to the mean (se=0 → promote on a hair). Added an **se-floor** so a constant sample must clear `z·seFloor + margin`.
- **F3 HIGH — FIXED**: rollback was trend-blind (whole-window mean) and scale-blind (fixed −0.05). Now **trend-aware** (recent sub-window) and scale-free (quality is [0,1]); a slow recent regression rolls back (tested).
- **F4 MEDIUM — FIXED** (absolute quality floor — part of F1).
- **F5 MEDIUM — FIXED**: `observe()` wraps predict/embed in try/catch (shadow can't throw into serving), and `predict()` fail-safes a non-finite score to the **cheapest** tier, not the most expensive off-box one.
- **F6 MEDIUM — FIXED**: the challenger never scores a `pinnedPrivate` prompt off-box (records tier-private, no predict). Locality is defense-in-depth on top of the champion's private lane.
- **F7 — noted** (KRR is sound: λI keeps K+λI PD; `predict` now finiteness-checks).
- Test gaps closed: F1 free-quality-blind, F2 se-floor, F3 slow-regression, shadow-throw isolation, locality, NaN fail-safe.

## Gate summary
- Tier 1: lint ✅ · build ✅ · test 143/143 ✅ · security invariants ✅ (challenger never serves; private never scored off-box; no promotion of a quality-regressing router).
- Tier 2: DoD green.
- Tier 3+4 (risk_phase): adversarial pass caught a CRITICAL gate fail-open + 2 HIGH; all fixed with tests. Full mutation/chaos harnesses disproportionate for pure statistical modules — a targeted adversarial reviewer on the real blast radius (wrong promotion / missed rollback / shadow leak) was the proportionate call.
- test_integration (live smoke): deferred — the learned router enters the serving path only after a real promotion, which won't happen on this seed.
