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

## 🔭 OpenTelemetry GenAI spans (§7)

> **Status: shipped.** The gateway's `otel` callback emits **OpenTelemetry GenAI** spans to a bundled **OTel Collector** (`docker compose up -d` starts it), which derives Prometheus metrics on `:8889` (scrape job `otel-collector`). This is the observability substrate the routing/quality/budget mitigations depend on — see [Limitations & Mitigations §7](limitations-and-mitigations.md#-7-observability-the-mitigations-depend-on).

Adopting the [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/) means telemetry is consumable by Grafana/Datadog/Jaeger/Tempo **without adapters**. Every gateway call carries:

| Attribute | Meaning |
|---|---|
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | Prompt / completion token counts per request |
| `gen_ai.request.model` | The tier alias / physical model asked for |
| `gen_ai.system` **or** `gen_ai.provider.name` | Which provider actually served it (anthropic / openai / gemini / local). The attribute name is version-dependent — older LiteLLM/semconv emits `gen_ai.system`, newer `gen_ai.provider.name`; the collector captures both. |
| `gen_ai.operation.name` | The operation (e.g. `chat`) |

**Wiring** (already in this kit): `litellm-config.yaml` sets `callbacks: ["prometheus", "otel"]`; `docker-compose.yml` points the gateway at the collector via `OTEL_EXPORTER=otlp_http` + `OTEL_ENDPOINT=http://otel-collector:4318/v1/traces` (the `/v1/traces` path is required — LiteLLM sends the endpoint verbatim); the collector's `spanmetrics` connector (namespace `gen_ai`) turns spans into metrics tagged by `gen_ai.request.model` and provider (`gen_ai.system`/`gen_ai.provider.name`). Config: [`otel-collector-config.yaml`](../../../otel-collector-config.yaml).

> [!WARNING]
> **Pin your versions.** The OTel GenAI attributes are still marked **Development** in the semantic-convention registry — the collector image is pinned (`otel/opentelemetry-collector-contrib:0.116.0`) so an upstream rename can't silently break your dashboards. Bump it deliberately, not via `:latest`.

> [!NOTE]
> Spans carry token counts, model, and provider — **never prompt/response bodies** (`turn_off_message_logging: true` drives LiteLLM's redaction across callbacks incl. OTel, and the shipped `debug` exporter at `verbosity: normal` prints counts, not attributes). Two things re-open that if you change them: raising the collector to `verbosity: detailed` prints content attributes into collector logs, and swapping `debug` for an OTLP/Jaeger/Tempo backend ships whatever the gateway attaches — **re-verify redaction on your LiteLLM version before either.**

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
> **Recommended after any model swap.** This kit ships the harness (limitations §3):
> ```bash
> ./scripts/quality-regression.sh              # runs tests/quality-prompts.jsonl through
>                                              # tier-fast vs tier-frontier; non-zero exit on regression
> ```
> It scores each answer with [`scripts/verify-escalate.sh`](../../../scripts/verify-escalate.sh) — a **rubric-anchored, position-swap-averaged** judge — and flags a prompt when `tier-fast` scores materially below `tier-frontier` (`REGRESSION_MARGIN`), failing CI when the regressed fraction exceeds `REGRESSION_THRESHOLD`. Add your own representative prompts to [`tests/quality-prompts.jsonl`](../../../tests/quality-prompts.jsonl). (Ruflo users: the repo's `cost-benchmark` / `cost-counterfactual` skills do this with real math — see [Evidence Appendix](evidence-appendix.md).)

**Verify-then-escalate (in-band, §3).** [`scripts/verify-escalate.sh`](../../../scripts/verify-escalate.sh) scores a single `tier-fast` answer and returns `accept` / `escalate` — the FrugalGPT cascade the *error*-based fallback ladder can't provide (it catches a **confidently-wrong** local answer). The judge is treated as **noisy**: position-swap averaged, rubric-anchored, and **fail-closed** (an unparseable score escalates).

> [!WARNING]
> The judge reads UNTRUSTED model output. Both scripts pass that content as **data** — jq-encoded (safe transport), **nonce-fenced** (the answer can't forge its own closing delimiter to smuggle instructions), and the parsed score is **clamped to `[0,1]` and fail-closed** (out-of-range or non-JSON ⇒ escalate). Still, an LLM-as-judge is [systematically biased](https://arxiv.org/html/2410.02736v1); treat its scores as a signal, not ground truth, and keep a human in the loop for high-stakes swaps.

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
