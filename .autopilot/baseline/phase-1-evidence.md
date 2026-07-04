# Phase 1 — evidence: portable Node/.mjs port of the reward/verify/budget toolchain

Feature: `local-first-learned-routing` · mode: `pr_ci` · gate: **PASSED** (2026-07-04)

Ports the four bash scripts to portable Node ESM (`scripts/lib/*.mjs`, no package.json,
Node built-ins only), behavior-preserving, with the FrugalGPT judge now running
in-process (no bash/jq/curl). The four `scripts/*.sh` entry points are kept as thin
shims (`exec node .../lib/<name>.mjs "$@"`) so the documented `./scripts/x.sh` commands
and doc links keep working.

## What shipped
- Foundations: `config.mjs` (env surface), `gateway-client.mjs` (OpenAI-compatible fetch, replaces curl).
- Ports: `verify-escalate.mjs` (the judge), `budget-snapshot.mjs`, `bench-gateway.mjs`, `quality-regression.mjs` (scores in-process via the ported judge).
- New: `reward.mjs` (quality/cost/latency → scalar for the later learned router).
- Tests: `scripts/lib/__tests__/*.test.mjs` — **69 node:test cases** (node:test + node:assert/strict), gateway mocked by injection. AAA; cover happy + fail-closed + injection + graceful-degradation.
- Thin bash shims for the four ported scripts (shellcheck-clean, executable).

## Definition of Done — green
- `node --check` every module → all parse.
- `node --test scripts/lib/__tests__/*.test.mjs` → 69/69 pass.
- `node scripts/lib/verify-escalate.mjs --help` → exits 0.
- greps: `position-swap` + `rubric` present in verify-escalate.mjs; **does not shell out** (no `child_process`); no TODO/FIXME.

Note: the DoD/profile/CI test command was corrected from `node --test scripts/lib/__tests__/`
(a directory form **removed in Node 23** — passed on CI's Node 22 but failed local Node 26)
to the portable glob `scripts/lib/__tests__/*.test.mjs`.

## Tier-3 adversarial review — outcome
Independent reviewer traced every module against its bash source and walked the
injection/fail-closed paths. **Security bottom line: the LLM-as-judge hardening is
faithfully preserved — no injection hole.** Untrusted content rides only in JSON strings
(JSON.stringify, never interpolated), fresh per-run nonce, strict `[0,1]` score parse
(injected `{"score":5}` → rejected → 0.0), both-empty → skipped.

Findings and resolutions:
- **#1 (MEDIUM) — FIXED**: a numeric corpus `id` threw on `id.padEnd(20)` and aborted the sweep → now `String(row.id ?? "?")`. Test added.
- **#2 (MEDIUM) — FIXED**: an unguarded `JSON.parse(line)` (and a missing `prompt`) aborted the whole sweep, contradicting the "degrades gracefully" docstring → now per-row try/catch skips a malformed/prompt-less row and continues. Tests added.
- **#3 (LOW-MED) — ACCEPTED (intentional)**: `verify-escalate` emits `passes` as numbers/`null` rather than the bash strings/`"null"`. Numbers are the correct JSON type; nothing in-repo reads `.passes`; `.score`'s type is unchanged.
- **#4 (LOW) — ACCEPTED (improvement)**: `gateway-client.health()` authenticates its `/metrics` probe (bash used bare curl). It tries `/health/liveliness` (no auth) first; authenticating the `/metrics` fallback is more correct when that endpoint is protected.
- **#5 (LOW) — ACCEPTED (library convention)**: a non-numeric `FRONTIER_*_BUDGET` falls back to the default (via `config.num`) rather than the bash CLI's hard `exit 1`. The library favors graceful defaults uniformly; a typo'd budget still emits valid JSON. Future option: a strict-validate mode.

## Gate summary
- Tier 1: lint ✅ (incl. 4 shims shellcheck-clean) · build (`docker compose config -q`) ✅ · test 69/69 ✅ · no-test-tampering ✅ · security invariants ✅ (no secrets, no shelling out, tier-private untouched — that's Phase 2).
- Tier 2: DoD green.
- Tier 3: reviewed; #1/#2 fixed, #3–#5 accepted with rationale.
- Tier 4: N/A — Phase 1 is not a risk_phase.
- test_integration (live gateway smoke): deferred — Phase 1 changes no gateway wiring and the modules aren't in the request path until Phase 4; unit tests mock the gateway.
