# metaharness × ruflo-local — how they compose

*Research note. Last validated: 2026-07-03.*

**TL;DR** — [metaharness](https://github.com/ruvnet/metaharness) and this repo are two
halves of the **same cost thesis**, from the same author ecosystem (ruvnet / ruflo /
claude-flow / ruvector). metaharness **generates the agent** (a branded CLI, MCP server,
memory, learning loop, and a cost-aware model router). ruflo-local is the **local backend
that agent points at** — real model endpoints, tier fall-through, budget caps, a privacy
lane, and Grafana/Prometheus observability. They meet at one well-defined seam: an
**OpenAI-compatible gateway endpoint** (`http://localhost:4000/v1`) exposing four tier
aliases. You can wire them together today for the *serving* half; the *router* half needs
one verification step called out below.

---

## How to read this doc — evidence legend

Every non-obvious claim is tagged so nothing here is taken on faith:

| Tag | Meaning |
|-----|---------|
| ✅ **Confirmed** | Verified in a file in this repo, or quoted from the metaharness README. |
| 🟡 **Inferred** | A reasonable conclusion from confirmed facts, *not* directly stated. Treat as a hypothesis to test. |
| ⛔ **Not stated** | metaharness's public README does **not** document this. Do not assume it works until you verify against the actual package. |

Sources used: this repo's `config/gateways/litellm-config.yaml`, `config/routing/ruflo-tiers.json`,
`config/routing/router-policy.example.json`, `docs/guide/reference/tiers-and-routing.md`; and the
metaharness README at `github.com/ruvnet/metaharness` (fetched 2026-07-03).

---

## 1. What each project actually is

### ruflo-local (this repo) — the serving substrate ✅

A local-first tiered LLM gateway. Confirmed from `config/gateways/litellm-config.yaml`, clients only ever
ask for **model aliases**; the gateway decides what physically serves each one:

| Alias | Serves (default) | Locality | Guardrail |
|-------|------------------|----------|-----------|
| `tier-fast` | `ollama_chat/qwen3.6:35b-a3b` (MoE, ~3B active) | local | workhorse, ~90% of traffic |
| `tier-heavy` | `ollama_chat/qwen3.6:27b` (dense) | local | up-tier target |
| `tier-frontier` | Claude Opus → GPT-4.1 → Gemini 2.5 Pro | cloud | per-deployment `max_budget` + `budget_duration`, auto-failover |
| `tier-private` | `ollama_chat/qwen3.6:27b`, **local-only** | local | ✅ deliberately absent from every fallback chain — can never escalate off-box |

Also confirmed in that file: a fall-through ladder (`tier-fast → tier-heavy →
tier-frontier`), context-window fallbacks, `num_retries: 2`, and
`callbacks: ["prometheus", "otel"]` for spend + OpenTelemetry GenAI spans. Routing on the
*client* side is done by ruflo's complexity router (or RouteLLM in the optional `router`
profile) — see §5.

### metaharness — the harness factory ✅

Not an agent framework; a **generator** that scaffolds branded, repo-aware agent packages.
Confirmed package surface from its README:

| Package | Role |
|---------|------|
| `@ruvnet/agent-harness-generator` (CLI: `metaharness`) | the generator itself |
| `@metaharness/kernel` | shared primitives, **Rust → wasm-pack + NAPI-RS** (v0.1.x beta) |
| `@metaharness/router` | cost-aware model selector — `route(query)` returns "the cheapest model predicted to clear your quality bar, learned from your own eval logs" |
| `@metaharness/darwin` | "Darwin Mode" — mutates the harness config, sandbox-tests each change, keeps only wins (`npm run evolve`; frozen model, no network by default) |
| `@metaharness/weight-eft` | LoRA tuning to distill a cheaper tier |
| `@ruvector/tiny-dancer` | optional native model training for the router |
| host wrappers | `@metaharness/claude-code`, `@metaharness/codex`, `@metaharness/hermes`, `@metaharness/pi-dev`, `@metaharness/openclaw`, `@metaharness/rvm`, `@metaharness/copilot`, `@metaharness/opencode`, `@metaharness/github-actions` |

Its headline result (✅ quoted, with the README's own caveats): **55.6% on SWE-bench
Verified (500), ~$0.15/instance (est.), ~56× cheaper than frontier-only**, via a
"cost-cascade" that escalates only failed/empty attempts to Opus-tier models. The README is
honest that the per-instance cost is an **estimate** and part of the lift is run-to-run
variance — so treat 56× as directional, not a guarantee.

---

## 2. Why they compose — the shared thesis

Both projects say the same thing at different layers:

> Do the cheap thing by default; spend frontier dollars only on the hard tail.

- **metaharness** expresses it at the **router / learning layer** — `route(query)` predicts
  the cheapest model that clears a quality bar, and the cascade escalates failures.
- **ruflo-local** expresses it at the **gateway / infra layer** — `tier-fast` local by
  default, budget-capped `tier-frontier` for the ~10% that needs it.

They're not redundant; they're **stacked concerns**: *which model* (metaharness) vs. *how
that model is actually served, capped, and observed* (ruflo-local). And they already share
a substrate — ✅ this repo ships `ruvector.db` and its `config/routing/router-policy.example.json`
references `ruvector-router-core` HNSW; metaharness's optional router training rides on
`@ruvector/tiny-dancer`. Same ruvector layer, both sides.

---

## 3. The one honest caveat before you wire anything

metaharness's README documents the router's **output** (`route(query)` → a model name) but
⛔ **does not state how you point the router — or the generated harness — at a custom
OpenAI-compatible base URL, LiteLLM, Ollama, or a self-hosted endpoint.** Its examples name
providers abstractly ("GLM/Qwen", "Opus/GPT"), not endpoints.

So the integration below splits cleanly into two layers with very different confidence:

- **Serving layer (ruflo-local side): ✅ ready today.** Any OpenAI-compatible client that
  lets you set `base_url` + `model` plugs straight in. This repo already proves it — see the
  OpenAI SDK example in `tiers-and-routing.md`.
- **Harness layer (metaharness side): 🟡 needs one verification.** You must confirm that the
  generated harness's **host wrapper** (e.g. `@metaharness/claude-code`) accepts a custom
  OpenAI-compatible `base_url`, and that the router emits model IDs you can map to the four
  tier aliases. Until you check the generated package, treat this as a hypothesis.

**How to verify (do this first):** scaffold a throwaway harness, then inspect it —

```bash
npx @ruvnet/agent-harness-generator my-probe   # or: npm i -g @ruvnet/agent-harness-generator
cd my-probe
grep -rE -i "base_?url|OPENAI_BASE|endpoint|localhost:4000|ollama|litellm" src/ package.json .env.example
# Look at what route(query) returns and where the host wrapper reads its endpoint/model from.
node -e "const {route}=require('@metaharness/router'); console.log(route('refactor this function'))"
```

If the wrapper reads an OpenAI base URL from env, you're in business (path A below). If the
router only returns fixed provider names, you map those names to aliases (path B).

---

## 4. Concrete wiring — the ruflo-local side (✅ ready)

Bring the gateway up (from this repo's README):

```bash
cp .env.example .env        # add keys; default gateway is LiteLLM
make render                 # render gateway configs to your hardware
docker compose up -d        # LiteLLM :4000 + Ollama + Prometheus + Grafana
#   to switch gateways instead: make gateway-up PROFILE=bifrost|helicone
./smoke-test.sh             # verify tiers, fall-through, privacy pin, metrics
```

The gateway now speaks OpenAI-compatible at `http://localhost:4000/v1` with models
`tier-fast` / `tier-heavy` / `tier-frontier` / `tier-private`. This is the exact contract
in `docs/guide/reference/tiers-and-routing.md` → *Anything using the OpenAI SDK*:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:4000/v1", api_key="<your-virtual-key>")
resp = client.chat.completions.create(model="tier-fast", messages=[...])
print(resp.model)   # tells you which physical model actually served it
```

### Path A — host wrapper points at the gateway (🟡 preferred, if verified)

If the generated harness's host wrapper takes an OpenAI base URL (verify per §3), point it
at the gateway and let ruflo-local own serving, failover, budgets, and metrics:

```bash
# In the generated harness's .env (names depend on the wrapper — confirm against the package)
export OPENAI_BASE_URL=http://localhost:4000/v1
export OPENAI_API_KEY=$LITELLM_MASTER_KEY          # the gateway's master/virtual key
```

Then constrain what `@metaharness/router` may emit to the four aliases. Conceptually:

```jsonc
// hypothetical router→alias map — confirm the router's real config format against the package (§3)
{
  "cheap":     "tier-fast",       // local MoE, ~$0
  "mid":       "tier-heavy",      // local dense 27B
  "frontier":  "tier-frontier",   // budget-capped Claude→GPT→Gemini
  "sensitive": "tier-private"     // never leaves the box
}
```

Now metaharness's cascade and ruflo-local's ladder **line up**: the router picks the tier;
the gateway resolves it to a physical model, applies the budget cap, fails over on error,
and emits the Prometheus/OTel spans.

### Path B — the router emits fixed provider names (fallback)

If `route(query)` only returns names like `qwen`/`glm`/`opus` and you can't change them, add
matching aliases to `config/gateways/litellm-config.yaml` so the gateway answers those names too. You
already have the pattern — every `tier-*` entry is just a `model_name` alias; add a
`model_name: opus` pointing at the same budget-capped Anthropic deployment, a
`model_name: qwen` at the local one, etc. The router keeps its vocabulary; the gateway
still enforces budgets and failover underneath.

---

## 5. Reconciling the two routers (important)

Both projects ship a router. Don't run them blind against each other — **pick a seam.**

| Option | metaharness router | ruflo-local routing | When |
|--------|--------------------|---------------------|------|
| **Stacked (recommended)** 🟡 | picks a **tier alias** per request from eval-log learning | gateway resolves alias → physical model, applies budget + failover + metrics | you want metaharness's learned selection *and* ruflo's hard guardrails |
| **Gateway-only** ✅ | not used | ruflo's neural/bandit router (`CLAUDE_FLOW_ROUTER_NEURAL=1`) or RouteLLM `router` profile does tier selection | you want metaharness purely as the harness/CLI/MCP generator |
| **Router-only** 🟡 | full selection | gateway is a dumb OpenAI-compat pass-through (still gives you budgets + metrics for free) | you trust metaharness's cascade and just want local serving + observability |

In the **stacked** option the layers don't fight because they answer different questions —
selection vs. enforcement. Note the trade-off already flagged in this repo's tiers doc: when
an upstream router chooses the tier, **ruflo's own per-model bandit labels blur** (it can't
see which physical model the gateway ultimately picked). If you lean on metaharness's
router, disable ruflo's learned path to avoid two learners disagreeing, and keep ruflo's
**tier floors** from `config/routing/router-policy.example.json` as a safety net (tool-driven / multi-turn
agent types should never drop below `tier-heavy`).

---

## 6. Bonus integrations worth stealing

Beyond routing, three metaharness pieces map onto this repo:

1. **`harness mcp-scan`** ✅ — "npm audit for agent tools": a static-only scan that flags
   shell/network grants, missing timeouts, wildcard permissions, and unpinned deps, exiting
   `1` on any HIGH. Point it at this repo's MCP surface (`.mcp.json` → `agentic-qe`, plus any
   others you add) as a pre-commit / CI gate. Its default-deny model (`off` · `local` stdio ·
   `remote` HTTPS+auth; no network/shell/file-write by default) is a good template for
   hardening local agent tooling.
2. **Darwin Mode + Weight-EFT** ✅ — LoRA-distilling a cheaper tier could tune the very Qwen
   models ruflo-local serves on `tier-fast`/`tier-heavy`. Better local quality → more traffic
   *stays* local → the 90/10 split tilts further toward local without losing quality. (🟡
   Whether the distilled weights drop cleanly into your Ollama/vLLM serving path is untested
   here — validate before relying on it.)
3. **Witness signing (Ed25519)** ✅ — metaharness signs releases with provenance. If you ever
   publish a ruflo-local-flavored harness, that's a ready-made supply-chain story.

---

## 7. Suggested next steps

1. **Verify the seam (§3).** Scaffold a probe harness; confirm the host wrapper takes an
   OpenAI base URL and see what `route()` emits. This decides Path A vs. Path B and is the
   only real unknown.
2. **Stand up the gateway** (`docker compose up -d`) and confirm `tier-*` aliases answer at
   `:4000/v1` (`./smoke-test.sh`).
3. **Wire one host wrapper** (e.g. `@metaharness/claude-code`) at the gateway; watch the
   Grafana spend/latency panels to confirm traffic actually lands on local tiers.
4. **Pick the router seam (§5)** and turn off the loser to avoid dueling learners.
5. **Add `harness mcp-scan` to CI** against `.mcp.json`.
6. **Re-benchmark, don't trust the numbers.** Both the 56× (metaharness) and the local
   `cost_per_m_tok: 0` in `config/routing/ruflo-tiers.json` are starting points — re-measure on your
   hardware via `docs/guide/reference/observability.md`.

---

## Appendix — what is NOT confirmed (so you don't over-claim)

- ⛔ metaharness router support for custom `base_url` / LiteLLM / Ollama / self-hosted
  endpoints — **not stated** in the README. The entire Path-A wiring depends on verifying it.
- ⛔ The router's real config file format and env vars — **not stated**. §4's alias map is
  illustrative.
- 🟡 That Darwin/Weight-EFT distilled weights serve cleanly via this repo's Ollama/vLLM path.
- 🟡 Whether the stacked-router option's latency/behavior is acceptable — measure it.
- Everything about ruflo-local's tiers, aliases, budgets, and fallbacks **is** ✅ confirmed
  in `config/gateways/litellm-config.yaml` and the guide.
