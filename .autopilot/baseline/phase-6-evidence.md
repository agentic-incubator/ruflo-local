# Phase 6 (9a) — evidence: ecosystem refresh + no-stub real-embedder default

Feature: `local-first-learned-routing` · mode: `pr_ci` · gate: **PASSED** (2026-07-05)

Inserted by the 2026-07-05 ecosystem audit as the platform baseline for phases 7–12:
take `@ruvector/rvf` 0.2.3 (fixes our upstream issue #641) and adopt ruflo 3.25.1's
no-stub norm — a REAL in-process embedder is the runtime default; a hash fallback is a
last resort that THROWS under `RUFLO_REQUIRE_REAL_EMBEDDINGS=1`.

## What shipped
- `package.json`: `@ruvector/rvf` ^0.2.2 → **^0.2.3** (installed 0.2.3; lock refreshed).
- `scripts/lib/train-router.mjs`: `trainRouter` is now **async** (awaits the embedder, derives `dim` from the actual embedding length). New `embedderDecision()` (pure) + `resolveEmbedder(env)` — real ruvllm default, degrade-to-hash unless `RUFLO_REQUIRE_REAL_EMBEDDINGS=1` (then throw). CLI trains with the real embedder (768-dim).
- `scripts/lib/__tests__/promotion.test.mjs`: updated for async `trainRouter`; added `embedderDecision` no-stub tests.

## Definition of Done — green
- `jq .optionalDependencies["@ruvector/rvf"] == "^0.2.3"` ✅
- `npm ci` (lock consistent) + `node --test …/*.test.mjs` → **146/146** ✅
- grep `REQUIRE_REAL_EMBEDDINGS` in train-router.mjs ✅ · no `TODO|FIXME` ✅
- CLI `train-router --seed … --out …` → artifact with `.candidates` + `.alpha`, now `dim: 768` (real ruvllm) ✅

## Notes
- **#641 fixed upstream**: `@ruvector/rvf@0.2.3` + ruvector 0.2.34 accept `dimension`/`dimensions`, fix MCP `rvf_create`, and add `embed --stdin/--input-file`. Our recorder already embeds **in-process** (ruvllm, no CLI/argv), so the argv item is moot here — noted, not needed.
- The **library** `trainRouter` keeps `hashEmbed` as its injectable default so deterministic tests stay sync-simple; only the **runtime** default (CLI) flips to the real embedder — that's the "default changes" intent without breaking test determinism.
- The ruflo pin bump (3.21.1→3.25.1) is deliberately **deferred to phase 10** (where the router is exercised), not done here.

## Gate summary
- Tier 1: lint ✅ · build ✅ · test 146/146 ✅ · no shell-out embed path (verified) ✅.
- Tier 2: DoD green.
- Tier 3: focused review (async refactor + embedder resolver). Findings fixed before merge:
  - **#1 HIGH — FIXED**: the no-stub guard lived only in the CLI wiring; a direct `trainRouter({rows})` could still hash-train under `RUFLO_REQUIRE_REAL_EMBEDDINGS=1`. `trainRouter`'s DEFAULT embedder is now the real-embedder resolver (enforced at the library boundary; tests pass `hashEmbed` explicitly).
  - **#2 MEDIUM — FIXED**: `resolveEmbedder` no longer wraps each call in an over-broad catch with a sticky hash latch. It decides once on module PRESENCE (`isRuvllmAvailable` via `require.resolve`); a runtime ruvllm error now propagates instead of silently downgrading to hash (mirrors recorder's absent-vs-operational split).
  - **#3 MEDIUM — FIXED**: added tests for `resolveEmbedder`, the async-embed `trainRouter` path, and the data guard.
  - **#4 LOW-MED — FIXED**: `trainRouter` validates embeddings (non-empty, equal-length, finite) and throws rather than writing a `dim:0 / NaN-alpha` garbage model.
  - **#5 LOW — noted**: latent (no caller passes an async embed to the sync `ShadowChallenger`); `observe()`'s try/catch already fails safe to the champion tier.
