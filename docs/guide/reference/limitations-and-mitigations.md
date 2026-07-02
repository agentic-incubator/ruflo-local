# ⚠️ Limitations & Mitigations

> **What this covers:** an honest list of what this stack does *not* solve, and — for the limits inherent to the guided-routing approach — a concrete, cited mitigation for each, plus a priority order.

← Back to [Technical Guide](../getting-started-technical.md) · [Plain-Language Guide](../getting-started-nontechnical.md)

---

## 🚧 What this doesn't solve (honest list)

> [!IMPORTANT]
> Items 1–3 are inherent to the **guided approach**; the [mitigations section](#-strengthening-the-guided-router) gives each a cited fix. This list stays honest about what the kit ships with *today*.

1. **Local model quality has a real ceiling.** A local coder — even a strong 27–35B-class one — will lose to frontier models on long-horizon reasoning, subtle instruction-following, and especially **agentic tool-calling**. If your workload is tool-heavy, expect a higher-than-10% escalation share or accept quality loss.
2. **The 90/10 in Mechanism A is emergent, not enforced.** Budgets cap the damage but don't *shape* the ratio; only Mechanism B (RouteLLM) targets a percentage, and its calibration is against public data, so your realized share drifts until you re-tune.
3. **No response-quality verification in-band.** A fallback fires on *errors*, not on *bad answers*. A local model that confidently answers wrong is served.
4. **RouteLLM's default router phones home for embeddings** (OpenAI), and its checkpoints were trained on an older model generation — rankings still transfer per the paper, but treat it as a heuristic, not ground truth.
5. **Ollama concurrency:** mostly sequential; multi-user or parallel-agent load queues. The vLLM profile solves it at the cost of NVIDIA-only + more setup.
6. **Single-node, homelab-grade:** no HA, no multi-instance budget sync (that needs Redis), Postgres on the same box. Fine for a power user; not a company platform as-is.
7. **LiteLLM is a Python proxy:** single-digit-ms overhead, wants periodic patching; at hundreds of RPS it becomes the bottleneck — far beyond personal use, but it's the known scale ceiling. → **now mitigated in this kit:** drop-in [Bifrost & Helicone gateway variants](gateway-variants.md) (Rust, µs-class, native OTel), selectable via `COMPOSE_PROFILES` with no client change.
8. **Quantization is not free:** Q4 GGUF weights trade measurable quality for memory; strict-format and long-context tasks feel it first. Prefer Q5/Q6 or AWQ when memory allows.
9. **Maintenance is on you:** model updates, image updates, key rotation, disk for model blobs (tens of GB), and the weekly metrics review.

---

## 🛡️ Strengthening the guided router

This addresses a sharper question than the list above: the limits of the **guided approach itself** — where your client decides the tier from a heuristic complexity/length score and the 90/10 split emerges structurally. Each weakness is paired with a concrete mitigation and its evidence. Numbers are quoted from primary sources; engineering synthesis is labelled as such.

### 🎯 1. The routing signal is weak — length ≠ difficulty
A router scoring mostly surface features mis-ranks both ways: a one-line "prove this invariant" is short-but-hard; a 4k-token file paste asking for a reformat is long-but-trivial. Learned routers beat heuristic baselines on the cost-quality frontier: **RouteLLM**'s matrix-factorization router reaches **95% of GPT-4 quality using only ~26% GPT-4 calls** (≈3.66× saving on MT-Bench), and transfers across model pairs ([arXiv:2406.18665](https://arxiv.org/abs/2406.18665)). **Hybrid LLM** cuts large-model calls **up to 40% at no quality drop** by predicting the small-vs-large *quality gap* ([arXiv:2404.14618](https://arxiv.org/abs/2404.14618)).

> ✅ **Mitigate:** turn on ruflo's shipped **neural router** (`CLAUDE_FLOW_ROUTER_NEURAL=1`, k-NN/KRR/FastGRNN over embeddings) instead of the lexical path; add non-length features (stack traces, multi-file scope, "prove/design/refactor-across-files"); reuse `ruvector-router-core` HNSW as a **semantic route cache**.
>
> 📦 **Shipped as reference policy in this kit** → [`router-policy.example.json`](../../../router-policy.example.json) (`signal.*`) + the enabling env in [Tiers & Routing → Strengthening the routing signal (§1)](tiers-and-routing.md#-strengthening-the-routing-signal-1-2). Enabling `CLAUDE_FLOW_ROUTER_NEURAL=1` is a real ruflo toggle; the feature set is reference policy you apply. Additive — `ruflo-tiers.json` stays schema v1.

### 🔧 2. Small local models are specifically weak at agentic tool-calling
The failure mode a length-based router is *least* equipped to see, because tool-heavy turns aren't necessarily long. On **BFCL** the gap is stateful multi-step orchestration: small models that pass single-turn calls collapse multi-turn (e.g. xLAM-2-3b ~55.6% multi-turn, Qwen3-1.7B ~16.9%, vs ~94% relevance detection) ([BFCL, ICML 2025](https://gorilla.cs.berkeley.edu/leaderboard.html)). Even frontier agents are unreliable — **τ-bench** shows GPT-4o at ~35% (airline) / ~61% (retail) pass@1 ([arXiv:2406.12045](https://arxiv.org/abs/2406.12045)); **τ²-bench** puts the airline ceiling ~70% ([arXiv:2506.07982](https://arxiv.org/abs/2506.07982)).

> ✅ **Mitigate:** treat **"agentic tool-calling / multi-turn"** as a hard escalation signal *independent of prompt length* — set a per-agent-type tier floor so tool-driven turns start at `tier-heavy` or frontier. This is why model selection leans on SWE-bench/agentic scores, not raw code-completion (see [Hardware & Models](hardware-and-models.md)).
>
> 📦 **Shipped as reference policy in this kit** → `escalation.tier_floor_by_agent_type` + `escalation.hard_signals` in [`router-policy.example.json`](../../../router-policy.example.json), documented at [Tiers & Routing → Tool-calling escalation floor (§2)](tiers-and-routing.md#-strengthening-the-routing-signal-1-2); uncertainty-forced up-tier via `CLAUDE_FLOW_ROUTER_ENSEMBLE_UNCERTAINTY_THRESHOLD`. The floor is reference policy you apply in ruflo — per-request *enforcement* awaits the RFC's tier-schema-v2 (not yet upstream).

### 🔍 3. No in-band quality verification
The ladder escalates on *failure/timeout*, never on a confidently-wrong local answer. The cascade remedy: score the cheap answer, escalate only on low score. **FrugalGPT** matched the best single LLM at **up to 98% lower cost**, or **+4% accuracy at equal cost** ([arXiv:2305.05176](https://arxiv.org/abs/2305.05176)). But the verifier is itself an LLM-as-judge, which is **systematically biased**: position-bias robustness can fall below 0.5; self-enhancement error runs 1.16–16.1% ([arXiv:2410.02736](https://arxiv.org/html/2410.02736v1)).

> ✅ **Mitigate:** add a FrugalGPT-style **verify-then-escalate** scorer on designated task classes, but make the judge **swap-averaged / rubric-anchored** and treat its output as noisy. Gate model swaps in CI with the [quality-regression harness](observability.md#quality-regression-harness).
>
> 📦 **Shipped in this kit** → [`scripts/verify-escalate.sh`](../../../scripts/verify-escalate.sh) (rubric-anchored, position-swap-averaged, **fail-closed** judge; prompt-injection-safe — untrusted content is passed as data) + [`scripts/quality-regression.sh`](../../../scripts/quality-regression.sh) over [`tests/quality-prompts.jsonl`](../../../tests/quality-prompts.jsonl) for CI. The judge stays **noisy by design** — a signal, not ground truth.

### 💰 4. Budget is observed, not consumed
A pure guided router doesn't read remaining budget; budgets only alert then hard-stop — so at exhaustion a genuinely hard task lands on a spent tier and silently degrades. **LiteLLM** demonstrates the target semantics: per-provider budget config, over-budget providers **skipped** with an **HTTP 429**, and a remaining-budget gauge ([provider budget routing](https://docs.litellm.ai/docs/proxy/provider_budget_routing)). Research is converging on putting remaining budget *into* the routing state: PILOT ([arXiv:2508.21141](https://arxiv.org/html/2508.21141v1)), SeqRoute, ParetoBandit.

> ✅ **Mitigate:** feed the cost-tracker's `cost-summary --format json` into `route()`; apply a demotion penalty to frontier candidates across the 50/75/90 rungs, mask frontier at 100% except pinned/escalation-forced; keep LiteLLM's 429 as the fail-closed backstop. Track a **token** budget alongside USD.
>
> 📦 **Shipped in this kit** → the LiteLLM **429 fail-closed backstop** is real today (per-deployment `max_budget` + `rpm`/`tpm` on every frontier deployment); the demotion-before-hardstop is a **router-side snapshot** — [`scripts/budget-snapshot.sh`](../../../scripts/budget-snapshot.sh) emits the JSON (USD **and** token utilization → demotion rung / mask) that a router consumes, documented at [Budgets & Trade-offs → Budget-steered routing (§4)](budgets-and-tradeoffs.md#-budget-steered-routing-4). `tier-private`/local are never steered.

### 📐 5. The 90/10 is emergent, not governed
Nothing *targets* a share; it drifts with your workload. **RouteLLM ships the missing primitive** — `calibrate_threshold --strong-model-pct 0.1` finds the cutoff that sends a target fraction to the strong model ([RouteLLM README](https://github.com/lm-sys/RouteLLM/blob/main/README.md)).

> ✅ **Mitigate:** a share governor that adjusts threshold α so rolling frontier share converges on target, with **quality-floor-beats-quota** (uncertainty/breaker escalations always bypass it). Re-calibrate weekly against your Prometheus actuals.

### 🎚️ 6. Governor stability, provenance, cold-start
- **Oscillation:** smooth observed share with an **EWMA** + a hysteresis band before nudging α (engineering synthesis, [EWMA control charts](https://www.nature.com/articles/s41598-025-09735-z)).
- **Label pollution:** don't masquerade local endpoints as `openrouter` — use an explicit tier schema (`locality`/`provider`/`base_url`) and echo `response.model` back into the outcome record.
- **Cold-start / drift:** warm-start new local models from RouteLLM's cross-pair transfer; run a Phase-0 overlay to collect outcomes before tightening governance.

### 📡 7. Observability the mitigations depend on
Adopt **OpenTelemetry GenAI semantic conventions** — `gen_ai.usage.input_tokens` / `output_tokens`, `gen_ai.request.model`, `gen_ai.provider.name` — so telemetry is consumable by Grafana/Datadog/Jaeger without adapters ([OTel GenAI registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)). *Status caveat:* these attributes are still marked **Development** — pin a version and opt in explicitly.

---

## 🥇 Priority order

| Move | Closes | Status in this kit |
|---|---|---|
| Enable the shipped neural router; add task-class/tool-calling escalation signal | §1, §2 | ✅ **shipped** — [`router-policy.example.json`](../../../router-policy.example.json) + [Tiers & Routing §1/§2](tiers-and-routing.md#-strengthening-the-routing-signal-1-2) |
| Quality-regression harness + FrugalGPT verify-then-escalate | §3 | ✅ **shipped** — [`scripts/quality-regression.sh`](../../../scripts/quality-regression.sh) + [`verify-escalate.sh`](../../../scripts/verify-escalate.sh) |
| Budget-steered routing consuming a budget snapshot | §4 | ✅ **shipped** — [`scripts/budget-snapshot.sh`](../../../scripts/budget-snapshot.sh) + [Budgets §4](budgets-and-tradeoffs.md#-budget-steered-routing-4) |
| OpenTelemetry GenAI spans + Prometheus surfaces | §7 | ✅ **shipped** — [Observability §7](observability.md#-opentelemetry-genai-spans-7) |
| Pluggable low-overhead gateway (the LiteLLM ceiling, honest-list #7) | #7 | ✅ **shipped** — [Bifrost & Helicone variants](gateway-variants.md) |
| Share governor (calibrated α + EWMA/hysteresis); governor stability | §5, §6 | ⬜ **open** — not in scope yet |

> [!TIP]
> The two highest-leverage moves are the cheapest: **turn on the neural router you already ship** and **add quality detection** — budgets and error-based fallback structurally cannot catch a confidently-wrong local answer.

📖 The full architectural rationale for these moves → [Architecture RFC](architecture-rfc.md) · the code-level evidence they build on → [Evidence Appendix](evidence-appendix.md) · all research links → [Resources](resources.md).
