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

## 🧬 `litellm-config.yaml` anatomy

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
model: ollama_chat/qwen3.6-35b-a3b     # was qwen3-coder:30b-a3b — stronger MoE, same ~3B-active speed
```
then `docker exec ollama ollama pull qwen3.6-35b-a3b && docker compose restart litellm`.

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
> Budgets **cap the damage** but don't *shape* the 90/10 ratio — only the learned router (Mechanism B in [Tiers & Routing](tiers-and-routing.md#-where-the-9010-comes-from)) targets a percentage. And budgets are observed, not consumed by routing — a genuinely hard task can still land on an exhausted tier. The mitigations for this are in [Limitations & Mitigations §4](limitations-and-mitigations.md#-4-budget-is-observed-not-consumed).

**Research context:** cascade/routing systems have repeatedly shown **50–98% cost reductions at matched quality** (FrugalGPT, arXiv:2305.05176; RouteLLM, arXiv:2406.18665). See [Resources](resources.md) for the full link set.
