# ruflo-local — local-first tiered LLM routing

Send **~90% of your LLM traffic to open-weight models on your own hardware** and reserve **~10%** for frontier APIs (Claude / GPT / Gemini) — with fall-through reliability, hard budget caps, a **privacy-pinned lane that can never leave your machine**, a **pluggable gateway** (LiteLLM · Bifrost · Helicone), and Grafana dashboards for all of it.

![Local-first AI traffic optimization](local-first-ai-traffic-optimization.png)

## Quick start

```bash
cp .env.example .env        # add keys; pick your gateway via COMPOSE_PROFILES
docker compose up -d        # default gateway (LiteLLM) + Ollama + Prometheus + Grafana
./smoke-test.sh             # verify tiers, fall-through, privacy pin, metrics
```

Full prerequisites (Docker, Ollama, optional ruflo/ruvector/vLLM) → **[docs/guide/reference/prerequisites.md](docs/guide/reference/prerequisites.md)**.

## Docs

Everything lives in the **[📖 Guide](docs/guide/README.md)**. Start with the front door that fits you:

- 🛠️ **[Getting Started — Technical](docs/guide/getting-started-technical.md)** — up and serving in ~10 minutes.
- 🌱 **[Getting Started — Plain-Language](docs/guide/getting-started-nontechnical.md)** — no jargon.

Key references: [Tiers & Routing](docs/guide/reference/tiers-and-routing.md) · [Budgets & Trade-offs](docs/guide/reference/budgets-and-tradeoffs.md) · [Observability](docs/guide/reference/observability.md) · [Gateway Variants](docs/guide/reference/gateway-variants.md) · [Limitations & Mitigations](docs/guide/reference/limitations-and-mitigations.md) · [Prerequisites](docs/guide/reference/prerequisites.md).
