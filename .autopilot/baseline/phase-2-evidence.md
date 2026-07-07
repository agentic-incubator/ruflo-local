# Phase 2 — evidence: the judge in-loop as the safe reflex

Feature: `local-first-learned-routing` · mode: `pr_ci` · **risk_phase** · gate: **PASSED** (2026-07-04)

Wires the FrugalGPT judge into the live loop on the RESPONSE side: a local-tier answer
is scored and escalated to frontier only on a low score — the day-one fix for "a
confidently-wrong local answer is served." One module: `scripts/lib/reflex.mjs` + tests.

## What shipped
- `scripts/lib/reflex.mjs` — verify-then-escalate wrapper; pure decision over (tier, verdict); the gateway stays dumb.
- `scripts/lib/__tests__/reflex.test.mjs` — **22 node:test cases**.

## Definition of Done — green
- `node --check scripts/lib/reflex.mjs` ✅
- `node --test scripts/lib/__tests__/reflex.test.mjs` → 22/22 ✅ (escalate-on-low, keep-on-high, private-never-escalate)
- grep `tier-private` present ✅ · grep:absent `TODO|FIXME` ✅
- full suite regression: **91/91** ✅ · lint ✅ · build ✅

## Tier-3 + Tier-4 adversarial review (risk_phase) — outcome
An independent `qe-security-reviewer` attacked the module along the risk surface
(pentest = privacy leak, mutation, chaos). **It found a CRITICAL fail-OPEN bug in the
first-cut privacy pin**, which was fixed before merge:

- **#1 CRITICAL — FIXED**: the pin was an exact-string match (`tier === "tier-private"`)
  with no normalization → any non-byte-identical tier (`"Tier-Private"`, a trailing
  space, or `undefined`) was scored by the *frontier* judge, leaking the private
  prompt+answer off-box. **Fix: inverted to a FAIL-CLOSED allowlist** — only explicitly
  *scorable* local tiers (`tier-fast`, `tier-heavy`, canonicalized trim+lowercase) ever
  go off-box; every other tier (private / unknown / blank / undefined / mis-cased) is
  kept local with zero network calls. Unknown ⇒ private, by construction.
- **#2 HIGH — FIXED**: `PRIVATE_TIER` override could orphan the literal `tier-private`.
  Gone — the allowlist has no single overridable private name; `tier-private` is never
  scorable regardless of `SCORABLE_TIERS` (tested).
- **#3 HIGH — FIXED**: the second-layer guard was "theater" (ran after off-box scoring).
  Now BOTH `reflex()` and `reflexDecision()` check `isScorable` → genuine defense-in-depth;
  the load-bearing short-circuit is documented.
- **#4 MEDIUM — FIXED (test)**: the default escalation lambda was untested. Added a test
  asserting a low score with no injected `escalate` re-queries `tier-frontier`.
- **#5 MEDIUM — FIXED**: a throwing judge/escalation rejected the whole reflex. Added
  try/catch → degrades to the local answer; tests for judge-throws and escalation-throws.
- **#6/#7 LOW — FIXED (tests)**: `overhead_ms` on the private path + echoed `tier`/`reason`
  now asserted.

**Machine-checkable proof the leak is closed**: five tests — one per leak vector the
reviewer named — each assert `client.calls.length === 0` (the gateway/judge is never
touched) for a low-scoring private/unknown answer.

**Reviewer's clean bill**: `verify-escalate` prompt-injection hardening is solid
(untrusted text in JSON strings only, per-run nonce, strict fail-closed `parseScore`).

## Gate summary
- Tier 1: lint ✅ · build ✅ · test 91/91 ✅ · no-test-tampering ✅ · security invariants ✅ (fail-closed privacy pin now enforced + tested).
- Tier 2: DoD green.
- Tier 3+4 (risk_phase): adversarial pentest/mutation/chaos pass found + fixed a CRITICAL fail-open; all 7 findings resolved. Full mutation/chaos *harnesses* were disproportionate for a ~120-line pure function — a targeted adversarial agent on the real blast radius (leak/mutation/degradation) was the proportionate call.
- test_integration (live smoke): deferred — reflex is response-side and not wired into the gateway request path until Phase 4; unit tests mock the gateway.
