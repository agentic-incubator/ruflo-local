// =============================================================================
// budget-snapshot.mjs — machine-readable remaining-budget snapshot (limitations §4).
//
// In-process Node port of budget-snapshot.sh — SAME contract, no bash/jq/curl. Emits
// JSON a router (e.g. ruflo route()) consumes to make budget STEER, not just alert:
// DEMOTE frontier candidates as budget fills (50/75/90 rungs) and MASK them at 100%
// — except pinned / escalation-forced turns. LiteLLM's per-deployment max_budget +
// HTTP 429 skip remains the fail-closed backstop underneath.
//
// FRONTIER-SCOPED: only frontier deployments' spend/tokens count. Local tiers and
// tier-private are NEVER budget-steered (locality/privacy invariant) — their $0,
// high-volume traffic must not perturb the frontier signal. The FRONTIER_MODELS
// regex (via config.mjs) is what enforces this scoping.
//
// CAVEAT (budget window): $GW/metrics counters may be CUMULATIVE, while the
// gateway's max_budget resets every budget_duration (1d). Set FRONTIER_USD_BUDGET /
// FRONTIER_TOKEN_BUDGET to reflect the SAME window as the metric you read, or point
// SPEND_METRIC/TOKEN_METRIC at a period-aware remaining-budget gauge (LiteLLM emits
// these when prometheus_initialize_budget_metrics is on — enabled in this kit).
//
// Env: GW, LITELLM_MASTER_KEY, FRONTIER_USD_BUDGET, FRONTIER_TOKEN_BUDGET,
//      FRONTIER_MODELS (regex), SPEND_METRIC, TOKEN_METRIC — same defaults as the
//      bash script, resolved once via config.mjs's budgetConfig().
// =============================================================================

import { budgetConfig } from "./config.mjs";
import { GatewayClient } from "./gateway-client.mjs";

/**
 * Sum sample values for FRONTIER deployments only (0 if none). $1 = base metric name.
 *
 * `^name(_total)?{` anchors to the SAMPLE line (excludes companion series like
 * name_created / name_bucket that would otherwise be summed); frontierModels
 * restricts to frontier deployments so local/private traffic never counts.
 */
export function sumFrontier(metricsText, baseMetric, frontierModels) {
  const line = new RegExp(`^${baseMetric}(_total)?\\{[^}]*(${frontierModels})`);
  let sum = 0;
  for (const l of String(metricsText ?? "").split("\n")) {
    if (!line.test(l)) continue;
    const tokens = l.trim().split(/\s+/);
    const v = Number(tokens[tokens.length - 1]);
    if (Number.isFinite(v)) sum += v;
  }
  return Number(sum.toFixed(6));
}

/** Utilization in [0, ∞), 0 when budget<=0. */
export function util(spent, budget) {
  return budget > 0 ? Number((spent / budget).toFixed(4)) : 0;
}

/** Demotion penalty for a utilization (RFC §8.2: 0 <0.5, ramp 0.5→0.9, MASK at 1.0). */
export function rung(u) {
  if (u >= 1.0) return "mask";
  if (u >= 0.9) return "0.75";
  if (u >= 0.75) return "0.5";
  if (u >= 0.5) return "0.25";
  return "0";
}

/**
 * Build the frontier budget snapshot. Fails closed: if the gateway's /metrics scrape
 * throws (unreachable/erroring, like curl -f's non-zero exit), metrics_available is
 * false and spend is treated as 0 — the router must not assume $0 spend from a failed
 * scrape, since the serving path may still be spending.
 */
export async function budgetSnapshot({ client, env } = {}) {
  const cfg = budgetConfig(env);
  const gw = client ?? new GatewayClient({ env });

  let metrics = "";
  let metricsAvailable = true;
  try {
    metrics = await gw.metrics();
  } catch {
    metrics = "";
    metricsAvailable = false;
  }

  const usdSpent = sumFrontier(metrics, cfg.spendMetric, cfg.frontierModels);
  const tokSpent = sumFrontier(metrics, cfg.tokenMetric, cfg.frontierModels);
  const usdUtil = util(usdSpent, cfg.usdBudget);
  const tokUtil = util(tokSpent, cfg.tokenBudget);

  // The tighter of the two budgets governs demotion (fail-closed on the worse pressure).
  const govUtil = Math.max(usdUtil, tokUtil);
  const demotionRung = rung(govUtil);
  const frontierMasked = demotionRung === "mask";

  return {
    schema_version: 1,
    scope: "frontier",
    note: "Frontier-only demotion; local tiers and tier-private are never steered.",
    metrics_available: metricsAvailable,
    metrics_available_hint:
      "when false, the router should fail-closed (demote/mask frontier) — the gateway may still be spending",
    usd: { spent: usdSpent, budget: cfg.usdBudget, utilization: usdUtil },
    tokens: { spent: tokSpent, budget: cfg.tokenBudget, utilization: tokUtil },
    governing_utilization: govUtil,
    demotion_rung: demotionRung,
    frontier_masked: frontierMasked,
    mask_exceptions: ["pinned", "escalation-forced"],
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
export async function main() {
  const result = await budgetSnapshot();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

// Run as a script (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code ?? 0));
}
