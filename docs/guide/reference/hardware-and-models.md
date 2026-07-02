# 🖥️ Hardware & Models

> **What this covers:** what your machine can realistically run locally, and *which* open-weight models to run — with evidence, footprints, and licenses.
> **Currency:** model selection is anchored to the **June–July 2026 open-weight leaderboards** (SWE-bench Verified). Re-check before a long-term pin — this space moves fast.

← Back to [Technical Guide](../getting-started-technical.md) · [Plain-Language Guide](../getting-started-nontechnical.md)

---

## 1. Hardware → what you can serve

Pick your local ambition by memory. The default `tier-fast` is a Mixture-of-Experts (MoE) model — big on disk, but only a fraction of it is "active" per token, so it runs at small-model speed.

| Your machine | Realistic local tiers | Notes |
|---|---|---|
| **16 GB RAM, no / small GPU** | `tier-fast` = a 7–14B **dense** coder (Q4) only | The 30B-A3B MoE needs ~19–22 GB and won't fit; skip local `tier-heavy` and let its fallback go straight to frontier |
| **24–32 GB RAM or 12–16 GB VRAM** | `tier-fast` = `Qwen3-Coder-30B-A3B` (MoE, ~3B active) at Q4; no local `tier-heavy` | The MoE fits in ~19–22 GB and runs at dense-7B speed; a dense 27B `tier-heavy` wants more room — fall it through to frontier |
| **Apple Silicon 32–64 GB unified** | `tier-fast` = `Qwen3-Coder-30B-A3B` (MoE) · `tier-heavy` = `Qwen3.6-27B` (dense) | **Run Ollama natively on the host** — Docker has no Apple-GPU access |
| **NVIDIA 24 GB+ (3090/4090/5090…)** | `tier-fast` = `Qwen3-Coder-30B-A3B` · `tier-heavy` = `Qwen3.6-27B`-AWQ on vLLM | Dense 27B at Q4/AWQ is ~16–17 GB weights + KV — fits 24 GB for moderate context; the `gpu` profile ~2× throughput at concurrency |

> [!NOTE]
> Tiers are just **aliases** (see [Tiers & Routing](tiers-and-routing.md)), so the model behind each is a one-line change. The defaults matter, but nothing locks you in.

**Where to get models:**
- 🦙 **Ollama library** (GGUF, one-command pull): https://ollama.com/library — starters: `qwen3-coder:30b-a3b` (`tier-fast`), `qwen3.6:27b` (`tier-heavy`, verify exact tag).
- 🤗 **Hugging Face** (safetensors, for vLLM): https://huggingface.co/models — e.g. `Qwen/Qwen3.6-27B`, `Qwen/Qwen3.6-35B-A3B`, `Qwen/Qwen3-Coder-30B-A3B-Instruct`.

---

## 2. Which models, and why

> [!IMPORTANT]
> **Caveat up front:** these scores are largely **vendor-reported and scaffolding-dependent** (e.g. the 30B-A3B figure uses OpenHands 100-turn). Treat cross-model gaps under ~3 pp as noise, and re-verify on *your* tasks with the [quality-regression harness](observability.md#quality-regression-harness). The open-weight field moved two generations past `qwen2.5-coder` in a year.

### 2a. Fits local hardware — what to actually run

| Role | Model | Params (active) | License | SWE-bench Verified | Q4 footprint | Fit |
|---|---|---|---|--:|---|---|
| **tier-fast (default)** | Qwen3-Coder-30B-A3B | 30.5B MoE (3.3B active) | Apache-2.0 | 51.6% | ~19–22 GB | 32 GB+ RAM / 24 GB GPU; runs at ~3B-dense speed. On Ollama today. |
| **tier-fast (upgrade)** | Qwen3.6-35B-A3B | 35B MoE (~3B active) | Apache-2.0 | **73.4%** | ~20 GB | Same footprint, far stronger — **pending a turnkey Q4 Ollama build** (HF/vLLM now). |
| **tier-heavy (default)** | Qwen3.6-27B (dense) | 27–28B dense | Apache-2.0 | **77.2%** | ~16–17 GB | 24 GB GPU / 64 GB Mac. Beats last-gen's 397B model on coding. |
| **tier-heavy (fallback)** | Qwen3.5-27B (dense) | 27B dense | Apache-2.0 | 72.4% | ~16–17 GB | Same footprint; use if a 3.6 build misbehaves. |

### 2b. Emerging candidate worth piloting — Ornith-1.0

**DeepReinforce, MIT, released Jun 25 2026.** A self-scaffolding agentic-coding family RL-post-trained on Gemma 4 / Qwen 3.5 bases (both Apache-2.0, so the MIT release is license-clean). Relevant here because it's *purpose-built for tool-use / multi-turn agents* — exactly where generic coders are weakest.

| Role | Model | Params (active) | License | SWE-bench Verified † | Q4/Q5 footprint | Fit |
|---|---|---|---|--:|---|---|
| tier-fast / **16 GB & edge** | Ornith-1.0-9B (dense) | 9B dense | MIT | 69.4% † | ~6 GB Q4 | Fills the 16 GB rung the table above lacks — *if the number holds*. |
| tier-fast (agentic) | Ornith-1.0-35B MoE | 35B MoE (~3B active) | MIT | 75.6% † | ~20 GB Q4 / ~25 GB Q5 | Competes with Qwen3.6-35B-A3B; agentic-tuned. |

> [!WARNING]
> † **Vendor-reported ("DeepReinforce official evaluation"), not yet on an independent SWE-bench Verified leaderboard.** A 9B dense at 69.4 would be extraordinary and is unconfirmed — treat with more skepticism than the Qwen rows.
>
> **For it:** official GGUF weights on HF (`Ornith-1.0-35B-GGUF` ~285k downloads / 645 likes; `-9B-GGUF` ~255k dl), reputable `bartowski` quants, runs on Ollama / LM Studio / vLLM / llama.cpp, and hands-on praise from Simon Willison (35B Q4_K_M, ~103 tok/s): *"it seems to be able to run the agent harness over many tool calls in a proficient way."*
> **Against:** DeepReinforce has little public track record; the model is ~1 week old.
> **Verdict:** pilot the **35B MoE** as an alternative `tier-fast` (side-by-side vs Qwen3.6-35B-A3B on *your* tasks) and the **9B** for 16 GB machines — but keep the verified Qwen entries as the default until an independent run confirms these numbers.

### 2c. Tops the boards but too big for one box

Open-weight, but hundreds-of-billions-to-trillion-param MoE needing multi-GPU clusters (e.g. GLM-4.6 AWQ = 176 GB across 4×48 GB). Use these only as **hosted-API frontier alternates** (add to the `tier-frontier` alias), never as a local rung:

| Model | Params (active) | License | SWE-bench Verified |
|---|---|---|--:|
| DeepSeek V4 Pro | 1.6T MoE (49B active) | MIT | 80.6% |
| MiniMax M3 | ~230B+ MoE | open | 80.5% |
| Kimi K2.6 (Moonshot) | 1T MoE (32B active) | Modified MIT | 80.2% |
| DeepSeek V4 Flash | 284B MoE (13B active) | MIT | 79.0% |
| GLM-5 (Z.AI) | ~744B MoE (~40B active) | MIT | 77.8% |
| GLM-4.7 (Z.AI) | 355B MoE | MIT | 73.8% (LiveCodeBench 84.9) |

---

## 3. Open questions — verify locally

- **Real tokens/sec** for these models on M-series Apple Silicon and on a 24 GB NVIDIA GPU (throughput claims were unconfirmed).
- **Head-to-head agentic tool-calling / BFCL-v3 ranks** — SWE-bench is used here as the proxy (see [Limitations & Mitigations §2](limitations-and-mitigations.md#-2-small-local-models-are-specifically-weak-at-agentic-tool-calling)).
- Whether dense `Qwen3.6-27B` holds a *usefully long* context on 24 GB at Q4 (plausible, not benchmarked).
- GLM-5.1/5.2, Qwen3.7-Max and DeepSeek "-Max" variants were already surfacing at this window — **re-check the leaderboards before a long-term pin.**

📊 **Leaderboards (verify before pinning):** [llm-stats](https://llm-stats.com/benchmarks/swe-bench-verified) · [Vellum](https://www.vellum.ai/open-llm-leaderboard) · [benchlm](https://benchlm.ai/benchmarks/sweVerified) · [Ollama registry](https://ollama.com/library).
