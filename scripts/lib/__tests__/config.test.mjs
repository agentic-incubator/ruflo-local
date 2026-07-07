// Tests for the centralized env surface. Every getter takes an injected env object,
// so these never touch process.env.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  str,
  num,
  gatewayConfig,
  judgeConfig,
  budgetConfig,
  benchConfig,
  regressionConfig,
  otelConfig,
  resolveGatewayEnv,
} from "../config.mjs";

test("str returns default when unset or blank, override otherwise", () => {
  assert.equal(str("X", "def", {}), "def");
  assert.equal(str("X", "def", { X: "" }), "def");
  assert.equal(str("X", "def", { X: "val" }), "val");
});

test("num returns default on unset/blank/NaN and parses valid numbers", () => {
  assert.equal(num("N", 5, {}), 5);
  assert.equal(num("N", 5, { N: "" }), 5);
  assert.equal(num("N", 5, { N: "notnum" }), 5);
  assert.equal(num("N", 5, { N: "12.5" }), 12.5);
});

test("gatewayConfig defaults match the bash script", () => {
  assert.deepEqual(gatewayConfig({}), {
    gateway: "http://localhost:4000",
    apiKey: "sk-local-master",
  });
});

test("judgeConfig defaults and overrides", () => {
  assert.deepEqual(judgeConfig({}), { judgeModel: "tier-frontier", threshold: 0.6 });
  assert.deepEqual(judgeConfig({ JUDGE_MODEL: "tier-heavy", VERIFY_THRESHOLD: "0.8" }), {
    judgeModel: "tier-heavy",
    threshold: 0.8,
  });
});

test("budgetConfig defaults match the bash script", () => {
  assert.deepEqual(budgetConfig({}), {
    usdBudget: 7.0,
    tokenBudget: 5000000,
    frontierModels: "claude-opus-4-8|gpt-4.1|gemini-2.5-pro",
    spendMetric: "litellm_spend_metric",
    tokenMetric: "litellm_total_tokens",
  });
});

test("benchConfig and regressionConfig defaults", () => {
  assert.deepEqual(benchConfig({}), { model: "tier-fast", n: 20 });
  assert.deepEqual(regressionConfig({}), {
    fastModel: "tier-fast",
    frontierModel: "tier-frontier",
    margin: 0.2,
    threshold: 0.2,
  });
});

test("otelConfig defaults to the shared collector endpoint litellm's own OTEL_EXPORTER already posts to, override via OTEL_ENDPOINT", () => {
  assert.deepEqual(otelConfig({}), { endpoint: "http://otel-collector:4318/v1/traces" });
  assert.deepEqual(otelConfig({ OTEL_ENDPOINT: "http://collector:4318/v1/traces" }), {
    endpoint: "http://collector:4318/v1/traces",
  });
});

test("resolveGatewayEnv merges a passed env object with GW pinned to the upstream origin", () => {
  assert.deepEqual(resolveGatewayEnv({ SOME_VAR: "x" }, "http://litellm:4000"), {
    SOME_VAR: "x",
    GW: "http://litellm:4000",
  });
});

test("resolveGatewayEnv falls back to process.env (not {}) when no env override is passed — the production shape", () => {
  process.env.RUFLO_TEST_RESOLVE_GATEWAY_ENV_MARKER = "present";
  try {
    const resolved = resolveGatewayEnv(undefined, "http://litellm:4000");
    assert.equal(resolved.RUFLO_TEST_RESOLVE_GATEWAY_ENV_MARKER, "present", "a real process.env var must survive when no override is passed");
    assert.equal(resolved.GW, "http://litellm:4000");
  } finally {
    delete process.env.RUFLO_TEST_RESOLVE_GATEWAY_ENV_MARKER;
  }
});
