// reflex.test.mjs — the safety reflex. Focus: the FAIL-CLOSED privacy pin (only an
// explicitly-scorable local tier ever goes off-box; private/unknown/blank/mis-cased
// tiers are kept local with zero network calls), escalate-on-low, keep-on-high, the
// default escalation target, and graceful degradation when the judge/escalation throws
// or yields nothing. The judge runs for real in-process over an injected stub client;
// no network is touched.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  reflex,
  reflexDecision,
  canonicalTier,
  isScorable,
  scorableTiers,
  escalationTier,
} from "../reflex.mjs";

/** Stub client: records every call; judge calls (system msg) get a score, escalation gets an answer. */
function mkClient(score, escalationAnswer = "frontier-answer") {
  const calls = [];
  return {
    calls,
    async chatContent(body) {
      calls.push(body);
      const isJudge = body.messages?.some((m) => m.role === "system");
      if (isJudge) return score === null ? "" : JSON.stringify({ score });
      return escalationAnswer;
    },
  };
}
const judgeCalls = (c) => c.calls.filter((b) => b.messages?.some((m) => m.role === "system"));
const escalationCalls = (c) => c.calls.filter((b) => !b.messages?.some((m) => m.role === "system"));

describe("canonicalize + allowlist (fail-closed primitives)", () => {
  test("should_trimAndLowercase_when_canonicalizing", () => {
    assert.equal(canonicalTier(" Tier-Private "), "tier-private");
    assert.equal(canonicalTier(undefined), "");
  });
  test("should_allowOnlyScorableTiers_byDefault", () => {
    assert.equal(isScorable("tier-fast"), true);
    assert.equal(isScorable("TIER-HEAVY"), true); // casing normalized
    assert.equal(isScorable("tier-private"), false);
    assert.equal(isScorable(undefined), false);
    assert.equal(isScorable("tier-unknown"), false);
  });
  test("should_honorSCORABLE_TIERS_override", () => {
    assert.deepEqual(scorableTiers({ SCORABLE_TIERS: "a, B ,c" }), ["a", "b", "c"]);
  });
  test("should_defaultEscalationTierToFrontier", () => {
    assert.equal(escalationTier({}), "tier-frontier");
    assert.equal(escalationTier({ ESCALATION_TIER: "tier-x" }), "tier-x");
  });
});

describe("reflexDecision (pure, fail-closed)", () => {
  test("should_notEscalate_when_tierNotScorable_evenOnLowScore", () => {
    const d = reflexDecision({ tier: "tier-private", verdict: { decision: "escalate", score: 0.1, threshold: 0.6 } });
    assert.equal(d.escalate, false);
  });
  test("should_escalate_when_scorableAndJudgeSaysEscalate", () => {
    assert.equal(reflexDecision({ tier: "tier-fast", verdict: { decision: "escalate", score: 0.2, threshold: 0.6 } }).escalate, true);
  });
  test("should_keep_when_judgeAccepts", () => {
    assert.equal(reflexDecision({ tier: "tier-fast", verdict: { decision: "accept", score: 0.9, threshold: 0.6 } }).escalate, false);
  });
  test("should_keep_when_verdictSkippedOrNull", () => {
    assert.equal(reflexDecision({ tier: "tier-fast", verdict: { decision: "skipped" } }).escalate, false);
    assert.equal(reflexDecision({ tier: "tier-fast", verdict: null }).escalate, false);
  });
});

describe("reflex — happy paths", () => {
  test("should_keepLocalAnswer_when_scoreIsHigh", async () => {
    const client = mkClient(0.9);
    const r = await reflex({ tier: "tier-fast", prompt: "P", answer: "local", client, threshold: 0.6 });
    assert.equal(r.escalated, false);
    assert.equal(r.answer, "local");
    assert.equal(escalationCalls(client).length, 0);
    assert.equal(r.tier, "tier-fast"); // echoed field asserted (#7)
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  });

  test("should_escalateToFrontier_when_scoreIsLow", async () => {
    const client = mkClient(0.2);
    const r = await reflex({ tier: "tier-fast", prompt: "P", answer: "local", client, threshold: 0.6, escalate: async () => "frontier-answer" });
    assert.equal(r.escalated, true);
    assert.equal(r.answer, "frontier-answer");
  });

  test("should_escalateAgainstFrontierTier_when_noEscalateInjected", async () => {
    // Exercises the DEFAULT escalation lambda (#4): a low score must re-query tier-frontier.
    const client = mkClient(0.1);
    const r = await reflex({ tier: "tier-fast", prompt: "P", answer: "local", client, threshold: 0.6 });
    assert.equal(r.escalated, true);
    assert.equal(r.answer, "frontier-answer");
    assert.equal(escalationCalls(client).length, 1);
    assert.equal(escalationCalls(client)[0].model, "tier-frontier");
  });
});

describe("reflex — FAIL-CLOSED privacy pin (#1/#2/#3)", () => {
  // Each of these WOULD have leaked under the old exact-match pin.
  for (const [label, tier] of [
    ["exact private tier", "tier-private"],
    ["case-drifted private", "Tier-Private"],
    ["trailing-space private", "tier-private "],
    ["undefined tier", undefined],
    ["unknown tier", "tier-mystery"],
  ]) {
    test(`should_keepLocal_andNeverTouchGateway_when_${label.replace(/\s/g, "_")}`, async () => {
      const client = mkClient(0.0); // would score low → would escalate, if it ran
      let escalateCalled = false;
      const r = await reflex({
        tier, prompt: "secret", answer: "private-local", client, threshold: 0.6,
        escalate: async () => { escalateCalled = true; return "leaked"; },
      });
      assert.equal(r.escalated, false);
      assert.equal(r.answer, "private-local");
      assert.equal(r.verdict, null);
      assert.equal(client.calls.length, 0, "non-scorable tier must not reach the gateway/judge");
      assert.equal(escalateCalled, false);
      assert.equal(typeof r.overhead_ms, "number"); // overhead present on the private path (#6)
    });
  }

  test("should_keepLocalForOrphanedPin_when_SCORABLE_TIERS_omitsAName", async () => {
    // #2: reconfiguring scorable tiers must not silently make tier-private scorable.
    const client = mkClient(0.0);
    const r = await reflex({ tier: "tier-private", prompt: "P", answer: "x", client, threshold: 0.6, env: { SCORABLE_TIERS: "tier-fast" } });
    assert.equal(client.calls.length, 0);
    assert.equal(r.escalated, false);
  });
});

describe("reflex — graceful degradation (chaos, #5)", () => {
  test("should_keepLocal_when_judgeIsUnavailable", async () => {
    const client = mkClient(null); // both passes empty → skipped
    const r = await reflex({ tier: "tier-fast", prompt: "P", answer: "local", client, threshold: 0.6 });
    assert.equal(r.escalated, false);
    assert.equal(r.answer, "local");
    assert.equal(r.verdict.decision, "skipped");
  });

  test("should_keepLocal_when_escalationReturnsNothing", async () => {
    const client = mkClient(0.1, ""); // low score, but frontier yields empty
    const r = await reflex({ tier: "tier-fast", prompt: "P", answer: "local", client, threshold: 0.6 });
    assert.equal(r.escalated, false);
    assert.equal(r.answer, "local");
  });

  test("should_degradeToLocal_when_judgeThrows", async () => {
    const client = { async chatContent() { throw new Error("boom"); } };
    const r = await reflex({ tier: "tier-fast", prompt: "P", answer: "local", client, threshold: 0.6 });
    assert.equal(r.escalated, false);
    assert.equal(r.answer, "local");
    assert.equal(typeof r.overhead_ms, "number");
  });

  test("should_degradeToLocal_when_escalationThrows", async () => {
    const client = mkClient(0.1);
    const r = await reflex({
      tier: "tier-fast", prompt: "P", answer: "local", client, threshold: 0.6,
      escalate: async () => { throw new Error("frontier down"); },
    });
    assert.equal(r.escalated, false);
    assert.equal(r.answer, "local");
  });

  test("should_recordNonNegativeOverhead_onScorablePath", async () => {
    const client = mkClient(0.9);
    const r = await reflex({ tier: "tier-fast", prompt: "P", answer: "a", client, threshold: 0.6 });
    assert.ok(r.overhead_ms >= 0);
  });
});
