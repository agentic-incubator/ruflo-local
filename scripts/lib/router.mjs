// =============================================================================
// router.mjs — the per-category champion: route a task to an AGENT (category) via
// ruflo route(), map that agent to its per-agent-type tier FLOOR, then let the budget
// snapshot STEER (not just alert).
//
// Grounded in ruflo's real behavior: `ruflo route <task>` is a Q-learning AGENT router
// (it returns Architect / Coder / Reviewer / …), NOT a model-tier router. So the product
// wiring is: ruflo picks the agent/category → config/routing/router-policy.example.json
// maps agent → tier floor → this router applies difficulty + budget on top.
//
// Decision order (tier-schema v1 — no per-request locality yet, that is Phase 6):
//   1. Privacy lane: a pinned-private request stays tier-private — never scored off-box,
//      never demoted, never escalated (and its task never reaches ruflo's argv).
//   2. Category: agentType (given) or derived from ruflo route() (injectable).
//   3. Floor: the higher of the agent-type floor and any HARD escalation signal
//      (agentic tool-calling / multi-turn — where small local models are weak).
//   4. Target: the difficulty pick (defaults to the floor); clamp UP — never below floor.
//   5. Budget steering: frontier is DEMOTED as utilization rises (any ramp rung) and
//      MASKED at 100% — but never below the floor; a frontier FLOOR beats the quota, and
//      escalation-forced turns are exempt. FAIL-CLOSED: if metrics are unavailable the
//      gateway may be spending blind, so frontier is masked (never fail-open).
// =============================================================================

import { budgetSnapshot } from "./budget-snapshot.mjs";
import { str } from "./config.mjs";

/** Escalation ladder, cheap → capable. tier-private is a separate pinned lane (not here). */
export const TIER_LADDER = ["tier-fast", "tier-heavy", "tier-frontier"];

export function tierRank(tier) {
  return TIER_LADDER.indexOf(tier);
}
/** Higher-capability of two ladder tiers. */
export function maxTier(a, b) {
  return tierRank(a) >= tierRank(b) ? a : b;
}
/** Clamp a tier UP to the floor — never below it. */
export function floorClamp(tier, floor) {
  return tierRank(tier) < tierRank(floor) ? floor : tier;
}
/** Agent-type floor from the policy (default when the type is unknown). */
export function agentFloor(policy, agentType) {
  const floors = policy?.escalation?.tier_floor_by_agent_type ?? {};
  return floors[agentType] ?? floors.default ?? "tier-fast";
}
/** Hard escalation signals lift the effective floor to at least tier-heavy. */
export function hardSignalFloor(policy, features = []) {
  const hard = policy?.escalation?.hard_signals ?? [];
  return features.some((f) => hard.includes(f)) ? "tier-heavy" : "tier-fast";
}

/**
 * Budget steering of a frontier pick → { tier, demoted, masked }. Any non-zero budget
 * rung (0.25/0.5/0.75 — the RFC ramp starts at util 0.5) demotes frontier to heavy; the
 * "mask" rung (util >= 1.0) masks it; UNAVAILABLE metrics fail CLOSED (treated as mask,
 * since the gateway may be spending blind). Never below `floor`; a frontier floor and an
 * escalation-forced turn are exempt.
 */
export function budgetSteer(tier, floor, rung, { escalationForced = false, metricsAvailable = true } = {}) {
  if (tier !== "tier-frontier" || escalationForced) return { tier, demoted: false, masked: false };
  const failClosed = metricsAvailable === false;
  const masked = rung === "mask" || failClosed;
  const demote = masked || rung !== "0"; // ramp step OR mask OR fail-closed
  if (!demote) return { tier, demoted: false, masked: false };
  const target = floorClamp("tier-heavy", floor);
  if (tierRank(target) >= tierRank("tier-frontier")) {
    return { tier: "tier-frontier", demoted: false, masked: false }; // floor beats quota
  }
  return { tier: target, demoted: true, masked };
}

/**
 * Default ruflo route() bridge — invoke ruflo's AGENT router and parse the chosen agent
 * id (e.g. "Agent: Architect (architect)" → "architect"). Returns null on any failure so
 * the caller keeps its provided/default category (never crashes the product path).
 */
export async function defaultRufloAgent({ task = "", env = process.env } = {}) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const bin = str("RUFLO_BIN", "npx", env);
  const ver = str("RUFLO_SPEC", "ruflo@3.21.1", env);
  const args = bin === "npx" ? ["-y", ver, "route", task] : ["route", task];
  try {
    const { stdout } = await promisify(execFile)(bin, args, { timeout: 45000 });
    // Prefer the parenthetical agent id on the "Agent:" line; fall back to "Routed to X".
    const m = stdout.match(/Agent:[^\n(]*\(([a-z][a-z0-9_-]*)\)/i) || stdout.match(/Routed to\s+([A-Za-z][\w-]*)/);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Route one request. `budget` is the budget-snapshot object (fetched if omitted).
 * `agentType` is the category; if omitted it is derived from `rufloAgent(task)`.
 * `targetTier` is the difficulty pick (defaults to the floor); it is always clamped up.
 * @returns {Promise<{tier, floor, agentType, target, demoted, masked, budget_rung, metrics_available, reason}>}
 */
export async function route({
  agentType,
  task = "",
  features = [],
  targetTier,
  pinnedPrivate = false,
  escalationForced = false,
  policy,
  budget,
  rufloAgent = defaultRufloAgent,
  env = process.env,
} = {}) {
  // 1. Privacy lane — pinned-private never leaves the box (and its task never hits ruflo argv).
  if (pinnedPrivate) {
    return { tier: "tier-private", floor: "tier-private", agentType: "private", target: "tier-private", demoted: false, masked: false, budget_rung: "n/a", metrics_available: true, reason: "privacy-pinned — local only, never budget-steered" };
  }

  // 2. Category via ruflo route() (agent router) when not provided.
  const category = agentType ?? (await rufloAgent({ task, env })) ?? "default";

  // 3. Floor = max(agent-type floor, hard-signal floor).
  const floor = maxTier(agentFloor(policy, category), hardSignalFloor(policy, features));

  // 4. Target = difficulty pick (default: the floor), clamped UP to the floor.
  const target = floorClamp(TIER_LADDER.includes(targetTier) ? targetTier : floor, floor);

  // 5. Budget steering (frontier only; never below floor; fail-closed on missing metrics).
  const snap = budget ?? (await budgetSnapshot({ env }));
  const rung = snap?.demotion_rung ?? "0";
  const metricsAvailable = snap?.metrics_available ?? true;
  const steered = budgetSteer(target, floor, rung, { escalationForced, metricsAvailable });

  const reason = steered.masked
    ? metricsAvailable ? `frontier masked (budget exhausted, rung ${rung})` : "frontier masked (metrics unavailable — fail-closed)"
    : steered.demoted
      ? `frontier demoted (budget rung ${rung})`
      : escalationForced && target === "tier-frontier"
        ? "escalation-forced frontier (budget-exempt)"
        : `floor=${floor}, target=${target} (agent ${category})`;

  return { tier: steered.tier, floor, agentType: category, target, demoted: steered.demoted, masked: steered.masked, budget_rung: rung, metrics_available: metricsAvailable, reason };
}
