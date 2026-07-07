import { test } from "node:test";
import assert from "node:assert/strict";
import { reward, DEFAULT_WEIGHTS } from "../reward.mjs";

test("reward() is strictly higher for higher quality, cost/latency fixed", () => {
  const low = reward({ quality: 0.5, costUsd: 0.01, latencySeconds: 1 });
  const high = reward({ quality: 0.9, costUsd: 0.01, latencySeconds: 1 });

  assert.ok(high > low);
});

test("reward() is strictly lower for higher cost, quality/latency fixed", () => {
  const cheap = reward({ quality: 0.8, costUsd: 0.01, latencySeconds: 1 });
  const expensive = reward({ quality: 0.8, costUsd: 0.05, latencySeconds: 1 });

  assert.ok(expensive < cheap);
});

test("reward() is strictly lower for higher latency, quality/cost fixed", () => {
  const fast = reward({ quality: 0.8, costUsd: 0.01, latencySeconds: 1 });
  const slow = reward({ quality: 0.8, costUsd: 0.01, latencySeconds: 5 });

  assert.ok(slow < fast);
});

test("reward() scores a cheap, fast, perfect local answer near wQuality", () => {
  const result = reward({ quality: 1, costUsd: 0, latencySeconds: 0.1 });

  assert.ok(Math.abs(result - DEFAULT_WEIGHTS.wQuality) < 0.01);
});

test("reward() clamps quality above 1 down to 1", () => {
  const clamped = reward({ quality: 1.5, costUsd: 0, latencySeconds: 0 });
  const atMax = reward({ quality: 1, costUsd: 0, latencySeconds: 0 });

  assert.equal(clamped, atMax);
});

test("reward() clamps negative cost to 0", () => {
  const negative = reward({ quality: 0.5, costUsd: -1, latencySeconds: 0 });
  const zero = reward({ quality: 0.5, costUsd: 0, latencySeconds: 0 });

  assert.equal(negative, zero);
});

test("reward() clamps negative latency to 0", () => {
  const negative = reward({ quality: 0.5, costUsd: 0, latencySeconds: -1 });
  const zero = reward({ quality: 0.5, costUsd: 0, latencySeconds: 0 });

  assert.equal(negative, zero);
});

test("reward() falls back to the default costRef when given a zero costRef", () => {
  const withZeroRef = reward({
    quality: 0.5,
    costUsd: 0.01,
    latencySeconds: 0,
    weights: { costRef: 0 },
  });
  const withDefaultRef = reward({ quality: 0.5, costUsd: 0.01, latencySeconds: 0 });

  assert.equal(withZeroRef, withDefaultRef);
  assert.ok(Number.isFinite(withZeroRef));
});

test("reward() falls back to the default latencyRef when given a negative latencyRef", () => {
  const withNegativeRef = reward({
    quality: 0.5,
    costUsd: 0,
    latencySeconds: 2,
    weights: { latencyRef: -10 },
  });
  const withDefaultRef = reward({ quality: 0.5, costUsd: 0, latencySeconds: 2 });

  assert.equal(withNegativeRef, withDefaultRef);
  assert.ok(Number.isFinite(withNegativeRef));
});

test("reward() ignores cost entirely when wCost is overridden to 0", () => {
  const cheap = reward({ quality: 0.7, costUsd: 0, latencySeconds: 1, weights: { wCost: 0 } });
  const expensive = reward({ quality: 0.7, costUsd: 5, latencySeconds: 1, weights: { wCost: 0 } });

  assert.equal(cheap, expensive);
});
