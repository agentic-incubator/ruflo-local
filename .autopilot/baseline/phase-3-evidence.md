# Phase 3 — evidence: DRACO routing-corpus recorder into a real RVF store

Feature: `local-first-learned-routing` · mode: `pr_ci` · gate: **PASSED** (2026-07-04)

Records every routing decision as a DRACO row — `{prompt_hash, embedding, category, tier,
judge_score, cost, latency, escalated}` — into a **real ruvector `.rvf` store** from day one
(no-backfill), so the per-question learner (phases 4–5) has training data with zero backfill.

## What shipped
- `scripts/lib/recorder.mjs` — embed (in-process) + append to `.ruvector/routing-corpus.rvf` via `@ruvector/rvf`'s `RvfDatabase`; portable JSONL fallback when the SDK is absent.
- `scripts/lib/__tests__/recorder.test.mjs` — 10 node:test cases.
- `package.json` (repo's first deps, both **optional**): `@ruvector/rvf` (real `.rvf`) + `@ruvector/ruvllm` (in-process embedder). `node_modules` + `.ruvector/` gitignored; `package-lock.json` committed.
- CI static job: `npm ci` step (npm-cached) so the real-RVF tests run in CI too.

## Definition of Done — green
- `node --check scripts/lib/recorder.mjs` ✅
- `node --test .../recorder.test.mjs` → 10/10 ✅ (schema · **count grows 1→2** · reopen persists · on-disk privacy · dim-check · JSONL dedup)
- grep `embedding` present ✅ · no `TODO|FIXME` ✅
- prose (real store, not a stub): `status().totalVectors` grows **1→2** on two distinct records and **persists across reopen** — asserted in the tests; also demonstrated end-to-end with the real in-process ruvllm embedder (768-dim) → `kind: rvf`, count 1→2.

## Grounding decision (per "don't trust stale priors")
The bundled `ruvector` CLI (0.2.33) initially *looked* broken (count stuck at 1), but rigorous
re-testing showed that was a red herring (I'd reused an identical embedding → legitimate
dedup). The CLI and the `@ruvector/rvf` SDK both work correctly. Per the operator's request an
upstream issue was filed for the *real* rough edges found — **ruvnet/RuVector#641**
(`dimensions` vs `dimension` create-options trap + broken MCP `rvf_create`; `embed text` has no
stdin so raw text hits argv). Storage uses the SDK (`RvfDatabase`), created with `dimensions`.

## Tier-3 adversarial review — outcome
`qe-code-reviewer` confirmed privacy-in-corpus is sound but found 8 defects; the substantive
ones were fixed before merge:
- **P1 (PRIVACY, argv leak) — FIXED**: the first cut shelled the raw prompt to `ruvector embed text <prompt>` (visible in `ps`/`/proc`/audit logs). Replaced with an **in-process** `@ruvector/ruvllm` embedder — no CLI, no argv, no `child_process` at all. Default now throws (asking to install/inject) rather than ever falling back to a leaky CLI.
- **P2 (silent corpus split) — FIXED**: the fallback now fires ONLY when the SDK import is absent (`RVF_SDK_ABSENT`); an operational RVF error propagates instead of silently downgrading a healthy `.rvf` to JSONL mid-run.
- **P3 (52-bit id collision) — FIXED**: the RVF id is now the FULL prompt_hash string (no truncation) — verified the SDK accepts string ids; distinct prompts never collide.
- **P4 (dedup/count divergence) — FIXED**: dedup-by-prompt is documented (one point per unique prompt, latest wins — the learner's granularity); JSONL `count()` now counts unique ids, matching RVF.
- **P5 (test gaps) — FIXED**: added an **on-disk** privacy readback (reads the `.rvf` bytes and asserts the raw secret is absent) and direct JSONL-backend tests.
- **P7 (validator) — FIXED**: `validateDracoRow` now type-checks every field (numbers/booleans/hex), not just presence.
- **P8 (dim mismatch) — FIXED**: `record()` asserts `embedding.length === store dimension` with a clear error; JSONL path handles a non-`.rvf` corpus path.
- **P6 (tmp collision) — moot**: no tmp file / no spawn (in-process embedder).

## Gate summary
- Tier 1: lint ✅ · build ✅ · test 101/101 ✅ · no-test-tampering ✅ · security invariants ✅ (raw prompt never stored AND never logged to argv; no shelling out).
- Tier 2: DoD green.
- Tier 3: reviewed; P1–P5,P7,P8 fixed, P6 moot.
- test_integration (live smoke): deferred — recorder enters the request path in Phase 4.
