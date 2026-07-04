# 🧭 Tiers & Routing

> **What this covers:** how the four tiers work, the fall-through ladder that keeps something always answering, how the ~90/10 split actually happens, and how to point your tools at the gateway.

← Back to [Technical Guide](../getting-started-technical.md) · [Plain-Language Guide](../getting-started-nontechnical.md)

---

## 🎛️ Tiers are aliases; routing is config

The gateway config defines four **aliases**. Clients never name real models — they ask for a *tier*, and your YAML decides what serves it:

| Alias | Serves | Role |
|---|---|---|
| `tier-fast` | local MoE `Qwen3.6-35B-A3B` (Ollama) | Default workhorse — the "90%" |
| `tier-heavy` | local dense `Qwen3.6-27B` (Ollama, optionally + vLLM under the same alias) | Harder tasks that still stay on-box |
| `tier-frontier` | Claude Opus → GPT → Gemini (three deployments, one alias); optionally add hosted open-weight leaders | The "10%": budget-capped, auto-failover between providers |
| `tier-private` | local dense `Qwen3.6-27B`, **no fallback chain** | Structurally cannot leave your machine |

> [!NOTE]
> **Repeating an alias creates load-balancing + failover across its deployments** — that's how `tier-frontier` spans three providers and how `tier-heavy` can span Ollama + vLLM.
> `tier-private` appears in **no** fallback chain: that *absence* is the privacy guarantee.

---

## 🪜 The fall-through ladder

```mermaid
sequenceDiagram
    autonumber
    participant App
    participant GW as Gateway
    participant T1 as tier-fast local
    participant T2 as tier-heavy local
    participant T3 as tier-frontier cloud
    App->>GW: model=tier-fast, prompt
    GW->>T1: try — 2 retries
    alt T1 healthy
        T1-->>App: response — $0, on-box
    else T1 fails / times out / context too long
        GW->>T2: fallback
        alt T2 healthy
            T2-->>App: response — $0, on-box
        else T2 also fails
            GW->>GW: budget gate — frontier under daily cap?
            GW->>T3: escalate — Claude then GPT then Gemini
            T3-->>App: response — metered
        end
    end
    Note over GW: every hop counted in Prometheus:<br/>tokens, spend, fallback events, latency
```

Three distinct safety nets stack here:

- 🔁 **Retries** — transient blips.
- 🪜 **Fallbacks** — a tier is down or the prompt overflows its context window (`context_window_fallbacks` up-shifts automatically).
- ⏸️ **Cooldowns** — a deployment failing repeatedly is benched for 30 s (LiteLLM's circuit-breaker analogue).

---

## 💵 Budgets that actually block

Each frontier deployment carries `max_budget` + `budget_duration` (e.g. $3/day for Claude). When a deployment crosses its budget, the gateway stops sending to it for the rest of the period — and because `tier-frontier` has three deployments, exhausting Claude's budget fails over to GPT, then Gemini, then (only when all are exhausted) errors. Spend state lives in Postgres and survives restarts.

Rate caps (`rpm` / `tpm`) sit alongside as burst protection — agentic tools can fire 10–20k-token requests in quick succession, and token-per-minute caps catch what request-per-minute caps miss.

💵 How to set and tune these → [Budgets & Trade-offs](budgets-and-tradeoffs.md).

---

## 📊 Where the "90/10" comes from

Two mechanisms — use either or both.

### Mechanism A — structural (default)
Your *client* decides the tier. Ruflo's complexity router, or your own habit of using `tier-fast` by default, produces the split; the gateway's ladder + budgets enforce the ceiling on frontier usage. Simple, transparent, zero extra latency. The ratio is **emergent**, governed by budget caps rather than targeted precisely.

### Mechanism B — learned (optional `router` profile)
The **RouteLLM** service (LMSYS's open-source framework, ICLR 2025) scores each prompt with a matrix-factorization router and picks strong-vs-weak per request. Its threshold is **calibrated to an explicit strong-model percentage** — the literal 90/10 dial:

```bash
# Inside the routellm container (or any Python env with routellm installed):
python -m routellm.calibrate_threshold --routers mf --strong-model-pct 0.1 \
       --config config.example.yaml
# → prints e.g.  "For 10.0% strong model calls for mf, threshold = 0.24034"
```

Clients then call the RouteLLM endpoint (`http://localhost:6060/v1`) with `model="router-mf-0.24034"`; it forwards to `tier-frontier` or `tier-fast` accordingly, so budgets and metrics still apply downstream. Published results: **>2× cost reduction without quality loss**, up to **85% cost reduction on MT-Bench**.

> [!WARNING]
> Two caveats: calibration is against **Chatbot Arena data** (your true share drifts from the calibrated pct until you re-tune against your own metrics), and the default `mf` router **calls OpenAI for embeddings** — a privacy trade-off (needs `OPENAI_API_KEY` even when both routed models are local).

**Tuning the dial:** start it (`docker compose --profile router up -d`), calibrate with `--strong-model-pct 0.1`, point clients at `:6060/v1`, then **re-calibrate against reality** after a week using your actual frontier share from [Observability](observability.md). Start conservative (5–15%) and inspect outputs before loosening.

RouteLLM repo: https://github.com/lm-sys/RouteLLM · Paper: https://arxiv.org/abs/2406.18665

📖 The deeper "why length ≠ difficulty, and what to do" discussion → [Limitations & Mitigations](limitations-and-mitigations.md).

---

## 🧠 Strengthening the routing signal (§1, §2)

> **Status: shipped as enablement config + reference policy** — *not* an automatic behavior change. These are the two highest-leverage, cheapest mitigations from [Limitations & Mitigations](limitations-and-mitigations.md#-strengthening-the-guided-router). This kit ships a reference policy — [`router-policy.example.json`](../../../router-policy.example.json) — you translate into ruflo env/config: enabling the neural router (`CLAUDE_FLOW_ROUTER_NEURAL=1`) is a **real ruflo toggle**, while the per-agent-type **tier floor** is **reference policy** you apply in your own ruflo setup (per-request local-tier *enforcement* is the RFC's proposed tier-schema-v2, not yet upstream). It is **additive**: `ruflo-tiers.json` stays schema v1 and is still consumed unchanged as the per-tier alts map.

### Stronger routing signal — score difficulty, not length (§1)
A router scoring mostly surface features mis-ranks both ways (a short "prove this invariant" is hard; a long file-paste reformat is trivial). Turn on ruflo's **shipped neural router** (k-NN / KRR / FastGRNN over embeddings) instead of the lexical path, feed it non-length features, and reuse the HNSW **semantic route cache** so near-duplicate prompts skip re-scoring:

```bash
export CLAUDE_FLOW_ROUTER_NEURAL=1                        # enable the neural router (else lexical/bandit path)
export CLAUDE_FLOW_ROUTER_NEURAL_WEIGHT=0.7              # blend weight neural↔bandit (tune to taste)
export CLAUDE_FLOW_ROUTER_KNN_K=16                        # k for the k-NN backend
export CLAUDE_FLOW_ROUTER_QUALITY_BAR=0.8                # minimum predicted quality before down-tiering
export CLAUDE_FLOW_ROUTER_COST_CEILING_USD_PER_MTOK=20   # $20 excludes Sonnet+Opus-class; $50 excludes only Opus
export CLAUDE_FLOW_ROUTER_EMBED_CACHE_SIZE=4096          # HNSW semantic route cache — near-dupes skip re-scoring
```

The non-length features to weight (stack traces, multi-file scope, `prove`/`design`/`refactor-across-files` verbs) are enumerated under `signal.non_length_features` in `router-policy.example.json`.

> ℹ️ The env **names** above are ruflo's documented neural-router surface; the **values** are illustrative starting points — verify the flags against your ruflo build and re-tune against your own metrics ([Observability](observability.md)). These exports also ship pre-listed in [`.env.example`](../../../.env.example) (its client-side section) — set them there, or `export` them in your shell. They're consumed by ruflo, **not** by docker-compose.

### Tool-calling escalation floor — independent of prompt length (§2)
Small local models are specifically weak at **agentic tool-calling and multi-turn orchestration**, and those turns aren't necessarily long — so a length-based router is the *least* equipped to catch them. Treat tool-calling / multi-turn as a **hard escalation signal independent of length**, and give tool-driven agent types a **per-agent-type tier floor** (the router may score down to a cheaper tier, but never *below* the floor):

```jsonc
// router-policy.example.json → escalation.tier_floor_by_agent_type
{ "default": "tier-fast", "reviewer": "tier-heavy", "orchestrator": "tier-heavy",
  "tool_user": "tier-heavy", "agentic_multiturn": "tier-frontier" }
```

Ensemble disagreement above `CLAUDE_FLOW_ROUTER_ENSEMBLE_UNCERTAINTY_THRESHOLD` forces an up-tier too — a *quality-floor-beats-quota* escalation that bypasses cost bias. This is why model selection leans on SWE-bench/agentic scores, not raw code-completion → [Hardware & Models](hardware-and-models.md).

---

## 🔌 Integrating your tools

### Ruflo / Claude-Flow
Ruflo keeps its complexity scoring and bandit learning; the gateway serves the tiers:

```bash
export CLAUDE_FLOW_ROUTER_OPENROUTER_ALTS=$PWD/ruflo-tiers.json   # ships in this kit
export OPENROUTER_API_KEY=$LITELLM_MASTER_KEY                     # any non-empty value
export OPENROUTER_BASE_URL=http://localhost:4000/v1               # if honored by your version
# Fallback wiring if your ruflo build routes OpenRouter traffic only to openrouter.ai:
export RUFLO_PROVIDER=ollama
export OLLAMA_BASE_URL=http://localhost:4000                      # gateway speaks /v1/chat/completions
export OLLAMA_API_KEY=$LITELLM_MASTER_KEY
```

Because ruflo's Ollama path is a plain OpenAI-compat client with a configurable base URL, pointing it at the gateway means even "ollama" traffic gains fallbacks, budgets, and metrics.

> [!NOTE]
> **Trade-off:** ruflo's per-model bandit labels blur slightly, since it can't see which physical model the gateway chose. Background on this → [Architecture RFC](architecture-rfc.md) and [Evidence Appendix](evidence-appendix.md).

### Anything using the OpenAI SDK
```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:4000/v1", api_key="<your-virtual-key>")
resp = client.chat.completions.create(model="tier-fast", messages=[...])
print(resp.model)   # tells you which physical model actually served it
```

### Sensitive work
Point it at **`tier-private`**. That alias has no fallback chain and a local-only deployment — a misconfigured budget or a dead local daemon produces an *error*, never a silent cloud escalation. Verify any time with the privacy-pin check in `smoke-test.sh` → [Observability & Testing](observability.md).
