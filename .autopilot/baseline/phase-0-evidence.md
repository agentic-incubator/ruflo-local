# Phase 0 — evidence: "make the ruflo upgrade real" + routing baseline

Feature: `local-first-learned-routing` · mode: `pr_ci` · gate: **PASSED** (2026-07-04)

Phase 0 is enablement + baseline capture — it introduces no product code and no new
attack surface. Its deliverables are machine config (correctly local/gitignored) and a
committed baseline; the operator-only steps (npx cache refresh, Claude Code session
restart) are recorded here because they can't be CI-gated, exactly as the phase
conventions require.

## Definition-of-Done evidence

| DoD | Check | Result |
|-----|-------|--------|
| 1 | `enabledMcpjsonServers` includes `ruflo` | **PASS** — `.claude/settings.json` (local/gitignored) lists `["agentic-qe","ruflo"]` |
| 2 | ruflo pin ≥ 3.18.x (the #2549 fix floor) | **PASS** — `mcpServers.ruflo.args = ["ruflo@3.21.1","mcp"]` |
| 3 | `npx -y ruflo@3.21.1 --version` resolves (no stale-cache failure) | **PASS** — prints `ruflo v3.21.1` |
| 4 | `.autopilot/baseline/route-baseline.json` has `.tier_shares` + `.latency` | **PASS** — tier_shares 0.9 local / 0.1 frontier (design intent); latency p50 5.833s / p95 6.299s over 11 tier-fast samples |
| 5 | ruflo neural native training backend **available** (not "unavailable") | **PASS** — see table below |

## `npx ruflo@3.21.1 neural status` (captured this run)

```
| Component           | Status     | Details                                   |
| Training Pipeline   | Available  | native @ruvector/ruvllm pipeline          |
| Contrastive Trainer | Available  | ready — trains in-process                 |
| HNSW Index          | Available  | @ruvector/core installed                  |
| Embedding Model     | Loaded     | Xenova/all-MiniLM-L6-v2 (384-dim)         |
| Flash Attention Ops | Available  | batchCosineSim, softmax, topK             |
| RuVector Training   | Not loaded | lazy — initializes on `neural train`      |
```

The #2549 fix is live: the training backend reports **Available (native @ruvector/ruvllm)**,
not "unavailable." `RuVector Training: Not loaded` is lazy initialization (loads on first
`neural train`), not an absence of the backend.

## Operator steps (ungateable — recorded, not enforced by CI)

- **npx cache**: the fixed binary resolves cleanly today (`ruflo v3.21.1`); no stale
  `~/.npm/_npx` refresh was needed this run.
- **Session restart**: enabling the ruflo MCP server in `.claude/settings.json` only surfaces
  the in-session MCP *tools* after a Claude Code restart. Phase-0 verification does **not**
  depend on it — every DoD check runs via the `npx ruflo` CLI, which is already on 3.21.1.
  A restart is only needed if/when a later phase drives ruflo via its MCP tool surface
  (Phase 4 wires ruflo into the request path).

## Gate summary

- Tier 1: lint ✅ · build (`docker compose config -q`) ✅ · format_check/test/test_integration/audit **SKIPPED** (no formatter; no `scripts/lib` tests until Phase 1; live gateway smoke is a gateway-phase check — Phase 0 changed no gateway wiring); no-test-tampering ✅ (diff deletes no tests); security invariants ✅ (no secrets, no destructive git, no tier-private cloud leak).
- Tier 2: DoD 5/5 green (above).
- Tier 3: adversarial review — the phase-0 diff is evidence/notes + a ledger line with no executable logic; review reduces to confirming the recorded claims match live command output, which they do.
- Tier 4 (risk_phase): heavy passes (mutation/pentest/chaos) are **inapplicable by content** — Phase 0 adds no code to mutate, no attack surface to exploit, and no failure paths to fault-inject. Documented, not skipped-for-convenience.
