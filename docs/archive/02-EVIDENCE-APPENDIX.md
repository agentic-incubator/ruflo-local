# Evidence Appendix — Code-Level Audit of ruvnet/ruflo and ruvnet/ruvector

Companion to `01-ARCHITECTURE-PROPOSAL.md`. All findings from direct source inspection of shallow clones: **ruflo @ `4eb807aa` (2026-07-01)**, **ruvector @ `2b68dad0` (2026-06-29)**. Line counts via `wc -l`; quotations avoided — statements paraphrase code and in-repo docs, with paths given so reviewers can verify.

---

## A. Routing Subsystem Inventory (ruflo)

### A.1 `v3/@claude-flow/cli/src/ruvector/` — the shipped router

| File | LoC | Role (as documented in module headers + read of implementation) |
|---|--:|---|
| `model-router.ts` | 1,490 | Default router. Complexity score = blend of lexical, semantic-depth, task-scope, uncertainty heuristics (pure JS, no model load). Selection = Thompson-sampling Beta-Bernoulli bandit with complexity-bucketed Beta(α,β) priors (ADR-142), persisted to `.swarm/model-router-state.json`, updated via `recordOutcome`. Uncertainty + circuit breaker drive escalation. Header explicitly corrects ADR-026: the originally-described tiny-dancer neural path "was never wired in directly"; it is now an optional gated addition (ADR-148). Reward shaping: haiku success 1.0 > sonnet 0.7 > opus 0.4; escalated haiku→ 0.0, sonnet 0.1 — the bandit self-corrects against tier overuse. Optional neural prior perturbs Beta priors per-call without persisting (hybrid math, ADR-148). |
| `neural-router.ts` | 957 | Gated cost-optimal path (ADR-148/149/150). Backends: `metaharness-knn`, `metaharness-krr` (LOO-CV λ), `fastgrnn` via `@ruvector/tiny-dancer`. Gates: `CLAUDE_FLOW_ROUTER_NEURAL=1` + embedding supplied + artifact/corpus loadable; otherwise returns null → bandit fallback with `routedBy:'bandit-fallback'`. Returns concrete `modelId` (Anthropic id or OpenRouter slug), `predictedQuality`, `metBar`, cheapest-first alternatives, `inferenceTimeUs`, optional `ensembleDisagreement` (iter 45). Supports **latency budget** (`…_LATENCY_BUDGET_MS`) and **cost ceiling** (`…_COST_CEILING_USD_PER_MTOK`; code comments give worked examples: $5 keeps only cheap+mid candidates, $20 excludes Sonnet+Opus, $50 excludes Opus). Post-hoc isotonic calibration via bundled calibrator JSONs (iter 22+24). `routedBy` is contractually never inferred (ADR-074/086). |
| `q-learning-router.ts` | 935 | RL-based router variant (not in default path). |
| `coverage-router.ts` | 653 | Coverage-driven routing experiments. |
| `enhanced-model-router.ts` | 736 | Extended router variant. |
| `semantic-router.ts` | 228 | Embedding-similarity routing utility. |
| `router-trajectory.ts` | 398 | Decision trajectory recorder (rotating logs; `…_TRAJECTORY*` envs). |
| `router-parallel-recorder.ts` | 252 | ADR-150 iter 11–12: logs parallel decisions for the SelfEvolvingRouter promotion gate (`…_PARALLEL_LOG*`). |
| `router-calibrator.ts` | 141 | Calibration loader. |

### A.2 Router assets — `v3/@claude-flow/cli/assets/model-router/`

`seed-router.fastgrnn.safetensors` · `seed-router.krr{,.low,.med,.high}.json` · `seed-router.calibrator{,.low,.med,.high}.json` · `seed-rows.json` (+ provenance) · `openrouter-alts.json`.

**`openrouter-alts.json` highlights** (measured 2026-06-15, per its own `_meta`):

- Purpose: per-Claude-tier OpenRouter alternates; downstream `agent-execute-core` uses the suggestion to override `MODEL_MAP[tier]`. Override file via `CLAUDE_FLOW_ROUTER_OPENROUTER_ALTS`; per-call via `OPENROUTER_DEFAULT_MODEL`. Explicit caveat: costs/choices are starters, and operators should **re-train an artifact with measured DRACO rows for their own traffic**.
- Cheap tier: default alt Ling 2.6 Flash — 100% pass over 45 runs, 684±104 ms, ~$0.001/1k passes, characterized as ~151× cheaper than Haiku 4.5 in that harness; a free Nemotron tier noted as fallback-only due to 429s.
- Mid tier: GPT-4.1 measured above Sonnet 4.6 on their 5-criterion LLM-judged rubric at ~4× lower cost; Llama-3.3-70B flagged as the $/quality Pareto leader (~91% of Sonnet quality at ~70× cheaper).
- **Judge-bias audit** included: cross-grading with GPT-4.1 as judge shifts absolute scores −7…−11 pp but preserves ranking; conclusion recorded that single-judge numbers are inflated but ordinally honest. (Relevance: methodological maturity of the in-repo benchmark harness we propose to reuse for local-model rows.)

### A.3 Execution dispatch — `v3/@claude-flow/cli/src/mcp-tools/agent-execute-core.ts`

- `AgentRecord` carries `model` (tier), `modelRoutedBy: 'explicit'|'router'|'codemod'|'default'|'hybrid'`, `modelId` (ADR-149 concrete id), `provider: 'anthropic'|'openrouter'`, `openrouterModel`.
- Provider precedence (issue #1725, #2042): explicit `RUFLO_PROVIDER=ollama` → Ollama; else Anthropic key; else OpenRouter key; else Ollama key; else instructive error listing all three envs.
- `callOllamaCompat`: OpenAI-compatible `POST {base}/v1/chat/completions`; `OLLAMA_BASE_URL` documented in-code for local/self-hosted endpoints (`http://localhost:11434`), auth header sent only for cloud-shaped keys; logical tier names mapped to Ollama defaults (e.g. opus → `gpt-oss:120b-cloud` since no opus-class local default); responses normalized so callers never see provider-specific fields. **Implication for Path 2:** the OpenAI-compat call the local tier needs already exists; the change is making it tier-addressable rather than global.
- Note: dispatch here uses raw `fetch` per provider rather than `@claude-flow/providers`' ProviderManager (which the file's header references) — evidence for the "parallel stacks" finding (§3.2, Gap fold-in).

### A.4 Provider + integration packages (built, partially wired)

- `v3/@claude-flow/providers/src/` — `anthropic|openai|google|cohere|ollama|ruvector`-provider + `provider-manager.ts`: load balancing (round-robin, latency-based, cost-based), automatic failover (`fallback.maxAttempts`, `fallback_success` / `fallback_exhausted` events), request caching, cost estimates, usage stats. Ollama provider defaults `baseUrl` to `http://localhost:11434`.
- `v3/@claude-flow/integration/src/multi-model-router.ts` — provider types incl. `ollama` and `onnx` (local, $0 in its catalog); routing modes manual / cost- / performance- / quality-optimized / rule-based; `RoutingRequest` supports `maxCost`, `maxLatency`, `minQuality`; config has `budgetLimit` + `budgetPeriod: 'hourly'|'daily'|'monthly'`; emits `budget:warning` at 80% and `budget:exceeded` at limit. **Budget is evented, not consumed by selection** — Gap 3 evidence.

### A.5 Cost tracking & observability — `plugins/ruflo-cost-tracker/`

23 CLI subcommands / 20+ skills. Decision-relevant subset:

| Skill/command | Function |
|---|---|
| `cost-track` (auto via Stop hook) | Per-session token capture from Claude Code jsonl into `cost-tracking` namespace |
| `cost-report`, `cost-breakdown` | USD attribution by tier/model/agent |
| `cost-budget-check` | Configurable budget; alert ladder info@50 / warn@75 / critical@90 / **hard stop@100 (exit 1)** |
| `cost-projection`, `cost-burn`, `cost-anomaly` | Forward extrapolation; window-over-window burn deltas; MAD outlier detection (Iglewicz–Hoaglin 3.5) |
| `cost-counterfactual` | Actual spend vs always-haiku/sonnet/opus baselines — quantifies routing's win; **ready-made acceptance harness for G2** |
| `cost-diff`, `cost-health` | CI regression gating on cost snapshots; composite gate |
| `cost-export` | **Prometheus textfile collector output** or webhook JSON — existing bridge to Grafana/Datadog |
| `cost-summary --format json` | Documented **stable JSON contract for inter-plugin consumption** — the interface Path 2's budget gate consumes |
| `cost outcome <task> <model> <outcome>` | Emits `hooks_model-outcome` so the router learns — closes the loop from cost land |

Also relevant: `v3/@claude-flow/guidance/src/gateway.ts` — deterministic per-tool-call pipeline with **multi-dimensional budget metering** (idempotency → schema → budget → decision, returning `budgetRemaining`); a precedent inside the repo for budget-as-gate semantics.

### A.6 Router environment-variable surface (observed, `src/ruvector/*.ts`)

`CLAUDE_FLOW_ROUTER_` + : `NEURAL`, `NEURAL_WEIGHT`, `MODEL_PATH`, `SEED_CORPUS`, `QUALITY_BAR`, `LATENCY_BUDGET_MS`, `COST_CEILING_USD_PER_MTOK`, `OPENROUTER_ALTS`, `PROVIDER`, `KNN_K`, `EMBED_CACHE_SIZE`, `CALIBRATE`, `CALIBRATOR_PATH`, `ENSEMBLE_UNCERTAINTY_THRESHOLD`, `AB`, `AB_SAMPLE_RATE`, `BANDIT_{FULL_INFLUENCE, PER_MODEL, SHRINKAGE_LAMBDA, WARMUP_RANGE}`, `TRAJECTORY{,_PATH,_MAXSIZE,_MAXROTATIONS,_TASKLEN}`, `PARALLEL_LOG{,_PATH,_MAX_BYTES,_TASK,_TASK_LIMIT}`.
Plus execution-side: `RUFLO_PROVIDER`, `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_DEFAULT_MODEL`, `ANTHROPIC_API_KEY`.
**Reading:** an unusually rich override surface — Path 1 (config-only) is viable precisely because of it, and Path 2's `…_LOCALITY`/governor knobs follow an established naming idiom.

---

## B. ruvector Inventory (routing-relevant crates)

| Crate / package | Relevance |
|---|---|
| `crates/ruvector-tiny-dancer-core` (+`-node`, `-wasm`; npm `@ruvector/tiny-dancer{,-wasm}` + per-platform binaries) | FastGRNN neural routing engine. README-documented figures: 144 ns feature extraction; 7.5 µs single inference; ~93 µs complete routing over 100 candidates; <1 MB models with 80–90% sparsity; INT8 quantization; conformal-prediction uncertainty; circuit breaker; SQLite/AgentDB persistence. Positioned as routing high-confidence work to cheap models and low-confidence work to expensive ones for a claimed 70–85% LLM cost reduction. This is the `fastgrnn` backend `neural-router.ts` loads. |
| `crates/ruvector-router-core` (+cli/ffi/wasm) | Vector DB + neural routing inference engine: HNSW (<0.5 ms p50 claim), SIMD distance (simsimd), scalar/product/binary quantization (4–32×), request-distribution/model-selection/failover features. Basis for a semantic route-cache and for Path 4's gateway core. |
| `METAHARNESS-README.md` + `docs/adr/ADR-265..267` | Darwin-mode evolutionary parameter optimization + 3-tier validation protocol with signed witnesses — reusable methodology for retraining/validating router artifacts against operator-local models (Phase 1b). |

---

## C. Gap Traceability Matrix

| Gap | Concrete evidence | Proposal element that closes it |
|---|---|---|
| G-1 No per-request local tier | Provider hint type `'anthropic'\|'openrouter'` (`agent-execute-core.ts`); Ollama reachable only via global `RUFLO_PROVIDER` / key-absence fallback; alts JSON has no `provider`/`base_url` fields | §8.4 tier schema v2 (`provider:'openai-compat'`, `base_url`, `locality`) + one dispatch branch |
| G-2 No traffic-share target | No share/quota concept anywhere in `src/ruvector/*`; reward shaping + cost ceiling are per-request, not distributional | §8.3 share governor (RouteLLM-style calibrated threshold + slow controller) [R1] |
| G-3 Budgets don't steer | `multi-model-router` emits events only; cost-tracker ladder exits processes but `route()` has no budget input; no import path from cost data into `model-router.ts` | §8.3 budget gate consuming `cost-summary` JSON; demotion rungs reuse the existing 50/75/90/100 ladder |
| (minor) Parallel stacks | Raw-fetch dispatch alongside ProviderManager; multi-model-router unused by CLI path | §8.6 Phase 1 routes all tier dispatch through one seam; consolidation noted in ADR text |
| (minor) No OTel | No `opentelemetry`/`otlp` usage found in v3 TS sources (docs mentions only); Prometheus exists only as plugin textfile | §8.5 span spec on GenAI semconv [O1][O2] |
| (minor) No in-band verification | Escalation is pre-response (uncertainty/breaker); outcomes recorded post-hoc | §8.6 Phase 3 optional FrugalGPT-style verifier [R2] |

---

## D. External Reference Notes (paraphrased findings used in scoring)

- **RouteLLM** [R1]: binary strong/weak routing trained on preference data; cost reductions >2× (85% MT-Bench, 45% MMLU, 35% GSM8K vs random baseline in the LMSYS release); APGR/CPT metrics; threshold α selected to meet a target strong-model call percentage — the formal basis for §8.3's governor; routers transfer to unseen model pairs.
- **FrugalGPT** [R2]: prompt adaptation + LLM approximation + cascade; post-query quality scorer overcomes the impossibility of reliable pre-query estimation for generative outputs; 50–98% cost savings across datasets; HEADLINES case study sent 16.6% of queries to GPT-4 — empirical anchor for the 10% frontier-share target being realistic rather than aspirational.
- **LiteLLM** [L1–L3]: per-provider/model `max_budget` + `budget_duration` (1s…1mo) with requests failing once budget crossed; `fail_closed_budget_enforcement` option; ordered fallbacks incl. context-window-triggered upshifts; routing strategies (simple-shuffle, least-busy, usage-based, latency-based) with cooldowns; Prometheus metric groups for tokens/spend/budget incl. `litellm_provider_remaining_budget_metric`; OTel callback. Production notes: Postgres+Redis expected at scale; Python proxy overhead documented as a limiting factor past a few hundred RPS [L4].
- **OTel GenAI semconv** [O1][O2][O3]: status Development; span attrs (`gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens/output_tokens`, finish reasons), agent spans, events for content capture (opt-in), stability opt-in via `OTEL_SEMCONV_STABILITY_OPT_IN`; Claude Code exports OTel metrics/logs with trace support in beta — meaning harness-side correlation is already possible.
- **Local serving** [S1][S2]: Ollama = llama.cpp-based, GGUF, OpenAI-compat at `:11434/v1`, sequential-by-default (single-user sweet spot); vLLM = PagedAttention, HF safetensors (no GGUF), ~2× throughput at 32-way concurrency on identical VRAM, OpenAI-compat at `:8000/v1`, unauthenticated by default (front with reverse proxy); migration = base-URL + model-name change. Justifies keying the local tier on any OpenAI-compatible `base_url`.

---

## E. Glossary

**Tier** — a routing destination class (codemod / local-fast / local-heavy / frontier). **Locality** — whether a tier's inference runs on operator hardware (`local`) or a paid API (`frontier`). **Share governor** — controller adjusting the routing threshold so observed frontier share tracks a target. **Demotion rung** — budget-utilization level at which frontier candidates receive selection penalties. **`routedBy`** — provenance label on every routing decision identifying the deciding backend (heuristic, bandit-fallback, metaharness-knn/krr, fastgrnn); a repo invariant this proposal preserves. **DRACO rows** — the repo's measured benchmark rows used to train router artifacts. **APGR / CPT** — RouteLLM's routing-quality metrics (avg performance-gap recovered; call-performance threshold).
