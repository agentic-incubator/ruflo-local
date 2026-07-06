# 🔀 Gateway Variants (litellm · bifrost · helicone)

> **What this covers:** the gateway is **pluggable** — `route-gateway` is the always-on host `:4000` seam; exactly one of three OpenAI-compatible gateways runs *behind* it at a time, internal-only. LiteLLM is the default; Bifrost and Helicone are opt-in performance variants. This is how you choose and switch.

← Back to [Technical Guide](../getting-started-technical.md) · Related: [Tiers & Routing](tiers-and-routing.md) · [Observability](observability.md)

---

## 🎛️ One selector, one gateway

All three gateways are compose **profiles**; a single `COMPOSE_PROFILES` selector picks the active one. They are **mutually exclusive** — `route-gateway` owns host `:4000` and forwards to whichever profile is active (via `GATEWAY_UPSTREAM_URL`); only one profile is ever active:

| Gateway | Profile | What it is | Pick it when |
|---|---|---|---|
| **LiteLLM** (default) | `litellm` | Python + Postgres; the reference gateway with the richest budget/fallback/config surface | You want the full feature set, the RouteLLM 90/10 dial, per-tool virtual keys |
| **Bifrost** | `bifrost` | Go, µs-class overhead, native OTel, no Python/Postgres footprint | You want minimal gateway overhead + native tracing (addresses the LiteLLM Python-proxy [scale ceiling](limitations-and-mitigations.md)) |
| **Helicone** | `helicone` | Rust, native OTel + rich budgets/caching; addresses via named routers (`/router/<tier>`) | You want Bifrost-class overhead **plus** dollar/token/request budgets and optional response caching |

The shipped `.env` sets `COMPOSE_PROFILES=litellm`, so **`docker compose up -d` still yields LiteLLM** — no change for existing users.

> [!IMPORTANT]
> `COMPOSE_PROFILES` **must** name exactly **one** gateway:
> - **Empty** → **no** upstream gateway starts, but `route-gateway` still comes up on host `:4000`
>   (it's always-on, unprofiled) — with nothing behind it, every request 502s instead of the
>   port simply being dead. Existing users upgrading from a pre-variants `.env`: add
>   `COMPOSE_PROFILES=litellm` (or `cp .env.example .env`).
> - **Two** (e.g. `litellm,bifrost`) → **both containers start** (neither binds a host port
>   anymore, so there's no port-allocation conflict) — but `route-gateway` only ever forwards
>   to the one named in `GATEWAY_UPSTREAM_URL` (default `http://litellm:4000`), so the other
>   just runs orphaned, wasting resources without ever serving a request. Only combine a
>   gateway with *overlays* (`litellm,gpu` / `litellm,router`), never with another gateway.

### Switching gateways

> **`COMPOSE_PROFILES` alone is not enough.** `route-gateway` (host `:4000`) never restarts when
> you switch profiles — it forwards to whatever `GATEWAY_UPSTREAM_URL` points at, which does NOT
> follow `COMPOSE_PROFILES` automatically. Set both together, or `route-gateway` keeps forwarding
> to the OLD upstream (which is no longer running) and every request 502s.
>
> `make gateway-up PROFILE=<name>` sets both for you from a single knob — use it instead of
> hand-pairing the two vars below.

```bash
# Default — LiteLLM (from the shipped .env):
docker compose up -d
# equivalently: make gateway-up            (PROFILE defaults to litellm)

# Switch to Bifrost (litellm stops; bifrost starts internal-only on :8080):
make gateway-up PROFILE=bifrost
# equivalent, if you're not using make — route-gateway itself never restarts,
# so you must point it at bifrost via GATEWAY_UPSTREAM_URL yourself:
COMPOSE_PROFILES=bifrost GATEWAY_UPSTREAM_URL=http://bifrost:8080 docker compose up -d --remove-orphans

# Back to LiteLLM:
make gateway-up PROFILE=litellm
```
Shared infra — Ollama, Prometheus, Grafana, the OTel collector — is **not** profiled, so it stays up across a switch. Add GPU/router overlays by combining profiles: `COMPOSE_PROFILES=litellm,gpu` (the `gateway-up` target only covers the mutually-exclusive gateway choice, not overlays — combine those with the raw `COMPOSE_PROFILES=` form).

---

## ⚡ Bifrost variant

Bifrost (Go, [maximhq/bifrost](https://github.com/maximhq/bifrost)) is a µs-class, OpenAI-compatible gateway with **native Prometheus + OpenTelemetry**. Config lives in [`config/gateways/bifrost-config.json`](../../../config/gateways/bifrost-config.json), which **mirrors the four tier aliases** so your clients keep calling `tier-fast` / `tier-heavy` / `tier-frontier` / `tier-private` unchanged.

**What carries over vs differs:**

| Concern | LiteLLM | Bifrost |
|---|---|---|
| Tier aliases | 4 tiers | **same 4 tiers** (`config/gateways/bifrost-config.json`) |
| Frontier budgets | per-deployment `max_budget` | `budget.max_usd_per_day` + `rpm`/`tpm` |
| Fallbacks | `litellm_settings.fallbacks` | `models.tier-frontier.fallbacks` |
| Metrics | `/metrics` (Prom) | native Prometheus (job `bifrost`) |
| OTel spans | `otel` callback → collector | native OTel → collector |
| Port | internal `:4000` | internal `:8080` — neither has a host port; `route-gateway` (host `:4000`) reaches whichever is active by service name |

> [!WARNING]
> **Privacy pin under Bifrost — verify it, don't assume it.** `tier-private` in `config/gateways/bifrost-config.json` has an **empty `fallbacks` list** (the same intent as LiteLLM keeping it out of every chain). But this rests on Bifrost honoring that (unverified) schema key, and `smoke-test.sh`'s privacy check only catches a leak if Bifrost returns the **resolved** model name (not just the `tier-private` alias). So after switching: confirm the resolved model in `config/gateways/bifrost-config.json` is local-only **and** re-run the smoke check. The guarantee is **inviolable by design** across variants — but under an experimental gateway you must validate the config actually enforces it.

> [!NOTE]
> **Host-native Ollama (macOS/Windows).** `config/gateways/bifrost-config.json` hardcodes the ollama provider `base_url` to the in-container `http://ollama:11434/v1`; unlike LiteLLM it does **not** read `OLLAMA_API_BASE`. If you run Ollama on the host (`--scale ollama=0`, `OLLAMA_API_BASE=http://host.docker.internal:11434`), edit that `base_url` in `config/gateways/bifrost-config.json` to match, or the local tiers break under Bifrost.

> [!NOTE]
> **Experimental.** Pin/verify the image tag (`maximhq/bifrost:v1.5.2`) and the `config/gateways/bifrost-config.json` schema against your Bifrost release — the config here is a faithful *template*, but Bifrost's schema evolves. `config/gateways/bifrost-config.json`'s `_meta.note` says the same.

### Benchmark the overhead
Compare added gateway latency on your own hardware with the same local model:
```bash
make gateway-up PROFILE=litellm && ./scripts/bench-gateway.sh   # baseline
make gateway-up PROFILE=bifrost && ./scripts/bench-gateway.sh   # variant
```
`scripts/bench-gateway.sh` reports p50/p95 over N `tier-fast` calls (local, ~$0). Read the overhead as the **delta** across variants on the same model — run it under each: `make gateway-up PROFILE=helicone && ./scripts/bench-gateway.sh`.

---

## 🧪 Helicone variant

Helicone AI Gateway ([Helicone/ai-gateway](https://github.com/Helicone/ai-gateway), Rust, Apache-2.0) is a low-overhead, OpenAI-compatible gateway with **native OpenTelemetry + Prometheus** and — unlike Bifrost — **dollar/token/request budgets and optional response caching** built in. Config lives in [`config/gateways/helicone-config.yaml`](../../../config/gateways/helicone-config.yaml), which mirrors the four tiers as **named routers**.

> [!IMPORTANT]
> **Addressing differs.** Helicone routes by **router name**, so clients call `http://localhost:4000/router/tier-fast` rather than `POST /v1/chat/completions` with `model: "tier-fast"`. The tier *vocabulary* is preserved (the routers are named `tier-fast` / `tier-heavy` / `tier-frontier` / `tier-private`), but point your clients at the `/router/<tier>` path when this variant is active. Consequently the shipped **`smoke-test.sh` targets LiteLLM/Bifrost addressing and does not exercise Helicone** — use the `/router/<tier>` paths to test this variant.

> [!WARNING]
> **Privacy pin under Helicone — validated by config, NOT by the shipped smoke test.** The `tier-private` router load-balances over a **single local model, with no other models and no fallback** (and the config has no global fallback block), so it cannot escalate off-box — by construction. **Caveat:** `smoke-test.sh` uses LiteLLM/Bifrost `model=`-at-`/v1/chat/completions` addressing, so it does **not** exercise Helicone's `/router/<tier>` routes — re-running it under Helicone validates nothing. Validate the pin here by (a) inspecting `config/gateways/helicone-config.yaml` (`tier-private` = one local model) and (b) a direct call, asserting the resolved model is local:
> ```bash
> curl -sS http://localhost:4000/router/tier-private/chat/completions \
>   -H "Content-Type: application/json" \
>   -d '{"messages":[{"role":"user","content":"ping"}]}' | jq -r '.model'   # must be a LOCAL model
> ```
> The guarantee is **inviolable by design across every variant**; only its *validation path* differs.

> [!NOTE]
> **Host-native Ollama + experimental.** Like Bifrost, `config/gateways/helicone-config.yaml` hardcodes the ollama `base-url` (edit it for `--scale ollama=0` host setups), caching is left **off** (no Redis/S3 needed), and the image tag (`helicone/ai-gateway:v1.0.0`) + config schema must be verified against your Helicone release ([config reference](https://docs.helicone.ai/ai-gateway/config)).

### Which gateway? — three-way comparison

| | **LiteLLM** (default) | **Bifrost** | **Helicone** |
|---|---|---|---|
| Language / footprint | Python + Postgres | Go, µs-class | Rust, µs-class |
| Client addressing | `model: "tier-fast"` | `model: "tier-fast"` | `/router/tier-fast` |
| Frontier budgets | ✅ USD per deployment | ◐ `budget` block | ✅ USD + token + request |
| Response caching | via config | — | ✅ Redis/S3 (opt-in, off here) |
| Native OTel / Prometheus | callback / `/metrics` | ✅ native | ✅ native |
| Config | `config/gateways/litellm-config.yaml` | `config/gateways/bifrost-config.json` | `config/gateways/helicone-config.yaml` |
| Maturity in this kit | **stable default** | experimental | experimental |
| Privacy pin (`tier-private`) | no fallback chain | empty `fallbacks` | single-model router, no fallback |

Pick **LiteLLM** for the richest, most-proven surface; **Bifrost** for the leanest overhead; **Helicone** when you want lean overhead *and* first-class budgets/caching.
