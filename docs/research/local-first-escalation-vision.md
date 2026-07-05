# Local-First Escalation — the vision, in plain language

> **Last validated:** 2026-07-04
> **Audience:** anyone new to this repo who wants the *why* before the *how*.
> Companion to the technical set (`architecture-rfc.md`, `metaharness-and-ruflo-local.md`,
> `limitations-and-mitigations.md`). This page is deliberately jargon-light.
>
> **Status (phases 0–10 shipped):** this page frames the *motivation*. Several "current
> problem" statements below — the judge "on the bench", the learner "off and empty" — describe
> the **pre-implementation** state. That escalation loop has since been built as a tested
> reference/overlay layer (`scripts/lib/{reflex,recorder,train-router,promotion-gate}.mjs`,
> 191 passing tests), though it is **not yet wired into the live gateway request path**. Read
> the "problems" as the *why this repo exists*, not the *current runtime state*.

## The one-sentence vision

**Ask the free local model first. Only pay for the expensive frontier model when the
local answer isn't good enough — and get smarter over time about which questions to send
where.**

Everything else in this repo is plumbing to make that one sentence true, cheap, private,
and self-improving.

## The analogy: homework with two helpers

- **Your smart friend next door** helps for *free*, instantly, and never repeats your
  business to anyone. That's the **local models** (Qwen on Ollama, on your own machine).
- **A paid genius tutor** who charges *real money per question*. Brilliant, but calling
  them for everything would bankrupt you. That's the **frontier models** (Claude Opus,
  GPT, Gemini).

The smart move is obvious: **ask your friend first; call the tutor only when your friend
is stuck.** That's "local-first, escalate to frontier." The rest of the repo is the
machinery to do that *well*.

| The concern | In plain terms | In the repo |
|---|---|---|
| **Tiering** | Deciding *who* to ask: friend, smarter friend, or tutor | The four tiers: `tier-fast`, `tier-heavy`, `tier-frontier`, `tier-private` |
| **The gateway** | One phone number that connects you to the right helper | LiteLLM (or Bifrost / Helicone) |
| **Quality / scoring** | *Checking whether the answer was actually good* before trusting it | `verify-escalate.sh` — a judge that scores the answer 0–1 |
| **Escalation** | "That was weak — **now** call the tutor" | Low score → re-ask a frontier model |
| **Budget / cost** | Only so much tutor money this week — spend it carefully | `budget-snapshot.sh` + per-model daily caps |
| **Privacy** | Some questions are *secret* — never text them outside | `tier-private` — never leaves the machine |
| **Learning** | Remembering "friend is always bad at calculus" and skipping straight to the tutor | the neural router + bandit (the ruvector part) |

## Why bother at all (the "why")

The naive versions are both bad:

- **Always use the tutor** → amazing answers, insane bill, and your secrets leave the building.
- **Always use the friend** → free and private, but you sometimes confidently ship a *wrong* answer.

The sweet spot — **friend by default, tutor for the hard tail** — buys roughly
frontier-quality at a fraction of the cost. rUv **reports** that escalating **only the
failures** (the gated-escalation work behind ADR-148) lifts quality substantially at a
fraction of the cost. The specific figures rUv cites — roughly ~15% → 33% at ~6× less — and
the "Barbarian & the Scholar" framing are **internal / not independently published**; treat
them as directional motivation, not a measured guarantee. That gap *is* the reason this repo exists.

## The honest problem (why it currently feels tangled)

Learning, tiering, budget, and quality live in **different components**, and today they
aren't wired into one loop. Three concrete knots:

1. **Two possible "brains."** One decider lives in **ruflo** (its neural router), another
   could live in **metaharness** (a separate cost-optimal picker). Run both and they
   disagree — each one's learning gets muddy. **Pick exactly one brain.**
2. **The judge is on the bench.** `verify-escalate.sh` can score an answer, but nothing
   feeds that score back automatically, so the system never *learns* from it. This is the
   core defect: **a local model that confidently answers *wrong* still gets trusted,
   because nobody checks in real time.**
3. **The learner is off and empty.** ruflo ships the neural router but it's switched
   **off** here and has learned from **zero** past questions. The "gets smarter over time"
   superpower isn't running yet.

## The picture

```
        Your question
             │
             ▼
   ┌───────────────────┐     "who should answer this?"
   │   THE DECIDER      │◄─── the ONE brain (currently off)
   │  (router/learner)  │
   └───────────────────┘
             │
        ┌────┴─────┐
        ▼          ▼
   Free friend   Paid tutor
   (local)       (frontier)
        │          │
        ▼          │
   ┌─────────┐     │   "was that answer actually good?"
   │  JUDGE  │     │   verify-escalate (on the bench right now)
   └─────────┘     │
        │          │
   good? keep.     │
   bad? ───────────┘  escalate to tutor
        │
        ▼
   remember what happened  ◄── learn, so next time we skip the friend for this kind
        │
        └──────► back to THE DECIDER
```

Everything needed is already in the box. The work isn't inventing pieces — it's **picking
one brain, putting the judge in the game, and closing the loop so it learns.**

## The three decisions that shape the build

1. **Who is the one brain?** — ruflo's built-in learner (least new machinery, uses what's
   shipped) vs. bolting on metaharness's picker.
2. **How smart, and when?** — ship the safe reflex first (score low → escalate), then let
   the learner ride on top of the judge's scores; or go straight to the trained router.
3. **How much can we change?** — keep it a clean config overlay, or change the tier system
   so it can pick local-vs-frontier *per individual question* rather than per category.

The recommended starting point: **one brain (ruflo's), safe reflex first, learning layered
on** — value on day one, smarts as the corpus grows.
