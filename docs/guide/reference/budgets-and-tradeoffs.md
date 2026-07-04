# 💵 Budgets & Trade-offs

> **What this covers:** the trade-offs every design choice makes, the config file's anatomy, and copy-paste tuning recipes — including per-tool spending caps.

← Back to [Technical Guide](../getting-started-technical.md) · [Plain-Language Guide](../getting-started-nontechnical.md) · Related: [Tiers & Routing](tiers-and-routing.md)

---

## ⚖️ The trade-off matrix

Every design choice trades something. Knowing which lever trades what keeps tuning rational:

| Lever | You gain | You give up |
|---|---|---|
| Smaller `tier-fast` model (7B vs 14B) | Speed, RAM headroom, snappier feel | First-try success → more fallbacks (latency, and money if they reach frontier) |
| Heavier quantization (Q4 vs Q8/FP16) | Fits bigger models in less memory | Subtle quality loss, worst on long reasoning and strict-format outputs |
| Tighter frontier budgets | Hard cost ceiling; forcing-function to improve local tiers | Hard tasks may land on an exhausted tier and degrade to local quality |
| Aggressive fallback ladder | Availability — something always answers | **Silent quality substitution** — you *got* an answer, but from a weaker model (watch fallback metrics) |
| RouteLLM learned routing | Precise, principled 90/10 dial | +1 hop latency, an embeddings dependency, calibration upkeep |
| Ollama (llama.cpp) serving | Dead-simple, GGUF everywhere | Mostly sequential — concurrency queues; vLLM gives ~2× throughput but wants NVIDIA + safetensors |
| `turn_off_message_logging: true` | Prompt bodies never persisted by the gateway | Harder debugging; flip per-investigation, not permanently |

> [!TIP]
> The single most important row is **silent quality substitution**. A fallback means something answered — but maybe from a weaker model than you wanted. Keep an eye on fallback counts in [Observability](observability.md).

---

## 🧬 `config/gateways/litellm-config.yaml` anatomy

- **`model_list`** — each entry is a *deployment*: an alias (`model_name`) plus what actually serves it (`litellm_params.model`, `api_base`, keys, budgets, rate caps). **Repeating an alias creates load-balancing + failover** across its deployments.
- **`litellm_settings.fallbacks`** — the ladder. Order matters; tried left-to-right. `tier-private` appears in no chain — that *absence* is the privacy guarantee.
- **`context_window_fallbacks`** — up-shift on long prompts *before* the small model truncates or errors (requires `enable_pre_call_checks: true`).
- **`router_settings.allowed_fails` / `cooldown_time`** — the breaker. 3 failures within a minute benches a deployment for 30 s.
- **`general_settings.database_url`** — Postgres; required for budgets / virtual keys to persist.

📘 Reference: [config settings](https://docs.litellm.ai/docs/proxy/config_settings) · [reliability / fallbacks](https://docs.litellm.ai/docs/proxy/reliability) · [budgets](https://docs.litellm.ai/docs/proxy/provider_budget_routing)

---

## 🍳 Common tuning recipes

**Swap the workhorse model** (one line):
```yaml
model: ollama_chat/qwen3.6:35b-a3b     # was qwen3-coder:30b-a3b-q4_K_M — stronger MoE, same ~3B-active speed
```
then `docker exec ollama ollama pull qwen3.6:35b-a3b && docker compose restart litellm`.
(Apple Silicon: use `qwen3.6:35b-mlx` for the MLX engine.)

**Raise / lower the frontier ceiling:** edit `max_budget` per deployment. Skew failover order by reordering deployments or setting asymmetric budgets (e.g. Claude $5/day primary, others $1/day emergency spares).

**No-GPU machine:** delete/comment the `tier-heavy` deployments; change fallbacks to `tier-fast: ["tier-frontier"]`.

**Per-tool budgets (virtual keys)** — mint scoped keys so, e.g., your IDE agent gets its own daily cap independent of your scripts:
```bash
curl http://localhost:4000/key/generate -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key_alias":"ide-agent","max_budget":1.5,"budget_duration":"1d","models":["tier-fast","tier-heavy","tier-frontier"]}'
```
Give that key to the tool instead of the master key. (Also the cleanest multi-user story.)

---

## 🧾 How budgets *block* (recap)

Each frontier deployment carries `max_budget` + `budget_duration`. Cross the budget and the gateway stops sending to that deployment for the period — failing over to the next provider, then erroring only when all are exhausted. Spend state persists in Postgres across restarts. Rate caps (`rpm`/`tpm`) sit alongside as burst protection.

> [!IMPORTANT]
> Budgets **cap the damage** but don't *shape* the 90/10 ratio — only the learned router (Mechanism B in [Tiers & Routing](tiers-and-routing.md#-where-the-9010-comes-from)) targets a percentage. And budgets are observed, not consumed by routing — a genuinely hard task can still land on an exhausted tier. The mitigations for this are below and in [Limitations & Mitigations §4](limitations-and-mitigations.md#-4-budget-is-observed-not-consumed).

---

## 🎚️ Budget-steered routing (§4)

> **Status: shipped as gateway backstop + router-side snapshot.** Turns "budget observed" into "budget consumed by the routing decision" — so budget pressure **demotes** frontier candidates *before* the hard stop, instead of a hard task silently landing on an exhausted tier.

Two layers, fail-closed:

1. **Gateway backstop (LiteLLM, real today).** Each frontier deployment's `max_budget` + `budget_duration` makes the gateway **skip** an over-budget deployment and fail over; when all frontier deployments are exhausted the request errors with **HTTP 429**. This is the hard, fail-closed floor — it cannot overspend. `rpm`/`tpm` on every frontier deployment add token-rate burst protection alongside the USD cap.
2. **Router-side demotion (consumes the snapshot).** [`scripts/budget-snapshot.sh`](../../../scripts/budget-snapshot.sh) emits JSON a router (e.g. ruflo `route()`) reads to apply a **demotion penalty** to frontier candidates across rising utilization, and to **mask** frontier entirely at 100% — *except* pinned or escalation-forced turns (quality-floor-beats-quota):

| Governing utilization | `demotion_rung` | Effect on frontier candidates |
|---|---|---|
| `< 0.5` | `0` | none |
| `0.5 – 0.75` | `0.25` | mild penalty |
| `0.75 – 0.9` | `0.5` | strong penalty |
| `0.9 – 1.0` | `0.75` | near-masked |
| `≥ 1.0` | `mask` | excluded (pinned/escalation-forced bypass) |

**Dual budget.** The snapshot tracks a **token** budget alongside **USD** (`FRONTIER_TOKEN_BUDGET` / `FRONTIER_USD_BUDGET`); the *tighter* of the two governs demotion, so a token blow-up throttles frontier even if the dollar cap has headroom. Feed it to your router on an interval:

```bash
GW=http://localhost:4000 ./scripts/budget-snapshot.sh   # → {usd, tokens, governing_utilization, demotion_rung, frontier_masked, metrics_available, ...}
```

The snapshot is **frontier-scoped** (only frontier deployments' spend/tokens count, via `FRONTIER_MODELS`), so the ~90% local traffic never skews the signal.

> [!WARNING]
> **Fail-closed on a bad scrape.** If `/metrics` is unreachable or erroring, `metrics_available` is `false` — the gateway may still be serving and spending (bounded only by the 429 cap), so a router should treat `false` as **demote/mask frontier**, not "0% used." And mind the **budget window**: `/metrics` spend counters may be *cumulative* while `max_budget` resets daily — set `FRONTIER_USD_BUDGET`/`FRONTIER_TOKEN_BUDGET` (or point `SPEND_METRIC`/`TOKEN_METRIC` at a period-aware remaining-budget gauge) to match the metric's window.

> [!NOTE]
> `tier-private` and the local tiers are **never** budget-steered — the snapshot's `scope` is `frontier` only. Local serving is ~$0 marginal; the privacy pin must never be perturbed by a budget signal.

**Research context:** cascade/routing systems have repeatedly shown **50–98% cost reductions at matched quality** (FrugalGPT, arXiv:2305.05176; RouteLLM, arXiv:2406.18665). See [Resources](resources.md) for the full link set.
