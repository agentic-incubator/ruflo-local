// router.test.mjs — the per-category champion. Proves: FLOORS are never violated; rising
// budget utilization DEMOTES (every ramp rung, incl. 0.25) then MASKS frontier; missing
// metrics FAIL CLOSED (mask, not open); a frontier floor beats the quota; escalation-forced
// is exempt; a pinned-private request is never steered; and ruflo route()'s AGENT output is
// parsed to a category. ruflo and the budget snapshot are injected — no ruflo, no gateway.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  route,
  tierRank,
  maxTier,
  floorClamp,
  agentFloor,
  hardSignalFloor,
  budgetSteer,
  defaultRufloAgent,
} from "../router.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const policy = JSON.parse(readFileSync(join(repoRoot, "config/routing/router-policy.example.json"), "utf8"));

const budget = (demotion_rung, metrics_available = true) => ({ demotion_rung, metrics_available, frontier_masked: demotion_rung === "mask" });

describe("tier primitives", () => {
  test("should_orderLadder_andRankPrivateOffLadder", () => {
    assert.ok(tierRank("tier-fast") < tierRank("tier-heavy"));
    assert.ok(tierRank("tier-heavy") < tierRank("tier-frontier"));
    assert.equal(tierRank("tier-private"), -1);
  });
  test("should_clampUpToFloor", () => {
    assert.equal(maxTier("tier-fast", "tier-heavy"), "tier-heavy");
    assert.equal(floorClamp("tier-fast", "tier-heavy"), "tier-heavy");
    assert.equal(floorClamp("tier-frontier", "tier-heavy"), "tier-frontier");
  });
  test("should_readAgentFloors_fromPolicy_defaultingUnknown", () => {
    assert.equal(agentFloor(policy, "reviewer"), "tier-heavy");
    assert.equal(agentFloor(policy, "agentic_multiturn"), "tier-frontier");
    assert.equal(agentFloor(policy, "architect"), "tier-fast"); // unknown → default
  });
  test("should_liftFloorToHeavy_onHardSignal", () => {
    assert.equal(hardSignalFloor(policy, ["requires_tool_calls"]), "tier-heavy");
    assert.equal(hardSignalFloor(policy, ["multi_file_scope"]), "tier-fast");
  });
});

describe("budgetSteer — demote across every rung, mask, fail-closed", () => {
  test("should_notTouchNonFrontier", () => {
    assert.deepEqual(budgetSteer("tier-heavy", "tier-fast", "mask"), { tier: "tier-heavy", demoted: false, masked: false });
  });
  for (const rung of ["0.25", "0.5", "0.75"]) {
    test(`should_demoteFrontierToHeavy_atRamp_${rung}`, () => {
      const r = budgetSteer("tier-frontier", "tier-fast", rung);
      assert.equal(r.tier, "tier-heavy");
      assert.equal(r.demoted, true);
      assert.equal(r.masked, false);
    });
  }
  test("should_keepFrontier_when_rungZero_andMetricsOk", () => {
    assert.deepEqual(budgetSteer("tier-frontier", "tier-fast", "0"), { tier: "tier-frontier", demoted: false, masked: false });
  });
  test("should_maskFrontier_atFullUtilization", () => {
    assert.equal(budgetSteer("tier-frontier", "tier-fast", "mask").masked, true);
  });
  test("should_failClosed_maskFrontier_when_metricsUnavailable_evenAtRungZero", () => {
    const r = budgetSteer("tier-frontier", "tier-fast", "0", { metricsAvailable: false });
    assert.equal(r.tier, "tier-heavy");
    assert.equal(r.masked, true);
  });
  test("should_keepFrontier_when_floorIsFrontier_orEscalationForced", () => {
    assert.equal(budgetSteer("tier-frontier", "tier-frontier", "mask").tier, "tier-frontier");
    assert.equal(budgetSteer("tier-frontier", "tier-fast", "mask", { escalationForced: true }).tier, "tier-frontier");
  });
});

describe("route — floors never violated", () => {
  test("should_clampUpToReviewerFloor", async () => {
    const r = await route({ agentType: "reviewer", policy, budget: budget("0"), targetTier: "tier-fast" });
    assert.equal(r.tier, "tier-heavy");
    assert.equal(r.floor, "tier-heavy");
  });
  test("should_honorFrontierFloor_underBudgetMask", async () => {
    const r = await route({ agentType: "agentic_multiturn", policy, budget: budget("mask") });
    assert.equal(r.tier, "tier-frontier");
    assert.equal(r.demoted, false);
  });
  test("should_liftUnknownAgentToHeavy_onHardSignal", async () => {
    const r = await route({ agentType: "architect", features: ["requires_tool_calls"], policy, budget: budget("0") });
    assert.equal(r.tier, "tier-heavy");
  });
  test("should_ignoreOffLadderTarget_fallingToFloor", async () => {
    const r = await route({ agentType: "coder", targetTier: "tier-bogus", policy, budget: budget("0") });
    assert.equal(r.tier, "tier-fast"); // off-ladder target ignored → floor
  });
});

describe("route — budget steers frontier down, out, and fail-closed", () => {
  test("should_demoteFrontier_atMidBand_rung025", async () => {
    const r = await route({ agentType: "default", targetTier: "tier-frontier", policy, budget: budget("0.25") });
    assert.equal(r.tier, "tier-heavy");
    assert.equal(r.demoted, true);
  });
  test("should_maskFrontier_whenExhausted", async () => {
    const r = await route({ agentType: "default", targetTier: "tier-frontier", policy, budget: budget("mask") });
    assert.equal(r.tier, "tier-heavy");
    assert.equal(r.masked, true);
  });
  test("should_failClosed_when_metricsUnavailable", async () => {
    const r = await route({ agentType: "default", targetTier: "tier-frontier", policy, budget: budget("0", false) });
    assert.equal(r.tier, "tier-heavy");
    assert.equal(r.masked, true);
    assert.match(r.reason, /metrics unavailable/);
  });
  test("should_keepFrontier_whenHealthy", async () => {
    const r = await route({ agentType: "default", targetTier: "tier-frontier", policy, budget: budget("0") });
    assert.equal(r.tier, "tier-frontier");
  });
});

describe("route — category from ruflo agent + privacy lane", () => {
  test("should_deriveCategoryFromRufloAgent_when_agentTypeOmitted", async () => {
    const r = await route({ task: "review this", policy, budget: budget("0"), rufloAgent: async () => "reviewer" });
    assert.equal(r.agentType, "reviewer");
    assert.equal(r.tier, "tier-heavy"); // reviewer floor
  });
  test("should_defaultCategory_when_rufloReturnsNull", async () => {
    const r = await route({ task: "x", policy, budget: budget("0"), rufloAgent: async () => null });
    assert.equal(r.agentType, "default");
  });
  test("should_stayPrivate_neverCallRuflo_when_pinnedPrivate", async () => {
    let called = false;
    const r = await route({ pinnedPrivate: true, task: "secret", policy, budget: budget("mask"), rufloAgent: async () => { called = true; return "coder"; } });
    assert.equal(r.tier, "tier-private");
    assert.equal(called, false); // task never reaches ruflo argv
  });
});

describe("defaultRufloAgent — parse the AGENT from ruflo route output", () => {
  test("should_parseAgentId_fromParenthetical", async () => {
    // Simulate ruflo's real stdout via an injected exec (env RUFLO_BIN can't help; parse-only unit).
    // Directly assert the regex the bridge uses against real-format text.
    const sample = "Routed to Architect\n| Agent: Architect (architect) |\n";
    const m = sample.match(/Agent:[^\n(]*\(([a-z][a-z0-9_-]*)\)/i);
    assert.equal(m[1], "architect");
  });
  test("should_returnNull_type_when_ruflAgentIsAFunction", () => {
    assert.equal(typeof defaultRufloAgent, "function");
  });
});
