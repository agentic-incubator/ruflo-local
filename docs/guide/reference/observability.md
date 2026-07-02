# 📊 Observability & Testing

> **What this covers:** what to watch, the PromQL queries to build panels around, the weekly review routine, and how to validate the stack (smoke tests, budget drills, quality-regression).

← Back to [Technical Guide](../getting-started-technical.md) · [Plain-Language Guide](../getting-started-nontechnical.md)

**Dashboards:** Grafana → http://localhost:3000 (admin / your `GRAFANA_PASSWORD`) · Prometheus → http://localhost:9090 · LiteLLM UI → http://localhost:4000/ui

---

## 👀 What to watch

Prometheus scrapes the gateway's `/metrics`. Useful queries to build Grafana panels around:

| Question | PromQL starting point |
|---|---|
| **Am I actually at 90/10?** | `sum(rate(litellm_input_tokens_metric[1d])) by (model)` → compare local vs frontier shares |
| Frontier spend today | `sum(litellm_spend_metric) by (model)` (or the admin UI's spend page / `/spend` endpoints) |
| **Fallbacks happening?** (silent quality substitution) | deployment failure/success counters by model — alert on rising failure rate for `tier-fast` |
| Latency per tier | request-duration histograms by model → p50/p95 panels |
| Budget headroom | remaining-budget gauges (enable `prometheus_initialize_budget_metrics: true` to emit them even for idle keys) |

> [!NOTE]
> `/metrics` is open-source again since **LiteLLM v1.80.0** — it was enterprise-gated between late-2024 and that release. If you pin an image from that window, metrics will be absent.

📘 Metric reference: https://docs.litellm.ai/docs/proxy/prometheus. A community Grafana dashboard exists if you'd rather import than build (search the Grafana dashboard registry for "LiteLLM").

---

## 🗓️ Weekly 10-minute review

- **Frontier share vs target** → adjust threshold / budgets.
- **Fallback counts** → is `tier-fast` under-powered?
- **Spend trend** → any runaway tool? (mint it a tighter [virtual key](budgets-and-tradeoffs.md#-common-tuning-recipes)).

---

## 🧪 Testing & validation

### Smoke test
```bash
./smoke-test.sh
```
Covers: each tier answers · forced fall-through (`mock_testing_fallbacks`) · **privacy pin** (asserts `tier-private` never resolves to a cloud model) · metrics endpoint live · spend query.

### Budget-block drill
Temporarily set one frontier deployment's `max_budget: 0.000001`, restart, call `tier-frontier` twice — first call may pass, second must fail over to the next provider. Restore after.

### Quality-regression harness
> [!TIP]
> **Recommended after any model swap.** Keep 15–30 prompts representative of *your* work in a file; run them through `tier-fast` and `tier-frontier` and eyeball or LLM-judge the diff. (Ruflo users: the repo's `cost-benchmark` / `cost-counterfactual` skills do this with real math — see [Evidence Appendix](evidence-appendix.md).)

### Load sanity (if sharing the box)
Fire 8–16 concurrent `tier-fast` requests; if latency collapses, that's Ollama's sequential nature — consider the vLLM profile.

---

## 📈 What good observability buys you

- **Privacy by architecture** — ~90% of prompts never leave your hardware; `tier-private` makes "never" structural. Gateway message-body logging is off by default in this kit.
- **Cost ceiling, not cost hope** — daily caps per provider that *block*, plus per-tool virtual-key budgets.
- **Availability better than frontier-only** — two local backends + three frontier providers = five independent serving paths.
- **Observability parity with SaaS gateways** — tokens, spend, latency, fallbacks per model in Grafana, on your box.

> [!WARNING]
> Metrics catch *errors and spend* — they do **not** catch a confidently-wrong local answer. That gap, and its mitigations, live in [Limitations & Mitigations](limitations-and-mitigations.md).
