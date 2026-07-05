# Ecosystem Audit — ruflo 3.21.1→3.25.1 & ruvector 0.2.34

> **Date:** 2026-07-05
> **Status:** audit + decisions (pipeline re-sequenced; phase-7 re-scoped; low-risk items scheduled)
> **Trigger:** ruflo advanced 5 minor releases and ruvector shipped 0.2.34 while `ruflo-local`
> was operating on pinned `ruflo@3.21.1` / `@ruvector/rvf@0.2.2`.
> **Companion docs:** `routing-refactor-decisions.md` (D1–D6), `metaharness-and-ruflo-local.md`
> (two-learner caveat), `.autopilot/pipeline.yml` (the phase plan this re-sequenced).
> Grounding: ruflo release notes (GitHub), ruvector v0.2.34 release + gist, and the RuvNet
> Brain (`search_ruvnet`) for source-level claims.

## Verdict

The ecosystem shipped — as productized, signed, significance-tested features — almost exactly
the learned-routing loop `ruflo-local` hand-built in phases 3–5, and it independently hardens the
same promotion-gate weaknesses our own adversarial review caught. **Nothing forced a redesign.**
Two clear wins were taken; the rigor upgrades were scheduled as new phases; one premature phase
(v2 tier schema) was re-scoped to a low-risk additive change.

## Versions

| Component | Was | Latest | Action |
|---|---|---|---|
| ruflo (pin) | `3.21.1` | `3.25.1` | bump **deferred to phase 10** (where the router is exercised) |
| `@ruvector/rvf` | `0.2.2` | `0.2.3` | **bumped in phase 6** — fixes our upstream #641 |
| ruvector CLI | `0.2.33` | `0.2.34` | picked up with the SDK bump |
| `@ruvector/ruvllm` | `^0.2.0` | + `lattice` Metal backend | tangential (macOS Metal LLM inference, not an embedder) |

## Impact by release

| Release | What it is | Touches | Impact |
|---|---|---|---|
| **rvf 0.2.3 / ruvector 0.2.34** | Fixes **our #641**: `dimension`/`dimensions` both accepted; MCP `rvf_create` fixed; `embed text` gains stdin/`--input-file` | recorder, RVF corpus | ✅ low-risk upgrade; validates our in-process-embedder choice |
| **ruflo 3.22** | Memory distillation + **real failure-signal capture** (hooks record actual failures, not hardcoded `success:true`) | reflex, corpus labels | ⚠️ our corpus has no negatives → **phase 9** |
| **ruflo 3.23** | Nightly **WAL-safe vector-DB backup** + rotation | `.ruvector/routing-corpus.rvf` | ⚠️ our corpus has no backup → **`corpus-durability` plan** (was phase 12; split to `.autopilot/queued/`) |
| **ruflo 3.24** | **Self-Learning Flywheel**: shadow-first, no-auto-serve, significance-gated, signed replayable lineage, drift canary + auto-rollback | phases 3–5 | 🎯 productized form of our loop; ours lacks significance test + signed lineage + canary + replay |
| **ruflo 3.25.0** | **Anti-overfitting proofs**: frozen hash-pinned held-out; per-gen human-relevance deltas; clean-room replay | phase 5 gate | 🎯 directly hardens our F1–F3 gate fixes → **phase 8**. Note: the "Lattice embedder" is **inactive/vaporware** (no `@ruvector/lattice-wasm`) — do not chase |
| **ruflo 3.25.1** | **Enforceable no-stub**: `RUFLO_REQUIRE_REAL_EMBEDDINGS=1` makes hash fallbacks throw | `train-router.mjs` | ⚠️ our trainer defaulted to a hash stub → **fixed in phase 6** |

## Judgment calls

| # | Call | Status |
|---|---|---|
| 1 | `@ruvector/rvf` → 0.2.3 (closes #641) | ✅ done (phase 6) |
| 2 | Real embedder default + honor `RUFLO_REQUIRE_REAL_EMBEDDINGS` | ✅ done (phase 6) |
| 3 | ruflo pin 3.21.1 → 3.25.1 | scheduled (phase 10, where the router is validated) |
| 4 | Adopt anti-overfitting methodology in the gate | scheduled (phase 8) |
| 5 | Capture real failure-signal as corpus negatives | scheduled (phase 9) |
| 6 | Corpus WAL-safe backup + rotation | scheduled (`corpus-durability` plan; was phase 12) |
| 7 | Lattice / Metal LLM backend | ignored for routing (macOS Metal inference, not an embedder) |

## Pipeline re-sequencing (2026-07-05)

Because phases 7/10/11 build **on** the ruflo/ruvector versions and the embedding substrate,
refreshing before them avoids rework. Final layout (phases 0–5 already merged):

| id | phase | risk? |
|---|---|---|
| 6 | ecosystem refresh (9a): rvf 0.2.3 + no-stub real-embedder default | — |
| 7 | tier-schema locality — **re-scoped, see below** | — |
| 8 | rigorous promotion proofs (frozen held-out + significance + replay) | risk |
| 9 | no-stub embeddings + real negatives | — |
| 10 | ruflo pin → 3.25.1 + metaharness eval | risk |
| 11 | Rust ruvector-gateway sidecar | risk |
| 12 | corpus durability (WAL-safe backup) | — |

## Decision: phase 7 (tier-schema v2) re-scoped to "Option A" (low-risk)

The original phase 7 ("flip `schema_version`→2, update the invariant everywhere, gated on
Phase-5 promotion") was **higher risk than its value**, because everything learned says v2's job
is already done at a better layer:

- **Nothing runtime reads the tier `schema_version`** — it is inert config metadata (the only
  `schema_version` a `.mjs` reads is budget-snapshot's *own* output schema).
- **Per-request locality is already enforced at runtime and tested airtight** —
  `router.mjs pinnedPrivate → tier-private (never off-box)` + the reflex's fail-closed allowlist.
  Locality is a *request* attribute, not a per-tier-config attribute.
- **ruflo defines/requires no v2 tier-locality schema** (`search_ruvnet` found no consumer);
  `ruflo-tiers.json` is our own overlay consumed via `CLAUDE_FLOW_ROUTER_OPENROUTER_ALTS`.
- **The promotion v2 was gated on never fired** (thin n≈15 seed → correct no-promote, per ADR-201 H5).

**Re-scoped criteria (non-breaking, additive, documentary):** declare each tier's *default*
locality as additive metadata ruflo/LiteLLM ignore; make the invariant accept
`schema_version ∈ {1,2}`; document that per-request locality is the runtime `pinnedPrivate`
override; keep the `tiers` map shape and rendered gateway configs unchanged; keep the
`tier-private` local-only pin inviolable. Full v2 materialization + its activation stay gated on a
real promotion. `depends_on` 5→4 (decoupled from the promotion trigger).

## Upstream contribution

Filed & fixed: [ruvnet/RuVector#641](https://github.com/ruvnet/RuVector/issues/641) — the
`dimensions`/`dimension` create-options trap + broken MCP `rvf_create` + `embed text` argv
exposure; all three addressed in ruvector 0.2.34 / `@ruvector/rvf@0.2.3`.
