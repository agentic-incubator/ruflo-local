# 🔀 Gateway Variants (litellm · bifrost · helicone)

> **What this covers:** the gateway is **pluggable** — exactly one of three OpenAI-compatible gateways runs on the `:4000` seam at a time. LiteLLM is the default; Bifrost and Helicone are opt-in performance variants. This is how you choose and switch.

← Back to [Technical Guide](../getting-started-technical.md) · Related: [Tiers & Routing](tiers-and-routing.md) · [Observability](observability.md)

---

## 🎛️ One selector, one gateway

All three gateways are compose **profiles**; a single `COMPOSE_PROFILES` selector picks the active one. They are **mutually exclusive** — each claims host `:4000`, and only one profile is ever active:

| Gateway | Profile | What it is | Pick it when |
|---|---|---|---|
| **LiteLLM** (default) | `litellm` | Python + Postgres; the reference gateway with the richest budget/fallback/config surface | You want the full feature set, the RouteLLM 90/10 dial, per-tool virtual keys |
| **Bifrost** | `bifrost` | Rust, µs-class overhead, native OTel, no Python/Postgres footprint | You want minimal gateway overhead + native tracing (addresses the LiteLLM Python-proxy [scale ceiling](limitations-and-mitigations.md)) |
| **Helicone** | `helicone` | *(added in the Helicone phase)* | — |

The shipped `.env` sets `COMPOSE_PROFILES=litellm`, so **`docker compose up -d` still yields LiteLLM** — no change for existing users.

> [!IMPORTANT]
> `COMPOSE_PROFILES` **must** name exactly **one** gateway:
> - **Empty** → **no** gateway starts (`:4000` is dead). Existing users upgrading from a pre-variants `.env`: add `COMPOSE_PROFILES=litellm` (or `cp .env.example .env`).
> - **Two** (e.g. `litellm,bifrost`) → **both** start and both claim host `:4000` → `docker compose up` fails with a port-allocation error. Only combine a gateway with *overlays* (`litellm,gpu` / `litellm,router`), never with another gateway.

### Switching gateways
```bash
# Default — LiteLLM (from the shipped .env):
docker compose up -d

# Switch to Bifrost (stops litellm, starts bifrost on the same :4000 seam):
COMPOSE_PROFILES=bifrost docker compose up -d --remove-orphans

# Back to LiteLLM:
COMPOSE_PROFILES=litellm docker compose up -d --remove-orphans
```
Shared infra — Ollama, Prometheus, Grafana, the OTel collector — is **not** profiled, so it stays up across a switch. Add GPU/router overlays by combining profiles: `COMPOSE_PROFILES=litellm,gpu`.

---

## ⚡ Bifrost variant

Bifrost (Rust, [maximhq/bifrost](https://github.com/maximhq/bifrost)) is a µs-class, OpenAI-compatible gateway with **native Prometheus + OpenTelemetry**. Config lives in [`bifrost-config.json`](../../../bifrost-config.json), which **mirrors the four tier aliases** so your clients keep calling `tier-fast` / `tier-heavy` / `tier-frontier` / `tier-private` unchanged.

**What carries over vs differs:**

| Concern | LiteLLM | Bifrost |
|---|---|---|
| Tier aliases | 4 tiers | **same 4 tiers** (`bifrost-config.json`) |
| Frontier budgets | per-deployment `max_budget` | `budget.max_usd_per_day` + `rpm`/`tpm` |
| Fallbacks | `litellm_settings.fallbacks` | `models.tier-frontier.fallbacks` |
| Metrics | `/metrics` (Prom) | native Prometheus (job `bifrost`) |
| OTel spans | `otel` callback → collector | native OTel → collector |
| Port | `:4000` | listens `:8080`, mapped to host `:4000` |

> [!WARNING]
> **Privacy pin under Bifrost — verify it, don't assume it.** `tier-private` in `bifrost-config.json` has an **empty `fallbacks` list** (the same intent as LiteLLM keeping it out of every chain). But this rests on Bifrost honoring that (unverified) schema key, and `smoke-test.sh`'s privacy check only catches a leak if Bifrost returns the **resolved** model name (not just the `tier-private` alias). So after switching: confirm the resolved model in `bifrost-config.json` is local-only **and** re-run the smoke check. The guarantee is **inviolable by design** across variants — but under an experimental gateway you must validate the config actually enforces it.

> [!NOTE]
> **Host-native Ollama (macOS/Windows).** `bifrost-config.json` hardcodes the ollama provider `base_url` to the in-container `http://ollama:11434/v1`; unlike LiteLLM it does **not** read `OLLAMA_API_BASE`. If you run Ollama on the host (`--scale ollama=0`, `OLLAMA_API_BASE=http://host.docker.internal:11434`), edit that `base_url` in `bifrost-config.json` to match, or the local tiers break under Bifrost.

> [!NOTE]
> **Experimental.** Pin/verify the image tag (`maximhq/bifrost:v1.5.2`) and the `bifrost-config.json` schema against your Bifrost release — the config here is a faithful *template*, but Bifrost's schema evolves. `bifrost-config.json`'s `_meta.note` says the same.

### Benchmark the overhead
Compare added gateway latency on your own hardware with the same local model:
```bash
COMPOSE_PROFILES=litellm docker compose up -d && ./scripts/bench-gateway.sh   # baseline
COMPOSE_PROFILES=bifrost docker compose up -d && ./scripts/bench-gateway.sh   # variant
```
`scripts/bench-gateway.sh` reports p50/p95 over N `tier-fast` calls (local, ~$0 — measures gateway overhead, not spend).
