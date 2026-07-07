# 🧰 Prerequisites — what to install & configure

> **What this covers:** everything you need on your machine before the stack runs, **organized by need**. Do the **Required** tier for a working kit; add the **Optional** tiers only if you want the feature they unlock. This is the single source of truth — both getting-started guides link here.

← Back to [Guide home](../README.md) · [Technical Guide](../getting-started-technical.md) · [Plain-Language Guide](../getting-started-nontechnical.md)

---

## ✅ Required — everyone

You need these for any working install.

### 1. Docker + Docker Compose
- **What / why:** runs the whole stack (gateway, Ollama, Prometheus, Grafana) as containers. Everything here is `docker compose`.
- **Install:** [Docker Desktop](https://docs.docker.com/get-docker/) (macOS/Windows) or Docker Engine + the Compose plugin (Linux).
- **Verify:**
  ```bash
  docker --version && docker compose version
  ```

### 2. Ollama (local inference)
- **What / why:** serves the local models behind `tier-fast` / `tier-heavy` / `tier-private` — the ~90% that never leaves your box.
- **Install:** [ollama.com/download](https://ollama.com/download). On macOS/Windows run it **on the host** (Docker can't reach Apple/consumer GPUs) and start the stack with `docker compose up --scale ollama=0`; on Linux the bundled `ollama` container works.
- **Pull the models** your tiers reference. `tier-fast` uses the **same GGUF tag on all
  hardware**; only `tier-heavy` / `tier-private` differ — the **MLX** build on Apple Silicon
  (same weights, Apple's MLX engine for better throughput), the plain build elsewhere. See
  [Hardware & Models](hardware-and-models.md).
  ```bash
  ollama pull qwen3.6:35b-a3b-q4_K_M       # tier-fast — all hardware (MoE ~3B active, ~20 GB)

  # tier-heavy / tier-private — pull ONE, matching your render variant (see §3):
  ollama pull qwen3.6:27b-mlx              # 🍎 Apple Silicon — MLX build (~20 GB); the auto-detected default
  ollama pull qwen3.6:27b                  # everyone else — plain GGUF build (~17 GB)
  ```
  You do **not** hand-edit `config/gateways/litellm-config.yaml` for this — `make render`
  (§3) writes the hardware-correct tag into the gateway configs from `config/model-sets.json`.
- **Verify:**
  ```bash
  ollama --version && ollama list
  ```

### 3. The gateway stack + `.env`
- **What / why:** the LiteLLM gateway (default) plus its keys, budgets, and the gateway selector.
- **Configure:**
  ```bash
  cp .env.example .env         # then edit: add frontier keys, master key
  make render                  # render gateway configs to your hardware (needs Node.js, see §4);
                               #   non-Apple-Silicon: make render RUFLO_MODEL_VARIANT=gguf
  make gateway-up               # brings up the default (LiteLLM) gateway + shared infra
  ```
  Set frontier API keys (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`) for the `tier-frontier` lane. To pick a different gateway, use `make gateway-up PROFILE=<name>` (see [Gateway Variants](gateway-variants.md) — it sets both `COMPOSE_PROFILES` and `GATEWAY_UPSTREAM_URL` together; hand-setting only `COMPOSE_PROFILES` leaves `route-gateway` forwarding to the old upstream). Frontier keys are optional if you only ever run local tiers.
- **Why `make render` is not optional:** the committed gateway configs are **generated** from `config/templates/*.tmpl`. `make render` auto-detects your arch (Apple Silicon → MLX, else → GGUF) and stamps the matching local model tags into `config/gateways/*`. Skip it on a non-Apple-Silicon host and `tier-heavy`/`tier-private` point at a `-mlx` tag that host never pulled → those tiers fail. Re-running is idempotent.
- **Verify:**
  ```bash
  curl -sS http://localhost:4000/health/liveliness && ./smoke-test.sh
  ```
  `./smoke-test.sh` auto-sources `.env`, so it uses the same `LITELLM_MASTER_KEY` the gateway started with.

### 4. CLI tools — Node.js, `python3`, `curl`
- **What / why:** `make render` regenerates the gateway configs and needs **Node.js ≥ 18** (ESM + `node --test`). `./smoke-test.sh` — the verification step in every guide — parses gateway JSON with **`python3`** and calls the gateway with **`curl`**. All three are hard dependencies of the Required flow above.
- **Verify:**
  ```bash
  node --version && python3 --version && curl --version
  ```

---

## 🔌 Optional — strengthen the guided router (§1–§4)

Only needed if you want the [router mitigations](limitations-and-mitigations.md#-strengthening-the-guided-router): the neural router, tool-calling escalation, and budget-steered routing.

### ruflo
- **What / why:** the agent meta-harness that does complexity scoring + the **neural router** (`CLAUDE_FLOW_ROUTER_NEURAL=1`, §1) and consumes the tier map / budget snapshot (§2/§4). Point it at this gateway per [Tiers & Routing → Integrating your tools](tiers-and-routing.md#-integrating-your-tools).
- **Prereqs:** Node.js.
- **Install:** ([ruvnet/ruflo](https://github.com/ruvnet/ruflo))
  ```bash
  npm install -g ruflo@latest        # or: npx ruflo@latest init wizard
  ```
- **Verify:**
  ```bash
  ruflo --version
  ```

### ruvector
- **What / why:** the Rust HNSW vector DB + FastGRNN engine that powers ruflo's **semantic route cache** (`CLAUDE_FLOW_ROUTER_EMBED_CACHE_SIZE`, §1). It **ships inside ruflo** — you do **not** install it separately for normal use; build it standalone only for advanced/embedded work.
- **Prereqs (standalone only):** the [Rust toolchain](https://www.rust-lang.org/tools/install).
- **Build (advanced):** ([ruvnet/ruvector](https://github.com/ruvnet/ruvector))
  ```bash
  git clone https://github.com/ruvnet/ruvector && cd ruvector && cargo build --release
  ```
- **Verify (toolchain):**
  ```bash
  cargo --version
  ```

---

## 🚀 Optional — scale / GPU

### vLLM
- **What / why:** high-throughput local serving for `tier-heavy` under the `gpu` compose profile — solves Ollama's sequential concurrency (honest-list #5). **NVIDIA only.**
- **Install:** shipped as the `vllm/vllm-openai` image; bring it up with `COMPOSE_PROFILES=litellm,gpu docker compose up -d`. Reference: [docs.vllm.ai](https://docs.vllm.ai/en/latest/getting_started/installation/index.html).
- **Verify:**
  ```bash
  curl -sS http://localhost:8000/v1/models
  ```

---

## 🧪 Optional — quality engineering (contributors)

### agentic-qe
- **What / why:** the standalone QE fleet (the `aqe` CLI) for test generation / coverage / quality gates when developing on this kit. Not needed to *run* the stack.
- **Install:** ([proffesor-for-testing/agentic-qe](https://github.com/proffesor-for-testing/agentic-qe))
  ```bash
  npm install -g agentic-qe        # provides the `aqe` CLI; run `aqe init` in a repo to scaffold
  ```
- **Verify:**
  ```bash
  aqe --version
  ```

---

> [!TIP]
> Minimum viable install = **Docker + Ollama + Node.js + `cp .env.example .env` + `make render` + `make gateway-up`**. Everything below the Required tier is opt-in — add it when you reach for the feature it unlocks.
