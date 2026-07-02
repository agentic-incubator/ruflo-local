# 🔬 Evidence Appendix — Code-Level Audit

> **What this is:** a reconditioned copy of the code-level audit backing the [Architecture RFC](architecture-rfc.md). All findings from direct source inspection of shallow clones — **ruflo @ `4eb807aa` (2026-07-01)**, **ruvector @ `2b68dad0` (2026-06-29)**. Paths are given so reviewers can verify; statements paraphrase code and in-repo docs.

← Back to [Guide home](../README.md) · [Architecture RFC](architecture-rfc.md)

---

## A. Routing subsystem inventory (ruflo)

### A.1 `v3/@claude-flow/cli/src/ruvector/` — the shipped router

| File | LoC | Role |
|---|--:|---|
| `model-router.ts` | 1,490 | Default router. Complexity score = blend of lexical, semantic-depth, task-scope, uncertainty heuristics (pure JS). Selection = Thompson-sampling Beta-Bernoulli bandit with complexity-bucketed priors (ADR-142), persisted to `.swarm/model-router-state.json`. Uncertainty + circuit breaker drive escalation. Reward shaping: haiku success 1.0 > sonnet 0.7 > opus 0.4; escalated haiku→0.0 — the bandit self-corrects against tier overuse. Optional neural prior perturbs Beta priors per-call without persisting (ADR-148). |
| `neural-router.ts` | 957 | Gated cost-optimal path (ADR-148/149/150). Backends: `metaharness-knn`, `metaharness-krr`, `fastgrnn`. Gates: `CLAUDE_FLOW_ROUTER_NEURAL=1` + embedding + loadable artifact; else null → bandit fallback. Returns concrete `modelId`, `predictedQuality`, `metBar`, cheapest-first alternatives, `inferenceTimeUs`. Supports **latency budget** and **cost ceiling** (`…_COST_CEILING_USD_PER_MTOK`; $5 keeps cheap+mid, $20 excludes Sonnet+Opus, $50 excludes Opus). `routedBy` contractually never inferred. |
| `q-learning-router.ts` | 935 | RL-based router variant (not in default path). |
| `coverage-router.ts` | 653 | Coverage-driven routing experiments. |
| `enhanced-model-router.ts` | 736 | Extended router variant. |
| `semantic-router.ts` | 228 | Embedding-similarity routing utility. |
| `router-trajectory.ts` | 398 | Decision trajectory recorder. |
| `router-parallel-recorder.ts` | 252 | Logs parallel decisions for the SelfEvolvingRouter promotion gate. |
| `router-calibrator.ts` | 141 | Calibration loader. |

### A.2 Router assets — `assets/model-router/`

`seed-router.fastgrnn.safetensors` · `seed-router.krr{,.low,.med,.high}.json` · `seed-router.calibrator*.json` · `seed-rows.json` · `openrouter-alts.json`.

**`openrouter-alts.json` highlights** (measured 2026-06-15):
- Per-Claude-tier OpenRouter alternates; `agent-execute-core` uses the suggestion to override `MODEL_MAP[tier]`. Override via `CLAUDE_FLOW_ROUTER_OPENROUTER_ALTS`; per-call via `OPENROUTER_DEFAULT_MODEL`. Explicit caveat: operators should **re-train an artifact with measured DRACO rows for their own traffic**.
- Cheap tier: Ling 2.6 Flash — 100% pass over 45 runs, ~$0.001/1k passes, ~151× cheaper than Haiku 4.5 in that harness.
- Mid tier: GPT-4.1 above Sonnet 4.6 on a 5-criterion rubric at ~4× lower cost; Llama-3.3-70B flagged as $/quality Pareto leader (~91% of Sonnet quality at ~70× cheaper).
- **Judge-bias audit** included: cross-grading with GPT-4.1 as judge shifts absolute scores −7…−11 pp but preserves ranking — single-judge numbers are inflated but ordinally honest.

### A.3 Execution dispatch — `mcp-tools/agent-execute-core.ts`
- `AgentRecord` carries `model` (tier), `modelRoutedBy`, `modelId`, `provider: 'anthropic'|'openrouter'`, `openrouterModel`.
- Provider precedence: explicit `RUFLO_PROVIDER=ollama` → Ollama; else Anthropic key; else OpenRouter key; else Ollama key; else instructive error.
- `callOllamaCompat`: OpenAI-compatible `POST {base}/v1/chat/completions`; `OLLAMA_BASE_URL` for local endpoints; responses normalized. **Implication:** the OpenAI-compat call the local tier needs already exists — the change is making it tier-addressable rather than global.

### A.4 Provider + integration packages (built, partially wired)
- `@claude-flow/providers` — `anthropic|openai|google|cohere|ollama|ruvector` providers + `provider-manager.ts`: load balancing, automatic failover, request caching, cost estimates. Ollama provider defaults `baseUrl` to `http://localhost:11434`.
- `@claude-flow/integration/multi-model-router.ts` — provider types incl. `ollama`/`onnx`; routing modes; `budgetLimit` + `budgetPeriod`; emits `budget:warning` at 80% and `budget:exceeded` at limit. **Budget is evented, not consumed by selection** — Gap 3 evidence.

### A.5 Cost tracking & observability — `plugins/ruflo-cost-tracker/`
23 CLI subcommands / 20+ skills. Decision-relevant subset:

| Skill/command | Function |
|---|---|
| `cost-track` (auto via Stop hook) | Per-session token capture from Claude Code jsonl |
| `cost-report`, `cost-breakdown` | USD attribution by tier/model/agent |
| `cost-budget-check` | Alert ladder info@50 / warn@75 / critical@90 / **hard stop@100 (exit 1)** |
| `cost-counterfactual` | Actual spend vs always-haiku/sonnet/opus baselines — **ready-made acceptance harness for G2** |
| `cost-export` | **Prometheus textfile collector** or webhook JSON |
| `cost-summary --format json` | **Stable JSON contract** — the interface the budget gate consumes |
| `cost outcome <task> <model> <outcome>` | Emits `hooks_model-outcome` so the router learns |

---

## B. ruvector inventory (routing-relevant crates)

| Crate / package | Relevance |
|---|---|
| `crates/ruvector-tiny-dancer-core` (+`-node`, `-wasm`) | FastGRNN neural routing engine. 144 ns feature extraction; 7.5 µs single inference; ~93 µs over 100 candidates; <1 MB models with 80–90% sparsity; INT8; conformal uncertainty; circuit breaker. The `fastgrnn` backend `neural-router.ts` loads. |
| `crates/ruvector-router-core` (+cli/ffi/wasm) | Vector DB + inference engine: HNSW (<0.5 ms p50), SIMD distance, 4–32× quantization. Basis for a semantic route-cache and Path 4's gateway core. |
| `METAHARNESS-README.md` + `ADR-265..267` | Darwin-mode evolutionary parameter optimization + 3-tier validation with signed witnesses — reusable for retraining/validating router artifacts against operator-local models. |

---

## C. Gap traceability matrix

| Gap | Concrete evidence | Proposal element that closes it |
|---|---|---|
| G-1 No per-request local tier | Provider hint type `'anthropic'\|'openrouter'`; Ollama reachable only via global `RUFLO_PROVIDER`; alts JSON has no `provider`/`base_url` | [RFC §8.3](architecture-rfc.md#83-schema--routing-tiersjson-v2-superset-of-openrouter-altsjson) tier schema v2 + one dispatch branch |
| G-2 No traffic-share target | No share/quota concept anywhere; reward shaping + cost ceiling are per-request, not distributional | [RFC §8.2](architecture-rfc.md#82-budget-steering-control-loop) share governor (RouteLLM-style) |
| G-3 Budgets don't steer | `multi-model-router` emits events only; cost-tracker ladder exits processes but `route()` has no budget input | [RFC §8.2](architecture-rfc.md#82-budget-steering-control-loop) budget gate consuming `cost-summary` JSON |
| (minor) Parallel stacks | Raw-fetch dispatch alongside ProviderManager | RFC Phase 1 routes all tier dispatch through one seam |
| (minor) No OTel | No `opentelemetry`/`otlp` usage in v3 TS sources | [RFC §8.4](architecture-rfc.md#84-observability-spec) span spec on GenAI semconv |
| (minor) No in-band verification | Escalation is pre-response; outcomes recorded post-hoc | RFC Phase 3 optional FrugalGPT-style verifier |

---

## D. External reference notes (paraphrased)

- **RouteLLM** [R1]: binary strong/weak routing trained on preference data; cost reductions >2× (85% MT-Bench); APGR/CPT metrics; threshold α selected to meet a target strong-model call percentage; routers transfer to unseen pairs.
- **FrugalGPT** [R2]: prompt adaptation + LLM approximation + cascade; post-query quality scorer; 50–98% cost savings; HEADLINES sent 16.6% of queries to GPT-4 — anchor for the 10% target being realistic.
- **LiteLLM** [L1–L3]: per-provider/model `max_budget` + `budget_duration` (1s…1mo); `fail_closed_budget_enforcement`; ordered + context-window fallbacks; routing strategies with cooldowns; Prometheus incl. `litellm_provider_remaining_budget_metric`; OTel callback. Postgres+Redis at scale; Python-proxy overhead past a few hundred RPS.
- **OTel GenAI semconv** [O1–O3]: status Development; span attrs (`gen_ai.*`), agent spans, content-capture events (opt-in); Claude Code already exports OTel metrics/logs.
- **Local serving** [S1][S2]: Ollama = llama.cpp/GGUF, OpenAI-compat `:11434/v1`, sequential-by-default; vLLM = PagedAttention/safetensors, ~2× throughput at 32-way concurrency, `:8000/v1`; migration = base-URL + model-name change.

---

## E. Glossary

**Tier** — a routing destination class (codemod / local-fast / local-heavy / frontier). **Locality** — whether a tier runs on operator hardware (`local`) or a paid API (`frontier`). **Share governor** — controller adjusting the routing threshold so observed frontier share tracks a target. **Demotion rung** — budget-utilization level at which frontier candidates receive selection penalties. **`routedBy`** — provenance label on every decision identifying the deciding backend; a repo invariant this proposal preserves. **DRACO rows** — measured benchmark rows used to train router artifacts. **APGR / CPT** — RouteLLM's routing-quality metrics.

---

*Companion design document → [Architecture RFC](architecture-rfc.md). All external links → [Resources](resources.md).*
