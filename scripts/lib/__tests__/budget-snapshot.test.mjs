import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetSnapshot, sumFrontier, util, rung } from "../budget-snapshot.mjs";

const FRONTIER_MODELS = "claude-opus-4-8|gpt-4.1|gemini-2.5-pro";

test("rung() returns '0' just below the 0.5 boundary", () => {
  assert.equal(rung(0.49), "0");
});

test("rung() returns '0.25' at the 0.5 boundary", () => {
  assert.equal(rung(0.5), "0.25");
});

test("rung() returns '0.5' at the 0.75 boundary", () => {
  assert.equal(rung(0.75), "0.5");
});

test("rung() returns '0.75' at the 0.9 boundary", () => {
  assert.equal(rung(0.9), "0.75");
});

test("rung() returns 'mask' at the 1.0 boundary", () => {
  assert.equal(rung(1.0), "mask");
});

test("rung() returns 'mask' above 1.0", () => {
  assert.equal(rung(1.5), "mask");
});

test("util() returns 0 for a zero budget", () => {
  assert.equal(util(3.5, 0), 0);
});

test("util() returns 0 for a negative budget", () => {
  assert.equal(util(3.5, -1), 0);
});

test("util() rounds the spent/budget ratio to 4 decimal places", () => {
  assert.equal(util(1, 3), 0.3333);
});

test("sumFrontier() sums only sample lines for frontier deployments", () => {
  const metrics = [
    'litellm_spend_metric{model="claude-opus-4-8"} 1.5',
    'litellm_spend_metric{model="gpt-4.1"} 2.25',
    'litellm_spend_metric{model="gemini-2.5-pro"} 0.75',
  ].join("\n");
  assert.equal(sumFrontier(metrics, "litellm_spend_metric", FRONTIER_MODELS), 4.5);
});

test("sumFrontier() ignores _created and _bucket companion series", () => {
  const metrics = [
    'litellm_spend_metric{model="claude-opus-4-8"} 1.5',
    'litellm_spend_metric_created{model="claude-opus-4-8"} 1700000000',
    'litellm_spend_metric_bucket{model="claude-opus-4-8",le="1"} 9',
  ].join("\n");
  assert.equal(sumFrontier(metrics, "litellm_spend_metric", FRONTIER_MODELS), 1.5);
});

test("sumFrontier() ignores non-frontier (local) deployments", () => {
  const metrics = [
    'litellm_spend_metric{model="claude-opus-4-8"} 1.5',
    'litellm_spend_metric{model="tier-fast"} 999',
  ].join("\n");
  assert.equal(sumFrontier(metrics, "litellm_spend_metric", FRONTIER_MODELS), 1.5);
});

test("sumFrontier() returns 0 when no frontier lines match", () => {
  const metrics = 'litellm_spend_metric{model="tier-fast"} 999';
  assert.equal(sumFrontier(metrics, "litellm_spend_metric", FRONTIER_MODELS), 0);
});

test("budgetSnapshot() computes utilization and rung from a reachable metrics scrape", async () => {
  const env = {
    FRONTIER_USD_BUDGET: "10",
    FRONTIER_TOKEN_BUDGET: "1000",
    FRONTIER_MODELS,
    SPEND_METRIC: "litellm_spend_metric",
    TOKEN_METRIC: "litellm_total_tokens",
  };
  const metricsText = [
    'litellm_spend_metric{model="claude-opus-4-8"} 9',
    'litellm_total_tokens{model="claude-opus-4-8"} 100',
  ].join("\n");
  const client = { metrics: async () => metricsText };

  const result = await budgetSnapshot({ client, env });

  assert.equal(result.metrics_available, true);
  assert.equal(result.usd.spent, 9);
  assert.equal(result.usd.utilization, 0.9);
  assert.equal(result.tokens.spent, 100);
  assert.equal(result.tokens.utilization, 0.1);
  assert.equal(result.governing_utilization, 0.9);
  assert.equal(result.demotion_rung, "0.75");
  assert.equal(result.frontier_masked, false);
});

test("budgetSnapshot() fails closed when the metrics scrape rejects", async () => {
  const env = {
    FRONTIER_USD_BUDGET: "10",
    FRONTIER_TOKEN_BUDGET: "1000",
    FRONTIER_MODELS,
  };
  const client = { metrics: async () => { throw new Error("gateway 503 unavailable"); } };

  const result = await budgetSnapshot({ client, env });

  assert.equal(result.metrics_available, false);
  assert.equal(result.usd.spent, 0);
  assert.equal(result.tokens.spent, 0);
  assert.equal(result.demotion_rung, "0");
  assert.equal(result.frontier_masked, false);
});
