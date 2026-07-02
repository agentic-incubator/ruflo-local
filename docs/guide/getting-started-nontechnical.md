# 🌱 Getting Started — Plain-Language Guide

> **Audience:** anyone curious about running AI on their *own* computer — no coding background needed.
> **Goal:** understand what this is, decide whether it's for you, and get it running with careful copy-paste (or hand it to a technical helper).
> **Time:** 📖 ~10 min to read · ☕ ~15 min to set up.

> **What you'll need first:** just a couple of free tools (Docker + Ollama). The [Prerequisites](reference/prerequisites.md) page lists them with plain steps — you only need the **"Required — everyone"** section; skip the optional parts unless a helper suggests them.

---

## 💡 What is this, really?

Imagine every AI tool you use (a coding assistant, a chat app, a script) currently mails its questions to a company's servers on the internet. You pay per letter, and your letters leave your house.

**This kit installs a smart mail room *inside your house.*** 🏠

- 📬 **~90 out of every 100 questions** get answered right there, by AI models running on **your own computer** — free, private, fast.
- ✈️ **~10 out of 100** — the genuinely hard ones — are forwarded to the big paid services (Claude, GPT, Gemini), but only up to a **spending limit you set**.
- 🔒 One special lane is **sealed**: anything you mark private is answered at home and *can never* be mailed out, even by mistake.

You get privacy, lower cost, and it keeps working even when the internet or a paid service is down.

> [!NOTE]
> Your tools don't change. They all just talk to **one address on your computer** (`http://localhost:4000`). Behind that address, a simple settings file decides who answers what. Change your mind later? Edit one file.

---

## 🧭 The four "lanes" (tiers)

Think of them like postage classes. You (or your tools) just pick a lane by name:

| Lane | Who answers | Best for |
|---|---|---|
| 🏠 **tier-fast** | A quick local model | Everyday questions — the ~90% |
| 🏠 **tier-heavy** | A stronger local model | Harder questions, still at home |
| ✈️ **tier-frontier** | Claude → GPT → Gemini | The hardest ~10%, with a spending cap |
| 🔒 **tier-private** | Local only, **sealed** | Anything sensitive — never leaves your machine |

📖 Want the mechanics of how a question flows through the lanes? → [Tiers & Routing](reference/tiers-and-routing.md) (a bit more technical, but readable).

---

## 🤔 Is this for you?

> [!TIP]
> **Good fit if** you value privacy, want predictable costs, and have a reasonably capable computer.
> **Maybe not yet if** your computer is older/low-memory, or you'd rather not touch a terminal at all — in which case, hand the [Technical Guide](getting-started-technical.md) to a tech-savvy friend and skim this page to understand what they're building.

**The one thing that decides what runs at home: your computer's memory.**

| Your computer | What runs locally |
|---|---|
| 💻 16 GB memory, no graphics card | A small local model only — hard questions go to the paid lane |
| 💻 32 GB memory (or a good GPU) | A solid everyday local model |
| 🖥️ Apple Silicon Mac (32–64 GB) or NVIDIA 24 GB+ GPU | Both a fast **and** a strong local model |

📖 Exact models, sizes, and reasoning → [Hardware & Models](reference/hardware-and-models.md).

---

## 🛠️ Setting it up (careful copy-paste)

> [!IMPORTANT]
> You'll paste a few commands into a **terminal** (the Terminal app on Mac, or PowerShell on Windows). You don't need to understand them — just do them in order. If anything errors, that's normal; note the message and ask a technical helper (or paste it into an AI chat).

**First, a one-time install:** [Docker Desktop](https://docs.docker.com/get-docker/) — the "engine" that runs the mail room. Install it and make sure it's open before continuing.

**Then, in the folder that contains this kit:**

**① Create your settings file and open it**
```bash
cp .env.example .env
```
Open the new `.env` file in any text editor. Set a password where it says `LITELLM_MASTER_KEY` (any phrase you'll remember). If you have paid-service keys, paste them in too — otherwise leave them blank (everything still works, fully local).

**② Turn on the mail room**
```bash
docker compose up -d
```

**③ Download the local AI models** (this pulls several gigabytes the first time — grab a coffee ☕)
```bash
docker exec ollama ollama pull qwen3-coder:30b-a3b
```

**④ Check that everything works**
```bash
./smoke-test.sh
```
✅ If it reports each lane answering and the 🔒 private lane staying home, you're done.

> [!WARNING]
> **On an Apple Silicon Mac?** There's one extra setting so the AI can use your Mac's chip. See the callout in the [Technical Guide → Step 1](getting-started-technical.md#-step-1--bring-up-the-stack), or ask your helper — it's a two-line change.

---

## 👀 Seeing what's happening

Open your web browser to these built-in dashboards (they run on your computer):

- 📊 **Grafana** → http://localhost:3000 — pretty charts: how much is answered at home vs. sent out, and what you've spent.
- 🎛️ **Control panel** → http://localhost:4000/ui — the mail room's own admin page.

📖 A friendly 10-minute weekly check-in routine → [Observability & Testing](reference/observability.md).

---

## 💬 Frequently asked

> [!NOTE]
> **"Does anything I type leave my computer?"**
> Only questions sent to the ✈️ **tier-frontier** lane. The 🏠 local lanes and the 🔒 sealed lane never do. The sealed lane is a *structural* guarantee — not a promise, a wall.

> [!NOTE]
> **"Will this get expensive?"**
> You set a hard daily limit (e.g. a few dollars). When it's hit, the paid lane simply stops until the next day — it can't overspend. → [Budgets & Trade-offs](reference/budgets-and-tradeoffs.md).

> [!NOTE]
> **"What are the honest downsides?"**
> Local models aren't as sharp as the big paid ones on the hardest tasks, and the system can occasionally give a confident-but-wrong answer without noticing. We keep an honest list → [Limitations & Mitigations](reference/limitations-and-mitigations.md).

> [!NOTE]
> **"What if I'd rather use something ready-made?"**
> There are managed and simpler alternatives → [Resources → Alternatives](reference/resources.md#-alternatives-worth-knowing).

---

## 🗺️ Where to next

- 🛠️ Ready to go deeper, or handing off to a developer → **[Technical Guide](getting-started-technical.md)**
- 🏠 How the lanes actually decide → [Tiers & Routing](reference/tiers-and-routing.md)
- 💵 Setting spending limits → [Budgets & Trade-offs](reference/budgets-and-tradeoffs.md)
- 📚 Everything, indexed → [Guide home](README.md)
