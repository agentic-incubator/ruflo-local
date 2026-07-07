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
| Tier aliases | 4 tiers | **same 4 tiers**, via `providers.<name>.keys[].aliases` (`config/gateways/bifrost-config.json`) |
| Frontier fallback | `litellm_settings.fallbacks` (per-alias chain) | `governance.routing_rules[]` (provider-scoped: anthropic → openai/gemini for `tier-frontier`; no per-alias tier-fast→tier-heavy equivalent — see quirks below) |
| Frontier budgets | per-deployment `max_budget` | not yet expressed (real schema's cost controls live elsewhere in `governance`; the current template has no budget block) |
| Metrics | `/metrics` (Prom) | native Prometheus (job `bifrost`) |
| OTel spans | `otel` callback → collector | native OTel → collector |
| Port | internal `:4000` | internal `:8080` — neither has a host port; `route-gateway` (host `:4000`) reaches whichever is active by service name |

<details>
<summary><strong>Real-world quirks found &amp; fixed (2026-07-07)</strong> — click to expand</summary>

The pinned image (`maximhq/bifrost:v1.5.2`) had never actually been brought up via `docker compose` in this repo before a CI matrix run first exercised it. Two independent bugs surfaced, both confirmed live (not guessed) and fixed in `docker-compose.yml` / `config/templates/bifrost-config.json.tmpl`:

1. **Entrypoint infinite loop (vendor bug).** The image's own `docker-entrypoint.sh` has a `parse_args()` catch-all branch (`set -- "$@" "$1"; shift`) that never shrinks the argument count for any flag it doesn't recognize as `--port`/`--host` — `-app-dir` (which this compose file must pass) triggers it every time, hanging the container forever with zero log output. Confirmed via `sh -x` trace. **Fix:** `docker-compose.yml`'s `bifrost` service sets `entrypoint: ["/app/main"]` directly, bypassing the broken wrapper — the real binary starts in ~3.5s and serves `/health` correctly.
2. **Stale config schema.** The old template's `providers.<name>.{type,base_url,api_key}` + top-level `models` map was never valid against v1.5.2's real schema (confirmed via its own live validator). The real shape is `keys[]`-based: each key has `name`/`value`/a `models` allow-list/`weight`, plus provider-specific `*_key_config` (e.g. `ollama_key_config: {url}`), and a client-facing alias maps to the real model id via `keys[].aliases`. Rewritten accordingly; verified live (tier-fast/heavy/private, DRACO corpus growth, and the privacy pin all pass through the real container).
3. **Fallback is provider-scoped, not alias-scoped.** `governance.routing_rules[].fallbacks` lists *provider names* to retry, not *aliases* — there's no direct way to express "tier-fast fails over to tier-heavy" the way LiteLLM's `fallbacks` chain does. Only `tier-frontier`'s cross-provider leg (anthropic → openai/gemini) is currently expressed; `smoke-test.sh`'s fall-through drill prints the result for Bifrost rather than hard-asserting on it, for exactly this reason.

</details>

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
> **Addressing differs, AND router names drop the `tier-` prefix.** Helicone routes by **router name**, so clients call `http://localhost:4000/router/fast` rather than `POST /v1/chat/completions` with `model: "tier-fast"`. The routers are named `fast` / `heavy` / `frontier` / `private` — no `tier-` prefix, unlike LiteLLM/Bifrost's `tier-fast` etc. This isn't a style choice: Helicone's router IDs are regex-capped at 12 characters (confirmed against its source, `ai-gateway/src/config/mod.rs`'s `ROUTER_ID_REGEX`), and `tier-frontier` (13 chars) cannot exist as a router ID at all. Rather than special-case just that one tier, all four drop the prefix uniformly. `smoke-test.sh` handles this automatically via `GATEWAY_KIND=helicone` (strips `tier-` before building the `/router/<name>` path) — set that env var to get full, real coverage under this variant, not a skip.

> [!WARNING]
> **Privacy pin under Helicone.** The `private` router load-balances over a **single local model, with no other models and no fallback** (and the config has no global fallback block), so it cannot escalate off-box — by construction. `smoke-test.sh`'s privacy-pin check exercises this for real when run with `GATEWAY_KIND=helicone` (it builds the correct `/router/private` path automatically). To validate manually instead:
> ```bash
> curl -sS http://localhost:4000/router/private/chat/completions \
>   -H "Content-Type: application/json" \
>   -d '{"messages":[{"role":"user","content":"ping"}]}' | jq -r '.model'   # must be a LOCAL model
> ```
> The guarantee is **inviolable by design across every variant**; only its *validation path* differs.

> [!NOTE]
> **Judging, escalation, and DRACO recording work correctly for Helicone-routed traffic (fixed 2026-07-07).** `route-gateway`'s tier detection originally matched only the literal alias string (`tier-fast`, etc.) in the `model` field — since Helicone requires the *real* resolved model id there instead (see below), a Helicone-routed request wasn't recognized as a scorable/bufferable tier decision at all: no judging, no escalation, and DRACO corpus rows either weren't written or carried the wrong tier. Fixed by teaching `route-gateway` to *also* recognize the tier from the URL path (`/router/<name>/...`) when present — checked with the same "first, unconditionally" priority as the body-based check, so the privacy pin's fail-closed guarantee is unchanged (`tier-private` still never gets buffered/judged). Live-verified: tier-fast/heavy escalate correctly on a low judge score, `/router/private/` produces zero judge/escalation egress calls, and DRACO corpus rows record the canonical tier. See `scripts/gateway-server.mjs`'s `tierFromRouterPath()`.

> [!NOTE]
> **Host-native Ollama + experimental.** Like Bifrost, `config/gateways/helicone-config.yaml` hardcodes the ollama `base-url` (edit it for `--scale ollama=0` host setups), caching is left **off** (no Redis/S3 needed), and the image tag (`helicone/ai-gateway:0.2.0-beta.30`) + config schema must be verified against your Helicone release ([config reference](https://docs.helicone.ai/ai-gateway/config)). Per-key rate limiting (token/request caps beyond the daily USD `budget`) was removed 2026-07-07 — it requires a globally-configured rate-limit store (redis/in-memory) this standalone kit doesn't otherwise need; the daily budget cap still applies.

> [!NOTE]
> **Local-tier chat completions require a real `model` id in the request body, even under router addressing.** Unlike LiteLLM/Bifrost, Helicone validates `model` against its global catalog before the router's own load-balancing applies — a bodyless-model call, or the bare tier alias, 400s (`Missing`/`Invalid model id in request body`, confirmed live). `smoke-test.sh` handles this automatically for `GATEWAY_KIND=helicone`: it reads the real provider/model id straight out of the rendered `config/gateways/helicone-config.yaml` for whichever router it's calling, rather than hardcoding a tag that varies per hardware variant. A manual call needs the same: `-d '{"model":"ollama/<real-tag>", ...}'`, not just `{"model":"tier-fast"}`.

<details>
<summary><strong>Real-world quirks found &amp; fixed (2026-07-07)</strong> — click to expand</summary>

Like Bifrost, Helicone had never actually been brought up via `docker compose` in this repo before a CI matrix run first exercised it — the pinned tag couldn't even be *pulled*. Confirmed live against the real image and its Rust source at each step, in order — **local-tier chat completions are now fully working and live-verified** (tier-fast/heavy/private, DRACO corpus growth, and the privacy pin all pass through the real container):

1. **`v1.0.0` was never a real Docker Hub tag.** Pull failed with `manifest unknown`. Helicone/ai-gateway has never published a Docker tag with a `v` prefix — GitHub releases use `v0.2.0-beta.N`, Docker Hub strips the `v`. Corrected to `helicone/ai-gateway:0.2.0-beta.30` (the latest real tag as of this writing).
2. **No image ENTRYPOINT.** `docker-compose.yml`'s `command: ["--config", "/app/config.yaml"]` was executing literal `--config` as if it were the binary (`exec: "--config": executable file not found`). The image's bare `CMD` is `/usr/local/bin/ai-gateway` with no entrypoint — fixed by prefixing the full binary path in `command:`.
3. **`cache-store: {type: disabled}` isn't a real variant** — only `redis`/`in-memory` are accepted. Fixed by omitting the block entirely (caching is opt-in; omitting it *is* "off").
4. **A provider must declare its own `models:` list.** `providers.ollama` needs the real (unprefixed) model tags it exposes, separate from how routers *reference* them (`ollama/<tag>`).
5. **`strategy: weighted` ≠ "pin one model."** It's `ProviderWeighted` — it picks among *providers* via a `providers: [{provider, weight}]` field, not a `models:` list. Each tier needing one specific model uses `model-latency` (`models: [modelId]`) instead — confirmed against `ai-gateway/src/config/balance.rs`'s `BalanceConfigInner` enum.
6. **`telemetry` field names differ from what the old template guessed** — the real fields are `exporter`/`otlp-endpoint`, not `prometheus`/`otel-endpoint` (`exporter: both` emits Prometheus metrics *and* OTel spans).
7. **Router IDs are capped at 12 characters** (`ai-gateway/src/config/mod.rs`'s `ROUTER_ID_REGEX`, `^[A-Za-z0-9_-]{1,12}$`) — `tier-frontier` (13 chars) cannot exist as a router ID at all. Rather than a one-off exception, all four routers drop the `tier-` prefix uniformly (see the IMPORTANT callout above).
8. **Per-key rate limiting needs a store.** `rate-limit.per-api-key` failed with `store not configured` — it requires a globally-declared rate-limit backend (redis/in-memory) this standalone kit doesn't otherwise need. Removed; the daily USD `budget` cap still applies.
9. **The real blocker: the provider key name must be a recognized `InferenceProvider`, or every chat completion 500s.** `providers.ollama-local` deserialized into the untagged `InferenceProvider::Named(String)` catch-all — which only has a **hardcoded converter allowlist** (`mistral`/`groq`/`deepseek`/`xai`/`hyperbolic`; confirmed in `ai-gateway/src/middleware/mapper/registry.rs`) — so every request failed with `Converter not present for OpenAI(ChatCompletions) -> OpenAICompatible{...}`. Ollama is actually a **first-class native `InferenceProvider` variant** with its own registered `OllamaConverter`; naming the provider key literally `ollama` resolves to that variant instead. The generic provider config struct (`GlobalProviderConfig`) also has no `type` field at all (only `models`/`base-url`/`version`) — the old `type: openai-compatible` line was always inert.
10. **Local-tier calls still need a real `model` id in the body** even after fix #9 — see the NOTE above; `smoke-test.sh` resolves it from the rendered config rather than hardcoding it.
11. **`route-gateway` itself needed a fix, not just the config: it never recognized Helicone-routed traffic as an explicit tier at all.** `scripts/gateway-server.mjs`'s `EXPLICIT_TIERS` check only matched a literal alias in the `model` field — since Helicone's `model` is always a real resolved id (fix #10), every Helicone-routed request fell through as `category: "unrouted"`, un-judged and (depending on the served tier's shape) not correctly recorded. Fixed by adding path-based tier detection (`/router/<name>/...` → canonical `tier-<name>`), checked with the same unconditional priority as the body-based check — see `tierFromRouterPath()`. Live-verified: escalation and DRACO recording now work correctly for Helicone's local tiers, and the privacy pin is unaffected (still never bufferable/judged).
12. **Not yet investigated:** the fall-through (fallback-chain) drill's behavior under Helicone is unconfirmed — `smoke-test.sh` prints the result rather than asserting on it, matching Bifrost's same provider-scoped-fallback caveat above.

</details>

### Which gateway? — three-way comparison

| | **LiteLLM** (default) | **Bifrost** | **Helicone** |
|---|---|---|---|
| Language / footprint | Python + Postgres | Go, µs-class | Rust, µs-class |
| Client addressing | `model: "tier-fast"` | `model: "tier-fast"` | `/router/fast` (no `tier-` prefix — 12-char router ID cap) |
| Frontier budgets | ✅ USD per deployment | ✗ not yet expressed in this template | ✅ USD per day |
| Response caching | via config | — | ✅ Redis/S3 (opt-in, off here) |
| Native OTel / Prometheus | callback / `/metrics` | ✅ native | ✅ native |
| Config | `config/gateways/litellm-config.yaml` | `config/gateways/bifrost-config.json` | `config/gateways/helicone-config.yaml` |
| Maturity in this kit | **stable default** | experimental | experimental |
| Privacy pin (`tier-private`) | no fallback chain | one key, no routing rule targets it | single-model router, no fallback |
| Local-tier (fast/heavy/private) chat | ✅ works | ✅ works (live-verified) | ✅ works (live-verified — see quirks above) |

Pick **LiteLLM** for the richest, most-proven surface; **Bifrost** for the leanest overhead; **Helicone** when you want lean overhead *and* first-class budgets/caching. All three have live-verified local-tier chat completions as of 2026-07-07; the fall-through (fallback-chain) drill's behavior is unconfirmed for Bifrost/Helicone (both provider-scoped, not alias-scoped) — `smoke-test.sh` prints rather than asserts on that one check for those two variants.
