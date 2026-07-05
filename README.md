# ruflo-local — local-first tiered LLM routing

Send **~90% of your LLM traffic to open-weight models on your own hardware** and reserve **~10%** for frontier APIs (Claude / GPT / Gemini) — with fall-through reliability, hard budget caps, a **privacy-pinned lane that can never leave your machine**, a **pluggable gateway** (LiteLLM · Bifrost · Helicone), and Grafana dashboards for all of it.

![Local-first AI traffic optimization](local-first-ai-traffic-optimization.png)

> *Illustrative.* Default routing is **structural**, not a bespoke learned router: your client picks a tier alias and the gateway ladder + per-provider budget caps make the local/frontier split emergent — the ~90/10 is a **target**, not an enforced governor (a learned dial is the optional RouteLLM profile). `vLLM` is an optional NVIDIA-GPU profile (Ollama is the default); Bifrost/Helicone are experimental variants (LiteLLM is the supported default). "~10 minutes" is after model pulls complete.

## Quick start

```bash
cp .env.example .env        # add keys; pick your gateway via COMPOSE_PROFILES
make render                 # render gateway configs to YOUR hardware (Apple Silicon→MLX, else→GGUF)
                            #   non-Apple-Silicon: make render RUFLO_MODEL_VARIANT=gguf
docker compose up -d        # default gateway (LiteLLM) + Ollama + Prometheus + Grafana
./smoke-test.sh             # verify tiers, fall-through, privacy pin, metrics (auto-sources .env)
```

> **Why `make render`?** The committed gateway configs are generated from `config/templates/*.tmpl` with hardware-specific local model tags (`tier-heavy`/`tier-private` use the MLX build on Apple Silicon, the plain build elsewhere). Skip it on a non-Apple-Silicon host and those tiers point at a `-mlx` tag you never pulled. Needs **Node.js**.

Full prerequisites (Docker, Ollama, Node.js, `python3`, optional ruflo/ruvector/vLLM) → **[docs/guide/reference/prerequisites.md](docs/guide/reference/prerequisites.md)**.

## Docs

Everything lives in the **[📖 Guide](docs/guide/README.md)**. Start with the front door that fits you:

- 🛠️ **[Getting Started — Technical](docs/guide/getting-started-technical.md)** — up and serving in ~10 minutes.
- 🌱 **[Getting Started — Plain-Language](docs/guide/getting-started-nontechnical.md)** — no jargon.

Key references: [Tiers & Routing](docs/guide/reference/tiers-and-routing.md) · [Budgets & Trade-offs](docs/guide/reference/budgets-and-tradeoffs.md) · [Observability](docs/guide/reference/observability.md) · [Gateway Variants](docs/guide/reference/gateway-variants.md) · [Limitations & Mitigations](docs/guide/reference/limitations-and-mitigations.md) · [Prerequisites](docs/guide/reference/prerequisites.md).
