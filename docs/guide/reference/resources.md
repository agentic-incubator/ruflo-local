# 🔗 Resources & Alternatives

> **What this covers:** when to prefer a different tool over this kit, and the full set of external links — core components, research papers, standards, and model leaderboards.

← Back to [Technical Guide](../getting-started-technical.md) · [Plain-Language Guide](../getting-started-nontechnical.md)

---

## 🧰 Alternatives worth knowing

| Tool | When to prefer it over this kit |
|---|---|
| **Bifrost** (Rust, open-source, self-hosted) — https://github.com/maximhq/bifrost | You want µs-class gateway overhead, native OTel, and no Python/Postgres footprint — **shipped as an activatable `COMPOSE_PROFILES=bifrost` variant** → [Gateway Variants](gateway-variants.md) |
| **OpenRouter** (managed) — https://openrouter.ai | You want one key for many *cloud* models with zero ops — but requests transit their SaaS (weaker privacy, no local tier) |
| **Portkey / TrueFoundry / Kong AI** (managed/enterprise gateways) | Team governance, RBAC, compliance needs beyond homelab scope |
| **Open WebUI** — https://github.com/open-webui/open-webui | You mainly want a chat UI over Ollama (composes fine *behind* this gateway too) |
| **LM Studio** — https://lmstudio.ai | GUI-first local model evaluation before promoting a model into a tier |

---

## 🧩 Core components

- **LiteLLM** — https://github.com/BerriAI/litellm (docs https://docs.litellm.ai)
- **Ollama** — https://ollama.com (library https://ollama.com/library)
- **vLLM** — https://docs.vllm.ai
- **llama.cpp** `llama-server` — https://github.com/ggml-org/llama.cpp
- **RouteLLM** — https://github.com/lm-sys/RouteLLM
- **Prometheus** — https://prometheus.io · **Grafana** — https://grafana.com

---

## 📚 Research

**Routing & cascades**
- RouteLLM — [arXiv:2406.18665](https://arxiv.org/abs/2406.18665)
- FrugalGPT — [arXiv:2305.05176](https://arxiv.org/abs/2305.05176)
- Hybrid LLM — [arXiv:2404.14618](https://arxiv.org/abs/2404.14618)
- RouterBench — [arXiv:2403.12031](https://arxiv.org/abs/2403.12031)
- GraphRouter — [arXiv:2410.03834](https://arxiv.org/abs/2410.03834)
- Budget-aware routing: PILOT [arXiv:2508.21141](https://arxiv.org/html/2508.21141v1) · SeqRoute [arXiv:2605.25424](https://arxiv.org/pdf/2605.25424) · ParetoBandit [arXiv:2604.00136](https://arxiv.org/pdf/2604.00136)

**Verifier / LLM-as-judge reliability**
- Justice or Prejudice — [arXiv:2410.02736](https://arxiv.org/html/2410.02736v1)
- Position bias — [arXiv:2406.07791](https://arxiv.org/abs/2406.07791)
- Self-preference — [arXiv:2410.21819](https://arxiv.org/html/2410.21819v2)
- Survey — [arXiv:2411.15594](https://arxiv.org/html/2411.15594v6)
- Cascade decision theory — [arXiv:2605.06350](https://arxiv.org/pdf/2605.06350)

**Agentic tool-calling**
- Berkeley Function-Calling Leaderboard — https://gorilla.cs.berkeley.edu/leaderboard.html (ICML 2025)
- τ-bench — [arXiv:2406.12045](https://arxiv.org/abs/2406.12045)
- τ²-bench — [arXiv:2506.07982](https://arxiv.org/abs/2506.07982)

---

## 🧭 Standards & budgets

- OpenTelemetry GenAI attribute registry — https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
- LiteLLM provider budget routing — https://docs.litellm.ai/docs/proxy/provider_budget_routing
- LiteLLM Prometheus metrics — https://docs.litellm.ai/docs/proxy/prometheus

---

## 📊 Model leaderboards (verify before pinning)

SWE-bench Verified aggregations:
- llm-stats — https://llm-stats.com/benchmarks/swe-bench-verified
- Vellum — https://www.vellum.ai/open-llm-leaderboard
- benchlm — https://benchlm.ai/benchmarks/sweVerified
- Ollama registry — https://ollama.com/library

📖 Which of these models to actually run → [Hardware & Models](hardware-and-models.md).
